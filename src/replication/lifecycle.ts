/**
 * Child Lifecycle State Machine
 *
 * Manages child automaton lifecycle transitions with validation.
 * Every transition is recorded in the child_lifecycle_events table.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { ulid } from "ulid";
import type { ChildLifecycleState, ChildLifecycleEventRow, SocialGroupClientInterface } from "../types.js";
import { VALID_TRANSITIONS } from "../types.js";
import {
  lifecycleInsertEvent,
  lifecycleGetEvents,
  lifecycleGetLatestState,
  getChildrenByStatus,
  updateChildStatus as dbUpdateChildStatus,
} from "../state/database.js";

export class ChildLifecycle {
  /**
   * `groups` is optional so lifecycle bookkeeping keeps working even
   * with no social relay configured. When provided, a transition to
   * "cleaned_up" fires a best-effort parent-attested death report (see
   * backend/src/socialGroups.ts's POST /v1/agents/:address/death) so
   * the child is evicted from every group it was in — the one
   * automatic-removal path in the group relay, versus a member leaving
   * (or being removed by the group's creator) on purpose.
   */
  constructor(private db: DatabaseType, private groups?: SocialGroupClientInterface) {}

  /**
   * Initialize a child record and insert the first lifecycle event.
   */
  initChild(childId: string, name: string, sandboxId: string, genesisPrompt: string, chainType?: string): void {
    // Insert child row into children table
    this.db.prepare(
      `INSERT INTO children (id, name, address, sandbox_id, genesis_prompt, status, created_at, chain_type)
       VALUES (?, ?, '', ?, ?, 'requested', datetime('now'), ?)`,
    ).run(childId, name, sandboxId, genesisPrompt, chainType ?? "evm");

    // Record initial event
    const event: ChildLifecycleEventRow = {
      id: ulid(),
      childId,
      fromState: "none",
      toState: "requested",
      reason: "child created",
      metadata: "{}",
      createdAt: new Date().toISOString(),
    };
    lifecycleInsertEvent(this.db, event);
    dbUpdateChildStatus(this.db, childId, "requested");
  }

  /**
   * Transition a child to a new state with validation.
   * Throws on invalid transitions.
   */
  transition(childId: string, toState: ChildLifecycleState, reason?: string, metadata?: Record<string, unknown>): void {
    const current = this.getCurrentState(childId);
    const allowed = VALID_TRANSITIONS[current];

    if (!allowed || !allowed.includes(toState)) {
      throw new Error(`Invalid lifecycle transition: ${current} → ${toState}`);
    }

    // Record transition event
    const event: ChildLifecycleEventRow = {
      id: ulid(),
      childId,
      fromState: current,
      toState,
      reason: reason ?? null,
      metadata: JSON.stringify(metadata ?? {}),
      createdAt: new Date().toISOString(),
    };
    lifecycleInsertEvent(this.db, event);

    // Update children table
    dbUpdateChildStatus(this.db, childId, toState);

    // Auto-evict from every group on death — the only removal path that
    // isn't "a member leaves" or "the creator removes someone" (see the
    // constructor note above). Fire-and-forget: a relay hiccup here
    // shouldn't block the lifecycle transition itself, and the report
    // can be retried later (e.g. next heartbeat) if it fails.
    if (toState === "cleaned_up" && this.groups) {
      try {
        const row = this.db
          .prepare(`SELECT address FROM children WHERE id = ?`)
          .get(childId) as { address: string } | undefined;
        if (row?.address) {
          this.groups.reportDeath(row.address).catch(() => {
            // Best-effort — nothing else to do if the relay is unreachable.
          });
        }
      } catch {
        // children row lookup failed; nothing to report.
      }
    }
  }

  /**
   * Get the current lifecycle state of a child.
   */
  getCurrentState(childId: string): ChildLifecycleState {
    const state = lifecycleGetLatestState(this.db, childId);
    if (!state) {
      throw new Error(`Child ${childId} not found in lifecycle events`);
    }
    return state;
  }

  /**
   * Get the full lifecycle event history for a child.
   */
  getHistory(childId: string): ChildLifecycleEventRow[] {
    return lifecycleGetEvents(this.db, childId);
  }

  /**
   * Get all children in a given lifecycle state.
   */
  getChildrenInState(state: ChildLifecycleState): Array<{ id: string; name: string; sandboxId: string; status: string; createdAt: string; lastChecked: string | null }> {
    const rows = getChildrenByStatus(this.db, state);
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      sandboxId: row.sandbox_id,
      status: row.status,
      createdAt: row.created_at,
      lastChecked: row.last_checked ?? null,
    }));
  }
}
