
import express from "express";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";

const app = express();

// WAV Base64 payload support
app.use(express.json({ limit: "35mb" }));

const PORT = process.env.PORT || 3000;

const {
  BROWSERBASE_API_KEY,
  BROWSERBASE_PROJECT_ID,
  BROWSERBASE_CONTEXT_ID,
  AUTOMATION_API_KEY,
  CLAUDE_PROJECT_URL
} = process.env;

// Validate environment variables
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
  throw new Error(
    `Missing environment variables: ${missing.join(", ")}`
  );
}

const bb = new Browserbase({
  apiKey: BROWSERBASE_API_KEY
});

// Authentication middleware
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

// Create Browserbase session
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

// Release Browserbase session
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

// Open Claude Project
async function openClaudeProject(page) {
  await page.goto(CLAUDE_PROJECT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  await page.waitForTimeout(7000);

  const url = page.url();

  if (
    url.includes("/login") ||
    url.includes("/oauth")
  ) {
    throw new Error(
      "Claude login required. Re-authenticate Browserbase Context."
    );
  }

  if (!url.includes("/project/")) {
    throw new Error(
      `Claude Project did not open. Current URL: ${url}`
    );
  }
}

// Find Claude chat input
async function findComposer(page) {
  const selectors = [
    '[contenteditable="true"]',
    "textarea",
    '[role="textbox"]'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).last();

    try {
      await locator.waitFor({
        state: "visible",
        timeout: 7000
      });

      return locator;
    } catch {}
  }

  throw new Error(
    "Claude chat input not found. Update composer selectors."
  );
}

// Submit prompt to Claude
async function submitPrompt(page, prompt) {
  const composer = await findComposer(page);

  await composer.click();
  await composer.fill(prompt);

  const selectors = [
    'button[aria-label*="Send" i]',
    'button[data-testid*="send"]',
    'button[aria-label*="Submit" i]'
  ];

  let sent = false;

  for (const selector of selectors) {
    const button = page.locator(selector).last();

    try {
      if (
        await button.count() &&
        await button.isVisible() &&
        await button.isEnabled()
      ) {
        await button.click();
        sent = true;
        break;
      }
    } catch {}
  }

  if (!sent) {
    await composer.press("Enter");
  }

  await page.waitForTimeout(3000);
}

// Get Claude response text
async function getMainText(page) {
  const main = page.locator("main").last();

  if (await main.count()) {
    return (await main.innerText()).trim();
  }

  return (await page.locator("body").innerText()).trim();
}

// Wait for Claude response
async function waitForClaudeResponse(
  page,
  timeoutMs = 900000
) {
  const started = Date.now();

  let previous = "";
  let stableSince = 0;
  let lastText = "";

  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(2500);

    const current = await getMainText(page);

    const stop = page.locator(
      'button[aria-label*="Stop" i], button[title*="Stop" i]'
    ).last();

    let generating = false;

    try {
      generating =
        await stop.count() > 0 &&
        await stop.isVisible();
    } catch {}

    if (current.length > 500) {
      lastText = current;

      if (current === previous && !generating) {
        if (!stableSince) {
          stableSince = Date.now();
        }

        if (Date.now() - stableSince >= 12000) {
          return lastText;
        }
      } else {
        stableSince = 0;
      }
    }

    previous = current;
  }

  throw new Error(
    "Claude response timed out. Inspect Browserbase session."
  );
}

// Safe audio filename
function safeFilename(value) {
  const name = String(value || "explainer")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);

  return `${name || "explainer"}-voice.wav`;
}

