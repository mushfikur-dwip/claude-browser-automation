
import express from "express";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const app = express();
app.use(express.json({ limit: "35mb" }));

const PORT = process.env.PORT || 3000;

const {
  BROWSERBASE_API_KEY,
  BROWSERBASE_PROJECT_ID,
  BROWSERBASE_CONTEXT_ID,
  AUTOMATION_API_KEY,
  CLAUDE_PROJECT_URL,
} = process.env;

const required = {
  BROWSERBASE_API_KEY,
  BROWSERBASE_PROJECT_ID,
  BROWSERBASE_CONTEXT_ID,
  AUTOMATION_API_KEY,
  CLAUDE_PROJECT_URL,
};

const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length) {
  throw new Error(
    `Missing environment variables: ${missing.join(", ")}`
  );
}

const FFMPEG_PATH = ffmpegStatic;
const FFPROBE_PATH = ffprobeStatic?.path;

if (!FFMPEG_PATH || !FFPROBE_PATH) {
  throw new Error("FFmpeg/FFprobe binary not found.");
}

const bb = new Browserbase({
  apiKey: BROWSERBASE_API_KEY,
});

// ================================================
// AUTHENTICATION
// ================================================

function authenticate(req, res, next) {
  if (
    req.headers.authorization !==
    `Bearer ${AUTOMATION_API_KEY}`
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  next();
}

// ================================================
// BROWSERBASE SESSION
// ================================================

async function createSession() {
  return bb.sessions.create({
    projectId: BROWSERBASE_PROJECT_ID,
    region: "us-west-2",
    api_timeout: 1200,
    browserSettings: {
      context: {
        id: BROWSERBASE_CONTEXT_ID,
        persist: true,
      },
    },
  });
}

async function releaseSession(sessionId) {
  if (!sessionId) return;

  try {
    await bb.sessions.update(sessionId, {
      status: "REQUEST_RELEASE",
      projectId: BROWSERBASE_PROJECT_ID,
    });
  } catch (error) {
    console.error(
      "Browserbase release error:",
      error.message
    );
  }
}

// ================================================
// CLAUDE BROWSER HELPERS
// ================================================

async function openClaudeProject(page) {
  await page.goto(CLAUDE_PROJECT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  await page.waitForTimeout(7000);

  const currentUrl = page.url();

  if (
    currentUrl.includes("/login") ||
    currentUrl.includes("/oauth")
  ) {
    throw new Error(
      "Claude login required. Run /setup-login."
    );
  }

  if (!currentUrl.includes("/project/")) {
    throw new Error(
      `Claude Project did not open: ${currentUrl}`
    );
  }
}

async function findComposer(page) {
  const selectors = [
    '[contenteditable="true"]',
    'div[role="textbox"]',
    "textarea",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).last();

    try {
      await locator.waitFor({
        state: "visible",
        timeout: 7000,
      });

      return locator;
    } catch {
      // Try next selector.
    }
  }

  throw new Error("Claude message composer not found.");
}

async function submitPrompt(page, prompt) {
  const composer = await findComposer(page);

  await composer.click();
  await composer.fill(prompt);

  const selectors = [
    'button[aria-label*="Send" i]',
    'button[data-testid*="send"]',
    'button[aria-label*="Submit" i]',
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
    } catch {
      // Try next selector.
    }
  }

  if (!submitted) {
    await composer.press("Enter");
  }

  await page.waitForTimeout(2500);
}

async function getMainText(page) {
  const main = page.locator("main").last();

  if (await main.count() > 0) {
    return (await main.innerText()).trim();
  }

  return (await page.locator("body").innerText()).trim();
}

async function isClaudeGenerating(page) {
  const selectors = [
    'button[aria-label*="Stop" i]',
    'button[title*="Stop" i]',
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
    } catch {
      // Continue checking.
    }
  }

  return false;
}

// ================================================
// CLAUDE RESPONSE PARSING
// ================================================

function countOccurrences(text, marker) {
  return text.split(marker).length - 1;
}

