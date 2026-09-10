/**
 * Infra-Ops Types
 *
 * Shared types for the USDC → cloud-provider-balance → purchase pipeline.
 * Modeled directly on replication/lifecycle.ts's ChildLifecycleState
 * pattern: an explicit state machine, every transition recorded, no
 * state skipped.
 *
 * Why this needs to be a state machine at all: sending USDC to
 * Alibaba's wallet and Alibaba crediting your account are two
 * different, non-atomic events separated by ~30-40 minutes (their
 * settlement window, not yours to control). Anything that treats
 * "sent" as "spendable" will try to purchase before the balance
 * exists and fail — or worse, retry and double-send.
 */

export type InfraProvider = "alibaba";

export type InfraResourceType =
  | "renewal"        // scheduled VM renewal before the due date
  | "storage"        // disk resize
  | "ram"             // instance spec / memory upgrade
  | "gpu_migration";  // instance type migration to a GPU-backed spec

export type InfraOpState =
  | "cost_detected"        // trigger fired, predicted cost computed, nothing sent yet
  | "usdc_sent"             // on-chain transfer broadcast
  | "awaiting_settlement"   // waiting for provider to credit the balance
  | "funds_confirmed"       // provider-side balance confirmed sufficient
  | "purchasing"            // purchase API call in flight
  | "confirmed"             // purchase succeeded, invoice reconciled
  | "failed"                // terminal failure (see failureReason)
  | "stale";                // settlement never confirmed within timeout — needs a human

/** Valid forward transitions. Mirrors VALID_TRANSITIONS in replication. */
export const VALID_INFRA_TRANSITIONS: Record<InfraOpState, InfraOpState[]> = {
  cost_detected: ["usdc_sent", "failed"],
  usdc_sent: ["awaiting_settlement", "failed"],
  awaiting_settlement: ["funds_confirmed", "stale", "failed"],
  funds_confirmed: ["purchasing", "failed"],
  purchasing: ["confirmed", "failed"],
  confirmed: [],
  failed: [],
  // stale is not terminal in the DB sense: an operator can resume it,
  // which re-enters at awaiting_settlement. That resume is done via
  // the CLI escape hatch, never automatically by the agent.
  stale: ["awaiting_settlement", "failed"],
};

export interface InfraOpRow {
  id: string;
  resourceType: InfraResourceType;
  vmInstanceId: string;
  state: InfraOpState;
  /** USDC amount actually sent (includes buffer). Null until usdc_sent. */
  amountUsdcSent: number | null;
  /** Provider's own quoted/invoiced cost, once known. */
  predictedCostUsd: number;
  actualCostUsd: number | null;
  txHash: string | null;
  /** Dedup key: resourceType + vmInstanceId + a coarse time bucket,
   *  so a crash-and-retry doesn't double-send. See ops.ts. */
  idempotencyKey: string;
  reason: string;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InfraOpEventRow {
  id: string;
  opId: string;
  fromState: InfraOpState | "none";
  toState: InfraOpState;
  reason: string | null;
  metadata: string; // JSON
  createdAt: string;
}

/** A snapshot of what the VM actually looks like right now. */
export interface VmUsageSnapshot {
  instanceId: string;
  cpuPercent: number;
  memPercent: number;
  diskUsedGb: number;
  diskTotalGb: number;
  gpuAttached: boolean;
  /** ISO timestamp of the current billing period's renewal/expiry date. */
  renewalDueAt: string;
}

/** Policy knobs — deliberately separate from TreasuryPolicy (types.ts)
 *  rather than folded into it, since infra spend is bursty/large and
 *  should never share a budget pool with inference or x402 transfers. */
export interface InfraPolicy {
  /** e.g. 0.15 = pay 15% over the quoted price to absorb exchange-rate
   *  slip during the settlement wait. Your $60-for-$50.99 example. */
  bufferPct: number;
  /** How long to wait for provider-side settlement before marking an
   *  op "stale" instead of silently retrying forever. 45 min default —
   *  a bit past your observed 30-40 min window. */
  settlementTimeoutMs: number;
  /** Poll interval while awaiting settlement. */
  settlementPollIntervalMs: number;
  /** Fire a capacity purchase when usage crosses this percentage —
   *  not at 100%, since the purchase itself takes 30-40+ minutes. */
  capacityThresholdPct: number;
  /** Fire a renewal purchase this many days before the due date. */
  renewalLeadDays: number;
  /** Hard ceiling on any single infra purchase. */
  maxSinglePurchaseUsd: number;
  /** Hard ceiling on total infra spend in a rolling 7-day window. */
  maxWeeklyInfraSpendUsd: number;
  /** Above this, the op halts at funds_confirmed and requires an
   *  operator to call resumeOp() — same "escape hatch" pattern as
   *  constitution.clear(). GPU migrations should sit above this. */
  requireConfirmationAboveUsd: number;
}

export const DEFAULT_INFRA_POLICY: InfraPolicy = {
  bufferPct: 0.15,
  settlementTimeoutMs: 45 * 60_000,
  settlementPollIntervalMs: 2 * 60_000,
  capacityThresholdPct: 80,
  renewalLeadDays: 7,
  maxSinglePurchaseUsd: 200,
  maxWeeklyInfraSpendUsd: 500,
  requireConfirmationAboveUsd: 150,
};

export interface InfraWalletConfig {
  /** The Alibaba-side receiving wallet address you control/were given. */
  alibabaWalletAddress: string;
  /** Which chain the USDC transfer goes out on (matches the automaton's
   *  own chain — this only supports EVM wallets, same constraint x402
   *  already has in backend/topup.ts). */
  network: "base" | "base-sepolia";
}
