/**
 * Task Outcome -> Self-Mod Scoring Bridge
 *
 * scoring.ts's recordOutcome() needs a filePath and a success/failure
 * bit. Neither is available at self-mod edit time (see scoring.ts's
 * own TODO, now resolved here) — they only become known once a task
 * that actually exercised the (possibly self-modified) skill finishes,
 * which is orchestration/task-graph.ts's completeTask()/failTask().
 *
 * Attribution is coarse, and deliberately so rather than invented:
 * this codebase injects EVERY enabled, auto-activate skill into every
 * turn's system prompt (see skills/loader.ts's getActiveSkillInstructions)
 * — there is no existing per-task "this specific skill caused this
 * specific outcome" instrumentation, and building one is a much larger
 * feature than this bridge. So the honest version of "did this
 * self-modified skill help or hurt" is: every scoped-owned skill file
 * that was active while the task ran shares in that task's own
 * success/failure. Several self-mods active at once means several
 * files get the same outcome recorded — genuine shared credit/blame,
 * not a precise causal claim.
 *
 * task-graph.ts's completeTask()/failTask() only have the raw
 * better-sqlite3 handle in scope (not the AutomatonDatabase wrapper
 * self-mod/scoring.ts's own tests use), so this file adapts the raw
 * handle to scoring.ts's minimal KVStore shape directly against the
 * same `kv` table state/database.ts's own getKV/setKV use — no new
 * storage mechanism, just a second, narrower accessor onto it.
 *
 * Also home to performAutoRevert(): once a scoped-owned skill's score
 * crosses scoring.ts's shouldAutoRevert() threshold,
 * recordTaskOutcomeForActiveSkills() flags it (see its own return
 * value) and the caller (orchestration/local-worker.ts, which has the
 * BackendClient this synchronous file doesn't) calls performAutoRevert()
 * to actually undo it — restoring the file's content from right before
 * its last self-mod, or removing it entirely if the self-mod WAS its
 * creation.
 */

import type { Database } from "better-sqlite3";
import type { BackendClient } from "../types.js";
import { recordOutcome, resetScore, shouldAutoRevert, getScore, getRecentFailureReasons, type KVStore } from "./scoring.js";
import { classifyFile, readScopeManifestSync } from "./merge-policy.js";
import { ulid } from "ulid";
import {
  gitCommitBeforeLastChange,
  gitPathExistsAtRef,
  gitCheckoutPathFromRef,
  gitCommit,
  escapeShellArg,
} from "../git/tools.js";

/**
 * Raw-DB equivalent of audit-log.ts's logModification() — same
 * reasoning as rawKVStore() above: this file only has the raw
 * better-sqlite3 handle (see task-graph.ts's completeTask()/
 * failTask()), not the AutomatonDatabase wrapper logModification()
 * itself expects. Writes to the exact same `modifications` table via
 * the same columns state/database.ts's own insertModification() uses.
 */
