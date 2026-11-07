
import express from "express";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const {
  BROWSERBASE_API_KEY,
  BROWSERBASE_PROJECT_ID,
  AUTOMATION_API_KEY
} = process.env;

if (!BROWSERBASE_API_KEY || !AUTOMATION_API_KEY) {
  throw new Error("Missing required environment variables");
}

const bb = new Browserbase({
  apiKey: BROWSERBASE_API_KEY
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "Claude Browser Automation",
    status: "online"
  });
});

// Protect API
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

    session = await bb.sessions.create({
      ...(BROWSERBASE_PROJECT_ID
        ? { projectId: BROWSERBASE_PROJECT_ID }
        : {}),
      region: "us-west-2",
      api_timeout: 300
    });

    const browser = await chromium.connectOverCDP(
      session.connectUrl
    );

    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] || await context.newPage();

      await page.goto("https://example.com", {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });

      const pageTitle = await page.title();

      return res.json({
        success: true,
        message: "Browserbase connected successfully",
        topic: title,
        browserTitle: pageTitle,
        sessionId: session.id,
        nextStep: "Claude automation will be added next"
      });
    } finally {
      // Release the remote Browserbase session
      await bb.sessions.update(session.id, {
        status: "REQUEST_RELEASE",
        ...(BROWSERBASE_PROJECT_ID
          ? { projectId: BROWSERBASE_PROJECT_ID }
          : {})
      });
    }
  } catch (error) {
    console.error("Automation error:", error.message);

    if (session?.id) {
      try {
        await bb.sessions.update(session.id, {
          status: "REQUEST_RELEASE",
          ...(BROWSERBASE_PROJECT_ID
            ? { projectId: BROWSERBASE_PROJECT_ID }
            : {})
        });
      } catch (releaseError) {
        console.error("Session release failed");
      }
    }

    return res.status(500).json({
      success: false,
      message: "Browser automation failed",
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
