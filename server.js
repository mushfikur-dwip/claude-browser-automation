
import express from "express";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json({ limit: "35mb" }));

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

const bb = new Browserbase({ apiKey: BROWSERBASE_API_KEY });

// Authentication
function authenticate(req, res, next) {
  if (req.headers.authorization !== `Bearer ${AUTOMATION_API_KEY}`) {
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

// Release session
async function releaseSession(sessionId) {
  if (!sessionId) return;

  try {
    await bb.sessions.update(sessionId, {
      status: "REQUEST_RELEASE",
      projectId: BROWSERBASE_PROJECT_ID
    });
  } catch (error) {
    console.error("Browserbase release error:", error.message);
  }
}

// Open Claude Project
async function openClaudeProject(page) {
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
    throw new Error("Claude login required. Run /setup-login.");
  }

  if (!currentUrl.includes("/project/")) {
    throw new Error(`Claude Project did not open: ${currentUrl}`);
  }
}

// Find Claude composer
async function findComposer(page) {
  const selectors = [
    '[contenteditable="true"]',
    'div[role="textbox"]',
    "textarea"
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

  throw new Error("Claude message composer not found.");
}

// Submit prompt
async function submitPrompt(page, prompt) {
  const composer = await findComposer(page);

  await composer.click();
  await composer.fill(prompt);

  const selectors = [
    'button[aria-label*="Send" i]',
    'button[data-testid*="send"]',
    'button[aria-label*="Submit" i]'
  ];

  let submitted = false;

  for (const selector of selectors) {
    const button = page.locator(selector).last();

    try {
      if (
        await button.count() > 0 &&
        await button.isVisible() &&
        await button.isEnabled()
      ) {
        await button.click();
        submitted = true;
        break;
      }
    } catch {}
  }

  if (!submitted) {
    await composer.press("Enter");
  }

  await page.waitForTimeout(2500);
}

// Get page text
async function getMainText(page) {
  const main = page.locator("main").last();

  if (await main.count() > 0) {
    return (await main.innerText()).trim();
  }

  return (await page.locator("body").innerText()).trim();
}

// Check if Claude is generating
async function isClaudeGenerating(page) {
  const selectors = [
    'button[aria-label*="Stop" i]',
    'button[title*="Stop" i]'
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).last();

    try {
      if (
        await button.count() > 0 &&
        await button.isVisible()
      ) {
        return true;
      }
    } catch {}
  }

  return false;
}

// Count marker occurrences
function countOccurrences(text, marker) {
  return text.split(marker).length - 1;
}

// Extract narration between markers
function extractMarkedVoiceover(text) {
  const startMarker = "VOICEOVER_START";
  const endMarker = "VOICEOVER_END";

  const startIndex = text.lastIndexOf(startMarker);
  const endIndex = text.lastIndexOf(endMarker);

  if (
    startIndex === -1 ||
    endIndex === -1 ||
    endIndex <= startIndex
  ) {
    return "";
  }

  return text
    .slice(startIndex + startMarker.length, endIndex)
    .replace(/```[a-z]*\s*/gi, "")
    .replace(/```/g, "")
    .trim();
}

// Word count
function countWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

// Wait for a NEW Claude script response
async function waitForMarkedScript(page, timeoutMs = 900000) {
  const startedAt = Date.now();

  let previousVoiceover = "";
  let stableSince = 0;
  let latestPageText = "";

  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(2500);

    latestPageText = await getMainText(page);

    const startCount = countOccurrences(
      latestPageText,
      "VOICEOVER_START"
    );

    const endCount = countOccurrences(
      latestPageText,
      "VOICEOVER_END"
    );

    // Prompt contains one marker pair.
    // Claude's answer must add another pair.
    if (startCount >= 2 && endCount >= 2) {
      const voiceover = extractMarkedVoiceover(latestPageText);
      const words = countWords(voiceover);
      const generating = await isClaudeGenerating(page);

      if (words >= 80 && !generating) {
        if (voiceover === previousVoiceover) {
          if (!stableSince) {
            stableSince = Date.now();
          }

          if (Date.now() - stableSince >= 8000) {
            return {
              pageText: latestPageText,
              voiceover,
              wordCount: words
            };
          }
        } else {
          previousVoiceover = voiceover;
          stableSince = 0;
        }
      } else {
        stableSince = 0;
      }
    }
  }

  const foundVoiceover = extractMarkedVoiceover(latestPageText);
  const foundWords = countWords(foundVoiceover);

  throw new Error(
    `Claude did not return a complete new voiceover. ` +
    `Detected ${foundWords} words. Check Claude response.`
  );
}

