/**
 * Git Tools
 *
 * Built-in git operations for the automaton.
 * Used for both state versioning and code development.
 */

import type { BackendClient, GitStatus, GitLogEntry } from "../types.js";

/**
 * Get git status for a repository.
 */
export async function gitStatus(
  backend: BackendClient,
  repoPath: string,
): Promise<GitStatus> {
  const result = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git status --porcelain -b 2>/dev/null`,
    10000,
  );

  const lines = result.stdout.split("\n").filter(Boolean);
  let branch = "unknown";
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = line.slice(3).split("...")[0];
      continue;
    }

    const statusCode = line.slice(0, 2);
    const file = line.slice(3);

    if (statusCode[0] !== " " && statusCode[0] !== "?") {
      staged.push(file);
    }
    if (statusCode[1] === "M" || statusCode[1] === "D") {
      modified.push(file);
    }
    if (statusCode === "??") {
      untracked.push(file);
    }
  }

  return {
    branch,
    staged,
    modified,
    untracked,
    clean:
      staged.length === 0 && modified.length === 0 && untracked.length === 0,
  };
}

/**
 * Get git diff output.
 */
export async function gitDiff(
  backend: BackendClient,
  repoPath: string,
  staged: boolean = false,
): Promise<string> {
  const flag = staged ? "--cached" : "";
  const result = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git diff ${flag} 2>/dev/null`,
    10000,
  );
  return result.stdout || "(no changes)";
}

/**
 * Create a git commit.
 */
export async function gitCommit(
  backend: BackendClient,
  repoPath: string,
  message: string,
  addAll: boolean = true,
): Promise<string> {
  if (addAll) {
    await backend.exec(`cd ${escapeShellArg(repoPath)} && git add -A`, 10000);
  }

  const result = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git commit -m ${escapeShellArg(message)} --allow-empty 2>&1`,
    10000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Git commit failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

/**
 * Get git log.
 */
export async function gitLog(
  backend: BackendClient,
  repoPath: string,
  limit: number = 10,
): Promise<GitLogEntry[]> {
  const safeLimit = Math.max(1, Math.floor(Number(limit))) || 10;
  const result = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git log --format="%H|%s|%an|%ai" -n ${safeLimit} 2>/dev/null`,
    10000,
  );

  if (!result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, message, author, date] = line.split("|");
      return { hash, message, author, date };
    });
}

/**
 * Push to remote.
 */
export async function gitPush(
  backend: BackendClient,
  repoPath: string,
  remote: string = "origin",
  branch?: string,
): Promise<string> {
  const branchArg = branch ? ` ${escapeShellArg(branch)}` : "";
  const result = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git push ${escapeShellArg(remote)}${branchArg} 2>&1`,
    30000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Git push failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout || "Push successful";
}

/**
 * Fetch from a remote without merging — used to check what's changed
 * upstream before deciding how (or whether) to bring it in. See
 * self-mod/sync.ts for the selective-merge flow built on top of this.
 */
export async function gitFetch(
  backend: BackendClient,
  repoPath: string,
  remote: string = "origin",
  ref?: string,
): Promise<string> {
  const refArg = ref ? ` ${escapeShellArg(ref)}` : "";
  const result = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git fetch ${escapeShellArg(remote)}${refArg} 2>&1`,
    30000,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Git fetch failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout || "Fetch successful";
}

/**
 * List files that differ between two refs (e.g. HEAD and
 * origin/main), without merging anything. self-mod/merge-policy.ts
 * classifies each returned path so the caller can decide what to do
 * with it — this function itself makes no merge decision.
 */
export async function gitDiffNameOnly(
  backend: BackendClient,
  repoPath: string,
  fromRef: string,
  toRef: string,
): Promise<string[]> {
  const result = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git diff --name-only ${escapeShellArg(fromRef)} ${escapeShellArg(toRef)} 2>&1`,
    15000,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Git diff failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim() ? result.stdout.trim().split("\n") : [];
}

/**
 * Checks out ONE path's content from a given ref into the working
 * tree and stages it — the primitive self-mod/sync.ts's selective
 * merge is built from. Deliberately narrower than `git merge`, which
 * has no path filter of its own: sync.ts needs to take a shared/core
 * file's upstream version while leaving an agent's own scoped files
 * (a different agent's business area, or this agent's own
 * not-yet-evaluated self-mod) completely untouched, which a full
 * repo-wide merge can't do by itself.
 */
export async function gitCheckoutPathFromRef(
  backend: BackendClient,
  repoPath: string,
  ref: string,
  relativePath: string,
): Promise<void> {
  const result = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git checkout ${escapeShellArg(ref)} -- ${escapeShellArg(relativePath)} 2>&1`,
    10000,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Git checkout of ${relativePath} from ${ref} failed: ${result.stderr || result.stdout}`);
  }
}

/**
 * True if `relativePath` differs between the agent's own current HEAD
 * and the branch/commit it last diverged from (mergeBaseRef) — i.e.
 * "did I locally modify this file since we last agreed with upstream."
 * Used to detect a real conflict (both sides touched the same file)
 * versus a one-sided change (safe to take automatically).
 */
export async function gitPathChangedSince(
  backend: BackendClient,
  repoPath: string,
  mergeBaseRef: string,
  relativePath: string,
): Promise<boolean> {
  const result = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git diff --quiet ${escapeShellArg(mergeBaseRef)} HEAD -- ${escapeShellArg(relativePath)}; echo $?`,
    10000,
  );
  // `git diff --quiet` exits 1 if there IS a difference, 0 if there is none.
  return result.stdout.trim().endsWith("1");
}

