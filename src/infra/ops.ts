/**
 * Infra Ops Orchestrator
 *
 * Drives one InfraOpRow through the state machine in types.ts. Mirrors
 * replication/lifecycle.ts's shape (init → transition → history) but
 * adds the settlement wait and the cross-agent lock, since this deals
 * with a slow, non-atomic, shared-wallet payment instead of an
 * in-process spawn.
 *
 * One call = one attempt at one op. The heartbeat tasks (infra-tasks.ts)
 * are what decide *when* to call it.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { ulid } from "ulid";
import type { PrivateKeyAccount, Address } from "viem";
import type {
  InfraOpRow,
  InfraOpState,
  InfraResourceType,
  InfraPolicy,
  InfraWalletConfig,
  VmUsageSnapshot,
} from "./types.js";
import { VALID_INFRA_TRANSITIONS } from "./types.js";
import {
  insertOp,
  insertEvent,
  updateOpState,
  updateOpFields,
  getOp,
  findActiveOpByIdempotencyKey,
  getTrailingWeekSpendUsd,
  claimLock,
  releaseLock,
} from "./database.js";
import { sendUsdc, waitForSettlement, getUsdcBalance } from "./usdc.js";
import { AlibabaClient } from "./alibaba-client.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("infra.ops");

export interface InfraOpsDeps {
  db: DatabaseType;
  account: PrivateKeyAccount;
  alibaba: AlibabaClient;
  policy: InfraPolicy;
  wallet: InfraWalletConfig;
}

export type InfraOpOutcome =
  | { status: "confirmed"; opId: string; actualCostUsd: number }
  | { status: "skipped"; reason: string }
  | { status: "awaiting_confirmation"; opId: string; reason: string }
  | { status: "failed"; opId: string; reason: string };

function transition(db: DatabaseType, op: InfraOpRow, to: InfraOpState, reason: string, metadata: Record<string, unknown> = {}) {
  const allowed = VALID_INFRA_TRANSITIONS[op.state];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid infra-op transition: ${op.state} → ${to}`);
  }
  insertEvent(db, {
    id: ulid(),
    opId: op.id,
    fromState: op.state,
    toState: to,
    reason,
    metadata: JSON.stringify(metadata),
    createdAt: new Date().toISOString(),
  });
  updateOpState(db, op.id, to);
  op.state = to;
}

/** Coarse time bucket so retries within the same window dedupe, but a
 *  *new* genuine need (e.g. two separate renewal cycles) doesn't. */
function idempotencyKey(resourceType: InfraResourceType, vmInstanceId: string): string {
  const dayBucket = new Date().toISOString().slice(0, 10);
  return `${resourceType}:${vmInstanceId}:${dayBucket}`;
}

/**
 * The full pipeline for one purchase: detect → send → wait → purchase.
 * `purchaseFn` is the specific Alibaba call (renew / resize disk / resize
 * spec) — kept as a parameter so this function has exactly one copy of
 * the settlement-wait and policy-gate logic instead of one per resource type.
 */