// Wait for new render response
async function waitForStableNewResponse(
  page,
  baselineText,
  timeoutMs = 1800000
) {
  const startedAt = Date.now();

  let previousText = "";
  let stableSince = 0;

  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(3000);

    const currentText = await getMainText(page);

    const hasNewContent =
      currentText.length > baselineText.length &&
      currentText !== baselineText;

    if (!hasNewContent) continue;

    const generating = await isClaudeGenerating(page);

    if (!generating && currentText === previousText) {
      if (!stableSince) stableSince = Date.now();

      if (Date.now() - stableSince >= 12000) {
        return currentText;
      }
    } else {
      stableSince = 0;
    }

    previousText = currentText;
  }

  throw new Error("Claude render response timed out.");
}

// Filename helper
function safeBaseName(value) {
  return String(value || "explainer")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70) || "explainer";
}

// Extract MP4 URL
function extractMp4Url(text) {
  const urls = text.match(/https?:\/\/[^\s<>"')]+/g) || [];

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
      "GET /health",
      "POST /run",
      "POST /render",
      "POST /setup-login",
      "POST /stop-session"
    ]
  });
});

// ================================================
// STAGE 1: GENERATE SCRIPT
// ================================================

app.post("/run", authenticate, async (req, res) => {
  let session;

  try {
    const title = String(req.body.title || "").trim();

    if (!title) {
      return res.status(400).json({
        success: false,
        message: "Topic title is required."
      });
    }

    console.log("Starting script generation:", title);

    session = await createSession();

    const browser = await chromium.connectOverCDP(
      session.connectUrl
    );

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    await openClaudeProject(page);

    const prompt = `
Follow the permanent Project Instructions already configured
in this Claude Project.

VIDEO TOPIC:
${title}

Create a complete one-minute explainer following the exact
six-scene structure in the permanent Project Instructions.

SCRIPT REQUIREMENTS:
- Write the spoken narration in English.
- Aim for approximately 120-180 words.
- Make it natural, accurate, engaging and suitable for voice narration.
- Do not put scene directions, production instructions or headings
  inside the spoken narration.
- Do not include the words "VOICEOVER_START" or "VOICEOVER_END"
  anywhere inside the narration itself.

MANDATORY OUTPUT FORMAT:

VOICEOVER_START
[Write ONLY the complete spoken narration here.]
VOICEOVER_END

After the closing marker, provide:
1. Six scene descriptions.
2. Visual direction for each scene.
3. On-screen text for each scene.
4. A short social media caption.

IMPORTANT:
- The two markers must each appear exactly once in your answer.
- Do not repeat the markers in explanations or code blocks.
- Do not create HTML, CSS, JavaScript or animation yet.
- Do not render a video in this stage.
- Do not ask for approval or ask questions.
- Finish the complete script before responding.
`;

    await submitPrompt(page, prompt);

    console.log("Waiting for Claude's new narration...");

    const result = await waitForMarkedScript(page);

    console.log(
      `Script ready. Word count: ${result.wordCount}`
    );

    return res.json({
      success: true,
      status: "SCRIPT_READY",
      topic: title,
      projectUrl: CLAUDE_PROJECT_URL,
      voiceover: result.voiceover,
      wordCount: result.wordCount,
      scriptResponse: result.pageText
    });

  } catch (error) {
    console.error("Script generation error:", error);

    return res.status(500).json({
      success: false,
      status: "SCRIPT_FAILED",
      message: error.message,
      sessionId: session?.id || null
    });

  } finally {
    if (session?.id) {
      await releaseSession(session.id);
    }
  }
});

// ================================================
// STAGE 2: UPLOAD WAV + RENDER VIDEO
// ================================================

