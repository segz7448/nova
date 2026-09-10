/**
 * Browser daemon script.
 *
 * This is plain Node.js (no build step) written to the sandbox and run
 * with \`node\`. It keeps ONE headless Chromium instance alive across
 * calls (navigate -> click -> type -> screenshot is a real session, not
 * a fresh browser every time) and exposes it over a tiny localhost HTTP
 * API that the agent drives via \`exec curl\`.
 *
 * Every real browser is bulky, so we lazy-launch on first use and let the
 * agent explicitly /close it back down when done with a session.
 *
 * next-phase.md Phase 2 (architecture-agent.md §4): a spawned sub-agent
 * worker gets "its own browser tab (not a new profile)" — a single
 * Chromium instance now holds a Map of pages keyed by tabId instead of
 * one module-level \`page\`. Every endpoint takes an optional \`tabId\` in
 * its request body; omitting it keeps exactly the old single-tab
 * behavior (tabId defaults to "main"), so this is additive, not a
 * breaking change to the existing single-tab callers (the top-level
 * agent's own browser_navigate/click/etc, which never pass tabId).
 * Multiple tabs share the one userDataDir profile (same cookies/session
 * storage, same as opening two tabs in one real browser window) — that's
 * intentional per §4: workers are threads sharing the parent's session,
 * not new isolated identities.
 */
