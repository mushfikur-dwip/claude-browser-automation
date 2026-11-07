
import express from "express";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";

const app = express();

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const {
  BROWSERBASE_API_KEY,
  BROWSERBASE_PROJECT_ID,
  BROWSERBASE_CONTEXT_ID,
  AUTOMATION_API_KEY,
  CLAUDE_PROJECT_URL
} = process.env;

// Validate environment variables
const requiredVariables = {
  BROWSERBASE_API_KEY,
  BROWSERBASE_PROJECT_ID,
  BROWSERBASE_CONTEXT_ID,
  AUTOMATION_API_KEY,
  CLAUDE_PROJECT_URL
};

const missingVariables = Object.entries(requiredVariables)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingVariables.length > 0) {
  throw new Error(
    `Missing environment variables: ${missingVariables.join(", ")}`
  );
}

// Validate Claude Project URL
const projectUrl = new URL(CLAUDE_PROJECT_URL);

if (
  projectUrl.hostname !== "claude.ai" ||
  !projectUrl.pathname.startsWith("/project/")
) {
  throw new Error("Invalid Claude Project URL");
}

// Browserbase client
const bb = new Browserbase({
  apiKey: BROWSERBASE_API_KEY
});

// Authentication middleware
function authenticate(req, res, next) {
  const token = req.headers.authorization;

  if (token !== `Bearer ${AUTOMATION_API_KEY}`) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  next();
}

// Health check
app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "Claude Browser Automation",
    status: "online",
    projectConfigured: true,
    contextConfigured: true
  });
});

// Create Browserbase session with saved Context
async function createBrowserSession() {
  return await bb.sessions.create({
    projectId: BROWSERBASE_PROJECT_ID,
    region: "us-west-2",
    browserSettings: {
      context: {
        id: BROWSERBASE_CONTEXT_ID,
        persist: true
      }
    }
  });
}

// Release Browserbase session
async function releaseSession(sessionId) {
  if (!sessionId) return;

  try {
    await bb.sessions.update(sessionId, {
      status: "REQUEST_RELEASE",
      projectId: BROWSERBASE_PROJECT_ID
    });

    console.log(`Session release requested: ${sessionId}`);
  } catch (error) {
    console.error("Session release error:", error.message);
  }
}

// Check Claude login status
async function inspectClaudeProject(page) {
  const currentUrl = page.url();
  const title = await page.title();

  const loginRequired =
    currentUrl.includes("/login") ||
    currentUrl.includes("/oauth") ||
    currentUrl.includes("/auth/");

  const projectOpened =
    currentUrl.includes("/project/") &&
    !loginRequired;

  return {
    projectOpened,
    loginRequired,
    browserTitle: title,
    currentUrl
  };
}

// Main automation endpoint
app.post("/run", authenticate, async (req, res) => {
  let session;
  let responseData;

  try {
    const { title } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: "A valid topic title is required"
      });
    }

    console.log(`Starting automation for: ${title}`);

    // Create Browserbase session
    session = await createBrowserSession();

    console.log(`Browserbase session created: ${session.id}`);

    // Connect Playwright
    const browser = await chromium.connectOverCDP(
      session.connectUrl
    );

    const context = browser.contexts()[0];

    const page =
      context.pages()[0] || await context.newPage();

    // Open the configured Claude Project
    await page.goto(CLAUDE_PROJECT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });

    // Wait for initial page rendering
    await page.waitForTimeout(7000);

    // Inspect current state
    const inspection = await inspectClaudeProject(page);

    console.log("Claude inspection:", inspection);

    responseData = {
      success: inspection.projectOpened,
      message: inspection.projectOpened
        ? "Claude Project opened successfully"
        : inspection.loginRequired
          ? "Claude login is required"
          : "Claude Project could not be verified",
      topic: title.trim(),
      ...inspection,
      sessionId: session.id,
      nextStep: inspection.projectOpened
        ? "Project is ready for prompt automation"
        : "Complete login and verify the saved Context"
    };

  } catch (error) {
    console.error("Automation error:", error);

    responseData = {
      success: false,
      message: "Browser automation failed",
      error: error.message,
      sessionId: session?.id || null
    };

  } finally {
    // Release session after collecting page information.
    // Persisted Context is intended to retain login state.
    if (session?.id) {
      await releaseSession(session.id);
    }
  }

  const statusCode = responseData.success ? 200 : 500;

  return res.status(statusCode).json(responseData);
});

// Open Claude manually for first-time login
app.post("/setup-login", authenticate, async (req, res) => {
  let session;

  try {
    session = await createBrowserSession();

    const browser = await chromium.connectOverCDP(
      session.connectUrl
    );

    const context = browser.contexts()[0];

    const page =
      context.pages()[0] || await context.newPage();

    await page.goto("https://claude.ai", {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });

    // Keep this session running for manual login.
    // Release it using /stop-session after login.

    return res.json({
      success: true,
      message: "Claude login browser opened",
      sessionId: session.id,
      loginUrl: "https://claude.ai",
      sessionInspector:
        `https://browserbase.com/sessions/${session.id}`,
      instruction:
        "Open the session inspector, log in manually, then call /stop-session."
    });

  } catch (error) {
    console.error("Login setup error:", error);

    if (session?.id) {
      await releaseSession(session.id);
    }

    return res.status(500).json({
      success: false,
      message: "Could not open Claude login session",
      error: error.message
    });
  }
});

// Stop manual login session
app.post("/stop-session", authenticate, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "sessionId is required"
      });
    }

    await releaseSession(sessionId);

    return res.json({
      success: true,
      message: "Session release requested",
      sessionId
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Claude Browser Automation running on port ${PORT}`);
});
