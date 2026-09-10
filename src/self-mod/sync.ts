/**
 * Self-Mod Sync
 *
 * Two flows, both built on the existing git primitives in
 * ../git/tools.ts:
 *
 *   1. pushSelfModBranch() — an agent's self-modifications are never
 *      pushed straight to `main`. They go to this agent's own branch
 *      (`agent/<address>/self-mod`), where they're a real, reviewable
 *      diff the founder (or an automated policy) can promote into
 *      `main` later — never something that unilaterally becomes the
 *      shared baseline the moment one agent decides it likes its own
 *      change.
 *
 *   2. syncFromMain() — the reverse direction. Pulling in `main`
 *      wholesale (a plain `git merge origin/main`) is wrong here for a
 *      reason specific to this codebase: `main` may contain another
 *      agent's scoped skill work that this agent has no business
 *      touching (different department, different line of work — see
 *      merge-policy.ts). So this doesn't call `git merge` at all; it
 *      walks the changed-file list, classifies each path, and applies
 *      a different rule per classification:
 *        - core            -> always taken from origin/main
 *        - scoped-owned    -> taken from origin/main UNLESS this
 *                             agent's own self-mod of that same file
 *                             has real, positive evidence behind it
 *                             (scoring.ts) — a genuine conflict,
 *                             resolved by which version performs
 *                             better, not by who pushed last
 *        - scoped-other    -> never even looked at
 */

import type { AutomatonDatabase, BackendClient } from "../types.js";
import {
  gitFetch,
  gitDiffNameOnly,
  gitCheckoutPathFromRef,
  gitPathChangedSince,
  gitBranch,
  gitPush,
  gitCommit,
  getRemoteUrl,
} from "../git/tools.js";
import { classifyFiles, readScopeManifest } from "./merge-policy.js";
import { getScore, localSelfModShouldWin } from "./scoring.js";
import { logModification } from "./audit-log.js";

export interface SyncReport {
  takenFromMain: string[]; // core + scoped-owned files that were checked out from origin/main
  keptLocal: string[]; // scoped-owned files where this agent's own self-mod won a real conflict
  skipped: string[]; // scoped-other files, never touched
  conflicts: { filePath: string; resolution: "took-main" | "kept-local" }[];
}

function selfModBranchName(address: string): string {
  const safe = address.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  if (!safe || safe === "main" || safe === "master") throw new Error("invalid agent identity for self-mod branch");
  return `agent/${safe}/self-mod`;
}

/**
 * Push this agent's current self-modifications to its OWN branch —
 * never to `main`. Creates the branch on first use, otherwise just
 * commits + pushes to the branch that's already there.
 *
 * Called automatically from code.ts's editFile() after a successful
 * edit to a scoped-owned file (see that file's own wiring) — "the
 * agent pushes its own fix," not a supervisor doing it on the agent's
 * behalf, per this repo's own design conversation. Edits to core files
 * deliberately do NOT auto-push here (see editFile()'s own comment on
 * why); this function will still push whatever's committed if called
 * directly, so that omission lives at the call site, not in here.
 */
export async function pushSelfModBranch(
  backend: BackendClient,
  repoPath: string,
  address: string,
  reason: string,
): Promise<{ branch: string; promotionUrl: string | null }> {
  const branch = selfModBranchName(address);

  // Agents may only ever operate on their own namespaced branch. The
  // first branch is based on origin/main; an existing branch is checked
  // out only when its exact name matches the derived identity.
  try {
    await gitBranch(backend, repoPath, "create", branch);
  } catch {
    await gitBranch(backend, repoPath, "checkout", branch);
  }

  const current = await backend.exec(`cd ${JSON.stringify(repoPath)} && git branch --show-current`, 10000);
  if (current.stdout.trim() !== branch) {
    throw new Error("self-modification refused: repository is not on the agent's dedicated branch");
  }

  await gitCommit(backend, repoPath, `self-mod: ${reason}`);
  await gitPush(backend, repoPath, "origin", branch);

  let promotionUrl: string | null = null;
  try {
    const originUrl = await getRemoteUrl(backend, repoPath, "origin");
    promotionUrl = buildCompareUrl(originUrl, branch);
  } catch {
    // Promotion URL is a convenience, not load-bearing — the push above already succeeded.
  }

  return { branch, promotionUrl };
}