function extractBetweenMarkers(text, start, end) {
  const startIndex = text.lastIndexOf(start);
  const endIndex = text.lastIndexOf(end);

  if (
    startIndex === -1 ||
    endIndex === -1 ||
    endIndex <= startIndex
  ) {
    return "";
  }

  return text
    .slice(startIndex + start.length, endIndex)
    .replace(/```[a-z]*\s*/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractVoiceover(text) {
  return extractBetweenMarkers(
    text,
    "VOICEOVER_START",
    "VOICEOVER_END"
  );
}

function extractSubtitleSrt(text) {
  return extractBetweenMarkers(
    text,
    "SUBTITLE_SRT_START",
    "SUBTITLE_SRT_END"
  );
}

function countWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

async function waitForMarkedScript(
  page,
  timeoutMs = 900000
) {
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

    // Prompt has one pair. Claude response adds another.
    if (startCount >= 2 && endCount >= 2) {
      const voiceover = extractVoiceover(
        latestPageText
      );

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
              wordCount: words,
              subtitleSrt: extractSubtitleSrt(
                latestPageText
              ),
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

  const foundVoiceover = extractVoiceover(
    latestPageText
  );

  throw new Error(
    `Claude did not return a complete voiceover. ` +
    `Detected ${countWords(foundVoiceover)} words.`
  );
}

// ================================================
// GENERAL HELPERS
// ================================================

function safeBaseName(value) {
  return String(value || "explainer")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70) || "explainer";
}

function runCommand(
  command,
  args,
  timeout = 600000
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;

      settled = true;
      child.kill("SIGKILL");

      reject(
        new Error("Process timed out.")
      );
    }, timeout);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `Command failed: ${stderr.slice(-4000)}`
          )
        );
      }
    });
  });
}

// ================================================
// AUDIO HELPERS
// ================================================

async function getAudioDuration(filePath) {
  const { stdout } = await runCommand(
    FFPROBE_PATH,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]
  );

  const duration = Number(stdout.trim());

  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error(
      "Unable to detect audio duration."
    );
  }

  return duration;
}

// ================================================
// IMAGE DOWNLOAD
// ================================================

async function downloadSceneImage(
  url,
  destination
) {
  const parsed = new URL(url);

  if (parsed.protocol !== "https:") {
    throw new Error(
      "Only HTTPS image URLs are allowed."
    );
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });

  if (!response.ok) {
    throw new Error(
      `Image download failed: ${response.status}`
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  if (!contentType.startsWith("image/")) {
    throw new Error(
      "Scene URL did not return an image."
    );
  }

  const declaredLength = Number(
    response.headers.get("content-length") || 0
  );

  const maxSize = 15 * 1024 * 1024;

  if (declaredLength > maxSize) {
    throw new Error(
      "Scene image exceeds 15 MB."
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (buffer.length > maxSize) {
    throw new Error(
      "Scene image exceeds 15 MB."
    );
  }

  await fs.writeFile(destination, buffer);
}

// ================================================
// SRT VALIDATION
// ================================================

function validateSrt(srt) {
  if (
    typeof srt !== "string" ||
    !srt.trim()
  ) {
    throw new Error(
      "Claude SRT subtitle is missing."
    );
  }

  const blocks = srt
    .trim()
    .replace(/\r/g, "")
    .split(/\n\s*\n/);

  const timePattern =
    /^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})$/;

  const toSeconds = (timestamp) => {
    const match = timestamp.match(
      /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/
    );

    if (!match) return NaN;

    return (
      Number(match[1]) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3]) +
      Number(match[4]) / 1000
    );
  };

  let previousEnd = 0;

  for (const block of blocks) {
    const lines = block.trim().split("\n");

    if (lines.length < 3) {
      throw new Error(
        "Invalid SRT subtitle block."
      );
    }

    const timeMatch = lines[1].match(
      timePattern
    );

    if (!timeMatch) {
      throw new Error(
        `Invalid SRT timestamp: ${lines[1]}`
      );
    }

    const start = toSeconds(timeMatch[1]);
    const end = toSeconds(timeMatch[2]);

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      start < previousEnd
    ) {
      throw new Error(
        "Invalid or overlapping SRT timestamps."
      );
    }

    previousEnd = end;
  }

  return blocks.length;
}

// ================================================
// SCENE VIDEO GENERATION
// ================================================

async function renderScene(
  imagePath,
  outputPath,
  duration
) {
  const frames = Math.max(
    1,
    Math.ceil(duration * 30)
  );

  const filter = [
    "scale=1080:1920:force_original_aspect_ratio=increase",
    "crop=1080:1920",
    "zoompan=z='min(zoom+0.0004,1.08)':d=1:s=1080x1920:fps=30",
    "setsar=1",
    "format=yuv420p",
  ].join(",");

  await runCommand(
    FFMPEG_PATH,
    [
      "-y",
      "-loop",
      "1",
      "-framerate",
      "30",
      "-i",
      imagePath,
      "-t",
      duration.toFixed(3),
      "-vf",
      filter,
      "-frames:v",
      String(frames),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      outputPath,
    ],
    300000
  );
}

// ================================================
// SUBTITLE BURNING
// ================================================

async function burnSubtitles(
  inputVideo,
  subtitlePath,
  outputVideo
) {
  const escapedPath = subtitlePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");

  const subtitleFilter =
    `subtitles='${escapedPath}':` +
    "force_style='FontName=DejaVu Sans," +
    "FontSize=20," +
    "Bold=1," +
    "PrimaryColour=&H00FFFFFF," +
    "OutlineColour=&H00000000," +
    "BorderStyle=1," +
    "Outline=3," +
    "Shadow=1," +
    "Alignment=2," +
    "MarginV=230'";

  await runCommand(
    FFMPEG_PATH,
    [
      "-y",
      "-i",
      inputVideo,
      "-vf",
      subtitleFilter,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      "-an",
      outputVideo,
    ],
    600000
  );
}

// ================================================
// HEALTH CHECK
// ================================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "Ant Digitals Explainer Automation",
    status: "online",
    endpoints: [
      "GET /health",
      "POST /run",
      "POST /render",
      "POST /setup-login",
      "POST /stop-session",
    ],
  });
});

// ================================================
// STAGE 1: CLAUDE SCRIPT GENERATION
// ================================================

app.post("/run", authenticate, async (req, res) => {
  let session;

  try {
    const title = String(
      req.body.title || ""
    ).trim();

    if (!title) {
      return res.status(400).json({
        success: false,
        message: "Topic title is required.",
      });
    }

    console.log(
      "Starting Claude script generation:",
      title
    );

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
already configured in this Claude Project.

VIDEO TOPIC:
${title}

Create a complete one-minute explainer.

SCRIPT REQUIREMENTS:
- Spoken narration must be in English.
- Aim for approximately 120-180 words.
- Make it natural, accurate and engaging.
- Follow the exact six-scene structure.
- Do not include directions inside narration.
- Do not ask questions or request approval.

MANDATORY OUTPUT FORMAT:

VOICEOVER_START
Write ONLY the complete spoken narration here.
VOICEOVER_END

After the narration, provide a six-scene production plan.

For each scene include:
1. Scene number.
2. Visual description.
3. Image generation prompt.
4. Suggested duration weight.
5. On-screen text.

SUBTITLE REQUIREMENTS:

Create an SRT subtitle file for the exact narration.

SUBTITLE_SRT_START
1
00:00:00,000 --> 00:00:03,000
Example subtitle

SUBTITLE_SRT_END

SRT RULES:
- Use valid SRT format.
- Use sequential subtitle numbers.
- Use timestamps in HH:MM:SS,mmm format.
- Keep subtitles short and readable.
- Cover the complete narration.
- Use approximate timing based on natural speech.
- Do not rewrite the narration.
- Do not put markdown fences around the SRT.
- Do not include the example subtitle literally.

IMPORTANT:
- Each marker must appear exactly once in your answer.
- Do not repeat markers in explanations.
- Do not create HTML, CSS or JavaScript.
- Do not render a video in this stage.
- Finish the complete response.
`;

    await submitPrompt(page, prompt);

    console.log(
      "Waiting for Claude script response..."
    );

    const result = await waitForMarkedScript(page);

    console.log(
      `Script ready. Words: ${result.wordCount}`
    );

    return res.json({
      success: true,
      status: "SCRIPT_READY",
      topic: title,
      projectUrl: CLAUDE_PROJECT_URL,

      voiceover: result.voiceover,
      wordCount: result.wordCount,

      subtitleSrt: result.subtitleSrt,

      // Contains the six-scene plan and
      // other Claude-generated production details.
      scriptResponse: result.pageText,

      subtitleAvailable: Boolean(
        result.subtitleSrt
      ),
    });

  } catch (error) {
    console.error(
      "Script generation error:",
      error
    );

    return res.status(500).json({
      success: false,
      status: "SCRIPT_FAILED",
      message: error.message,
      sessionId: session?.id || null,
    });

  } finally {
    if (session?.id) {
      await releaseSession(session.id);
    }
  }
});

