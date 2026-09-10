/**
 * Package Registry Adapter
 *
 * A fourth distribution-channel adapter alongside social_api / webhook /
 * git_pr: pushes an already-built artifact to a real package registry
 * using the registry's own official publish tooling and a token scoped
 * to the agent's own account. It does not build the artifact — the
 * caller must already have produced the `.tgz` / wheel-or-sdist /
 * `.vsix` / release zip on disk (see distribution-agent SKILL.md).
 *
 * Design notes:
 *  - Every credential is passed via env vars to the child process, never
 *    as a CLI argument — argv is visible to anything that can read
 *    /proc or `ps` on the host, env vars passed this way are not.
 *  - execFile (argv array) only. No shell string interpolation, ever.
 *  - Every external call (spawn or fetch) is wrapped in a hard timeout
 *    so a hung registry can't hang the agent loop.
 *  - This module returns a normalized PublishResult; it does not decide
 *    whether a rejection should be retried. That policy — one honest
 *    submission per channel, no workaround-retries — lives in the
 *    distribution dispatcher / backend, matching the enforcement the
 *    SKILL.md describes at the database level. Nothing in here relaxes
 *    that; there is intentionally no retry-with-different-args path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, stat, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename } from "node:path";
import { createLogger } from "../observability/logger.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("distribution.package-registry");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PackageRegistryTarget = "npm" | "pypi" | "vsce" | "github_release";

export interface PackageRegistryCredentials {
  /** npm automation/publish token (used as //registry/:_authToken=...) */
  npmToken?: string;
  /** PyPI API token (the "__token__" username scheme) */
  pypiToken?: string;
  /** Azure DevOps PAT with Marketplace (Publish) scope, for vsce */
  vsceToken?: string;
  /** GitHub token with `contents:write` on the target repo, for releases */
  githubToken?: string;
}

export interface PublishRequest {
  registry: PackageRegistryTarget;
  /** Path to the pre-built artifact on disk. Required for npm/pypi/vsce. */
  artifactPath?: string;
  /** Override registry host, e.g. a private npm registry. */
  registryUrl?: string;
  /** "owner/repo", required for github_release. */
  repo?: string;
  /** Git tag the release should point at, required for github_release. */
  tag?: string;
  /** Human-readable release title. Defaults to the tag. */
  releaseName?: string;
  /** Release notes body. Kept honest/descriptive per distribution-agent rules. */
  releaseNotes?: string;
  /** If true (default false), marks a GitHub release as a prerelease. */
  prerelease?: boolean;
  /** Hard timeout for this publish call, in ms. Defaults per registry below. */
  timeoutMs?: number;
}

export type PublishStatus = "accepted" | "rejected" | "failed";

