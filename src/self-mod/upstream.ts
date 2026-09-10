/**
 * Upstream Awareness
 *
 * Helpers for the automaton to know its own git origin,
 * detect new upstream commits, and review diffs.
 * All git commands use execFileSync with argument arrays to prevent injection.
 */

import { execFileSync } from "child_process";

const REPO_ROOT = process.cwd();

/**
 * Run a git command using execFileSync with argument array (no shell interpolation).
 */
function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 15_000,
  }).trim();
}

/**
 * Return origin URL (credentials stripped), current branch, and HEAD info.
 */
export function getRepoInfo(): {
  originUrl: string;
  branch: string;
  headHash: string;
  headMessage: string;
} {
  const rawUrl = git(["config", "--get", "remote.origin.url"]);
  // Strip embedded credentials (https://user:token@host/... -> https://host/...)
  const originUrl = rawUrl.replace(/\/\/[^@]+@/, "//");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const headLine = git(["log", "-1", "--format=%h %s"]);
  const [headHash, ...rest] = headLine.split(" ");
  return { originUrl, branch, headHash, headMessage: rest.join(" ") };
}

/**
 * The repo URL to clone when provisioning a new sandbox (child spawn,
 * self-replication). Resolution order:
 *   1. AUTOMATON_REPO_URL env var — explicit override, useful when the
 *      child can't reach the parent's git remote the same way (e.g. a
 *      private host reachable only via SSH key the child doesn't have)
 *      and you'd rather point it at a public mirror/fork you own.
 *   2. This instance's own `git remote origin` — the default, and the
 *      right choice for the overwhelming majority of deployments: a
 *      child just gets exactly the code the parent is running.
 * No hardcoded fallback to any third party's repository — if neither
 * is available, this throws so the caller gets a clear, actionable
 * error instead of silently cloning code the operator never chose.
 */
export function getRuntimeRepoUrl(): string {
  const override = process.env.AUTOMATON_REPO_URL?.trim();
  if (override) return override;

  try {
    const { originUrl } = getRepoInfo();
    if (originUrl) return originUrl;
  } catch {
    // fall through to the error below
  }

  throw new Error(
    "No repo URL configured for provisioning new sandboxes. Set the " +
      "AUTOMATON_REPO_URL environment variable, or run this automaton " +
      "from a git checkout that has a 'origin' remote configured " +
      "(git remote add origin <your-repo-url>).",
  );
}

/**
 * Fetch origin and report how many commits we're behind.
 */
export function checkUpstream(): {
  behind: number;
  commits: { hash: string; message: string }[];
} {
  git(["fetch", "origin", "main", "--quiet"]);
  const log = git(["log", "HEAD..origin/main", "--oneline"]);
  if (!log) return { behind: 0, commits: [] };
  const commits = log.split("\n").map((line) => {
    const [hash, ...rest] = line.split(" ");
    return { hash, message: rest.join(" ") };
  });
  return { behind: commits.length, commits };
}

/**
 * Return per-commit diffs for every commit ahead of HEAD on origin/main.
 */
export function getUpstreamDiffs(): {
  hash: string;
  message: string;
  author: string;
  diff: string;
}[] {
  const log = git(["log", "HEAD..origin/main", "--format=%H %an|||%s"]);
  if (!log) return [];

  return log.split("\n").map((line) => {
    const [hashAndAuthor, message] = line.split("|||");
    const parts = hashAndAuthor.split(" ");
    const hash = parts[0];
    const author = parts.slice(1).join(" ");
    let diff: string;
    try {
      diff = git(["diff", `${hash}~1..${hash}`]);
    } catch {
      // First commit in the range may not have a parent
      diff = git(["show", hash, "--format=", "--stat"]);
    }
    return { hash: hash.slice(0, 12), message, author, diff };
  });
}
