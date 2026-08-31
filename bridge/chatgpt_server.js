const http = require("http");
const path = require("path");
const { chromium } = require("patchright");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const os = require("os");
const https = require("https");

const EMAIL = process.env.EMAIL || "shawonhawladar@yahoo.com";
const YAHOO_APP_PASSWORD = process.env.YAHOO_APP_PASSWORD || "uihygpqoqyumiglw";
const PORT = process.env.PORT || 3000;
const LOGIN_URL = "https://chatgpt.com/auth/login";
const USER_DATA_DIR = path.join(__dirname, "chrome-profile");

let pageInstance = null;
let isReady = false;
let initError = null;
let readyWaiters = [];
// Event-driven readiness (same philosophy as chatgpt-login.js: every wait
// is event-driven, nothing fails fast on a timer). Requests that arrive
// while the browser is still logging in simply WAIT for the composer to
// appear instead of getting a 503.
function whenReady() {
  if (isReady) return Promise.resolve();
  if (initError) return Promise.reject(initError);
  return new Promise((resolve, reject) => readyWaiters.push({ resolve, reject }));
}

// Request queue to process prompts sequentially without browser conflicts
const queue = [];
let processing = false;

function extractOtp(parsed) {
  const body = `${parsed.subject ?? ""}\n${parsed.text ?? ""}\n${parsed.html ?? ""}`;
  const match = body.match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

async function waitForOtp(sinceDate) {
  const client = new ImapFlow({
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    auth: { user: EMAIL, pass: YAHOO_APP_PASSWORD },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const scanForOtp = async () => {
      const uids = await client.search({ since: sinceDate, from: "openai.com" });
      if (!uids || uids.length === 0) return null;
      for (const uid of uids.sort((a, b) => b - a)) {
        const { content } = await client.download(uid);
        const parsed = await simpleParser(content);
        if (parsed.date && parsed.date < sinceDate) continue;
        const otp = extractOtp(parsed);
        if (otp) return otp;
      }
      return null;
    };
    let otp = await scanForOtp();
    if (otp) return otp;
    console.log("[IMAP] Waiting for OTP email push...");
    otp = await new Promise((resolve, reject) => {
      client.on("exists", async () => {
        try {
          const found = await scanForOtp();
          if (found) resolve(found);
        } catch (err) {
          reject(err);
        }
      });
      client.on("error", reject);
      client.on("close", () => reject(new Error("IMAP connection closed.")));
    });
    return otp;
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

async function initBrowser() {
  // ── Camoufox FIRST: the anti-detect Firefox ALREADY running in this
  // repo (started in the 'Start Camoufox' step, ws://127.0.0.1:9222).
  // It spoofs fingerprints at the C++ level, so ChatGPT cannot detect
  // automation at all - no more bot-flagged logins. Patchright Chrome
  // stays only as a fallback (e.g. remote mode has no Camoufox).
  let context = null;
  let usingCamoufox = false;
  const camoufoxWs = (process.env.CAMOUFOX_WS_URL || "").trim();
  if (camoufoxWs) {
    let firefox = null;
    try {
      firefox = require("playwright-core").firefox;
    } catch (e) {
      console.log("[Browser] playwright-core missing - cannot use Camoufox: " + e.message);
    }
    if (firefox) console.log("[Browser] Connecting to Camoufox anti-detect server: " + camoufoxWs);
    // The Camoufox server may still be BOOTING on a fresh runner (browser
    // fetch + engine warm-up) - retry for up to 2 minutes instead of
    // giving up on the first ECONNREFUSED.
    for (let tries = 0; firefox && !context && tries < 24; tries++) {
      try {
        const browser = await firefox.connect(camoufoxWs, { timeout: 10000 });
        context = browser.contexts()[0] || (await browser.newContext({ viewport: null }));
        usingCamoufox = true;
        console.log("[Browser] ✅ Camoufox connected - fingerprint-spoofed Firefox in use.");
      } catch (err) {
        const msg = String(err.message || err).split("\n")[0];
        if (tries === 23) {
          console.log("[Browser] Camoufox not reachable after 2 min (" + msg + ") - falling back to Patchright Chrome.");
        } else {
          if (tries % 6 === 0) console.log("[Browser] Camoufox not up yet (" + msg + ") - retrying up to 2 min...");
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  }
  if (!context) {
    console.log("[Browser] Launching Patchright Chrome...");
    // EXACT launch method from the proven chatgpt-login.js: real Chrome,
    // persistent profile, viewport null (real window size) and NO custom
    // flags - the clean launch Patchright needs to stay undetected.
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: "chrome",
      headless: false,
      viewport: null,
    });
  }
  context.setDefaultTimeout(0);
  context.setDefaultNavigationTimeout(0);
  // Camoufox context is shared/persistent - always take a dedicated fresh
  // tab there; for the local Chrome profile reuse the first tab as before.
  const page = usingCamoufox
    ? await context.newPage()
    : context.pages()[0] || (await context.newPage());
  pageInstance = page;
  console.log("[Browser] Opening ChatGPT login page...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  const composer = page.locator("#prompt-textarea");
  const emailInput = page.locator('input[type="email"][name="email"]');
  await Promise.race([
    emailInput.waitFor({ state: "visible" }),
    composer.waitFor({ state: "visible" }),
  ]);
  const alreadyLoggedIn = await composer.isVisible().catch(() => false);
  if (!alreadyLoggedIn) {
    console.log("[Auth] Entering email: " + EMAIL);
    await emailInput.click();
    await emailInput.pressSequentially(EMAIL, { delay: 50 });
    const sinceDate = new Date(Date.now() - 30_000);
    await page.locator('form button[type="submit"]').click();
    console.log("[Auth] Waiting for OTP input...");
    // accept the classic name=code field OR the one-time-code variant
    const codeInput = page
      .locator('input[name="code"], input[autocomplete="one-time-code"]')
      .first();
    // VISIBLE wait: instead of blocking blindly, poll every 5s and
    //  - auto-click the Cloudflare "Verify you are human" challenge that
    //    datacenter IPs (GitHub runners) often get served
    //  - every 15s log the current URL + page text so the run log shows
    //    exactly which screen the login is stuck on
    let waited = 0;
    while (
      !(await codeInput.isVisible().catch(() => false)) &&
      !(await composer.isVisible().catch(() => false))
    ) {
      const cf = page
        .frameLocator('iframe[src*="challenges.cloudflare.com"]')
        .locator('input[type="checkbox"], label')
        .first();
      if (await cf.isVisible().catch(() => false)) {
        console.log("[Auth] Cloudflare 'Verify you are human' detected - clicking it...");
        await cf.click().catch(() => {});
      }
      // Accounts WITH a password get the PASSWORD page instead of the code
      // page. Click "Log in with a one-time code" to force the OTP flow
      // (exact selector taken from the live page HTML).
      const otpBtn = page
        .locator('button[name="intent"][value="passwordless_login_send_otp"]')
        .first();
      if (await otpBtn.isVisible().catch(() => false)) {
        console.log("[Auth] Password page detected - clicking 'Log in with a one-time code'...");
        await otpBtn.click().catch(() => {});
      }
      if (waited > 0 && waited % 15 === 0) {
        const bodyText = (await page.locator("body").innerText().catch(() => ""))
          .replace(/\s+/g, " ")
          .slice(0, 200);
        console.log(`[Auth] still waiting (${waited}s) url=${page.url()}`);
        console.log(`[Auth] page says: ${bodyText}`);
        await page.screenshot({ path: `/tmp/chatgpt_login_${waited}s.png` }).catch(() => {});
      }
      await page.waitForTimeout(5000);
      waited += 5;
    }
    if (await composer.isVisible().catch(() => false)) {
      console.log("[Auth] Session active - no OTP needed.");
    } else {
      const otp = await waitForOtp(sinceDate);
      console.log("[Auth] Submitting OTP: " + otp);
      await codeInput.click();
      await codeInput.pressSequentially(otp, { delay: 80 });
      await page.locator('button[name="intent"][value="validate"]').click();
      await composer.waitFor({ state: "visible" });
    }
  }
  console.log("[Browser] ✅ ChatGPT is logged in and ready!");
  isReady = true;
  for (const w of readyWaiters) w.resolve();
  readyWaiters = [];
}

// ── Vision support ───────────────────────────────────────────
// The ChatGPT WEBSITE supports images natively, so we accept the
// standard OpenAI vision format (content parts with image_url:
// data:base64 or http URLs), save them to temp files, and attach
// them to the composer like a human would. To any client this
// looks like a normal vision model.

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((p) => p && p.type === "text")
      .map((p) => p.text || "")
      .join("\n");
  return "";
}

const MAX_PROMPT_CHARS = parseInt(process.env.MAX_PROMPT_CHARS || "240000", 10);
const MAX_TYPE_CHARS = parseInt(process.env.MAX_TYPE_CHARS || "24000", 10);
const MAX_THREAD_TURNS = parseInt(process.env.MAX_THREAD_TURNS || "40", 10);
const TOOL_RESULT_MAX = parseInt(process.env.TOOL_RESULT_MAX || "6000", 10);
const FULL_HEADER =
  "You are the ASSISTANT in the conversation below. The SYSTEM section holds your standing instructions, skills and memory - follow them exactly. Continue the conversation: reply ONLY with the assistant next message, with no role labels.";
const DELTA_HEADER =
  "(conversation continues - new messages below; keep following the SYSTEM instructions from before and reply ONLY with the assistant next message, no role labels)";

// Middle-clip huge text, keeping the head (usually the important part)
// and the tail (usually totals/conclusions). Deterministic, so delta
// matching stays consistent across requests.
function clipMiddle(text, max) {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  return (
    text.slice(0, head) +
    "\n[... " + (text.length - max) + " chars omitted ...]\n" +
    text.slice(text.length - tail)
  );
}

function messageToBlock(m) {
  if (!m || !m.role) return "";
  let text = contentToText(m.content);
  if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
    const calls = m.tool_calls
      .map((t) => "[tool call] " + ((t.function && t.function.name) || "?") + "(" + ((t.function && t.function.arguments) || "") + ")")
      .join("\n");
    text = text ? text + "\n" + calls : calls;
  }
  if (!text) return "";
  // Tool outputs are the biggest space hogs in agent loops - clip them so
  // full sends stay small enough to type in one or two messages.
  if (m.role === "tool" && text.length > TOOL_RESULT_MAX) {
    text = clipMiddle(text, TOOL_RESULT_MAX);
  }
  const label =
    m.role === "system" ? "SYSTEM" :
    m.role === "assistant" ? "ASSISTANT" :
    m.role === "tool" ? "TOOL RESULT" + (m.name ? " (" + m.name + ")" : "") :
    "USER";
  return "### " + label + "\n" + text;
}

// ── SMART CONTEXT CACHE ──
// Remembers which serialized blocks the CURRENT ChatGPT web thread has
// already seen, so a continuing agent conversation sends only the DELTA
// (new messages) instead of re-sending the whole history every request.
let webThread = { blocks: [], turns: 0 };
function resetWebThread() {
  webThread = { blocks: [], turns: 0 };
}
function deltaSince(blocks) {
  const sent = webThread.blocks;
  if (!sent.length || sent.length >= blocks.length) return null;
  for (let i = 0; i < sent.length; i++) {
    if (sent[i] !== blocks[i]) return null; // history diverged -> full resend
  }
  return blocks.slice(sent.length);
}

function serializeBlocks(blocks) {
  let out = [FULL_HEADER].concat(blocks).join("\n\n");
  if (out.length > MAX_PROMPT_CHARS) {
    const systemBlocks = blocks.filter((b) => b.indexOf("### SYSTEM") === 0);
    const rest = blocks.filter((b) => b.indexOf("### SYSTEM") !== 0);
    let used = FULL_HEADER.length + systemBlocks.join("\n\n").length + 200;
    const kept = [];
    for (let i = rest.length - 1; i >= 0; i--) {
      if (used + rest[i].length > MAX_PROMPT_CHARS && kept.length > 0) break;
      kept.unshift(rest[i]);
      used += rest[i].length + 2;
    }
    out = [FULL_HEADER].concat(systemBlocks, ["### NOTE\n(older messages were truncated to fit)"], kept).join("\n\n");
  }
  return out;
}

// Split long text into typeable chunks at newline boundaries.
function chunkText(text, size) {
  if (!text || text.length <= size) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

function collectImageUrls(messages) {
  const urls = [];
  for (const m of messages) {
    if (!m || m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p && p.type === "image_url") {
        const u = typeof p.image_url === "string" ? p.image_url : (p.image_url && p.image_url.url);
        if (u) urls.push(u);
      }
    }
  }
  return urls;
}

function fetchUrl(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("http:") ? http : https;
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchUrl(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function materializeImages(urls) {
  const files = [];
  for (const u of urls.slice(0, 4)) { // ChatGPT-safe cap per message
    try {
      let buf, ext = "png";
      if (u.startsWith("data:")) {
        const m = u.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s);
        if (!m) continue;
        ext = m[1].toLowerCase().replace("jpeg", "jpg").split("+")[0];
        buf = Buffer.from(m[2], "base64");
      } else if (/^https?:\/\//.test(u)) {
        buf = await fetchUrl(u);
        const em = u.split("?")[0].match(/\.(png|jpe?g|webp|gif)$/i);
        ext = em ? em[1].toLowerCase().replace("jpeg", "jpg") : "png";
      } else continue;
      const f = path.join(os.tmpdir(), "img-" + Date.now() + "-" + Math.random().toString(36).slice(2) + "." + ext);
      fs.writeFileSync(f, buf);
      files.push(f);
    } catch (e) {
      console.error("[Vision] image load failed:", e.message);
    }
  }
  return files;
}

// Type one message into the current web thread, send it, wait for the
// reply to finish streaming, and return the reply text.
async function sendMessageToWeb(page, text, files) {
  const composer = page.locator("#prompt-textarea");
  const prevAssistantCount = await page
    .locator('[data-message-author-role="assistant"]')
    .count();
  await composer.waitFor({ state: "visible" });
  if (files.length > 0) {
    console.log(`[Upload] Attaching ${files.length} file(s)...`);
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(files);
    // wait for uploads to finish: the send button stays disabled
    // while a file is uploading
    await page.waitForTimeout(1500);
    const sendProbe = page.locator(
      'button[data-testid="send-button"], button[aria-label="Send prompt"], button[data-testid="fruitjuice-send-button"]'
    );
    for (let i = 0; i < 60; i++) {
      const enabled = await sendProbe.isEnabled().catch(() => false);
      if (enabled) break;
      await page.waitForTimeout(1000);
    }
  }
  await composer.click();
  await composer.fill("");
  await page.keyboard.insertText(text || "Describe the attached image(s).");
  await page.waitForTimeout(300);
  const sendBtn = page.locator(
    'button[data-testid="send-button"], button[aria-label="Send prompt"], button[data-testid="fruitjuice-send-button"]'
  );
  if (
    (await sendBtn.isVisible().catch(() => false)) &&
    (await sendBtn.isEnabled().catch(() => false))
  ) {
    await sendBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }
  const stopButton = page.locator('button[data-testid="stop-button"]');
  const newAssistantMessage = page
    .locator('[data-message-author-role="assistant"]')
    .nth(prevAssistantCount);
  await Promise.race([
    stopButton.waitFor({ state: "visible", timeout: 10000 }).catch(() => {}),
    newAssistantMessage.waitFor({ state: "attached", timeout: 10000 }).catch(() => {}),
    page.waitForTimeout(3000),
  ]);
  if (await stopButton.isVisible().catch(() => false)) {
    await stopButton.waitFor({ state: "hidden", timeout: 240000 }).catch(() => {});
  }
  await page.waitForTimeout(1000);
  let reply = "";
  if ((await newAssistantMessage.count()) > 0) {
    reply = await newAssistantMessage.innerText();
  } else {
    reply = await page
      .locator('[data-message-author-role="assistant"]')
      .last()
      .innerText();
  }
  return reply.trim();
}

async function askChatGPT(prompt, imageFiles = [], blocks = null) {
  const page = pageInstance;
  // ── SMART CONTEXT DELIVERY (NO file uploads - ChatGPT free tier caps
  // attachments per day, so long context is CHUNK-TYPED instead) ──
  // 1) DELTA: continuing conversations send only the new messages.
  // 2) FULL: fresh chat + whole context once (tool results pre-clipped).
  // 3) CHUNK: text longer than MAX_TYPE_CHARS goes as numbered parts in
  //    the same thread with a reply-OK protocol - works on any tier.
  let text = prompt;
  let mode = "single";
  if (blocks && blocks.length) {
    const delta = deltaSince(blocks);
    if (delta && delta.length && webThread.turns < MAX_THREAD_TURNS) {
      text = [DELTA_HEADER].concat(delta).join("\n\n");
      mode = "delta";
      console.log(`[Context] Delta mode: ${delta.length} new block(s), ${text.length} chars (thread turn ${webThread.turns + 1}).`);
    } else {
      text = serializeBlocks(blocks);
      mode = "full";
      console.log(`[Context] Full mode: fresh chat, ${blocks.length} block(s), ${text.length} chars.`);
    }
  }
  if (mode !== "delta") {
    // fresh chat so leftover web-thread context never mixes in
    try {
      await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
    } catch (e) {}
    resetWebThread();
  }
  const chunks = chunkText(text || "", MAX_TYPE_CHARS);
  let reply = "";
  if (chunks.length <= 1) {
    reply = await sendMessageToWeb(page, text, imageFiles);
    webThread.turns += 1;
  } else {
    console.log(`[Context] Chunk mode: ${chunks.length} typed parts (${text.length} chars total), no file upload needed.`);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const head = isLast
        ? `[CONTEXT PART ${i + 1}/${chunks.length} - FINAL] The context is now complete. Follow the SYSTEM instructions and reply ONLY with the assistant next message, no role labels.`
        : `[CONTEXT PART ${i + 1}/${chunks.length}] More context is coming. Do NOT act yet - reply with exactly "OK" and nothing else.`;
      reply = await sendMessageToWeb(page, head + "\n\n" + chunks[i], isLast ? imageFiles : []);
      webThread.turns += 1;
    }
  }
  if (blocks && blocks.length) {
    // remember what this web thread has seen -> next request sends only delta
    webThread.blocks = blocks.concat(["### ASSISTANT\n" + reply]);
  }
  return reply;
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  const { prompt, images, blocks, resolve, reject } = queue.shift();
  try {
    const reply = await askChatGPT(prompt, images || [], blocks || null);
    resolve(reply);
  } catch (err) {
    resetWebThread(); // unknown web-thread state after an error -> full resend next time
    reject(err);
  } finally {
    for (const f of images || []) fs.unlink(f, () => {});
    processing = false;
    processQueue();
  }
}

function queuePrompt(prompt, images, blocks) {
  return new Promise((resolve, reject) => {
    queue.push({ prompt, images, blocks, resolve, reject });
    processQueue();
  });
}

// ── HTTP API Server (OpenAI Compatible) ─────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  // Health check
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: isReady ? "ready" : "initializing" }));
  }
  // Models list (OpenAI format)
  if (req.url === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "chatgpt", object: "model", created: Date.now(), owned_by: "openai" },
          { id: "gpt-4o", object: "model", created: Date.now(), owned_by: "openai" },
          { id: "gpt-4o-mini", object: "model", created: Date.now(), owned_by: "openai" }
        ],
      })
    );
  }
  // Chat completions (OpenAI format)
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        if (!isReady) {
          console.log("[API] Login still in progress - holding this request until ChatGPT is ready (event-driven, no fail-fast)...");
          await whenReady();
        }
        const data = JSON.parse(body || "{}");
        const messages = data.messages || [];
        // Forward FULL context as blocks; askChatGPT decides delta vs full
        // and typing vs file-attach (smart long-context delivery).
        let prompt = "";
        let blocks = null;
        if (messages.length > 0) {
          if (messages.length === 1 && messages[0] && messages[0].role === "user") {
            prompt = contentToText(messages[0].content);
          } else {
            blocks = messages.map(messageToBlock).filter(Boolean);
          }
        } else if (data.prompt) {
          prompt = data.prompt;
        }
        // Vision: pull image_url parts (base64 data URLs or http URLs)
        const imageUrls = collectImageUrls(messages);
        const imageFiles = imageUrls.length ? await materializeImages(imageUrls) : [];
        if (!prompt && !(blocks && blocks.length) && imageFiles.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "No prompt provided in request" } }));
        }
        console.log(`[API] Received ${blocks ? blocks.length + " message block(s)" : prompt.length + " chars"}, ${imageFiles.length} image(s).`);
        const reply = await queuePrompt(prompt, imageFiles, blocks);
        const responseJson = {
          id: "chatcmpl-" + Math.random().toString(36).substring(2),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: data.model || "chatgpt",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: reply,
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: Math.ceil(prompt.length / 4),
            completion_tokens: Math.ceil(reply.length / 4),
            total_tokens: Math.ceil((prompt.length + reply.length) / 4),
          },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseJson));
      } catch (err) {
        console.error("[API Error]", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Route not found" } }));
});

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`[Server] Local HTTP server listening on http://0.0.0.0:${PORT}`);
  try {
    await initBrowser();
  } catch (err) {
    console.error("[Browser Init Failed]", err);
    initError = err;
    for (const w of readyWaiters) w.reject(err);
    readyWaiters = [];
  }
});
