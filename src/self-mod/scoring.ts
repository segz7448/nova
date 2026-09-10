/**
 * Self-Mod Scoring
 *
 * Deciding "founder's edit vs. my self-mod, which one wins" by
 * authority (founder always wins) throws away real information when
 * the agent's version is actually better — see this repo's own design
 * conversation on why that's the wrong default. Deciding it by
 * "whichever is newer" is just as arbitrary. The only defensible
 * signal is "which one actually performs better at the job it's for,"
 * so this file gives sync.ts a small, honest, inspectable version of
 * that: a per-file running tally of outcomes, stored in the agent's
 * own local KV store (AutomatonDatabase.getKV/setKV — the same
 * general-purpose store already used elsewhere in this codebase, no
 * new storage mechanism needed).
 *
 * This is deliberately NOT a claim of rigorous experimentation (no
 * control group, no statistical test) — it's the simplest version of
 * "did this file's own self-modification make things better or worse,
 * according to the agent's own subsequent task outcomes." Call
 * recordOutcome() from wherever a skill/behavior backed by a
 * self-modified file actually gets used and its result is known (that
 * wiring is scoped separately — see this file's own TODO below) so the
 * score reflects real usage, not a guess made at edit time.
 */

/**
 * The only two members of AutomatonDatabase this file actually uses.
 * Narrowed on purpose (rather than importing AutomatonDatabase
 * itself) so a lightweight adapter over the raw better-sqlite3 handle
 * — see task-outcome.ts, used from orchestration/task-graph.ts where
 * only the raw handle is in scope, not the full AutomatonDatabase
 * wrapper — can satisfy this structurally without implementing (or
 * stubbing) the rest of AutomatonDatabase's much larger surface.
 */
export interface KVStore {
  getKV(key: string): string | undefined;
  setKV(key: string, value: string): void;
}

const KV_PREFIX = "selfmod:score:";
const MAX_RECENT_REASONS = 5;
const MAX_REASON_LENGTH = 300;

export interface OutcomeScore {
  success: number;
  failure: number;
}

function kvKey(filePath: string, field: "success" | "failure" | "reasons"): string {
  return `${KV_PREFIX}${filePath}:${field}`;
}

function readCount(db: KVStore, filePath: string, field: "success" | "failure"): number {
  const raw = db.getKV(kvKey(filePath, field));
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function readReasons(db: KVStore, filePath: string): string[] {
  const raw = db.getKV(kvKey(filePath, "reasons"));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Record one outcome for a scoped file this agent has self-modified.
 *
 * `reason` is the actual failure message from the task that just
 * exercised this file (task-graph.ts's failTask() already has this —
 * see its own `error` parameter) — stored so a later auto-revert's
 * audit entry can say WHY, not just THAT, a skill got reverted.
 * Capped to the MAX_RECENT_REASONS most recent (oldest dropped first)
 * so this stays a small, bounded diagnostic trail rather than an
 * ever-growing log; each reason is itself truncated to
 * MAX_REASON_LENGTH so one verbose stack trace can't dominate it.
 * Ignored on a success (there's nothing to explain).
 */
export function recordOutcome(db: KVStore, filePath: string, success: boolean, reason?: string): void {
  const field = success ? "success" : "failure";
  const current = readCount(db, filePath, field);
  db.setKV(kvKey(filePath, field), String(current + 1));

  if (!success && reason) {
    const collapsed = reason.replace(/\s+/g, " ").trim();
    const trimmed = collapsed.length > MAX_REASON_LENGTH ? `${collapsed.slice(0, MAX_REASON_LENGTH)}…` : collapsed;
    const reasons = [...readReasons(db, filePath), trimmed].slice(-MAX_RECENT_REASONS);
    db.setKV(kvKey(filePath, "reasons"), JSON.stringify(reasons));
  }
}

/**
 * The most recent recorded failure reasons for a file, oldest first,
 * capped at MAX_RECENT_REASONS — see recordOutcome()'s own doc
 * comment. Read by self-mod/task-outcome.ts's applyFlaggedAutoReverts()
 * to build a real, specific reason for an auto-revert's audit entry
 * instead of a generic "repeated failures" placeholder.
 */
export function getRecentFailureReasons(db: KVStore, filePath: string): string[] {
  return readReasons(db, filePath);
}

export function getScore(db: KVStore, filePath: string): OutcomeScore {
  return {
    success: readCount(db, filePath, "success"),
    failure: readCount(db, filePath, "failure"),
  };
}

/**
 * Clears a file's recorded outcomes (including its stored failure
 * reasons). Called after a successful auto-revert (see self-mod/
 * task-outcome.ts's performAutoRevert) — the version now in place is
 * no longer the one that earned this failure history, so it should be
 * evaluated fresh rather than starting out already looking "clearly
 * bad" (or carrying stale reasons) from its predecessor's record.
 */
export function resetScore(db: KVStore, filePath: string): void {
  db.setKV(kvKey(filePath, "success"), "0");
  db.setKV(kvKey(filePath, "failure"), "0");
  db.setKV(kvKey(filePath, "reasons"), "[]");
}

/**
 * A local self-mod only overrides an incoming upstream change to the
 * same file when it has real, clearly-net-positive evidence behind
 * it — not merely "no evidence against it yet." Thresholds are
 * deliberately conservative: a brand-new, never-exercised self-mod
 * (0 successes recorded) should NOT win against `main` just because
 * it hasn't failed yet. Absence of evidence is not evidence.
 */
const MIN_SUCCESSES_TO_OVERRIDE = 3;
const MIN_SUCCESS_RATIO_TO_OVERRIDE = 0.75; // successes / (successes + failures)

export function localSelfModShouldWin(score: OutcomeScore): boolean {
  const total = score.success + score.failure;
  if (score.success < MIN_SUCCESSES_TO_OVERRIDE) return false;
  return score.success / total >= MIN_SUCCESS_RATIO_TO_OVERRIDE;
}

/**
 * The inverse case: not "is this self-mod good enough to keep over
 * main," but "is this self-mod clearly bad enough to undo on its
 * own." Same conservatism, mirrored: a handful of failures right
 * after a self-mod could just be noise (the task itself was hard,
 * unrelated infra hiccup, whatever) — auto-revert needs a real,
 * accumulated pattern, not one bad run. Requiring a minimum failure
 * count before reverting is the same "absence of evidence is not
 * evidence" principle as MIN_SUCCESSES_TO_OVERRIDE above, applied to
 * the failure side: zero-or-one failures is not yet a pattern.
 */
const MIN_FAILURES_TO_REVERT = 3;
const MAX_SUCCESS_RATIO_TO_REVERT = 0.25; // successes / (successes + failures)

export function shouldAutoRevert(score: OutcomeScore): boolean {
  const total = score.success + score.failure;
  if (score.failure < MIN_FAILURES_TO_REVERT) return false;
  return score.success / total <= MAX_SUCCESS_RATIO_TO_REVERT;
}