/**
 * Builds a GitHub compare-to-PR URL for this agent's branch against
 * `main` — a plain link, not an API call, so it needs no token and
 * works the same whether a human or an automated promotion policy
 * clicks it. Returns null for a non-GitHub remote (e.g. a bare local
 * path in tests) rather than guessing at a URL shape that doesn't apply.
 */
export function buildCompareUrl(originUrl: string, branch: string): string | null {
  const match = originUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) return null;
  const [, owner, repo] = match;
  return `https://github.com/${owner}/${repo}/compare/main...${encodeURIComponent(branch)}?expand=1`;
}

/**
 * Pull in what this agent needs from `main` — core files always,
 * this agent's own scoped files when they don't have a real,
 * evidenced local override. Everything else (another agent's scoped
 * work) is left completely alone.
 *
 * `mergeBaseRef` should be whatever ref represents "the last commit
 * this agent's own branch and `main` both agreed on" — ordinarily
 * `git merge-base HEAD origin/main`, computed by the caller so this
 * function stays a pure "given these two refs, do the selective
 * merge" operation rather than one more place that decides how to
 * find a merge-base.
 */
export async function syncFromMain(
  backend: BackendClient,
  db: AutomatonDatabase,
  repoPath: string,
  mergeBaseRef: string,
): Promise<SyncReport> {
  await gitFetch(backend, repoPath, "origin", "main");

  const changedFiles = await gitDiffNameOnly(backend, repoPath, "HEAD", "origin/main");
  const manifest = await readScopeManifest(backend, repoPath);
  const classified = classifyFiles(changedFiles, manifest);

  const report: SyncReport = { takenFromMain: [], keptLocal: [], skipped: [...classified["scoped-other"]], conflicts: [] };

  // Core: always taken from origin/main, no conflict evaluation at
  // all — an agent's own local edit to a core file (if it happened;
  // core self-mod isn't the intended flow, see code.ts) never gets to
  // out-rank the shared baseline the way a scoped-owned file's proven
  // self-mod can.
  for (const filePath of classified.core) {
    await gitCheckoutPathFromRef(backend, repoPath, "origin/main", filePath);
    report.takenFromMain.push(filePath);
  }

  // Scoped-owned: only a real conflict (this agent ALSO changed the
  // same file since the merge-base) gets evaluated by evidence.
  // Everything else is either a clean one-sided upstream change (take
  // it) or a clean one-sided local change (nothing to do, it's
  // already in the working tree).
  for (const filePath of classified["scoped-owned"]) {
    const changedLocally = await gitPathChangedSince(backend, repoPath, mergeBaseRef, filePath);
    if (!changedLocally) {
      await gitCheckoutPathFromRef(backend, repoPath, "origin/main", filePath);
      report.takenFromMain.push(filePath);
      continue;
    }

    const score = getScore(db, filePath);
    if (localSelfModShouldWin(score)) {
      report.keptLocal.push(filePath);
      report.conflicts.push({ filePath, resolution: "kept-local" });
    } else {
      await gitCheckoutPathFromRef(backend, repoPath, "origin/main", filePath);
      report.takenFromMain.push(filePath);
      report.conflicts.push({ filePath, resolution: "took-main" });
    }
  }

  if (report.takenFromMain.length > 0) {
    await gitCommit(
      backend,
      repoPath,
      `sync: merged ${report.takenFromMain.length} file(s) from origin/main ` +
        `(${report.conflicts.length} resolved conflict(s), ${report.skipped.length} other-agent file(s) skipped)`,
    );
    logModification(db, "code_edit", "selective sync from origin/main", {
      diff: JSON.stringify(report).slice(0, 10_000),
      reversible: true,
    });
  }

  return report;
}
