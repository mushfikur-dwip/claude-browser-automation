
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
  AUTOMATION_API_KEY
} = process.env;

if (
  !BROWSERBASE_API_KEY ||
  !BROWSERBASE_PROJECT_ID ||
  !AUTOMATION_API_KEY
) {
  throw new Error("Missing required environment variables");
}

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
    status: "online"
  });
});

// Create Browserbase session
async function createBrowserSession(useContext = false) {
  const settings = {
    projectId: BROWSERBASE_PROJECT_ID,
    region: "us-west-2"
  };

  if (useContext) {
    if (!BROWSERBASE_CONTEXT_ID) {
      throw new Error("BROWSERBASE_CONTEXT_ID is missing");
    }

    settings.browserSettings = {
      context: {
        id: BROWSERBASE_CONTEXT_ID,
        persist: true
      }
    };
  }

  return await bb.sessions.create(settings);
}

// Browserbase connection test
app.post("/run", authenticate, async (req, res) => {
  let session;

  try {
    const { title } = req.body;

    if (!title) {
      return res.status(400).json({
        success: false,
        message: "Title is required"
      });
    }

    // IMPORTANT: session is declared inside this route
    session = await createBrowserSession(true);

    const browser = await chromium.connectOverCDP(
      session.connectUrl
    );

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    await page.goto("https://claude.ai", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    const pageTitle = await page.title();
    const currentUrl = page.url();

    // Release test session
    await bb.sessions.update(session.id, {
      status: "REQUEST_RELEASE",
      projectId: BROWSERBASE_PROJECT_ID
    });

    return res.json({
      success: true,
      message: "Browserbase and Claude connection successful",
      topic: title,
      browserTitle: pageTitle,
      currentUrl,
      sessionId: session.id
    });

  } catch (error) {
    console.error("Browser automation error:", error);

    if (session?.id) {
      try {
        await bb.sessions.update(session.id, {
          status: "REQUEST_RELEASE",
          projectId: BROWSERBASE_PROJECT_ID
        });
      } catch (releaseError) {
        console.error("Session release failed:", releaseError.message);
      }
    }

    return res.status(500).json({
      success: false,
      message: "Browser automation failed",
      error: error.message
    });
  }
});

// Open Claude for manual login
app.post("/setup-login", authenticate, async (req, res) => {
  let session;

  try {
    session = await createBrowserSession(true);

    const browser = await chromium.connectOverCDP(
      session.connectUrl
    );

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    await page.goto("https://claude.ai", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Keep this session running for manual login.
    // Do not release it here.

    return res.json({
      success: true,
      message: "Claude login session opened",
      sessionId: session.id,
      loginUrl: "https://claude.ai",
      sessionInspector:
        `https://browserbase.com/sessions/${session.id}`,
      instruction: "Log in manually using Browserbase Live View."
    });

  } catch (error) {
    console.error("Login setup error:", error);

    if (session?.id) {
      try {
        await bb.sessions.update(session.id, {
          status: "REQUEST_RELEASE",
          projectId: BROWSERBASE_PROJECT_ID
        });
      } catch (releaseError) {
        console.error("Session release failed:", releaseError.message);
      }
    }

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Stop a session after login is complete
app.post("/stop-session", authenticate, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "sessionId is required"
      });
    }

    await bb.sessions.update(sessionId, {
      status: "REQUEST_RELEASE",
      projectId: BROWSERBASE_PROJECT_ID
    });

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
  console.log(`Server running on port ${PORT}`);
});