// ================================================
// STAGE 2: FFMPEG VIDEO RENDERING
// ================================================

app.post("/render", authenticate, async (req, res) => {
  let workDir;

  try {
    const {
      title,
      audioBase64,
      subtitleSrt,
      scenes,
    } = req.body;

    if (
      !title ||
      !audioBase64 ||
      !subtitleSrt ||
      !Array.isArray(scenes)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "title, audioBase64, subtitleSrt and scenes are required.",
      });
    }

    if (scenes.length !== 6) {
      return res.status(400).json({
        success: false,
        message:
          "Exactly 6 scene images are required.",
      });
    }

    if (
      typeof audioBase64 !== "string" ||
      !/^[A-Za-z0-9+/=\s]+$/.test(audioBase64)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid audioBase64.",
      });
    }

    // Decode Gemini WAV.
    const audioBuffer = Buffer.from(
      audioBase64,
      "base64"
    );

    const maxAudioSize = 20 * 1024 * 1024;

    if (
      audioBuffer.length < 1000 ||
      audioBuffer.length > maxAudioSize ||
      audioBuffer.subarray(0, 4).toString() !== "RIFF" ||
      audioBuffer.subarray(8, 12).toString() !== "WAVE"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid WAV file or file exceeds 20 MB.",
      });
    }

    // Validate Claude subtitles.
    const subtitleCount = validateSrt(
      subtitleSrt
    );

    // Validate six scene image URLs.
    for (const scene of scenes) {
      if (!scene?.imageUrl) {
        return res.status(400).json({
          success: false,
          message:
            "Every scene needs an imageUrl.",
        });
      }

      try {
        const parsed = new URL(scene.imageUrl);

        if (parsed.protocol !== "https:") {
          throw new Error("HTTPS required.");
        }
      } catch {
        return res.status(400).json({
          success: false,
          message:
            "Every scene must have a valid HTTPS imageUrl.",
        });
      }
    }

    console.log(
      "Starting FFmpeg render:",
      title
    );

    workDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ant-video-")
    );

    // Save original Gemini WAV.
    const audioPath = path.join(
      workDir,
      "voiceover.wav"
    );

    await fs.writeFile(
      audioPath,
      audioBuffer
    );

    // Audio is the master timeline.
    const audioDuration = await getAudioDuration(
      audioPath
    );

    console.log(
      "Audio duration:",
      audioDuration
    );

    // Save Claude SRT.
    const subtitlePath = path.join(
      workDir,
      "subtitles.srt"
    );

    await fs.writeFile(
      subtitlePath,
      subtitleSrt,
      "utf8"
    );

    // Allocate scene durations by weights.
    const weights = scenes.map((scene) => {
      const value = Number(scene.duration);

      return (
        Number.isFinite(value) && value > 0
      )
        ? value
        : 1;
    });

    const totalWeight = weights.reduce(
      (sum, value) => sum + value,
      0
    );

    const durations = weights.map(
      (value) =>
        (audioDuration * value) / totalWeight
    );

    const clips = [];

    // Download and render all six scenes.
    for (let i = 0; i < scenes.length; i++) {
      const imagePath = path.join(
        workDir,
        `scene-${i + 1}.jpg`
      );

      const clipPath = path.join(
        workDir,
        `scene-${i + 1}.mp4`
      );

      console.log(
        `Processing scene ${i + 1}/6`
      );

      await downloadSceneImage(
        scenes[i].imageUrl,
        imagePath
      );

      await renderScene(
        imagePath,
        clipPath,
        durations[i]
      );

      clips.push(clipPath);
    }

    // Create FFmpeg concat list.
    const concatPath = path.join(
      workDir,
      "concat.txt"
    );

    const concatContent = clips
      .map((file) => `file '${file}'`)
      .join("\n");

    await fs.writeFile(
      concatPath,
      concatContent,
      "utf8"
    );

    const joinedVideo = path.join(
      workDir,
      "joined.mp4"
    );

    // Join six scene clips.
    await runCommand(
      FFMPEG_PATH,
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatPath,
        "-c",
        "copy",
        joinedVideo,
      ],
      300000
    );

    // Burn Claude subtitles.
    const subtitledVideo = path.join(
      workDir,
      "subtitled.mp4"
    );

    await burnSubtitles(
      joinedVideo,
      subtitlePath,
      subtitledVideo
    );

    // Add original Gemini voiceover.
    const outputPath = path.join(
      workDir,
      "final-video.mp4"
    );

    console.log(
      "Adding original Gemini voiceover..."
    );

    await runCommand(
      FFMPEG_PATH,
      [
        "-y",
        "-i",
        subtitledVideo,
        "-i",
        audioPath,

        "-map",
        "0:v:0",
        "-map",
        "1:a:0",

        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",

        "-t",
        audioDuration.toFixed(3),
        "-shortest",
        "-movflags",
        "+faststart",

        outputPath,
      ],
      600000
    );

    const stat = await fs.stat(outputPath);

    if (stat.size < 10000) {
      throw new Error(
        "Final MP4 file is unexpectedly small."
      );
    }

    const filename =
      `${safeBaseName(title)}.mp4`;

    console.log(
      "Video render completed:",
      filename
    );

    // Return MP4 binary to n8n.
    res.setHeader(
      "Content-Type",
      "video/mp4"
    );

    res.setHeader(
      "X-Video-Duration",
      audioDuration.toFixed(3)
    );

    res.setHeader(
      "X-Subtitle-Count",
      String(subtitleCount)
    );

    res.download(
      outputPath,
      filename,
      async (error) => {
        if (error) {
          console.error(
            "Video response error:",
            error.message
          );
        }

        try {
          await fs.rm(workDir, {
            recursive: true,
            force: true,
          });
        } catch {
          // Ignore cleanup errors.
        }
      }
    );

  } catch (error) {
    console.error(
      "FFmpeg render error:",
      error
    );

    if (workDir) {
      try {
        await fs.rm(workDir, {
          recursive: true,
          force: true,
        });
      } catch {
        // Ignore cleanup errors.
      }
    }

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        status: "RENDER_FAILED",
        message: error.message,
      });
    }
  }
});

// ================================================
// MANUAL CLAUDE LOGIN
// ================================================

app.post(
  "/setup-login",
  authenticate,
  async (req, res) => {
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
        timeout: 90000,
      });

      return res.json({
        success: true,
        sessionId: session.id,
        sessionInspector:
          `https://browserbase.com/sessions/${session.id}`,
        message:
          "Complete Claude login manually.",
      });

    } catch (error) {
      if (session?.id) {
        await releaseSession(session.id);
      }

      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// ================================================
// RELEASE MANUAL SESSION
// ================================================

app.post(
  "/stop-session",
  authenticate,
  async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "sessionId is required.",
      });
    }

    await releaseSession(sessionId);

    return res.json({
      success: true,
      message: "Session release requested.",
    });
  }
);

// ================================================
// START SERVER
// ================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Ant Digitals Explainer Automation running on port ${PORT}`
  );
});