export async function runInfraPurchase(deps: InfraOpsDeps, params: {
  resourceType: InfraResourceType;
  vmInstanceId: string;
  predictedCostUsd: number;
  reason: string;
  purchaseFn: (actualBalanceUsd: number) => Promise<{ success: boolean; actualCostUsd?: number; error?: string }>;
}): Promise<InfraOpOutcome> {
  const { db, account, policy, wallet } = deps;
  const { resourceType, vmInstanceId, predictedCostUsd, reason, purchaseFn } = params;

  const key = idempotencyKey(resourceType, vmInstanceId);
  const existing = findActiveOpByIdempotencyKey(db, key);
  if (existing) {
    return { status: "skipped", reason: `Op already in flight (${existing.state}), id=${existing.id}` };
  }

  // Hard caps, checked before anything is sent.
  if (predictedCostUsd > policy.maxSinglePurchaseUsd) {
    logger.warn(`Blocked: ${resourceType} for ${vmInstanceId} costs $${predictedCostUsd} > single-purchase cap $${policy.maxSinglePurchaseUsd}`);
    return { status: "skipped", reason: `Exceeds maxSinglePurchaseUsd ($${policy.maxSinglePurchaseUsd})` };
  }
  const weekSpend = getTrailingWeekSpendUsd(db);
  if (weekSpend + predictedCostUsd > policy.maxWeeklyInfraSpendUsd) {
    logger.warn(`Blocked: ${resourceType} for ${vmInstanceId} would push 7-day spend to $${(weekSpend + predictedCostUsd).toFixed(2)} > cap $${policy.maxWeeklyInfraSpendUsd}`);
    return { status: "skipped", reason: `Would exceed maxWeeklyInfraSpendUsd ($${policy.maxWeeklyInfraSpendUsd})` };
  }

  // Cross-agent lock — one automaton per wallet-affecting op per VM at a time.
  const lockKey = `${resourceType}:${vmInstanceId}`;
  const gotLock = claimLock(db, lockKey, account.address, policy.settlementTimeoutMs + 10 * 60_000);
  if (!gotLock) {
    return { status: "skipped", reason: `Another agent holds the lock for ${lockKey}` };
  }

  try {
    // ── cost_detected ────────────────────────────────────────────
    const op: InfraOpRow = {
      id: ulid(),
      resourceType,
      vmInstanceId,
      state: "cost_detected",
      amountUsdcSent: null,
      predictedCostUsd,
      actualCostUsd: null,
      txHash: null,
      idempotencyKey: key,
      reason,
      failureReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    insertOp(db, op);
    insertEvent(db, { id: ulid(), opId: op.id, fromState: "none", toState: "cost_detected", reason, metadata: "{}", createdAt: op.createdAt });
    logger.info(`[${op.id}] cost_detected: ${resourceType} on ${vmInstanceId}, predicted $${predictedCostUsd}, reason: ${reason}`);

    // ── usdc_sent ─────────────────────────────────────────────────
    const amountUsdc = round2(predictedCostUsd * (1 + policy.bufferPct));
    const sendResult = await sendUsdc({
      account,
      toAddress: wallet.alibabaWalletAddress as Address,
      amountUsdc,
      network: wallet.network,
    });

    if (!sendResult.success) {
      transition(db, op, "failed", `USDC send failed: ${sendResult.error}`);
      updateOpFields(db, op.id, { failureReason: sendResult.error });
      return { status: "failed", opId: op.id, reason: sendResult.error ?? "unknown send failure" };
    }

    updateOpFields(db, op.id, { amountUsdcSent: amountUsdc, txHash: sendResult.txHash });
    transition(db, op, "usdc_sent", `Sent $${amountUsdc} USDC (${((amountUsdc / predictedCostUsd - 1) * 100).toFixed(0)}% buffer)`, { txHash: sendResult.txHash });
    logger.info(`[${op.id}] usdc_sent: $${amountUsdc}, tx=${sendResult.txHash}`);

    // ── awaiting_settlement ──────────────────────────────────────
    transition(db, op, "awaiting_settlement", "Waiting for Alibaba-side settlement");

    const { settled, elapsedMs } = await waitForSettlement({
      timeoutMs: policy.settlementTimeoutMs,
      pollIntervalMs: policy.settlementPollIntervalMs,
      onPoll: (elapsed, result) => {
        logger.info(`[${op.id}] settlement poll @ ${Math.round(elapsed / 1000)}s: balance=$${result.observedValue ?? "?"}`);
      },
      checkFn: async () => {
        const balance = await deps.alibaba.getAccountBalance();
        return { settled: balance >= predictedCostUsd, observedValue: balance };
      },
    });

    if (!settled) {
      transition(db, op, "stale", `No settlement after ${Math.round(elapsedMs / 60000)} min — needs operator review`);
      logger.warn(`[${op.id}] stale: settlement not observed within timeout. USDC was sent (tx=${sendResult.txHash}) — this needs a human, not a retry.`);
      return { status: "awaiting_confirmation", opId: op.id, reason: "Settlement timeout — funds sent but not yet confirmed on Alibaba's side. Check manually before retrying." };
    }

    const balanceAtSettlement = await deps.alibaba.getAccountBalance();
    transition(db, op, "funds_confirmed", `Balance confirmed: $${balanceAtSettlement.toFixed(2)}`);
    logger.info(`[${op.id}] funds_confirmed after ${Math.round(elapsedMs / 60000)} min`);

    // ── confirmation gate for large/irreversible purchases ──────
    if (predictedCostUsd > policy.requireConfirmationAboveUsd) {
      logger.warn(`[${op.id}] halted at funds_confirmed: $${predictedCostUsd} exceeds requireConfirmationAboveUsd ($${policy.requireConfirmationAboveUsd}). Funds are on Alibaba's balance, ready to spend — an operator must resume this op explicitly.`);
      return { status: "awaiting_confirmation", opId: op.id, reason: `Purchase of $${predictedCostUsd} requires explicit operator confirmation before proceeding (resumeAndPurchase).` };
    }

    // ── purchasing → confirmed ───────────────────────────────────
    return await executePurchase(deps, op, balanceAtSettlement, purchaseFn);
  } finally {
    releaseLock(db, lockKey, account.address);
  }
}

async function executePurchase(
  deps: InfraOpsDeps,
  op: InfraOpRow,
  balanceAtSettlement: number,
  purchaseFn: (actualBalanceUsd: number) => Promise<{ success: boolean; actualCostUsd?: number; error?: string }>,
): Promise<InfraOpOutcome> {
  const { db } = deps;
  transition(db, op, "purchasing", "Calling Alibaba purchase API");

  const result = await purchaseFn(balanceAtSettlement);

  if (!result.success) {
    transition(db, op, "failed", `Purchase failed: ${result.error}`);
    updateOpFields(db, op.id, { failureReason: result.error });
    logger.error(`[${op.id}] purchase failed: ${result.error}. Funds remain on Alibaba's balance — no USDC lost, but the intended purchase didn't happen.`);
    return { status: "failed", opId: op.id, reason: result.error ?? "unknown purchase failure" };
  }

  updateOpFields(db, op.id, { actualCostUsd: result.actualCostUsd ?? op.predictedCostUsd });
  transition(db, op, "confirmed", `Purchase confirmed, actual cost $${result.actualCostUsd ?? op.predictedCostUsd}`);
  logger.info(`[${op.id}] confirmed`);

  return { status: "confirmed", opId: op.id, actualCostUsd: result.actualCostUsd ?? op.predictedCostUsd };
}

/**
 * Operator escape hatch for an op halted at funds_confirmed by the
 * requireConfirmationAboveUsd gate (e.g. a GPU migration). Never called
 * by the agent itself — same pattern as constitution.clear().
 */
export async function resumeAndPurchase(
  deps: InfraOpsDeps,
  opId: string,
  purchaseFn: (actualBalanceUsd: number) => Promise<{ success: boolean; actualCostUsd?: number; error?: string }>,
): Promise<InfraOpOutcome> {
  const op = getOp(deps.db, opId);
  if (!op) return { status: "failed", opId, reason: "op not found" };
  if (op.state !== "funds_confirmed") {
    return { status: "failed", opId, reason: `Cannot resume from state ${op.state}, expected funds_confirmed` };
  }
  const balance = await deps.alibaba.getAccountBalance();
  return executePurchase(deps, op, balance, purchaseFn);
}

/**
 * Operator escape hatch for a "stale" op — USDC was sent but settlement
 * was never observed within the timeout. Re-enters at awaiting_settlement
 * with a fresh (shorter) poll window, for after a human has manually
 * verified the funds landed (e.g. checked the Alibaba console directly).
 */
export async function resumeStaleOp(deps: InfraOpsDeps, opId: string, extraWaitMs: number = 10 * 60_000): Promise<InfraOpOutcome> {
  const op = getOp(deps.db, opId);
  if (!op) return { status: "failed", opId, reason: "op not found" };
  if (op.state !== "stale") {
    return { status: "failed", opId, reason: `Cannot resume from state ${op.state}, expected stale` };
  }
  transition(deps.db, op, "awaiting_settlement", "Resumed by operator after manual verification");

  const { settled } = await waitForSettlement({
    timeoutMs: extraWaitMs,
    pollIntervalMs: deps.policy.settlementPollIntervalMs,
    checkFn: async () => {
      const balance = await deps.alibaba.getAccountBalance();
      return { settled: balance >= op.predictedCostUsd, observedValue: balance };
    },
  });

  if (!settled) {
    transition(deps.db, op, "stale", "Still not settled after operator-triggered resume");
    return { status: "awaiting_confirmation", opId, reason: "Still not settled — check Alibaba console directly" };
  }

  const balance = await deps.alibaba.getAccountBalance();
  transition(deps.db, op, "funds_confirmed", `Balance confirmed on resume: $${balance.toFixed(2)}`);
  return { status: "awaiting_confirmation", opId, reason: "Funds confirmed — call resumeAndPurchase to complete the purchase" };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
