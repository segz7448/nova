/**
 * Infra Heartbeat Tasks
 *
 * Same shape as BUILTIN_TASKS in heartbeat/tasks.ts — register these
 * into that same map (or merge at startup, see infra/README.md) rather
 * than running a separate scheduler.
 *
 * Two tasks:
 *   infra_renewal_check   - cheap, runs often, only *acts* inside the
 *                            lead-time window (see triggers.ts)
 *   infra_capacity_check  - polls usage, fires storage/RAM purchases
 *
 * Both are read-heavy and only escalate to a spend when a trigger
 * actually fires, so running them more often than they act is fine —
 * the idempotency key in ops.ts prevents duplicate sends within a day.
 */

import type { TickContext, HeartbeatLegacyContext, HeartbeatTaskFn } from "../types.js";
import { createLogger } from "../observability/logger.js";
import { runInfraPurchase, type InfraOpsDeps } from "../infra/ops.js";
import { checkRenewalTrigger, checkStorageTrigger, checkRamTrigger, nextDiskSizeGb } from "../infra/triggers.js";

const logger = createLogger("heartbeat.infra");

export const INFRA_TASK_INTERVALS_MS = {
  infra_renewal_check: 6 * 60 * 60_000,   // every 6h; only acts within renewalLeadDays
  infra_capacity_check: 30 * 60_000,       // every 30m
} as const;

/**
 * `deps` and `vmInstanceId` come from a closure at task-registration
 * time (see infra/README.md's wiring example) since HeartbeatTaskFn's
 * signature is fixed by the existing scheduler and doesn't carry
 * arbitrary extra context.
 */
export function createInfraTasks(deps: InfraOpsDeps, vmInstanceId: string, diskId: string): Record<string, HeartbeatTaskFn> {
  return {
    infra_renewal_check: async (_ctx: TickContext, _taskCtx: HeartbeatLegacyContext) => {
      try {
        const usage = await deps.alibaba.getVmUsage(vmInstanceId);
        const decision = checkRenewalTrigger(usage, deps.policy);

        if (!decision.shouldFire) {
          return { shouldWake: false };
        }

        const predictedCostUsd = await deps.alibaba.getRenewalPriceUsd(vmInstanceId, 1);
        logger.info(`Renewal trigger fired for ${vmInstanceId}: ${decision.reason}, quoted $${predictedCostUsd}`);

        const outcome = await runInfraPurchase(deps, {
          resourceType: "renewal",
          vmInstanceId,
          predictedCostUsd,
          reason: decision.reason!,
          purchaseFn: async () => {
            const result = await deps.alibaba.renewInstance(vmInstanceId, 1);
            return { success: result.success, actualCostUsd: predictedCostUsd, error: result.error };
          },
        });

        return {
          shouldWake: outcome.status === "failed" || outcome.status === "awaiting_confirmation",
          message: `infra_renewal_check: ${outcome.status}${"reason" in outcome ? " — " + outcome.reason : ""}`,
        };
      } catch (err: any) {
        logger.error(`infra_renewal_check failed: ${err.message}`);
        return { shouldWake: false };
      }
    },

    infra_capacity_check: async (_ctx: TickContext, _taskCtx: HeartbeatLegacyContext) => {
      try {
        const usage = await deps.alibaba.getVmUsage(vmInstanceId);

        const storageDecision = checkStorageTrigger(usage, deps.policy);
        const ramDecision = checkRamTrigger(usage, deps.policy);
        const decision = storageDecision.shouldFire ? storageDecision : ramDecision;

        if (!decision.shouldFire) {
          return { shouldWake: false };
        }

        if (decision.resourceType === "storage") {
          const newSizeGb = nextDiskSizeGb(usage.diskTotalGb);
          const predictedCostUsd = await deps.alibaba.getDiskResizePriceUsd(diskId, newSizeGb);
          logger.info(`Storage trigger fired for ${vmInstanceId}: ${decision.reason}, resize to ${newSizeGb}GB, quoted $${predictedCostUsd}`);

          const outcome = await runInfraPurchase(deps, {
            resourceType: "storage",
            vmInstanceId,
            predictedCostUsd,
            reason: decision.reason!,
            purchaseFn: async () => {
              const result = await deps.alibaba.resizeDisk(diskId, newSizeGb);
              return { success: result.success, actualCostUsd: predictedCostUsd, error: result.error };
            },
          });

          return {
            shouldWake: outcome.status === "failed" || outcome.status === "awaiting_confirmation",
            message: `infra_capacity_check(storage): ${outcome.status}`,
          };
        }

        // RAM/instance-spec bumps need a target instance type decided
        // by the agent (region + workload specific), not guessed here —
        // surface it as a wake-up with the reason instead of guessing.
        return {
          shouldWake: true,
          message: `infra_capacity_check(ram): ${decision.reason}. Choose a target instance type and call resizeInstanceSpec via runInfraPurchase.`,
        };
      } catch (err: any) {
        logger.error(`infra_capacity_check failed: ${err.message}`);
        return { shouldWake: false };
      }
    },
  };
}
