/**
 * Merge Policy
 *
 * The founder pushes to `main`. Every agent forks its own git history
 * the moment it self-modifies (see sync.ts). This file answers the one
 * question that makes reconciling those two things safe instead of
 * chaotic: for a given changed file, does EVERY agent need it
 * automatically, or does it only matter to the one agent (or handful
 * of agents) whose actual line of work it belongs to?
 *
 *   - "core"          — shared engine (everything outside skills/:
 *                        capability checks, orchestration, the self-mod
 *                        system itself, etc). Every agent's business
 *                        depends on this being correct and consistent,
 *                        so it is never something an individual agent's
 *                        local self-mod experiment should silently
 *                        diverge from. Always eligible for automatic
 *                        merge from `main`.
 *   - "scoped-owned"   — under skills/, and matches this agent's own
 *                        ownership manifest (scope.json). This is the
 *                        agent's actual business area — where it's
 *                        expected to have opinions, run experiments,
 *                        and occasionally know better than whatever's
 *                        on `main`.
 *   - "scoped-other"   — under skills/, but belongs to some OTHER
 *                        agent's business area (a different
 *                        department's skill living in the same shared
 *                        tree). Not this agent's concern at all — it's
 *                        deliberately never merged, never evaluated,
 *                        never even looked at by this agent's sync.
 *
 * The `skills/` split is a convention, not a hard technical boundary —
 * see scope.json's own comment for why a path-prefix split was chosen
 * over inventing a formal "department type" concept on the agent
 * runtime side, which doesn't otherwise exist there (that's an
 * office/org-chart concept on the backend, not something the agent's
 * own local git checkout has any notion of).
 */

import type { BackendClient } from "../types.js";
import fs from "node:fs";

export type FileClassification = "core" | "scoped-owned" | "scoped-other";

export interface ScopeManifest {
  ownedGlobs: string[];
}

const SKILLS_PREFIX = "skills/";
const DEFAULT_MANIFEST: ScopeManifest = { ownedGlobs: [`${SKILLS_PREFIX}distribution-agent/**`] };
const SCOPE_MANIFEST_PATH = "self-mod/scope.json";

function parseManifest(raw: string): ScopeManifest {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.ownedGlobs) || !parsed.ownedGlobs.every((g: unknown) => typeof g === "string")) {
    return DEFAULT_MANIFEST;
  }
  return { ownedGlobs: parsed.ownedGlobs };
}

/**
 * Reads this instance's own scope.json. Falls back to the built-in
 * default if the file is missing or malformed — a missing/broken
 * manifest should never silently widen what counts as "core" (i.e.
 * never fail open into "nothing is scoped, everything merges
 * automatically"); it should fail closed into the narrowest sensible
 * default instead.
 */
export async function readScopeManifest(backend: BackendClient, repoPath: string): Promise<ScopeManifest> {
  try {
    const raw = await backend.readFile(`${repoPath}/${SCOPE_MANIFEST_PATH}`);
    return parseManifest(raw);
  } catch {
    return DEFAULT_MANIFEST;
  }
}

/**
 * Synchronous counterpart to readScopeManifest(), for callers that
 * are themselves synchronous and run in the agent's own process (not
 * behind the BackendClient sandbox abstraction) — e.g.
 * orchestration/task-graph.ts's completeTask()/failTask(), which are
 * synchronous transactions against the raw sqlite handle and can't
 * await a BackendClient call without becoming async and rippling
 * through every one of their own callers. A direct fs read here is at
 * the same trust level as self-mod/code.ts's own direct
 * fs.existsSync/fs.realpathSync calls elsewhere in this package: it's
 * the agent reading its own local checkout, not reaching into a
 * remote sandbox.
 */
export function readScopeManifestSync(repoPath: string): ScopeManifest {
  try {
    const raw = fs.readFileSync(`${repoPath}/${SCOPE_MANIFEST_PATH}`, "utf8");
    return parseManifest(raw);
  } catch {
    return DEFAULT_MANIFEST;
  }
}

/**
 * Minimal glob matcher — only what scope.json actually needs
 * (directory-prefix globs ending in `/**`, or an exact path, or a
 * single-segment `*`). Deliberately not a general-purpose glob
 * library: the manifest is meant to be hand-written and reviewed by
 * whoever owns this agent instance, so keeping the matching rules
 * small enough to read in one sitting matters more than expressive
 * power here.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("**")
    .map((segment) =>
      segment
        .split("*")
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(filePath));
}

/**
 * Classify a single changed file path (relative to repo root, the
 * same form `git diff --name-only` already returns).
 */
export function classifyFile(filePath: string, manifest: ScopeManifest): FileClassification {
  if (!filePath.startsWith(SKILLS_PREFIX)) {
    return "core";
  }
  return matchesAnyGlob(filePath, manifest.ownedGlobs) ? "scoped-owned" : "scoped-other";
}

export function classifyFiles(
  filePaths: string[],
  manifest: ScopeManifest,
): Record<FileClassification, string[]> {
  const result: Record<FileClassification, string[]> = { core: [], "scoped-owned": [], "scoped-other": [] };
  for (const filePath of filePaths) {
    result[classifyFile(filePath, manifest)].push(filePath);
  }
  return result;
}
