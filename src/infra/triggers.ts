/**
 * Infra Triggers
 *
 * Pure decision functions: given a usage snapshot and policy, should a
 * purchase fire, and for how much? Kept separate from ops.ts so the
 * "when" logic is unit-testable without touching the DB, USDC, or
 * Alibaba's API.
 */

import type { InfraPolicy, VmUsageSnapshot, InfraResourceType } from "./types.js";
import { AlibabaClient } from "./alibaba-client.js";

export interface TriggerDecision {
  shouldFire: boolean;
  resourceType?: InfraResourceType;
  reason?: string;
}

/** Fires `renewalLeadDays` before the instance's renewal/expiry date. */
export function checkRenewalTrigger(usage: VmUsageSnapshot, policy: InfraPolicy): TriggerDecision {
  const dueAt = new Date(usage.renewalDueAt).getTime();
  const daysUntilDue = (dueAt - Date.now()) / (1000 * 60 * 60 * 24);

  if (daysUntilDue <= policy.renewalLeadDays) {
    return {
      shouldFire: true,
      resourceType: "renewal",
      reason: `Renewal due in ${daysUntilDue.toFixed(1)} days (lead time: ${policy.renewalLeadDays})`,
    };
  }
  return { shouldFire: false };
}

/** Fires when disk usage crosses the threshold — well before 100%, since
 *  the purchase itself takes 30-40+ minutes once you count settlement. */
export function checkStorageTrigger(usage: VmUsageSnapshot, policy: InfraPolicy): TriggerDecision {
  if (usage.diskTotalGb === 0) return { shouldFire: false };
  const pctUsed = (usage.diskUsedGb / usage.diskTotalGb) * 100;

  if (pctUsed >= policy.capacityThresholdPct) {
    return {
      shouldFire: true,
      resourceType: "storage",
      reason: `Disk at ${pctUsed.toFixed(1)}% (threshold: ${policy.capacityThresholdPct}%)`,
    };
  }
  return { shouldFire: false };
}

export function checkRamTrigger(usage: VmUsageSnapshot, policy: InfraPolicy): TriggerDecision {
  if (usage.memPercent >= policy.capacityThresholdPct) {
    return {
      shouldFire: true,
      resourceType: "ram",
      reason: `Memory at ${usage.memPercent.toFixed(1)}% (threshold: ${policy.capacityThresholdPct}%)`,
    };
  }
  return { shouldFire: false };
}

/** Simple sizing rule: next disk tier up, rounded to a clean number.
 *  Swap this out for something workload-aware later — it's intentionally
 *  dumb (fixed +50% headroom) rather than guessing at growth rate from
 *  one snapshot. */
export function nextDiskSizeGb(currentGb: number): number {
  return Math.ceil((currentGb * 1.5) / 10) * 10;
}
