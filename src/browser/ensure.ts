/**
 * Lazily provisions and starts the browser daemon on whatever sandbox is
 * calling it. This means EXISTING agents (parents that were already
 * running before browser support was added) get it on first use too --
 * not just newly spawned children that had it baked in at provisioning
 * time in spawn.ts.
 */
import type { BackendClient } from "../types.js";
import { BROWSER_DAEMON_SCRIPT } from "./daemon-script.js";

// Where the daemon's own code + node_modules live. This is deliberately
// NOT the persistent browser-profile mount -- it's disposable install
// scaffolding, fine to live in /workspace (the office/fs bind mount,
// writable and per-agent) and fine to be rebuilt on every fresh
// container. The daemon's actual persistent state (cookies, session,
// downloads) lives under /home/agent/.browser-profile, the separate
// bind mount docker.ts sets up for exactly this -- see daemon-script.ts.
// Previously this pointed at /root/automaton/browser, which can't work
// against the real sandbox profile: containers run as a fixed non-root
// UID (10001:10001) with ReadonlyRootfs, so nothing can write under
// /root at all.
const BROWSER_DIR = "/workspace/.automaton-browser";
const HEALTH_URL = "http://127.0.0.1:39222/health";

async function isHealthy(backend: BackendClient): Promise<boolean> {
  const result = await backend.exec(
    `curl -s -o /dev/null -w '%{http_code}' ${HEALTH_URL} || true`,
    5000,
  );
  return result.stdout.trim() === "200";
}

export async function ensureBrowserDaemon(backend: BackendClient): Promise<void> {
  if (await isHealthy(backend)) return;

  // Install chromium + a resident npm dep, best-effort (may already be present).
  // NOTE (separate known gap, not fixed here): this apt-get install also
  // needs root and will fail against the real sandbox image the same way
  // the old /root path did, since containers run as a fixed non-root UID
  // with no sudo. Out of scope for this fix (which is about office/mount
  // paths, not image provisioning) -- the real fix is baking chromium +
  // its deps into config.dockerSandboxImage at build time so this line
  // becomes a no-op "which chromium" check that always succeeds.
  await backend.exec(
    "which chromium || which chromium-browser || " +
      "apt-get update -qq && apt-get install -y -qq chromium fonts-liberation libnss3 libatk-bridge2.0-0 libgtk-3-0",
    180_000,
  );

  await backend.exec(`mkdir -p ${BROWSER_DIR}`, 10_000);
  await backend.writeFile(`${BROWSER_DIR}/daemon.js`, BROWSER_DAEMON_SCRIPT);
  await backend.writeFile(
    `${BROWSER_DIR}/package.json`,
    JSON.stringify({ name: "automaton-browser", private: true, dependencies: { "puppeteer-core": "^23.0.0" } }, null, 2),
  );
  await backend.exec(`cd ${BROWSER_DIR} && npm install --no-audit --no-fund`, 120_000);

  // Start detached so it survives this exec call returning.
  await backend.exec(
    `cd ${BROWSER_DIR} && nohup node daemon.js > daemon.log 2>&1 & disown`,
    5000,
  );

  // Poll for the daemon to come up.
  for (let i = 0; i < 15; i++) {
    if (await isHealthy(backend)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Browser daemon failed to start within 15s -- check daemon.log in the sandbox.");
}

export async function browserCall(
  backend: BackendClient,
  endpoint: string,
  body: Record<string, unknown> = {},
  timeoutMs = 45_000,
): Promise<any> {
  await ensureBrowserDaemon(backend);
  const payload = JSON.stringify(body).replace(/'/g, `'\\''`);
  const result = await backend.exec(
    `curl -s -X POST http://127.0.0.1:39222/${endpoint} -H 'Content-Type: application/json' -d '${payload}'`,
    timeoutMs,
  );
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: `Non-JSON response: ${result.stdout || result.stderr}` };
  }
}

/**
 * next-phase.md Phase 2: a spawned sub-agent worker gets "its own
 * browser tab (not a new profile)" (architecture-agent.md §4). Same
 * daemon, same call shape as browserCall() above -- the only difference
 * is every body gets `tabId` stamped on it so the daemon's per-tab Map
 * (see daemon-script.ts) routes this call to the worker's own Page
 * instead of the parent's "main" tab. Reuses the parent's already-
 * running daemon and userDataDir; never spins up a second browser
 * instance or profile, per the "not a new profile" requirement.
 */
export async function workerBrowserCall(
  backend: BackendClient,
  tabId: string,
  endpoint: string,
  body: Record<string, unknown> = {},
  timeoutMs = 45_000,
): Promise<any> {
  return browserCall(backend, endpoint, { ...body, tabId }, timeoutMs);
}

/** GET /tabs on the daemon -- which tabIds are currently live. */
export async function listBrowserTabs(backend: BackendClient): Promise<string[]> {
  await ensureBrowserDaemon(backend);
  const result = await backend.exec(
    `curl -s http://127.0.0.1:39222/tabs`,
    10_000,
  );
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed.ok ? parsed.tabs : [];
  } catch {
    return [];
  }
}