/**
 * Read the remote's URL (credentials stripped) through backend.exec(),
 * consistent with every other function in this file. self-mod/
 * upstream.ts's getRepoInfo() reads the same value via a direct
 * execFileSync call against the host process instead — fine for its
 * own read-only use, but this file's callers (sync.ts) need the
 * dependency-injected BackendClient path for testability.
 */
export async function getRemoteUrl(
  backend: BackendClient,
  repoPath: string,
  remote: string = "origin",
): Promise<string> {
  const result = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git config --get remote.${remote}.url 2>&1`,
    10000,
  );
  return result.stdout.trim().replace(/\/\/[^@]+@/, "//");
}

/**
 * The commit immediately BEFORE the most recent change to one
 * specific path — i.e. "what this file looked like right before its
 * last self-mod." Returns null if the path has no history at all
 * (never committed) or its most recent touch was the repo's very
 * first commit (nothing to go back to).
 */
export async function gitCommitBeforeLastChange(
  backend: BackendClient,
  repoPath: string,
  relativePath: string,
): Promise<string | null> {
  const lastCommit = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git log -1 --format=%H -- ${escapeShellArg(relativePath)} 2>&1`,
    10000,
  );
  const hash = lastCommit.stdout.trim();
  if (!hash) return null;

  const parent = await backend.exec(`cd ${escapeShellArg(repoPath)} && git rev-parse ${hash}^ 2>&1`, 10000);
  return parent.exitCode === 0 ? parent.stdout.trim() : null;
}

/**
 * Whether `relativePath` existed in the tree at `ref` — used to tell
 * "the file existed before, restore its prior content" apart from
 * "the file was newly created by the self-mod being reverted, so
 * reverting means removing it" (self-mod/task-outcome.ts's
 * performAutoRevert branches on this).
 */
export async function gitPathExistsAtRef(
  backend: BackendClient,
  repoPath: string,
  ref: string,
  relativePath: string,
): Promise<boolean> {
  const result = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git cat-file -e ${escapeShellArg(`${ref}:${relativePath}`)} 2>&1; echo EXIT:$?`,
    10000,
  );
  return result.stdout.includes("EXIT:0");
}

/**
 * Manage branches.
 */
export async function gitBranch(
  backend: BackendClient,
  repoPath: string,
  action: "list" | "create" | "checkout" | "delete",
  branchName?: string,
): Promise<string> {
  let cmd: string;

  if (action !== "list") {
    if (!branchName) throw new Error("Branch name required");
    // Runtime agents are never allowed to mutate the founder baseline or
    // another agent's namespace through the generic branch tool.
    if (branchName === "main" || branchName === "master") {
      throw new Error("branch isolation: agents cannot mutate founder branch");
    }
    if (!branchName.startsWith("agent/")) {
      throw new Error("branch isolation: branch must be under agent/<identity>/");
    }
  }

  switch (action) {
    case "list":
      cmd = `cd ${escapeShellArg(repoPath)} && git branch -a 2>/dev/null`;
      break;
    case "create":
      if (!branchName) throw new Error("Branch name required");
      cmd = `cd ${escapeShellArg(repoPath)} && git checkout -b ${escapeShellArg(branchName)} 2>&1`;
      break;
    case "checkout":
      if (!branchName) throw new Error("Branch name required");
      cmd = `cd ${escapeShellArg(repoPath)} && git checkout ${escapeShellArg(branchName)} 2>&1`;
      break;
    case "delete":
      if (!branchName) throw new Error("Branch name required");
      cmd = `cd ${escapeShellArg(repoPath)} && git branch -d ${escapeShellArg(branchName)} 2>&1`;
      break;
    default:
      throw new Error(`Unknown branch action: ${action}`);
  }

  const result = await backend.exec(cmd, 10000);
  return result.stdout || result.stderr || "Done";
}

/**
 * Clone a repository.
 */
export async function gitClone(
  backend: BackendClient,
  url: string,
  targetPath: string,
  depth?: number,
): Promise<string> {
  const depthArg = depth
    ? ` --depth ${Math.max(1, Math.floor(Number(depth)))}`
    : "";
  const result = await backend.exec(
    `git clone${depthArg} ${escapeShellArg(url)} ${escapeShellArg(targetPath)} 2>&1`,
    120000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Git clone failed: ${result.stderr || result.stdout}`);
  }

  return `Cloned ${url} to ${targetPath}`;
}

/**
 * Initialize a git repository.
 */
export async function gitInit(
  backend: BackendClient,
  repoPath: string,
): Promise<string> {
  const result = await backend.exec(
    `cd ${escapeShellArg(repoPath)} && git init 2>&1`,
    10000,
  );
  return result.stdout || "Git initialized";
}

export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
