
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

session = await bb.sessions.create({
  projectId: BROWSERBASE_PROJECT_ID,
  region: "us-west-2",
  browserSettings: {
    context: {
      id: process.env.BROWSERBASE_CONTEXT_ID,
      persist: true
    }
  }
});




app.post("/setup-login", authenticate, async (req, res) => {
  try {
    const contextId = process.env.BROWSERBASE_CONTEXT_ID;

    if (!contextId) {
      return res.status(400).json({
        success: false,
        message: "BROWSERBASE_CONTEXT_ID is missing"
      });
    }

    const session = await bb.sessions.create({
      browserSettings: {
        context: {
          id: contextId,
          persist: true
        }
      }
    });

    const browser = await chromium.connectOverCDP(
      session.connectUrl
    );

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    await page.goto("https://claude.ai", {
      waitUntil: "domcontentloaded"
    });

    return res.json({
      success: true,
      message: "Claude login session is ready",
      sessionId: session.id,
      loginUrl: "https://claude.ai",
      sessionInspector:
        `https://browserbase.com/sessions/${session.id}`,
      instruction:
        "Open the session in Browserbase and log in manually."
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
