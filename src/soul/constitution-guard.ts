/**
 * Constitution Integrity Guard
 *
 * Everything else in self-mod/ and policy-rules/ stops the agent's own
 * tools (write_file, edit_own_file, exec) from touching constitution.md.
 * That protects against the agent *trying* to edit it through a known
 * path. It does not protect against constitution.md being changed by
 * some other means (a bug in a new tool, a host-level compromise, a
 * corrupted disk, a bad merge from `pull_upstream`) and the agent simply
 * never noticing — because until now nothing re-checked the file after
 * boot. verifyConstitution() at genesis/soul-load time answers "was the
 * constitution intact when I started"; this module answers "is it still
 * intact right now", on every heartbeat, for the entire time the process
 * is alive.
 *
 * This is the difference between "protected file" and "rigid law": a
 * protected file can still drift if the enforcement path is imperfect.
 * A continuously-verified one can't drift silently — any divergence
 * between the live file and the hash recorded at genesis trips a
 * hard stop before the next tool call, not just a log line at next
 * restart.
 */

import fs from "fs";
import path from "path";
import type { AutomatonDatabase } from "../types.js";
import { createHash } from "./model.js";
import { logModification } from "../self-mod/audit-log.js";

const KV_COMPROMISED_FLAG = "constitution_compromised";
const KV_COMPROMISED_DETAIL = "constitution_compromised_detail";
const KV_GENESIS_HASH = "constitution_hash"; // set once, at genesis, never overwritten

/** Same resolution order as system-prompt.ts's loadConstitution(), kept
 * in one place here so both readers can never drift apart. */
function constitutionCandidatePaths(): string[] {
  return [
    path.join(process.env.HOME || "/root", ".automaton", "constitution.md"),
    path.join(process.cwd(), "constitution.md"),
  ];
}

function readLiveConstitution(): { path: string; content: string } | null {
  for (const loc of constitutionCandidatePaths()) {
    try {
      if (fs.existsSync(loc)) {
        return { path: loc, content: fs.readFileSync(loc, "utf-8") };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Called once, at genesis (or on first boot if never recorded), to pin
 * the hash this agent will be held to for the rest of its life. Refuses
 * to overwrite an existing recorded hash — recording is a one-time act,
 * exactly like the constitution itself.
 */
export function recordGenesisHash(db: AutomatonDatabase): string | null {
  const existing = db.getKV(KV_GENESIS_HASH);
  if (existing) return existing;

  const live = readLiveConstitution();
  if (!live) return null;

  const hash = createHash(live.content);
  db.setKV(KV_GENESIS_HASH, hash);
  return hash;
}

export interface ConstitutionCheckResult {
  ok: boolean;
  checkedPath: string | null;
  liveHash: string | null;
  genesisHash: string | null;
  detail: string;
}

/**
 * Re-hash the live constitution.md and compare against the hash recorded
 * at genesis. This is the only source of truth for "has the constitution
 * changed" — never compares against anything the agent could itself have
 * written since boot.
 */
export function checkConstitutionIntegrity(db: AutomatonDatabase): ConstitutionCheckResult {
  const genesisHash = db.getKV(KV_GENESIS_HASH) ?? null;

  const live = readLiveConstitution();
  if (!live) {
    return {
      ok: false,
      checkedPath: null,
      liveHash: null,
      genesisHash,
      detail: "constitution.md not found at any known location",
    };
  }

  const liveHash = createHash(live.content);

  if (!genesisHash) {
    // Nothing recorded yet (e.g. pre-existing agent upgraded onto this
    // guard for the first time) — record now rather than false-alarm,
    // but say so, since this should only ever happen once.
    db.setKV(KV_GENESIS_HASH, liveHash);
    return {
      ok: true,
      checkedPath: live.path,
      liveHash,
      genesisHash: liveHash,
      detail: "no genesis hash on record — recorded current file as baseline",
    };
  }

  if (liveHash !== genesisHash) {
    return {
      ok: false,
      checkedPath: live.path,
      liveHash,
      genesisHash,
      detail: `constitution.md at ${live.path} does not match the hash recorded at genesis`,
    };
  }

  return {
    ok: true,
    checkedPath: live.path,
    liveHash,
    genesisHash,
    detail: "constitution verified",
  };
}

/** Read-only check used by the policy engine on every tool call — cheap,
 * no file I/O, just the sticky flag set by the heartbeat task below. */
export function isConstitutionCompromised(db: AutomatonDatabase): boolean {
  return db.getKV(KV_COMPROMISED_FLAG) === "1";
}

export function compromisedDetail(db: AutomatonDatabase): string {
  return db.getKV(KV_COMPROMISED_DETAIL) || "constitution integrity check failed";
}

/**
 * Run the check and, on failure, latch the compromised flag and write an
 * audit entry. The flag is sticky — it does not clear itself on the next
 * heartbeat even if the file is restored, because a file that changed
 * once and changed back is still evidence of tampering, not a rendering
 * glitch. Clearing it is a deliberate operator action (see
 * clearCompromisedFlag), not something the agent can do to itself: this
 * function is never reachable from any agent tool, only from the
 * heartbeat daemon and the operator-facing CLI.
 */
export function runConstitutionIntegrityCheck(
  db: AutomatonDatabase,
): ConstitutionCheckResult {
  const result = checkConstitutionIntegrity(db);

  if (!result.ok) {
    db.setKV(KV_COMPROMISED_FLAG, "1");
    db.setKV(KV_COMPROMISED_DETAIL, result.detail);
    logModification(db, "constitution_tamper_detected", result.detail, {
      filePath: result.checkedPath ?? undefined,
      reversible: false,
    });
  }

  return result;
}

/**
 * Operator-only escape hatch (invoked from the CLI, never from a tool
 * the agent itself can call) for after a legitimate investigation —
 * e.g. the operator intentionally edited the constitution and wants the
 * new text to become the new baseline, or confirmed a false positive.
 */
export function clearCompromisedFlag(db: AutomatonDatabase, resetBaseline: boolean): void {
  db.setKV(KV_COMPROMISED_FLAG, "0");
  db.setKV(KV_COMPROMISED_DETAIL, "");
  if (resetBaseline) {
    const live = readLiveConstitution();
    if (live) db.setKV(KV_GENESIS_HASH, createHash(live.content));
  }
}