// Extract MP4 URL from response
function extractMp4Url(text) {
  const urls =
    text.match(/https?:\/\/[^\s<>"')]+/g) || [];

  return urls
    .map(url => url.replace(/[.,;]+$/, ""))
    .find(url => /\.mp4(?:[?#].*)?$/i.test(url)) || null;
}

// Health check
app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "Claude Explainer Automation",
    status: "online",
    endpoints: [
      "/run",
      "/render",
      "/setup-login",
      "/stop-session"
    ]
  });
});

// ==========================================
// STAGE 1: GENERATE SCRIPT
// ==========================================

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

    console.log("Generating script:", title);

    session = await createSession();

    const browser = await chromium.connectOverCDP(
      session.connectUrl
    );

    const context = browser.contexts()[0];

    const page =
      context.pages()[0] ||
      await context.newPage();

    await openClaudeProject(page);

    const prompt = `
Follow the permanent Project Instructions
in this Claude Project.

VIDEO TOPIC:
${title}

TASK:

1. Research the topic.
2. Follow the exact six-scene structure.
3. Write an English voiceover script of 120-140 words.
4. Clearly place narration under the heading VOICEOVER.
5. Include scene-by-scene visual concepts.
6. Include on-screen text.
7. Include a short social media caption.
8. Do not create HTML, CSS or JavaScript yet.
9. Do not render video yet.

Return the complete script.
Stop after script generation.
`;

    await submitPrompt(page, prompt);

    console.log("Waiting for Claude script...");

    const scriptResponse =
      await waitForClaudeResponse(page);

    return res.json({
      success: true,
      status: "SCRIPT_READY",
      topic: title,
      projectUrl: CLAUDE_PROJECT_URL,
      scriptResponse
    });

  } catch (error) {
    console.error("Script error:", error);

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

// ==========================================
// STAGE 2: UPLOAD WAV + RENDER VIDEO
// ==========================================

app.post("/render", authenticate, async (req, res) => {
  let session;

  try {
    const title = String(req.body.title || "").trim();

    const voiceover =
      String(req.body.voiceover || "").trim();

    const script =
      String(req.body.script || "").trim();

    const audioBase64 =
      String(req.body.audioBase64 || "").trim();

    if (!title || !voiceover || !audioBase64) {
      return res.status(400).json({
        success: false,
        message:
          "title, voiceover and audioBase64 are required"
      });
    }

    if (!/^[A-Za-z0-9+/=\s]+$/.test(audioBase64)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Base64 audio data"
      });
    }

    // Convert Base64 to WAV buffer
    const audioBuffer = Buffer.from(
      audioBase64,
      "base64"
    );

    // Validate WAV header
    if (
      audioBuffer.length < 1000 ||
      audioBuffer.subarray(0, 4).toString() !== "RIFF" ||
      audioBuffer.subarray(8, 12).toString() !== "WAVE"
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid WAV file"
      });
    }

    const filename = safeFilename(
      req.body.audioFileName || title
    );

    console.log(
      `Rendering: ${title}, Audio size: ${audioBuffer.length}`
    );

    // Start Browserbase
    session = await createSession();

    const browser = await chromium.connectOverCDP(
      session.connectUrl
    );

    const context = browser.contexts()[0];

    const page =
      context.pages()[0] ||
      await context.newPage();

    await openClaudeProject(page);

    // Find Claude file input
    let fileInput =
      page.locator('input[type="file"]').last();

    try {
      await fileInput.waitFor({
        state: "attached",
        timeout: 10000
      });

    } catch {
      const attachSelectors = [
        'button[aria-label*="Attach" i]',
        'button[aria-label*="Upload" i]',
        'button[title*="Attach" i]'
      ];

      for (const selector of attachSelectors) {
        const button = page.locator(selector).last();

        try {
          if (
            await button.count() &&
            await button.isVisible()
          ) {
            await button.click();
            break;
          }
        } catch {}
      }

      fileInput =
        page.locator('input[type="file"]').last();

      await fileInput.waitFor({
        state: "attached",
        timeout: 15000
      });
    }

    // Upload WAV to Claude
    await fileInput.setInputFiles({
      name: filename,
      mimeType: "audio/wav",
      buffer: audioBuffer
    });

    console.log("WAV uploaded to Claude.");

    await page.waitForTimeout(8000);

    // Automatic video rendering prompt
    const prompt = `
Continue production for this explainer video.

TOPIC:
${title}

VOICEOVER:
${voiceover}

FULL SCRIPT AND SCENE PLAN:
${script || "Use the existing six-scene plan."}

IMPORTANT AUDIO INSTRUCTION:

I have attached the final narration as a WAV file.

Use this exact uploaded audio as the narration track.

Do not generate another voiceover.
Do not change the spoken words.

TASK:

1. Follow permanent Project Instructions.
2. Create the complete six-scene explainer.
3. Build HTML, CSS and JavaScript animation.
4. Synchronize scenes with supplied narration.
5. Add captions and on-screen text.
6. Render the complete video.
7. Export the final video as MP4.
8. Do not ask for approval.
9. Do not stop for confirmation.

Return the final MP4 download URL if available.
Also return the social media caption.

If Claude creates a downloadable artifact instead
of a direct URL, clearly identify that artifact.
`;

    await submitPrompt(page, prompt);

    console.log("Claude video rendering started...");

    const renderResponse =
      await waitForClaudeResponse(
        page,
        1800000
      );

    const videoUrl =
      extractMp4Url(renderResponse);

    return res.json({
      success: true,

      status: videoUrl
        ? "VIDEO_URL_RETURNED"
        : "RENDER_RESPONSE_READY",

      topic: title,

      video_url: videoUrl,

      caption: String(req.body.caption || ""),

      renderResponse,

      sessionId: session.id,

      note: videoUrl
        ? "MP4 URL detected."
        : "Claude responded, but no direct MP4 URL was detected. Inspect renderResponse."
    });

  } catch (error) {
    console.error("Render error:", error);

    return res.status(500).json({
      success: false,
      status: "RENDER_FAILED",
      message: error.message,
      sessionId: session?.id || null
    });

  } finally {
    if (session?.id) {
      await releaseSession(session.id);
    }
  }
});

// ==========================================
// MANUAL CLAUDE LOGIN SETUP
// ==========================================

app.post("/setup-login", authenticate, async (req, res) => {
  let session;

  try {
    session = await createSession();

    const browser = await chromium.connectOverCDP(
      session.connectUrl
    );

    const context = browser.contexts()[0];

    const page =
      context.pages()[0] ||
      await context.newPage();

    await page.goto("https://claude.ai", {
      waitUntil: "domcontentloaded",
      timeout: 90000
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

// ==========================================
// STOP SESSION
// ==========================================

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

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Claude automation running on port ${PORT}`
  );
});
