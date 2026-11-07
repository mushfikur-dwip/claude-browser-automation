
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

const required = {
  BROWSERBASE_API_KEY,
  BROWSERBASE_PROJECT_ID,
  BROWSERBASE_CONTEXT_ID,
  AUTOMATION_API_KEY,
  CLAUDE_PROJECT_URL
};

const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length) {
  throw new Error(`Missing environment variables: ${missing.join(", ")}`);
}

const bb = new Browserbase({
  apiKey: BROWSERBASE_API_KEY
});

function authenticate(req, res, next) {
  if (
    req.headers.authorization !==
    `Bearer ${AUTOMATION_API_KEY}`
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  next();
}

async function createSession() {
  return bb.sessions.create({
    projectId: BROWSERBASE_PROJECT_ID,
    region: "us-west-2",
    api_timeout: 1200,
    browserSettings: {
      context: {
        id: BROWSERBASE_CONTEXT_ID,
        persist: true
      }
    }
  });
}

async function releaseSession(sessionId) {
  if (!sessionId) return;

  try {
    await bb.sessions.update(sessionId, {
      status: "REQUEST_RELEASE",
      projectId: BROWSERBASE_PROJECT_ID
    });
  } catch (error) {
    console.error("Session release error:", error.message);
  }
}

async function findComposer(page) {
  const selectors = [
    '[contenteditable="true"]',
    'textarea',
    '[role="textbox"]'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).last();

    try {
      await locator.waitFor({
        state: "visible",
        timeout: 5000
      });

      return locator;
    } catch {
      // Try the next selector.
    }
  }

  throw new Error(
    "Claude chat input not found. Inspect the page DOM and update selectors."
  );
}

async function submitPrompt(page, prompt) {
  const composer = await findComposer(page);

  await composer.click();
  await composer.fill(prompt);

  const sendButtons = [
    'button[aria-label*="Send" i]',
    'button[data-testid*="send"]',
    'button[aria-label*="Submit" i]'
  ];

  let sent = false;

  for (const selector of sendButtons) {
    const button = page.locator(selector).last();

    if (await button.count()) {
      try {
        if (await button.isVisible() && await button.isEnabled()) {
          await button.click();
          sent = true;
          break;
        }
      } catch {
        // Try keyboard submission.
      }
    }
  }

  if (!sent) {
    await composer.press("Enter");
  }

  await page.waitForTimeout(3000);
}

async function getMainText(page) {
  const main = page.locator("main").last();

  if (await main.count()) {
    return (await main.innerText()).trim();
  }

  return (await page.locator("body").innerText()).trim();
}

async function waitForClaudeResponse(page, timeoutMs = 900000) {
  const startedAt = Date.now();

  let previousText = "";
  let stableSince = 0;
  let lastText = "";

  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(2000);

    const currentText = await getMainText(page);

    const stopButton = page.locator(
      'button[aria-label*="Stop" i], button[title*="Stop" i]'
    ).last();

    let isGenerating = false;

    try {
      isGenerating =
        (await stopButton.count()) > 0 &&
        await stopButton.isVisible();
    } catch {
      isGenerating = false;
    }

    if (currentText.length > 500) {
      lastText = currentText;

      if (currentText === previousText && !isGenerating) {
        if (!stableSince) stableSince = Date.now();

        // Wait for response to remain stable for 10 seconds.
        if (Date.now() - stableSince >= 10000) {
          return lastText;
        }
      } else {
        stableSince = 0;
      }
    }

    previousText = currentText;
  }

  throw new Error(
    "Claude response timed out. Check the Browserbase session."
  );
}

// Health check
app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "Claude Script Automation",
    status: "online"
  });
});

// Generate script from a topic
app.post("/run", authenticate, async (req, res) => {
  let session;

  try {
    const title = String(req.body.title || "").trim();

    if (!title) {
      return res.status(400).json({
        success: false,
        message: "Topic title is required"
      });
    }

    console.log("Starting topic:", title);

    session = await createSession();

    const browser = await chromium.connectOverCDP(
      session.connectUrl
    );

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    await page.goto(CLAUDE_PROJECT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });

    await page.waitForTimeout(7000);

    const currentUrl = page.url();

    if (
      currentUrl.includes("/login") ||
      currentUrl.includes("/oauth")
    ) {
      throw new Error(
        "Claude login required. Re-authenticate the Browserbase Context."
      );
    }

    if (!currentUrl.includes("/project/")) {
      throw new Error(
        "Claude Project did not open. Check CLAUDE_PROJECT_URL."
      );
    }

    // Project Instructions are already saved in Claude.
    // Ask Claude to execute only the first production stage.
    const prompt = `
Follow the permanent Project Instructions already configured
in this Claude Project.

NEW VIDEO TOPIC:
${title}

TASK:
1. Research the topic and prepare the complete explainer plan.
2. Follow the exact six-scene structure in the Project Instructions.
3. Write the English voiceover script (approximately 120-140 words).
4. Provide scene-by-scene visual concepts and voice direction.
5. Put the complete voiceover in one copy-friendly code block.
6. Do not create HTML, CSS, JavaScript, animation or render files yet.
7. Stop after the script and wait for my approval.

This is the script preparation stage only.
Do not skip any permanent Project Instructions.
`;

    await submitPrompt(page, prompt);

    console.log("Prompt submitted. Waiting for Claude...");

    const responseText = await waitForClaudeResponse(page);

    console.log("Claude response completed.");

    return res.json({
      success: true,
      status: "SCRIPT_READY_FOR_REVIEW",
      topic: title,
      projectUrl: CLAUDE_PROJECT_URL,
      sessionId: session.id,
      scriptResponse: responseText,
      nextStep: "Review the script before proceeding to audio and video production."
    });

  } catch (error) {
    console.error("Automation error:", error);

    return res.status(500).json({
      success: false,
      status: "FAILED",
      message: error.message,
      sessionId: session?.id || null
    });

  } finally {
    if (session?.id) {
      await releaseSession(session.id);
    }
  }
});

// Manual Claude login setup
app.post("/setup-login", authenticate, async (req, res) => {
  let session;

  try {
    session = await createSession();

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
      sessionId: session.id,
      sessionInspector:
        `https://browserbase.com/sessions/${session.id}`,
      message: "Complete Claude login manually."
    });

  } catch (error) {
    if (session?.id) {
      await releaseSession(session.id);
    }

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Stop a manually opened session
app.post("/stop-session", authenticate, async (req, res) => {
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
    message: "Session release requested"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Claude automation running on port ${PORT}`);
});