function logModificationRaw(
  db: Database,
  type: "code_revert",
  description: string,
  options: { filePath?: string; reversible?: boolean; diff?: string },
): void {
  db.prepare(
    `INSERT INTO modifications (id, timestamp, type, description, file_path, diff, reversible)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ulid(),
    new Date().toISOString(),
    type,
    description,
    options.filePath ?? null,
    options.diff ?? null,
    options.reversible === false ? 0 : 1,
  );
}

export function rawKVStore(db: Database): KVStore {
  return {
    getKV(key: string): string | undefined {
      const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value;
    },
    setKV(key: string, value: string): void {
      db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(
        key,
        value,
      );
    },
  };
}

interface ActiveSkillRow {
  path: string;
}

function getActiveScopedOwnedSkillPaths(db: Database, repoPath: string): string[] {
  const manifest = readScopeManifestSync(repoPath);
  const rows = db
    .prepare("SELECT path FROM skills WHERE enabled = 1 AND auto_activate = 1")
    .all() as ActiveSkillRow[];
  return rows.map((r) => r.path).filter((path) => classifyFile(path, manifest) === "scoped-owned");
}

/**
 * For call sites with no BackendClient in scope (orchestrator.ts,
 * which only collects task results — actual execution with backend
 * access happens in workers, see local-worker.ts's own
 * applyFlaggedAutoReverts wiring). Can't perform the revert itself,
 * but must not silently drop the signal either: logs clearly so a
 * human (or a future pass with backend access, e.g. the next time
 * this same file's flagged from a path that DOES have one) sees it.
 */
export function logFlaggedAutoRevertsWithoutBackend(
  flaggedForRevert: string[],
  logger: { warn: (msg: string, ctx?: Record<string, unknown>) => void },
): void {
  for (const filePath of flaggedForRevert) {
    logger.warn(
      `Self-modified skill ${filePath} crossed the auto-revert threshold, but this code path has no ` +
        `BackendClient available to perform the revert. It will be re-evaluated (and reverted, if still ` +
        `flagged) the next time this file is exercised by a worker that has one.`,
      { filePath },
    );
  }
}

/**
 * Shared follow-up for every real completeTask()/failTask() call
 * site: given the paths that function just flagged, actually revert
 * each one and log the outcome either way. Doesn't throw — a failed
 * auto-revert is logged, not propagated, since by the time this runs
 * the task's own outcome is already finalized and committed.
 */
export async function applyFlaggedAutoReverts(
  backend: BackendClient,
  db: Database,
  repoPath: string,
  flaggedForRevert: string[],
  logger: { warn: (msg: string, ctx?: Record<string, unknown>) => void; info: (msg: string, ctx?: Record<string, unknown>) => void },
): Promise<void> {
  for (const filePath of flaggedForRevert) {
    const reasons = getRecentFailureReasons(rawKVStore(db), filePath);
    // Short, single-line summary for the git commit message — commit
    // messages shouldn't carry multiple full error strings.
    const shortReason =
      reasons.length > 0
        ? `${reasons.length} repeated failure(s), most recent: "${reasons[reasons.length - 1].replace(/\s+/g, " ")}"`
        : "repeated task failures since this self-mod (auto-revert threshold)";
    // Full detail for the structured audit log (modifications.diff) —
    // every recorded reason, not just the most recent one.
    const fullDetail =
      reasons.length > 0
        ? reasons.map((r, i) => `${i + 1}. ${r}`).join("\n")
        : "No individual failure reasons were recorded for this file.";

    const result = await performAutoRevert(backend, db, repoPath, filePath, shortReason, fullDetail);
    if (result.reverted) {
      logger.warn(`Auto-reverted self-modified skill: ${filePath}`, { filePath, detail: result.detail, reasons });
    } else {
      logger.info(`Self-modified skill ${filePath} was flagged for auto-revert but revert did not run`, {
        filePath,
        detail: result.detail,
        reasons,
      });
    }
  }
}

/**
 * Called from completeTask()/failTask() (see task-graph.ts's own call
 * sites) after a task's outcome is already final. Never throws — a
 * scoring failure (missing kv/skills table on an older DB, a bad
 * scope.json, whatever) must never turn an already-decided task
 * outcome into a broken transaction. Scoring is a downstream
 * observer of that outcome, not a participant in deciding it.
 *
 * Returns the scoped-owned file paths that just crossed
 * shouldAutoRevert()'s threshold. This function itself never performs
 * the revert — it's synchronous (task-graph.ts's completeTask()/
 * failTask() are sync transactions against the raw better-sqlite3
 * handle, with no BackendClient in scope), and reverting is a real
 * git operation that needs one. The caller (orchestration/
 * local-worker.ts, which already has both `db` and `backend` in
 * scope right next to its own completeTask()/failTask() calls) is
 * expected to pass any returned paths to performAutoRevert() below.
 *
 * `failureReason` (task-graph.ts's failTask() already has this as its
 * own `error` parameter) is recorded alongside the failure so a later
 * auto-revert's audit entry can cite the actual reason(s), not just
 * "repeated failures" — see scoring.ts's recordOutcome() and
 * getRecentFailureReasons().
 */
export function recordTaskOutcomeForActiveSkills(
  db: Database,
  repoPath: string,
  success: boolean,
  failureReason?: string,
): string[] {
  const flaggedForRevert: string[] = [];
  try {
    const kv = rawKVStore(db);
    for (const path of getActiveScopedOwnedSkillPaths(db, repoPath)) {
      recordOutcome(kv, path, success, failureReason);
      if (shouldAutoRevert(getScore(kv, path))) {
        flaggedForRevert.push(path);
      }
    }
  } catch {
    // Best-effort — see this function's own doc comment.
  }
  return flaggedForRevert;
}

/**
 * Reverts ONE scoped-owned file to whatever it looked like right
 * before its most recent self-mod — not a blanket `git revert HEAD`
 * (see agent/tools.ts's existing revert_last_edit tool for that
 * coarser, manually-triggered version), because other files may have
 * been committed in between and this should only ever touch the one
 * file that actually earned a "clearly worse" score.
 *
 * Two cases, both real git operations:
 *   - The file existed before its last self-mod -> restore that prior
 *     content (git checkout <parent> -- <path>).
 *   - The file did NOT exist before (the self-mod WAS its creation)
 *     -> remove it (git rm) — a skill that's clearly making things
 *     worse and never existed before this self-mod should simply go
 *     away, not be "restored" to a version that was never there.
 *
 * After a successful revert, resets that file's score (see
 * scoring.ts's resetScore doc comment for why) and logs a
 * code_revert modification, same ModificationType the existing manual
 * revert_last_edit tool uses.
 *
 * Never throws — called from a fire-and-forget-style follow-up after
 * a task already completed; a failed auto-revert attempt should be
 * logged, not allowed to take down whatever's calling it. Returns a
 * result object instead so the caller can decide what (if anything)
 * to do with a failure.
 */
export async function performAutoRevert(
  backend: BackendClient,
  db: Database,
  repoPath: string,
  filePath: string,
  reason: string,
  detail?: string,
): Promise<{ reverted: boolean; detail: string }> {
  try {
    const beforeCommit = await gitCommitBeforeLastChange(backend, repoPath, filePath);
    if (!beforeCommit) {
      return { reverted: false, detail: `No prior commit found for ${filePath} — nothing to revert to.` };
    }

    const existedBefore = await gitPathExistsAtRef(backend, repoPath, beforeCommit, filePath);
    if (existedBefore) {
      await gitCheckoutPathFromRef(backend, repoPath, beforeCommit, filePath);
    } else {
      const rmResult = await backend.exec(
        `cd ${escapeShellArg(repoPath)} && git rm -f ${escapeShellArg(filePath)} 2>&1`,
        10000,
      );
      if (rmResult.exitCode !== 0) {
        return { reverted: false, detail: `git rm failed for ${filePath}: ${rmResult.stderr || rmResult.stdout}` };
      }
    }

    await gitCommit(
      backend,
      repoPath,
      `auto-revert: ${filePath} (${reason})`,
    );

    if (/\.(ts|js|tsx|jsx)$/.test(filePath)) {
      try {
        await backend.exec(`cd ${escapeShellArg(repoPath)} && npm run build`, 60_000);
      } catch {
        // Same as editFile()'s own step 10 — a failed rebuild doesn't undo the revert itself.
      }
    }

    resetScore(rawKVStore(db), filePath);
    logModificationRaw(db, "code_revert", `Auto-reverted ${filePath}: ${reason}`, {
      filePath,
      reversible: true,
      diff: detail,
    });

    return { reverted: true, detail: existedBefore ? "Restored prior content." : "Removed (had no prior version)." };
  } catch (err) {
    return { reverted: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