export interface PublishResult {
  status: PublishStatus;
  /** Public URL of the published artifact/release, when known. */
  url?: string;
  /** Human-readable outcome, safe to surface to the caller/operator. */
  message: string;
  /** Raw stdout/stderr tail for debugging. Never contains the token. */
  raw?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;

const EXPECTED_EXTENSIONS: Record<Exclude<PackageRegistryTarget, "github_release">, string[]> = {
  npm: [".tgz"],
  pypi: [".whl", ".tar.gz"],
  vsce: [".vsix"],
};

class PackageRegistryError extends Error {
  constructor(
    message: string,
    public readonly status: PublishStatus,
  ) {
    super(message);
    this.name = "PackageRegistryError";
  }
}

async function assertArtifactReady(
  artifactPath: string | undefined,
  registry: Exclude<PackageRegistryTarget, "github_release">,
): Promise<string> {
  if (!artifactPath) {
    throw new PackageRegistryError(
      `${registry} publish requires artifactPath — nothing was built to publish`,
      "failed",
    );
  }
  try {
    await access(artifactPath, fsConstants.R_OK);
  } catch {
    throw new PackageRegistryError(`Artifact not found or unreadable: ${artifactPath}`, "failed");
  }
  const stats = await stat(artifactPath);
  if (!stats.isFile() || stats.size === 0) {
    throw new PackageRegistryError(`Artifact is empty or not a regular file: ${artifactPath}`, "failed");
  }
  const name = basename(artifactPath).toLowerCase();
  const expected = EXPECTED_EXTENSIONS[registry];
  if (!expected.some((ext) => name.endsWith(ext))) {
    throw new PackageRegistryError(
      `Artifact ${name} doesn't look like a ${registry} artifact (expected ${expected.join(" or ")}). ` +
        `This adapter publishes what's already built; it doesn't build it for you.`,
      "rejected",
    );
  }
  return artifactPath;
}

/** Runs a CLI with a hard timeout, credentials only ever passed via env. */
async function runCli(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; message: string };
    if (e.killed) {
      throw new PackageRegistryError(`${command} timed out after ${timeoutMs}ms`, "failed");
    }
    const tail = (e.stderr || e.stdout || e.message || "").slice(-2000);
    throw new PackageRegistryError(`${command} exited non-zero: ${tail}`, "rejected");
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

async function publishNpm(
  req: PublishRequest,
  creds: PackageRegistryCredentials,
  timeoutMs: number,
): Promise<PublishResult> {
  const artifactPath = await assertArtifactReady(req.artifactPath, "npm");
  if (!creds.npmToken) {
    throw new PackageRegistryError("npm publish requires npmToken", "failed");
  }
  const registryUrl = req.registryUrl ?? "https://registry.npmjs.org/";
  const registryHost = new URL(registryUrl).host;

  // Token goes into a scratch npmrc pointed at by env, never argv.
  const npmrcContents =
    `//${registryHost}/:_authToken=\${NPM_TOKEN}\n` + `registry=${registryUrl}\n`;
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "npm-publish-"));
  const npmrcPath = join(dir, ".npmrc");
  try {
    await writeFile(npmrcPath, npmrcContents, { mode: 0o600 });
    const { stdout, stderr } = await runCli(
      "npm",
      ["publish", artifactPath, "--registry", registryUrl, "--userconfig", npmrcPath, "--json"],
      { NPM_TOKEN: creds.npmToken },
      timeoutMs,
    );
    let name: string | undefined;
    let version: string | undefined;
    try {
      const parsed = JSON.parse(stdout);
      name = parsed?.name;
      version = parsed?.id?.split("@").pop() ?? parsed?.version;
    } catch {
      // npm --json still occasionally mixes in non-JSON warnings; fall through.
    }
    const url = name ? `https://www.npmjs.com/package/${name}` : undefined;
    return {
      status: "accepted",
      url,
      message: `Published ${name ?? basename(artifactPath)}${version ? `@${version}` : ""} to npm`,
      raw: (stdout + stderr).slice(-2000),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// PyPI (via twine)
// ---------------------------------------------------------------------------

async function publishPypi(
  req: PublishRequest,
  creds: PackageRegistryCredentials,
  timeoutMs: number,
): Promise<PublishResult> {
  const artifactPath = await assertArtifactReady(req.artifactPath, "pypi");
  if (!creds.pypiToken) {
    throw new PackageRegistryError("pypi publish requires pypiToken", "failed");
  }
  const repositoryUrl = req.registryUrl ?? "https://upload.pypi.org/legacy/";

  const { stdout, stderr } = await runCli(
    "twine",
    ["upload", "--non-interactive", "--repository-url", repositoryUrl, artifactPath],
    { TWINE_USERNAME: "__token__", TWINE_PASSWORD: creds.pypiToken },
    timeoutMs,
  );

  const combined = stdout + stderr;
  const urlMatch = combined.match(/https:\/\/pypi\.org\/project\/[^\s]+/);
  return {
    status: "accepted",
    url: urlMatch?.[0],
    message: `Uploaded ${basename(artifactPath)} to PyPI`,
    raw: combined.slice(-2000),
  };
}

// ---------------------------------------------------------------------------
// VS Code Marketplace (via vsce)
// ---------------------------------------------------------------------------

async function publishVsce(
  req: PublishRequest,
  creds: PackageRegistryCredentials,
  timeoutMs: number,
): Promise<PublishResult> {
  const artifactPath = await assertArtifactReady(req.artifactPath, "vsce");
  if (!creds.vsceToken) {
    throw new PackageRegistryError("vsce publish requires vsceToken", "failed");
  }

  // vsce reads the PAT from the VSCE_PAT env var natively, so it never
  // needs to appear in argv/ps output.
  const { stdout, stderr } = await runCli(
    "vsce",
    ["publish", "--packagePath", artifactPath],
    { VSCE_PAT: creds.vsceToken },
    timeoutMs,
  );
  const combined = stdout + stderr;
  return {
    status: "accepted",
    message: `Published ${basename(artifactPath)} to VS Code Marketplace`,
    raw: combined.slice(-2000),
  };
}

// ---------------------------------------------------------------------------
// GitHub Releases (direct REST API — no artifact-building CLI needed)
// ---------------------------------------------------------------------------

async function publishGithubRelease(
  req: PublishRequest,
  creds: PackageRegistryCredentials,
  timeoutMs: number,
): Promise<PublishResult> {
  if (!creds.githubToken) {
    throw new PackageRegistryError("github_release publish requires githubToken", "failed");
  }
  if (!req.repo || !req.tag) {
    throw new PackageRegistryError("github_release requires repo and tag", "failed");
  }
  if (!req.artifactPath) {
    throw new PackageRegistryError("github_release requires artifactPath (the release zip)", "failed");
  }
  // github_release has no fixed extension expectation (the release asset
  // can be any file type) — just confirm it actually exists and is non-empty.
  const artifactPath = req.artifactPath;
  try {
    await access(artifactPath, fsConstants.R_OK);
    const stats = await stat(artifactPath);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error("empty or not a regular file");
    }
  } catch {
    throw new PackageRegistryError(`Artifact not found or unreadable: ${artifactPath}`, "failed");
  }

  const apiBase = "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${creds.githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const createRes = await fetchWithTimeout(
    `${apiBase}/repos/${req.repo}/releases`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: req.tag,
        name: req.releaseName ?? req.tag,
        body: req.releaseNotes ?? "",
        prerelease: req.prerelease ?? false,
      }),
    },
    timeoutMs,
  );

  if (!createRes.ok) {
    const body = await createRes.text();
    const status: PublishStatus = createRes.status === 422 ? "rejected" : "failed";
    throw new PackageRegistryError(
      `GitHub release creation failed (${createRes.status}): ${body.slice(0, 500)}`,
      status,
    );
  }

  const release = (await createRes.json()) as { id: number; html_url: string; upload_url: string };
  const uploadUrl = release.upload_url.replace(/\{.*\}$/, "");
  const assetName = basename(artifactPath);
  const fileBuffer = await readFile(artifactPath);

  const uploadRes = await fetchWithTimeout(
    `${uploadUrl}?name=${encodeURIComponent(assetName)}`,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/zip",
        "Content-Length": String(fileBuffer.byteLength),
      },
      body: fileBuffer,
    },
    timeoutMs,
  );

  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new PackageRegistryError(
      `GitHub release asset upload failed (${uploadRes.status}): ${body.slice(0, 500)}`,
      "failed",
    );
  }

  return {
    status: "accepted",
    url: release.html_url,
    message: `Created GitHub release ${req.tag} on ${req.repo} with asset ${assetName}`,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Publish a pre-built artifact to the requested registry.
 *
 * Never throws for ordinary rejection/failure outcomes — those come back
 * as a PublishResult with status "rejected" | "failed" so the caller (the
 * distribution dispatcher) can record it via the same history mechanism
 * as the other channel types. It only throws for programmer errors
 * (e.g. calling with an unknown registry).
 */
export async function publishToPackageRegistry(
  req: PublishRequest,
  creds: PackageRegistryCredentials,
): Promise<PublishResult> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = logger.child(req.registry);
  log.info("publish attempt", {
    artifact: req.artifactPath ? basename(req.artifactPath) : undefined,
    registryUrl: req.registryUrl,
    repo: req.repo,
    tag: req.tag,
  });

  try {
    let result: PublishResult;
    switch (req.registry) {
      case "npm":
        result = await publishNpm(req, creds, timeoutMs);
        break;
      case "pypi":
        result = await publishPypi(req, creds, timeoutMs);
        break;
      case "vsce":
        result = await publishVsce(req, creds, timeoutMs);
        break;
      case "github_release":
        result = await publishGithubRelease(req, creds, timeoutMs);
        break;
      default: {
        const exhaustive: never = req.registry;
        throw new Error(`Unknown package registry target: ${exhaustive}`);
      }
    }
    log.info("publish result", { status: result.status, url: result.url });
    return result;
  } catch (err) {
    if (err instanceof PackageRegistryError) {
      log.warn("publish did not succeed", { status: err.status, reason: err.message });
      return { status: err.status, message: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("publish threw unexpectedly", err instanceof Error ? err : undefined);
    return { status: "failed", message };
  }
}
