/**
 * Infra-Ops Database
 *
 * Three tables:
 *   infra_ops         - one row per purchase/renewal attempt
 *   infra_ops_events  - full transition history (audit trail)
 *   infra_locks       - cross-agent claim table so two automatons
 *                       sharing one Alibaba wallet don't both fire a
 *                       top-up for the same VM in the same window
 *
 * Call initInfraSchema(db) once at startup (same place agent/src/state
 * runs its own migrations) before anything else in infra/ touches the db.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { InfraOpRow, InfraOpEventRow, InfraOpState, InfraResourceType } from "./types.js";

export function initInfraSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS infra_ops (
      id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      vm_instance_id TEXT NOT NULL,
      state TEXT NOT NULL,
      amount_usdc_sent REAL,
      predicted_cost_usd REAL NOT NULL,
      actual_cost_usd REAL,
      tx_hash TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_infra_ops_state ON infra_ops(state);
    CREATE INDEX IF NOT EXISTS idx_infra_ops_vm ON infra_ops(vm_instance_id);

    CREATE TABLE IF NOT EXISTS infra_ops_events (
      id TEXT PRIMARY KEY,
      op_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      reason TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (op_id) REFERENCES infra_ops(id)
    );

    CREATE INDEX IF NOT EXISTS idx_infra_events_op ON infra_ops_events(op_id);

    CREATE TABLE IF NOT EXISTS infra_locks (
      resource_key TEXT PRIMARY KEY,
      holder_address TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
}

function rowToOp(row: any): InfraOpRow {
  return {
    id: row.id,
    resourceType: row.resource_type,
    vmInstanceId: row.vm_instance_id,
    state: row.state,
    amountUsdcSent: row.amount_usdc_sent,
    predictedCostUsd: row.predicted_cost_usd,
    actualCostUsd: row.actual_cost_usd,
    txHash: row.tx_hash,
    idempotencyKey: row.idempotency_key,
    reason: row.reason,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertOp(db: DatabaseType, op: InfraOpRow): void {
  db.prepare(
    `INSERT INTO infra_ops
       (id, resource_type, vm_instance_id, state, amount_usdc_sent,
        predicted_cost_usd, actual_cost_usd, tx_hash, idempotency_key,
        reason, failure_reason, created_at, updated_at)
     VALUES (@id, @resourceType, @vmInstanceId, @state, @amountUsdcSent,
             @predictedCostUsd, @actualCostUsd, @txHash, @idempotencyKey,
             @reason, @failureReason, @createdAt, @updatedAt)`,
  ).run(op as any);
}

/** Idempotency check: is there already a non-terminal op for this key? */
export function findActiveOpByIdempotencyKey(
  db: DatabaseType,
  idempotencyKey: string,
): InfraOpRow | null {
  const row = db
    .prepare(
      `SELECT * FROM infra_ops
       WHERE idempotency_key = ? AND state NOT IN ('confirmed', 'failed')`,
    )
    .get(idempotencyKey);
  return row ? rowToOp(row) : null;
}

export function getOp(db: DatabaseType, opId: string): InfraOpRow | null {
  const row = db.prepare(`SELECT * FROM infra_ops WHERE id = ?`).get(opId);
  return row ? rowToOp(row) : null;
}

export function updateOpFields(
  db: DatabaseType,
  opId: string,
  fields: Partial<
    Pick<InfraOpRow, "amountUsdcSent" | "actualCostUsd" | "txHash" | "failureReason">
  >,
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id: opId, updatedAt: new Date().toISOString() };
  if (fields.amountUsdcSent !== undefined) { sets.push("amount_usdc_sent = @amountUsdcSent"); params.amountUsdcSent = fields.amountUsdcSent; }
  if (fields.actualCostUsd !== undefined) { sets.push("actual_cost_usd = @actualCostUsd"); params.actualCostUsd = fields.actualCostUsd; }
  if (fields.txHash !== undefined) { sets.push("tx_hash = @txHash"); params.txHash = fields.txHash; }
  if (fields.failureReason !== undefined) { sets.push("failure_reason = @failureReason"); params.failureReason = fields.failureReason; }
  if (sets.length === 0) return;
  db.prepare(`UPDATE infra_ops SET ${sets.join(", ")}, updated_at = @updatedAt WHERE id = @id`).run(params);
}

export function insertEvent(db: DatabaseType, event: InfraOpEventRow): void {
  db.prepare(
    `INSERT INTO infra_ops_events (id, op_id, from_state, to_state, reason, metadata, created_at)
     VALUES (@id, @opId, @fromState, @toState, @reason, @metadata, @createdAt)`,
  ).run(event as any);
}

export function updateOpState(db: DatabaseType, opId: string, state: InfraOpState): void {
  db.prepare(`UPDATE infra_ops SET state = ?, updated_at = ? WHERE id = ?`)
    .run(state, new Date().toISOString(), opId);
}

export function getOpsInState(db: DatabaseType, state: InfraOpState): InfraOpRow[] {
  const rows = db.prepare(`SELECT * FROM infra_ops WHERE state = ?`).all(state);
  return rows.map(rowToOp);
}

/** Rolling 7-day spend across all resource types, for the weekly cap. */
export function getTrailingWeekSpendUsd(db: DatabaseType): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(actual_cost_usd, amount_usdc_sent, 0)), 0) AS total
       FROM infra_ops
       WHERE created_at >= datetime('now', '-7 days')
         AND state != 'failed'`,
    )
    .get() as { total: number };
  return row.total;
}

// ─── Cross-agent lock ───────────────────────────────────────────────
// resourceKey should be `${resourceType}:${vmInstanceId}` so different
// VMs / different resource types on the same VM don't block each other.

export function claimLock(
  db: DatabaseType,
  resourceKey: string,
  holderAddress: string,
  ttlMs: number,
): boolean {
  const now = new Date();
  const nowIso = now.toISOString();
  const existing = db
    .prepare(`SELECT * FROM infra_locks WHERE resource_key = ?`)
    .get(resourceKey) as { expires_at: string } | undefined;

  if (existing && new Date(existing.expires_at) > now) {
    return false; // someone else holds it, and it hasn't expired
  }

  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  db.prepare(
    `INSERT INTO infra_locks (resource_key, holder_address, claimed_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(resource_key) DO UPDATE SET
       holder_address = excluded.holder_address,
       claimed_at = excluded.claimed_at,
       expires_at = excluded.expires_at`,
  ).run(resourceKey, holderAddress, nowIso, expiresAt);
  return true;
}

export function releaseLock(db: DatabaseType, resourceKey: string, holderAddress: string): void {
  db.prepare(`DELETE FROM infra_locks WHERE resource_key = ? AND holder_address = ?`)
    .run(resourceKey, holderAddress);
}
