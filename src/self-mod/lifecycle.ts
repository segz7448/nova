import { spawn } from "node:child_process";

/** Agent-local lifecycle hooks. Commands are deployment-owned environment
 * values; the backend/general server is never addressed or restarted. */
export async function finishWorkAndRestart(): Promise<void> {
  const drain = process.env.AGENT_DEPARTMENT_DRAIN_COMMAND?.trim();
  const restart = process.env.AGENT_RESTART_COMMAND?.trim();
  if (!restart) return;
  if (drain) await run(drain, Number(process.env.AGENT_DRAIN_TIMEOUT_MS || "300000"));
  const delay = Math.max(0, Number(process.env.AGENT_RESTART_DELAY_MS || "1000"));
  setTimeout(() => {
    spawn(restart, { shell: true, detached: true, stdio: "ignore", env: process.env }).unref();
  }, delay).unref();
}

function run(command: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); resolve(); }, Math.max(1000, timeoutMs));
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.once("error", () => { clearTimeout(timer); resolve(); });
  });
}
