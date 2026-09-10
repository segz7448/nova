/**
 * Skills Registry
 *
 * Install skills from remote sources:
 * - Git repos: git clone <url> ~/.automaton/skills/<name>
 * - URLs: fetch a SKILL.md from any URL
 * - Self-created: the automaton writes its own SKILL.md files
 *
 * All shell commands use execFileSync with argument arrays to prevent injection.
 * Directory operations use fs.* to avoid shell interpolation entirely.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import * as yaml from "yaml";
import type {
  Skill,
  SkillSource,
  AutomatonDatabase,
  BackendClient,
} from "../types.js";
import { parseSkillMd } from "./format.js";
import {
  assertSafeRemoteUrl,
  curlResolveArgs,
  GIT_GLOBAL_HARDENED_ARGS,
  GIT_CLONE_HARDENED_FLAGS,
  GIT_CLONE_HARDENED_ENV,
} from "../security/safe-remote-url.js";

// Validation patterns to prevent injection via path/URL arguments
const SKILL_NAME_RE = /^[a-zA-Z0-9-]+$/;
const SAFE_URL_RE = /^https?:\/\/[^\s;|&$`(){}<>]+$/;

// Size limits for skill content
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_INSTRUCTIONS_LENGTH = 10_000;

/**
 * Validate that a skill path does not escape the skills directory.
 * Prevents path traversal attacks via crafted skill names.
 */
function validateSkillPath(skillsDir: string, name: string): string {
  const resolved = path.resolve(skillsDir, name);
  if (!resolved.startsWith(path.resolve(skillsDir) + path.sep)) {
    throw new Error(`Skill path traversal detected: ${name}`);
  }
  return resolved;
}

/**
 * Install a skill from a git repository.
 * Clones the repo into ~/.automaton/skills/<name>/
 * Uses execFileSync with argument arrays to prevent shell injection.
 */
export async function installSkillFromGit(
  repoUrl: string,
  name: string,
  skillsDir: string,
  db: AutomatonDatabase,
  _backend: BackendClient,
): Promise<Skill | null> {
  // Validate inputs to prevent injection
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`);
  }
  if (!SAFE_URL_RE.test(repoUrl)) {
    throw new Error(`Invalid repo URL: "${repoUrl}". Must be an http(s) URL with no shell metacharacters.`);
  }
  // DNS check happens as close to the clone as this function's control
  // flow allows (nothing else awaits/does I/O in between) to minimize —
  // though, per assertSafeRemoteUrl's own doc comment, not eliminate —
  // the DNS-rebinding TOCTOU window: git's HTTP transport re-resolves
  // the hostname itself and has no supported way to pin to the address
  // validated here.
  await assertSafeRemoteUrl(repoUrl);

  const resolvedDir = resolveHome(skillsDir);
  const targetDir = validateSkillPath(resolvedDir, name);

  // Clone using execFileSync with argument array (no shell interpolation).
  // GIT_GLOBAL_HARDENED_ARGS (http.followRedirects=false) blocks the
  // redirect-based SSRF variant; GIT_CLONE_HARDENED_FLAGS/ENV lock down
  // submodules, credential prompts, and ambient gitconfig. See
  // safe-remote-url.ts for what this does and doesn't close.
  try {
    execFileSync(
      "git",
      [
        ...GIT_GLOBAL_HARDENED_ARGS,
        "clone",
        "--depth",
        "1",
        ...GIT_CLONE_HARDENED_FLAGS,
        repoUrl,
        targetDir,
      ],
      {
        encoding: "utf-8",
        timeout: 60_000,
        env: { ...process.env, ...GIT_CLONE_HARDENED_ENV },
      },
    );
  } catch (err: any) {
    throw new Error(`Failed to clone skill repo: ${err.message}`);
  }

  // Read SKILL.md using fs (no shell needed)
  const skillMdPath = path.join(targetDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`No SKILL.md found in cloned repo at ${skillMdPath}`);
  }

  const content = fs.readFileSync(skillMdPath, "utf-8");
  const skill = parseSkillMd(content, skillMdPath, "git");
  if (!skill) {
    throw new Error("Failed to parse SKILL.md from cloned repo");
  }

  db.upsertSkill(skill);
  return skill;
}

/**
 * Install a skill from a URL (fetches a single SKILL.md).
 * Uses execFileSync with argument arrays and fs.* for safe operations.
 */
export async function installSkillFromUrl(
  url: string,
  name: string,
  skillsDir: string,
  db: AutomatonDatabase,
  _backend: BackendClient,
): Promise<Skill | null> {
  // Validate inputs to prevent injection
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`);
  }
  if (!SAFE_URL_RE.test(url)) {
    throw new Error(`Invalid URL: "${url}". Must be an http(s) URL with no shell metacharacters.`);
  }
  const { url: safeUrl, addresses } = await assertSafeRemoteUrl(url);

  const resolvedDir = resolveHome(skillsDir);
  const targetDir = validateSkillPath(resolvedDir, name);
  const skillMdPath = path.join(targetDir, "SKILL.md");

  // Create directory using fs (no shell needed)
  fs.mkdirSync(targetDir, { recursive: true });

  // Fetch SKILL.md using execFileSync with argument array (no shell
  // interpolation). curlResolveArgs (--resolve) pins the connection to
  // the exact address(es) assertSafeRemoteUrl just validated, closing
  // the DNS-rebinding TOCTOU gap for this call: curl no longer does its
  // own independent (and independently rebindable) DNS lookup for this
  // host, while --proto/--proto-redir still keep it from ever landing on
  // anything but http(s) even via a redirect chain.
  try {
    execFileSync(
      "curl",
      [
        "-fsS",
        "--max-time",
        "30",
        "--max-filesize",
        "1048576",
        "--proto",
        "=http,https",
        "--proto-redir",
        "=http,https",
        ...curlResolveArgs(safeUrl, addresses),
        "-o",
        skillMdPath,
        safeUrl.toString(),
      ],
      {
        encoding: "utf-8",
        timeout: 30_000,
      },
    );
  } catch (err: any) {
    throw new Error(`Failed to fetch SKILL.md from URL: ${err.message}`);
  }

  // Read content using fs (no shell needed)
  const content = fs.readFileSync(skillMdPath, "utf-8");
  const skill = parseSkillMd(content, skillMdPath, "url");
  if (!skill) {
    throw new Error("Failed to parse fetched SKILL.md");
  }

  db.upsertSkill(skill);
  return skill;
}