export const BROWSER_DAEMON_SCRIPT = `
const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const puppeteer = require("puppeteer-core");

const PORT = 39222;
// This is the docker.ts createNamedSandbox bind mount target
// (browserDir on the host, mounted to /home/agent/.browser-profile in
// the container) -- the ONLY thing in this daemon that needs to survive
// container recreation. Chromium's --user-data-dir keeps cookies/
// localStorage/session here so a killed and recreated sandbox for the
// same agent resumes its browser session instead of starting logged
// out every time (next-phase.md Phase 0 follow-up: "point the daemon
// at /home/agent/.browser-profile").
const PROFILE_DIR = "/home/agent/.browser-profile";
const DOWNLOAD_DIR = path.join(PROFILE_DIR, "downloads");
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
const VISION_BASE_URL = (process.env.VISION_MODEL_BASE_URL || "").replace(/\\/$/, "");
const VISION_API_KEY = process.env.VISION_MODEL_API_KEY || "";

function findChromePath() {
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("No chromium/chrome binary found on this sandbox.");
}

let browser = null;
// tabId -> Page. "main" is the default tab every pre-Phase-2 call uses
// implicitly. Cleared whenever the whole browser is relaunched (crash
// recovery below), same as the old single \`page\` variable was.
const pages = new Map();

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browser) {
    try { await browser.close(); } catch {}
  }
  pages.clear();
  browser = await puppeteer.launch({
    executablePath: findChromePath(),
    headless: true,
    userDataDir: PROFILE_DIR,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  return browser;
}

async function ensurePage(tabId) {
  const id = tabId || "main";
  const b = await ensureBrowser();
  let p = pages.get(id);
  if (p && !p.isClosed()) return p;
  p = await b.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  pages.set(id, p);
  return p;
}

function closeTab(tabId) {
  const id = tabId || "main";
  const p = pages.get(id);
  pages.delete(id);
  if (p && !p.isClosed()) {
    return p.close().catch(() => {});
  }
  return Promise.resolve();
}

function listTabs() {
  return [...pages.keys()].filter((id) => {
    const p = pages.get(id);
    return p && !p.isClosed();
  });
}

async function inspectScreenshot(page, prompt) {
  if (!VISION_BASE_URL || !VISION_API_KEY) throw new Error("vision service is not configured");
  const image = await page.screenshot({ encoding: "base64" });
  const resp = await fetch(VISION_BASE_URL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + VISION_API_KEY },
    body: JSON.stringify({ model: "smolvlm2-500m", max_tokens: 500, messages: [{ role: "user", content: [
      { type: "text", text: prompt || "Describe visible UI elements, likely buttons, and any error or loading state. Do not suggest actions." },
      { type: "image_url", image_url: { url: "data:image/png;base64," + image } },
    ] }] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error("vision service returned HTTP " + resp.status);
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      if (!chunks) return resolve({});
      try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

async function safeDownloadUrl(raw) {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("download URL must be an unauthenticated http(s) URL");
  const blocked = /^(127\\.|0\\.|10\\.|192\\.168\\.|169\\.254\\.|172\\.(1[6-9]|2\\d|3[01])\\.|::1$|fc|fd|fe80)/i;
  if (url.hostname === "localhost" || blocked.test(url.hostname)) throw new Error("download URL targets a private address");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => blocked.test(address))) throw new Error("download URL targets a private address");
  return url;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { ok: true, hasSession: !!(browser && browser.isConnected()) });
    }

    const body = await readBody(req);
    const tabId = body.tabId || "main";

    if (req.method === "POST" && req.url === "/navigate") {
      const p = await ensurePage(tabId);
      const resp = await p.goto(body.url, { waitUntil: "domcontentloaded", timeout: body.timeoutMs || 30000 });
      return send(res, 200, {
        ok: true,
        tabId,
        status: resp ? resp.status() : null,
        url: p.url(),
        title: await p.title(),
      });
    }

    if (req.method === "POST" && req.url === "/text") {
      const p = await ensurePage(tabId);
      const selector = body.selector || "body";
      const text = await p.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText : null;
      }, selector);
      return send(res, 200, { ok: text !== null, tabId, text });
    }

    if (req.method === "POST" && req.url === "/click") {
      const p = await ensurePage(tabId);
      await p.click(body.selector, { delay: 50 });
      return send(res, 200, { ok: true, tabId });
    }

    if (req.method === "POST" && req.url === "/type") {
      const p = await ensurePage(tabId);
      await p.type(body.selector, body.text, { delay: 20 });
      return send(res, 200, { ok: true, tabId });
    }

    if (req.method === "POST" && req.url === "/screenshot") {
      const p = await ensurePage(tabId);
      const name = (body.name || "screenshot").replace(/[^a-z0-9_-]/gi, "_") + ".png";
      const filePath = path.join(DOWNLOAD_DIR, name);
      await p.screenshot({ path: filePath, fullPage: !!body.fullPage });
      const stat = fs.statSync(filePath);
      return send(res, 200, { ok: true, tabId, path: filePath, bytes: stat.size });
    }

    if (req.method === "POST" && req.url === "/inspect") {
      const p = await ensurePage(tabId);
      const observation = await inspectScreenshot(p, body.prompt);
      return send(res, 200, { ok: true, tabId, capturedAt: Date.now(), observation });
    }

    if (req.method === "POST" && req.url === "/click-coordinate") {
      const p = await ensurePage(tabId);
      const x = Number(body.x), y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= 1280 || y >= 800) throw new Error("invalid viewport coordinates");
      await p.mouse.click(x, y);
      return send(res, 200, { ok: true, tabId, x, y });
    }

    if (req.method === "POST" && req.url === "/download") {
      const safeUrl = await safeDownloadUrl(body.url);
      const resp = await fetch(safeUrl, { redirect: "error", signal: AbortSignal.timeout(30000) });
      if (!resp.ok) return send(res, 200, { ok: false, error: "HTTP " + resp.status });
      const bytes = Number(resp.headers.get("content-length") || 0);
      if (bytes > 10485760) return send(res, 200, { ok: false, error: "download exceeds 10 MiB" });
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 10485760) return send(res, 200, { ok: false, error: "download exceeds 10 MiB" });
      const name = (body.filename || path.basename(new URL(body.url).pathname) || "download.bin")
        .replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(DOWNLOAD_DIR, name);
      fs.writeFileSync(filePath, buf);
      return send(res, 200, { ok: true, path: filePath, bytes: buf.length });
    }

    if (req.method === "POST" && req.url === "/eval") {
      const p = await ensurePage(tabId);
      const fn = new Function("return (" + body.code + ")");
      const result = await p.evaluate(fn());
      return send(res, 200, { ok: true, tabId, result });
    }

    // Closes one tab (default "main") without tearing down the shared
    // browser instance or any other tab -- used both by the existing
    // single-tab browser_close (tabId omitted) and by Phase 2's worker
    // cleanup (tabId = wkr_xx) when a sub-agent's task ends.
    if (req.method === "POST" && req.url === "/close") {
      await closeTab(tabId);
      return send(res, 200, { ok: true, tabId, closed: true });
    }

    // Phase 2: introspection so the backend can confirm a worker's tab
    // is actually gone after killing it, and so nothing needs its own
    // side-channel bookkeeping of which tabIds are live.
    if (req.method === "GET" && req.url === "/tabs") {
      return send(res, 200, { ok: true, tabs: listTabs() });
    }

    // Full teardown of the whole browser instance (every tab, every
    // agent) -- kept as a separate endpoint from the per-tab /close
    // above so a top-level agent can still fully reset its session
    // without a name collision with the new per-tab semantics.
    if (req.method === "POST" && req.url === "/shutdown") {
      if (browser) { try { await browser.close(); } catch {} }
      browser = null;
      pages.clear();
      return send(res, 200, { ok: true, closed: true });
    }

    send(res, 404, { ok: false, error: "unknown endpoint" });
  } catch (err) {
    send(res, 200, { ok: false, error: String(err && err.message || err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("browser-daemon listening on " + PORT);
});
`;