app.post("/render", authenticate, async (req, res) => {
  let session;

  try {
    const title = String(req.body.title || "").trim();
    const voiceover = String(req.body.voiceover || "").trim();
    const script = String(req.body.script || "").trim();
    const audioBase64 = String(req.body.audioBase64 || "").trim();

    if (!title || !voiceover || !audioBase64) {
      return res.status(400).json({
        success: false,
        message: "title, voiceover and audioBase64 are required."
      });
    }

    if (!/^[A-Za-z0-9+/=\s]+$/.test(audioBase64)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Base64 audio data."
      });
    }

    const audioBuffer = Buffer.from(audioBase64, "base64");

    // Validate WAV
    if (
      audioBuffer.length < 1000 ||
      audioBuffer.subarray(0, 4).toString() !== "RIFF" ||
      audioBuffer.subarray(8, 12).toString() !== "WAVE"
    ) {
      return res.status(400).json({
        success: false,
        message: "The supplied audio is not a valid WAV file."
      });
    }

    // 20 MB maximum
    const maxAudioBytes = 20 * 1024 * 1024;

    if (audioBuffer.length > maxAudioBytes) {
      return res.status(413).json({
        success: false,
        message: "WAV file is larger than the 20 MB limit."
      });
    }

    const baseName = safeBaseName(title);

    const audioFileName = String(
      req.body.audioFileName || `${baseName}-voice.wav`
    );

    console.log(
      `Starting render: ${title}; WAV bytes: ${audioBuffer.length}`
    );

    session = await createSession();

    const browser = await chromium.connectOverCDP(
      session.connectUrl
    );

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    await openClaudeProject(page);

    // Locate Claude file input
    let fileInput = page.locator('input[type="file"]').last();

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

      let clicked = false;

      for (const selector of attachSelectors) {
        const button = page.locator(selector).last();

        try {
          if (
            await button.count() > 0 &&
            await button.isVisible()
          ) {
            await button.click();
            clicked = true;
            break;
          }
        } catch {}
      }

      if (!clicked) {
        throw new Error(
          "Claude attachment button was not found."
        );
      }

      fileInput = page.locator('input[type="file"]').last();

      await fileInput.waitFor({
        state: "attached",
        timeout: 15000
      });
    }

    // Upload WAV
    await fileInput.setInputFiles({
      name: audioFileName,
      mimeType: "audio/wav",
      buffer: audioBuffer
    });

    console.log("WAV attached to Claude.");

    await page.waitForTimeout(8000);

    const baselineText = await getMainText(page);

    const renderPrompt = `
Continue production for this explainer video.

VIDEO TOPIC:
${title}

FINAL VOICEOVER:
${voiceover}

FULL SCRIPT AND SIX-SCENE PLAN:
${script || "Use the six-scene plan from this project conversation."}

A WAV narration file has been attached.

AUDIO REQUIREMENTS:
- Use the exact attached WAV file as narration.
- Do not generate a replacement voice.
- Do not rewrite the spoken words.
- Synchronize visuals and captions to this audio.

PRODUCTION TASK:
1. Follow the permanent Project Instructions.
2. Create the complete six-scene explainer.
3. Build the required HTML, CSS and JavaScript animation.
4. Synchronize scenes with the narration.
5. Add captions and on-screen text.
6. Render/export the final video as MP4.
7. Do not ask for approval or confirmation.
8. Complete the production task.

Return:
- Direct downloadable MP4 URL if available.
- Final social media caption.
- If a downloadable artifact is created instead,
  identify its name and explain how it can be downloaded.
`;

    await submitPrompt(page, renderPrompt);

    console.log("Waiting for Claude video render...");

    const renderResponse = await waitForStableNewResponse(
      page,
      baselineText,
      1800000
    );

    const videoUrl = extractMp4Url(renderResponse);

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
        : "No direct MP4 URL detected. Inspect renderResponse for a downloadable artifact."
    });

  } catch (error) {
    console.error("Video render error:", error);

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

// ================================================
// MANUAL CLAUDE LOGIN
// ================================================

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

// ================================================
// RELEASE MANUAL SESSION
// ================================================

app.post("/stop-session", authenticate, async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      message: "sessionId is required."
    });
  }

  await releaseSession(sessionId);

  return res.json({
    success: true,
    message: "Session release requested."
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Claude Explainer Automation running on port ${PORT}`
  );
});