/**
 * Create a new skill authored by the automaton itself.
 * Uses fs.* for directory creation and file writing (no shell needed).
 */
export async function createSkill(
  name: string,
  description: string,
  instructions: string,
  skillsDir: string,
  db: AutomatonDatabase,
  backend: BackendClient,
): Promise<Skill> {
  // Validate name to prevent path traversal/injection
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`);
  }

  // Enforce size limits
  const safeDescription = description.slice(0, MAX_DESCRIPTION_LENGTH);
  const safeInstructions = instructions.slice(0, MAX_INSTRUCTIONS_LENGTH);

  const resolvedDir = resolveHome(skillsDir);
  const targetDir = validateSkillPath(resolvedDir, name);

  // Create directory using fs (no shell needed)
  fs.mkdirSync(targetDir, { recursive: true });

  // Generate YAML frontmatter safely using yaml.stringify (prevents YAML injection)
  const frontmatter = yaml.stringify({
    name,
    description: safeDescription,
    "auto-activate": true,
  });
  const content = `---\n${frontmatter}---\n\n${safeInstructions}`;

  const skillMdPath = path.join(targetDir, "SKILL.md");
  await backend.writeFile(skillMdPath, content);

  const skill: Skill = {
    name,
    description: safeDescription,
    autoActivate: true,
    instructions: safeInstructions,
    source: "self",
    path: skillMdPath,
    enabled: true,
    installedAt: new Date().toISOString(),
  };

  db.upsertSkill(skill);
  return skill;
}

/**
 * Remove a skill (disable in DB and optionally delete from disk).
 * Uses fs.rmSync for safe file deletion (no shell needed).
 */
export async function removeSkill(
  name: string,
  db: AutomatonDatabase,
  _backend: BackendClient,
  skillsDir: string,
  deleteFiles: boolean = false,
): Promise<void> {
  // Validate name to prevent path traversal/injection
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`);
  }

  db.removeSkill(name);

  if (deleteFiles) {
    const resolvedDir = resolveHome(skillsDir);
    const targetDir = validateSkillPath(resolvedDir, name);
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
}

/**
 * List all installed skills.
 */
export function listSkills(db: AutomatonDatabase): Skill[] {
  return db.getSkills();
}

function resolveHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}
