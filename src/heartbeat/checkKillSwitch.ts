/**
 * Cooperative kill-switch check.
 *
 * Runs every heartbeat tick (recommend every 30-60s, NOT tied to the
 * main think/act/observe loop — this must keep running even during
 * low_compute tiers when the main loop slows down or the agent is
 * mid-turn). Polls GET /control/kill-status/:address on the backend
 * (agent-facing auth, x-backend-key — see backend/src/controlStatusRoute.ts).
 *
 * On a positive flag: logs it, writes a final SOUL.md-adjacent note to
 * the audit log so there's a record of *why* it stopped, and exits the
 * process. Does NOT try to be clever about finishing in-flight work —
 * an agent that just got a kill order from its creator should stop,
 * not negotiate for one more turn. Funds are frozen independently by
 * the same admin action (see rootKillSwitch.ts), so even if this check
 * is delayed or missed for one cycle, the agent can't transact in the
 * meantime.
 */

import type { HeartbeatLegacyContext, HeartbeatTaskFn, TickContext } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("kill-switch");

export const checkKillSwitch: HeartbeatTaskFn = async (
  _ctx: TickContext,
  taskCtx: HeartbeatLegacyContext,
) => {
  let status: { shutdown: boolean; reason: string | null };
  try {
    status = await taskCtx.backend.checkKillStatus();
  } catch (err) {
    // Network hiccup: fail OPEN on availability (don't crash the
    // heartbeat over a transient error) but fail CLOSED on safety —
    // the funds freeze doesn't depend on this check succeeding, so a
    // missed poll here is not the only thing standing between the
    // agent and spending money. Just try again next tick.
    logger.warn(`kill-switch poll failed, will retry next tick: ${String(err)}`);
    return { shouldWake: false };
  }

  if (!status.shutdown) return { shouldWake: false };

  logger.error(`SHUTDOWN REQUESTED by admin kill switch: ${status.reason ?? "no reason given"}`);
  taskCtx.db.setKV(
    "shutdown_record",
    JSON.stringify({ reason: status.reason, at: new Date().toISOString() }),
  );

  // Give the logger a moment to flush, then exit. Exit code 0: this is
  // an intentional, requested stop, not a crash. (process.exit here
  // means the {shouldWake} we'd otherwise return never actually
  // matters — but the type still has to satisfy HeartbeatTaskFn.)
  await new Promise((resolve) => setTimeout(resolve, 500));
  process.exit(0);
};

// Registration (add to BUILTIN_TASKS in agent/src/heartbeat/tasks.ts):
//
//   import { checkKillSwitch } from "./checkKillSwitch.js";
//   export const BUILTIN_TASKS: Record<string, HeartbeatTaskFn> = {
//     ...,
//     check_kill_switch: checkKillSwitch,
//   };
//
// And in the default heartbeat schedule (agent/src/heartbeat/config.ts's
// default entries, or your automaton's own heartbeat.yml): give it a
// SHORT interval (e.g. 30s) and mark it essential so it does NOT get
// shed under low_compute — this is the one task that must never stop
// running regardless of survival tier.
