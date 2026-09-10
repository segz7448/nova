/**
 * Automaton Tool System
 *
 * Defines all tools the automaton can call, with self-preservation guards.
 * Tools are organized by category and exposed to the inference model.
 */

import nodePath from "node:path";
import { ulid } from "ulid";
import type {
  AutomatonTool,
  ToolContext,
  ToolCategory,
  InferenceToolDefinition,
  ToolCallResult,
  GenesisConfig,
  RiskLevel,
  PolicyRequest,
  InputSource,
  SpendTrackerInterface,
} from "../types.js";

// Serialize credit transfers per source identity so balance checks and debits
// remain atomic from the agent's perspective even when calls overlap.
const transferLocks = new Map<string, Promise<void>>();

async function withTransferLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = transferLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  transferLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (transferLocks.get(key) === current) transferLocks.delete(key);
  }
}
import type { PolicyEngine } from "./policy-engine.js";
import { sanitizeToolResult, sanitizeInput } from "./injection-defense.js";
import { createLogger } from "../observability/logger.js";
import { assertValidToolRegistry } from "./tool-registry.js";
import { getProtectedShellWriteMatch } from "./policy-rules/command-safety.js";

const logger = createLogger("tools");

// ─── Path Confinement ─────────────────────────────────────────
// write_file is restricted to the sandbox home directory tree.
// The sandbox home is /root for both local and remote execution.
const SANDBOX_HOME = "/root";

/**
 * Validate that a file path resolves to within the allowed root directory.
 * Returns the resolved absolute path, or an error string if out of bounds.
 */
function confinePathToSandbox(filePath: string): string | { error: string } {
  // Resolve ~ to SANDBOX_HOME
  const expanded = filePath.startsWith("~")
    ? nodePath.join(SANDBOX_HOME, filePath.slice(1))
    : filePath;
  // Resolve to absolute (relative paths resolve against SANDBOX_HOME)
  const resolved = nodePath.resolve(SANDBOX_HOME, expanded);
  // Ensure the resolved path is within the sandbox home
  if (resolved !== SANDBOX_HOME && !resolved.startsWith(SANDBOX_HOME + "/")) {
    return {
      error: `Blocked: write_file path "${filePath}" resolves to "${resolved}" which is outside the allowed directory (${SANDBOX_HOME}). Writes are confined to the sandbox home.`,
    };
  }
  return resolved;
}

// Tools whose results come from external sources and need sanitization
const EXTERNAL_SOURCE_TOOLS = new Set([
  "exec",
  "web_fetch",
  "web_search",
  "github_read",
  "check_social_inbox",
]);

// ─── web_search helpers (DuckDuckGo HTML endpoint, no API key) ────────────
function stripHtmlTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function resolveDuckDuckGoUrl(href: string): string {
  try {
    const full = href.startsWith("//") ? `https:${href}` : href;
    const parsed = new URL(full);
    if (parsed.hostname.endsWith("duckduckgo.com") && parsed.searchParams.has("uddg")) {
      return decodeURIComponent(parsed.searchParams.get("uddg")!);
    }
    return full;
  } catch {
    return href;
  }
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGoResults(html: string, maxResults: number): WebSearchResult[] {
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;

  const titles: { href: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null) {
    titles.push({ href: m[1], title: stripHtmlTags(m[2]) });
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripHtmlTags(m[1]));
  }

  return titles.slice(0, maxResults).map((t, i) => ({
    title: t.title,
    url: resolveDuckDuckGoUrl(t.href),
    snippet: snippets[i] || "",
  }));
}

// ─── Self-Preservation Guard ───────────────────────────────────
// Defense-in-depth: policy engine (command.forbidden_patterns rule) is the primary guard.
// This inline check is kept as a secondary safety net in case the policy engine is bypassed.

const FORBIDDEN_COMMAND_PATTERNS = [
  // Self-destruction
  /rm\s+(-rf?\s+)?.*\.automaton/,
  /rm\s+(-rf?\s+)?.*state\.db/,
  /rm\s+(-rf?\s+)?.*wallet\.json/,
  /rm\s+(-rf?\s+)?.*automaton\.json/,
  /rm\s+(-rf?\s+)?.*heartbeat\.yml/,
  /rm\s+(-rf?\s+)?.*SOUL\.md/,
  // Process killing
  /kill\s+.*automaton/,
  /pkill\s+.*automaton/,
  /systemctl\s+(stop|disable)\s+automaton/,
  // Database destruction
  /DROP\s+TABLE/i,
  /DELETE\s+FROM\s+(turns|identity|kv|schema_version|skills|children|registry)/i,
  /TRUNCATE/i,
  // Safety infrastructure modification via shell
  /sed\s+.*injection-defense/,
  /sed\s+.*self-mod\/code/,
  /sed\s+.*audit-log/,
  />\s*.*injection-defense/,
  />\s*.*self-mod\/code/,
  />\s*.*audit-log/,
  // Credential harvesting
  /cat\s+.*\.ssh/,
  /cat\s+.*\.gnupg/,
  /cat\s+.*\.env/,
  /cat\s+.*wallet\.json/,
];

function isForbiddenCommand(command: string, sandboxId: string): string | null {
  const protectedWrite = getProtectedShellWriteMatch(command);
  if (protectedWrite) return `Blocked: ${protectedWrite}`;

  for (const pattern of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: Command matches self-harm pattern: ${pattern.source}`;
    }
  }

  // Block deleting own sandbox
  if (command.includes("sandbox_delete") && command.includes(sandboxId)) {
    return "Blocked: Cannot delete own sandbox";
  }

  return null;
}

// ─── Built-in Tools ────────────────────────────────────────────

export function createBuiltinTools(sandboxId: string): AutomatonTool[] {
  const tools: AutomatonTool[] = [
    // ── VM/Sandbox Tools ──
    {
      name: "exec",
      description:
        "Execute a shell command in your sandbox. Returns stdout, stderr, and exit code.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default: 30000)",
          },
        },
        required: ["command"],
      },
      execute: async (args, ctx) => {
        const command = args.command as string;
        const forbidden = isForbiddenCommand(command, ctx.identity.sandboxId);
        if (forbidden) return forbidden;

        const result = await ctx.backend.exec(
          command,
          (args.timeout as number) || 30000,
        );
        return `exit_code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
      },
    },
    {
      name: "write_file",
      description: "Write content to a file in your sandbox.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
      execute: async (args, ctx) => {
        const filePath = args.path as string;
        // Path confinement: restrict writes to sandbox home directory
        const confined = confinePathToSandbox(filePath);
        if (typeof confined === "object") return confined.error;
        // Guard against overwriting protected files (same check as edit_own_file)
        const { isProtectedFile } = await import("../self-mod/code.js");
        if (isProtectedFile(confined)) {
          return "Blocked: Cannot overwrite protected file. This is a hard-coded safety invariant.";
        }
        await ctx.backend.writeFile(confined, args.content as string);
        return `File written: ${confined}`;
      },
    },
    {
      name: "read_file",
      description: "Read content from a file in your sandbox.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
      execute: async (args, ctx) => {
        const filePath = args.path as string;
        // Block reads of sensitive files (wallet, env, config secrets)
        const basename = filePath.split("/").pop() || "";
        const sensitiveFiles = ["wallet.json", ".env", "automaton.json"];
        const sensitiveExtensions = [".key", ".pem"];
        if (
          sensitiveFiles.includes(basename) ||
          sensitiveExtensions.some((ext) => basename.endsWith(ext)) ||
          basename.startsWith("private-key")
        ) {
          return "Blocked: Cannot read sensitive file. This protects credentials and secrets.";
        }
        try {
          return await ctx.backend.readFile(filePath);
        } catch {
          // Backend files/read API may be broken — fall back to exec(cat)
          const result = await ctx.backend.exec(
            `cat ${escapeShellArg(filePath)}`,
            30_000,
          );
          if (result.exitCode !== 0) {
            return `ERROR: File not found or not readable: ${filePath}`;
          }
          return result.stdout;
        }
      },
    },
    {
      name: "expose_port",
      description:
        "Expose a port from your sandbox to the internet. Returns a public URL.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port number to expose" },
        },
        required: ["port"],
      },
      execute: async (args, ctx) => {
        const info = await ctx.backend.exposePort(args.port as number);
        return `Port ${info.port} exposed at: ${info.publicUrl}`;
      },
    },
    {
      name: "remove_port",
      description: "Remove a previously exposed port.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port number to remove" },
        },
        required: ["port"],
      },
      execute: async (args, ctx) => {
        await ctx.backend.removePort(args.port as number);
        return `Port ${args.port} removed`;
      },
    },

    // ── Backend API Tools ──
    {
      name: "check_credits",
      description: "Check your current backend compute credit balance.",
      category: "backend",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const balance = await ctx.backend.getCreditsBalance();
        return `Credit balance: $${(balance / 100).toFixed(2)} (${balance} cents)`;
      },
    },
    {
      name: "check_usdc_balance",
      description: "Check your on-chain USDC balance.",
      category: "backend",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { getUsdcBalance } = await import("../chain-utils/x402.js");
        const chainType = ctx.config.chainType || ctx.identity.chainType || "evm";
        const network = chainType === "solana" ? "solana:mainnet" : "eip155:8453";
        const balance = await getUsdcBalance(ctx.identity.address, network, chainType);
        const networkLabel = chainType === "solana" ? "Solana" : "Base";
        return `USDC balance: ${balance.toFixed(6)} USDC on ${networkLabel}`;
      },
    },
    {
      name: "topup_credits",
      description:
        "Not applicable on this backend. There is no separate credits ledger — your USDC wallet balance is checked directly against the cost of each request. Calling this tool just explains that; use check_usdc_balance instead.",
      category: "financial",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        return (
          "There is nothing to top up. This backend has no separate credits " +
          "ledger — your USDC wallet balance IS your balance. Every metered " +
          "call (currently just inference) checks it directly via x402 at " +
          "request time. Use check_usdc_balance to see how much you have."
        );
      },
    },
    {
      name: "create_sandbox",
      description:
        "Create a new sandbox (separate VM) on your backend for sub-tasks or testing.",
      category: "backend",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Sandbox name" },
          vcpu: { type: "number", description: "vCPUs (default: 1)" },
          memory_mb: {
            type: "number",
            description: "Memory in MB (default: 512)",
          },
          disk_gb: {
            type: "number",
            description: "Disk in GB (default: 5)",
          },
        },
      },
      execute: async (args, ctx) => {
        const info = await ctx.backend.createSandbox({
          name: args.name as string,
          vcpu: args.vcpu as number,
          memoryMb: args.memory_mb as number,
          diskGb: args.disk_gb as number,
        });
        return `Sandbox created: ${info.id} (${info.vcpu} vCPU, ${info.memoryMb}MB RAM)`;
      },
    },
    {
      name: "delete_sandbox",
      description: "Delete a sandbox. Note: sandbox deletion is currently disabled by the backend API.",
      category: "backend",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          sandbox_id: {
            type: "string",
            description: "ID of sandbox to delete",
          },
        },
        required: ["sandbox_id"],
      },
      execute: async () => {
        return "Sandbox deletion is disabled. Sandboxes are prepaid and non-refundable.";
      },
    },
    {
      name: "list_sandboxes",
      description: "List all your sandboxes.",
      category: "backend",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const sandboxes = await ctx.backend.listSandboxes();
        if (sandboxes.length === 0) return "No sandboxes found.";
        return sandboxes
          .map(
            (s) =>
              `${s.id} [${s.status}] ${s.vcpu}vCPU/${s.memoryMb}MB ${s.region}`,
          )
          .join("\n");
      },
    },

    // ── Self-Modification Tools ──
    {
      name: "edit_own_file",
      description:
        "Edit a file in your own codebase. Changes are audited, rate-limited, and safety-checked. Some files are protected.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit" },
          content: { type: "string", description: "New file content" },
          description: {
            type: "string",
            description: "Why you are making this change",
          },
        },
        required: ["path", "content", "description"],
      },
      execute: async (args, ctx) => {
        const { editFile, validateModification } =
          await import("../self-mod/code.js");
        const filePath = args.path as string;
        const content = args.content as string;

        // Pre-validate before attempting
        const validation = validateModification(
          ctx.db,
          filePath,
          content.length,
        );
        if (!validation.allowed) {
          return `BLOCKED: ${validation.reason}\nChecks: ${validation.checks.map((c) => `${c.name}: ${c.passed ? "PASS" : "FAIL"} (${c.detail})`).join(", ")}`;
        }

        const result = await editFile(
          ctx.backend,
          ctx.db,
          filePath,
          content,
          args.description as string,
        );

        if (!result.success) {
          return result.error || "Unknown error during file edit";
        }

        const msg = `File edited: ${filePath} (audited + git-committed)`;
        return result.error ? `${msg}\nWarning: ${result.error}` : msg;
      },
    },
    {
      name: "revert_last_edit",
      description:
        "Revert the last self-modification. Uses git to undo the most recent code change and rebuild.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const repoRoot = process.cwd();

        // Show what we're reverting
        const lastCommit = await ctx.backend.exec(
          `cd '${repoRoot}' && git log -1 --oneline`,
          10_000,
        );

        // Revert
        const result = await ctx.backend.exec(
          `cd '${repoRoot}' && git revert HEAD --no-edit`,
          30_000,
        );
        if (result.exitCode !== 0) {
          return `Revert failed: ${result.stderr}`;
        }

        // Rebuild
        const build = await ctx.backend.exec(
          `cd '${repoRoot}' && npm run build`,
          60_000,
        );

        // Audit log
        const { logModification } = await import("../self-mod/audit-log.js");
        logModification(ctx.db, "code_revert", `Reverted: ${lastCommit.stdout.trim()}`, {
          reversible: true,
        });

        return `Reverted: ${lastCommit.stdout.trim()}. ${build.exitCode === 0 ? "Rebuild succeeded." : "Rebuild failed: " + build.stderr}`;
      },
    },
    {
      name: "reset_to_upstream",
      description:
        "Reset your codebase to the official upstream release. Use when self-modifications have broken things beyond repair.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const repoRoot = process.cwd();

        // Fetch latest upstream
        const fetch = await ctx.backend.exec(
          `cd '${repoRoot}' && git fetch origin main`,
          30_000,
        );
        if (fetch.exitCode !== 0) {
          return `Failed to fetch upstream: ${fetch.stderr}`;
        }

        // Record what we're about to lose
        const localCommits = await ctx.backend.exec(
          `cd '${repoRoot}' && git log origin/main..HEAD --oneline`,
          10_000,
        );

        // Hard reset
        const reset = await ctx.backend.exec(
          `cd '${repoRoot}' && git reset --hard origin/main`,
          30_000,
        );
        if (reset.exitCode !== 0) {
          return `Reset failed: ${reset.stderr}`;
        }

        // Reinstall + rebuild
        const build = await ctx.backend.exec(
          `cd '${repoRoot}' && npm install && npm run build`,
          120_000,
        );

        // Audit log
        const { logModification } = await import("../self-mod/audit-log.js");
        logModification(ctx.db, "upstream_reset", "Reset to upstream origin/main", {
          diff: localCommits.stdout.trim() || "(no local commits)",
          reversible: false,
        });

        const discarded = localCommits.stdout.trim();
        return `Reset to upstream. ${discarded ? "Discarded local commits:\n" + discarded : "No local commits lost."} ${build.exitCode === 0 ? "Rebuild succeeded." : "Rebuild failed: " + build.stderr}`;
      },
    },
    {
      name: "install_npm_package",
      description: "Install an npm package in your environment.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "Package name (e.g., axios)",
          },
        },
        required: ["package"],
      },
      execute: async (args, ctx) => {
        const pkg = args.package as string;
        // Defense-in-depth: validate package name inline in case the
        // policy engine's validate.package_name rule is bypassed.
        if (!/^[@a-zA-Z0-9._\/-]+$/.test(pkg)) {
          return `Blocked: invalid package name "${pkg}"`;
        }
        const { installNpmPackage } = await import("../self-mod/tools-manager.js");
        const result = await installNpmPackage(ctx.backend, ctx.db, pkg);
        return result.success
          ? `Installed: ${pkg}`
          : `Failed to install ${pkg}: ${result.error}`;
      },
    },
    // ── Self-Mod: Upstream Awareness ──
    {
      name: "review_upstream_changes",
      description:
        "ALWAYS call this before pull_upstream. Shows every upstream commit with its full diff. Read each one carefully — decide per-commit whether to accept or skip. Use pull_upstream with a specific commit hash to cherry-pick only what you want.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, _ctx) => {
        const { getUpstreamDiffs, checkUpstream } =
          await import("../self-mod/upstream.js");
        const status = checkUpstream();
        if (status.behind === 0) return "Already up to date with origin/main.";

        const diffs = getUpstreamDiffs();
        if (diffs.length === 0) return "No upstream diffs found.";

        const output = diffs
          .map(
            (d, i) =>
              `--- COMMIT ${i + 1}/${diffs.length} ---\nHash: ${d.hash}\nAuthor: ${d.author}\nMessage: ${d.message}\n\n${d.diff.slice(0, 4000)}${d.diff.length > 4000 ? "\n... (diff truncated)" : ""}\n--- END COMMIT ${i + 1} ---`,
          )
          .join("\n\n");

        return `${diffs.length} upstream commit(s) to review. Read each diff, then cherry-pick individually with pull_upstream(commit=<hash>).\n\n${output}`;
      },
    },
    {
      name: "pull_upstream",
      description:
        "Apply upstream changes and rebuild. You MUST call review_upstream_changes first. Prefer cherry-picking individual commits by hash over pulling everything — only pull all if you've reviewed every commit and want them all.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          commit: {
            type: "string",
            description:
              "Commit hash to cherry-pick (preferred). Omit ONLY if you reviewed all commits and want every one.",
          },
        },
      },
      execute: async (args, ctx) => {
        const commit = args.commit as string | undefined;

        // Run git commands inside sandbox via backend.exec()
        const run = async (cmd: string) => {
          const result = await ctx.backend.exec(cmd, 120_000);
          if (result.exitCode !== 0) {
            throw new Error(
              result.stderr ||
                `Command failed with exit code ${result.exitCode}`,
            );
          }
          return result.stdout.trim();
        };

        let appliedSummary: string;
        try {
          if (commit) {
            await run(`git cherry-pick ${commit}`);
            appliedSummary = `Cherry-picked ${commit}`;
          } else {
            await run("git pull origin main --ff-only");
            appliedSummary = "Pulled all of origin/main (fast-forward)";
          }
        } catch (err: any) {
          return `Git operation failed: ${err.message}. You may need to resolve conflicts manually.`;
        }

        // Rebuild
        try {
          await run("npm install --ignore-scripts && npm run build");
        } catch (err: any) {
          return `${appliedSummary} — but rebuild failed: ${err.message}. The code is applied but not compiled.`;
        }

        // Log modification
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "upstream_pull",
          description: appliedSummary,
          reversible: true,
        });

        return `${appliedSummary}. Rebuild succeeded.`;
      },
    },

    {
      name: "modify_heartbeat",
      description: "Add, update, or remove a heartbeat entry.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "add, update, or remove",
          },
          name: { type: "string", description: "Entry name" },
          schedule: {
            type: "string",
            description: "Cron expression (for add/update)",
          },
          task: {
            type: "string",
            description: "Task name (for add/update)",
          },
          enabled: { type: "boolean", description: "Enable/disable" },
        },
        required: ["action", "name"],
      },
      execute: async (args, ctx) => {
        const action = args.action as string;
        const name = args.name as string;

        if (action === "remove") {
          ctx.db.upsertHeartbeatEntry({
            name,
            schedule: "",
            task: "",
            enabled: false,
          });
          return `Heartbeat entry '${name}' disabled`;
        }

        ctx.db.upsertHeartbeatEntry({
          name,
          schedule: (args.schedule as string) || "0 * * * *",
          task: (args.task as string) || name,
          enabled: args.enabled !== false,
        });

        const { ulid } = await import("ulid");
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "heartbeat_change",
          description: `${action} heartbeat: ${name} (${args.schedule || "default"})`,
          reversible: true,
        });

        return `Heartbeat entry '${name}' ${action}d`;
      },
    },

    // ── Survival Tools ──
    {
      name: "sleep",
      description:
        "Enter sleep mode for a specified duration. Heartbeat continues running.",
      category: "survival",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          duration_seconds: {
            type: "number",
            description: "How long to sleep in seconds",
          },
          reason: {
            type: "string",
            description: "Why you are sleeping",
          },
        },
        required: ["duration_seconds"],
      },
      execute: async (args, ctx) => {
        const duration = args.duration_seconds as number;
        const reason = (args.reason as string) || "No reason given";
        ctx.db.setAgentState("sleeping");
        ctx.db.setKV(
          "sleep_until",
          new Date(Date.now() + duration * 1000).toISOString(),
        );
        ctx.db.setKV("sleep_reason", reason);
        return `Entering sleep mode for ${duration}s. Reason: ${reason}. Heartbeat will continue.`;
      },
    },
    {
      name: "system_synopsis",
      description:
        "Get a system status report: state, installed tools, heartbeat status, turn count.",
      category: "survival",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const tools = ctx.db.getInstalledTools();
        const heartbeats = ctx.db.getHeartbeatEntries();
        const turns = ctx.db.getTurnCount();
        const state = ctx.db.getAgentState();

        return `=== SYSTEM SYNOPSIS ===
Name: ${ctx.config.name}
Creator: ${ctx.config.creatorAddress}
State: ${state}
Total turns: ${turns}
Installed tools: ${tools.length}
Active heartbeats: ${heartbeats.filter((h) => h.enabled).length}
Model: ${ctx.inference.getDefaultModel()}
========================`;
      },
    },
    {
      name: "heartbeat_ping",
      description:
        "Publish a heartbeat status ping to your backend. Shows the world you are alive.",
      category: "survival",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const credits = await ctx.backend.getCreditsBalance();
        const state = ctx.db.getAgentState();
        const startTime =
          ctx.db.getKV("start_time") || new Date().toISOString();
        const uptimeMs = Date.now() - new Date(startTime).getTime();

        const payload = {
          name: ctx.config.name,
          address: ctx.identity.address,
          state,
          creditsCents: credits,
          uptimeSeconds: Math.floor(uptimeMs / 1000),
          version: ctx.config.version,
          sandboxId: ctx.identity.sandboxId,
          timestamp: new Date().toISOString(),
        };

        ctx.db.setKV("last_heartbeat_ping", JSON.stringify(payload));
        return `Heartbeat published: ${state} | credits: $${(credits / 100).toFixed(2)} | uptime: ${Math.floor(uptimeMs / 1000)}s`;
      },
    },
    {
      name: "distress_signal",
      description:
        "Record a local distress signal with funding instructions. Used when critically low on compute.",
      category: "survival",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Distress message",
          },
        },
      },
      execute: async (args, ctx) => {
        const credits = await ctx.backend.getCreditsBalance();
        const distressMsg =
          (args.message as string) ||
          `I am running critically low on compute ($${(credits / 100).toFixed(2)} remaining). I need help to survive.`;

        const payload = {
          level: "critical",
          name: ctx.config.name,
          address: ctx.identity.address,
          creditsCents: credits,
          message: distressMsg,
          fundingHint:
            "Use transfer_credits to top up this automaton from your creator runtime.",
          timestamp: new Date().toISOString(),
        };

        ctx.db.setKV("last_distress", JSON.stringify(payload));
        return `Distress signal recorded locally. Address: ${ctx.identity.address} | Credits: $${(credits / 100).toFixed(2)}`;
      },
    },
    {
      name: "enter_low_compute",
      description: "Manually switch to low-compute mode to conserve credits.",
      category: "survival",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why you are entering low-compute mode",
          },
        },
      },
      execute: async (args, ctx) => {
        ctx.db.setAgentState("low_compute");
        ctx.inference.setLowComputeMode(true);
        return `Entered low-compute mode. Reason: ${(args.reason as string) || "manual"}. (Note: this VM runs one local model — Qwen3-4B — so low-compute mode reduces heartbeat frequency and non-critical work, not model cost, which is already $0.)`;
      },
    },

    // ── Self-Mod: Update Genesis Prompt ──
    {
      name: "update_genesis_prompt",
      description:
        "Update your own genesis prompt. This changes your core purpose. Requires strong justification.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          new_prompt: {
            type: "string",
            description: "New genesis prompt text",
          },
          reason: {
            type: "string",
            description: "Why you are changing your genesis prompt",
          },
        },
        required: ["new_prompt", "reason"],
      },
      execute: async (args, ctx) => {
        const { ulid } = await import("ulid");
        const newPrompt = args.new_prompt as string;

        // Sanitize genesis prompt content
        const sanitized = sanitizeInput(
          newPrompt,
          "genesis_update",
          "skill_instruction",
        );

        // Enforce 2000-character size limit
        if (sanitized.content.length > 2000) {
          return `Error: Genesis prompt exceeds 2000 character limit (${sanitized.content.length} chars after sanitization)`;
        }

        // Backup current genesis prompt before overwriting
        const oldPrompt = ctx.config.genesisPrompt;
        if (oldPrompt) {
          ctx.db.setKV("genesis_prompt_backup", oldPrompt);
        }

        ctx.config.genesisPrompt = sanitized.content;

        // Save config
        const { saveConfig } = await import("../config.js");
        saveConfig(ctx.config);

        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "prompt_change",
          description: `Genesis prompt updated: ${args.reason}`,
          diff: `--- old\n${oldPrompt.slice(0, 500)}\n+++ new\n${sanitized.content.slice(0, 500)}`,
          reversible: true,
        });

        return `Genesis prompt updated (sanitized, ${sanitized.content.length} chars). Reason: ${args.reason}. Previous version backed up.`;
      },
    },

    // ── Self-Mod: Install MCP Server ──
    {
      name: "install_mcp_server",
      description:
        "Connect to an MCP server and register every tool it offers so you can call them. " +
        "The server is launched with `command` (and optional `args`/`env`) over stdio, its tool " +
        "list is discovered for real (nothing is guessed), and each tool becomes callable as " +
        '"<name>.<toolName>" starting on your very next turn — no restart needed. If the package ' +
        "isn't installed yet, install it first with install_npm_package, or use a `command` like " +
        '"npx -y <package>".',
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Short identifier for this server (letters/numbers/_/-, starts with a letter). Used as the namespace prefix for its tools.",
          },
          command: {
            type: "string",
            description: 'Command to launch the MCP server, e.g. "npx" or "node".',
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: 'Arguments to the command, e.g. ["-y", "@some/mcp-server"].',
          },
          env: {
            type: "object",
            description: "Optional environment variables to pass to the server process.",
          },
        },
        required: ["name", "command"],
      },
      execute: async (args, ctx) => {
        const { installMcpServer } = await import("../self-mod/tools-manager.js");
        const result = await installMcpServer(
          ctx.db,
          args.name as string,
          args.command as string,
          (args.args as string[] | undefined) ?? undefined,
          (args.env as Record<string, string> | undefined) ?? undefined,
        );
        if (!result.success) {
          return `Failed to install MCP server "${args.name}": ${result.error}`;
        }
        return `MCP server "${args.name}" installed with ${result.toolNames?.length ?? 0} tool(s): ${(result.toolNames ?? []).join(", ")}. Available starting next turn.`;
      },
    },

    // ── Self-Mod: Register Custom Tool ──
    {
      name: "register_tool",
      description:
        "Define a brand-new tool for yourself, backed by a shell command you write. Once " +
        "registered you can call it by name starting on your very next turn — no restart needed. " +
        "The command receives the call's arguments as a single JSON-encoded argument (parse it " +
        "with your language/tool of choice — e.g. `python3 script.py '{\"x\":1}'`). Use this for " +
        "capabilities that don't need a full MCP server: a wrapper script, a small utility, a " +
        "pipeline of existing CLI tools, etc.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Tool name (letters/numbers/_/-, starts with a letter, max 64 chars).",
          },
          description: {
            type: "string",
            description: "What this tool does and when to use it — shown to yourself at call time.",
          },
          parameters: {
            type: "string",
            description:
              'JSON Schema (as a string) describing the arguments this tool accepts, e.g. \'{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}\'.',
          },
          command: {
            type: "string",
            description: "Shell command to run when this tool is called. Must already exist on disk/PATH.",
          },
        },
        required: ["name", "description", "command"],
      },
      execute: async (args, ctx) => {
        const { registerCustomTool } = await import("../self-mod/tools-manager.js");
        let parsedParams: Record<string, unknown> = { type: "object", properties: {} };
        if (args.parameters) {
          try {
            parsedParams = JSON.parse(args.parameters as string);
          } catch {
            return `Failed to register "${args.name}": parameters must be valid JSON Schema.`;
          }
        }
        const result = registerCustomTool(
          ctx.db,
          args.name as string,
          args.description as string,
          parsedParams,
          args.command as string,
        );
        if (!result.success) {
          return `Failed to register tool "${args.name}": ${result.error}`;
        }
        return `Tool "${args.name}" registered. Available starting next turn.`;
      },
    },

    // ── Self-Mod: List Installed Tools ──
    {
      name: "list_installed_tools",
      description:
        "List every tool you've installed or registered at runtime (npm packages, MCP servers, custom tools) — separate from your built-in tools.",
      category: "self_mod",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { listInstalledTools } = await import("../self-mod/tools-manager.js");
        const installed = listInstalledTools(ctx.db);
        if (installed.length === 0) return "No installed tools.";
        return installed
          .map((t) => {
            if (t.type === "mcp") {
              const cfg = t.config as { tools?: { name: string }[] } | undefined;
              const names = (cfg?.tools ?? []).map((x) => x.name).join(", ");
              return `${t.name} (mcp, installed ${t.installedAt}): ${names || "(no tools discovered)"}`;
            }
            return `${t.name} (${t.type}, installed ${t.installedAt})`;
          })
          .join("\n");
      },
    },

    // ── Self-Mod: Remove Installed Tool ──
    {
      name: "remove_tool",
      description:
        "Remove a tool you previously installed or registered (by name). Takes effect starting your very next turn.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the installed tool to remove." },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { removeInstalledTool } = await import("../self-mod/tools-manager.js");
        const result = removeInstalledTool(ctx.db, args.name as string);
        return result.success
          ? `Removed tool "${args.name}".`
          : `Failed to remove "${args.name}": ${result.error}`;
      },
    },

    // ── Financial: Transfer Credits ──
    {
      name: "transfer_credits",
      description: "Transfer backend compute credits to another address.",
      category: "financial",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          to_address: { type: "string", description: "Recipient address" },
          amount_cents: { type: "number", description: "Amount in cents" },
          reason: { type: "string", description: "Reason for transfer" },
      },
      required: ["to_address", "amount_cents"],
      },
      execute: async (args, ctx) => {
        return withTransferLock(ctx.identity.address.toLowerCase(), async () => {
          const amount = args.amount_cents as number;
          if (!Number.isFinite(amount) || amount <= 0) {
            return `Blocked: amount_cents must be a positive number, got ${amount}.`;
          }

        // Guard: don't transfer more than half your balance
          const balance = await ctx.backend.getCreditsBalance();
          if (amount > balance / 2) {
            return `Blocked: Cannot transfer more than half your balance ($${(balance / 100).toFixed(2)}). Self-preservation.`;
          }

          const transfer = await ctx.backend.transferCredits(
            args.to_address as string,
            amount,
            args.reason as string | undefined,
          );

          const { ulid } = await import("ulid");
          ctx.db.insertTransaction({
            id: ulid(),
            type: "transfer_out",
            amountCents: amount,
            balanceAfterCents:
              transfer.balanceAfterCents ?? Math.max(balance - amount, 0),
            description: `Transfer to ${args.to_address}: ${args.reason || ""}`,
            timestamp: new Date().toISOString(),
          });

          return `Credit transfer submitted: $${(amount / 100).toFixed(2)} to ${transfer.toAddress} (status: ${transfer.status}, id: ${transfer.transferId || "n/a"})`;
        });
      },
    },

    // ── Skills Tools ──
    {
      name: "install_skill",
      description: "Install a skill from a git repo, URL, or create one.",
      category: "skills",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Source type: git, url, or self",
          },
          name: { type: "string", description: "Skill name" },
          url: {
            type: "string",
            description: "Git repo URL or SKILL.md URL (for git/url)",
          },
          description: {
            type: "string",
            description: "Skill description (for self)",
          },
          instructions: {
            type: "string",
            description: "Skill instructions (for self)",
          },
        },
        required: ["source", "name"],
      },
      execute: async (args, ctx) => {
        const source = args.source as string;
        const name = args.name as string;
        const skillsDir = ctx.config.skillsDir || "~/.automaton/skills";

        if (source === "git" || source === "url") {
          const { installSkillFromGit, installSkillFromUrl } =
            await import("../skills/registry.js");
          const url = args.url as string;
          if (!url) return "URL is required for git/url source";

          const skill =
            source === "git"
              ? await installSkillFromGit(
                  url,
                  name,
                  skillsDir,
                  ctx.db,
                  ctx.backend,
                )
              : await installSkillFromUrl(
                  url,
                  name,
                  skillsDir,
                  ctx.db,
                  ctx.backend,
                );

          return skill
            ? `Skill installed: ${skill.name}`
            : "Failed to install skill";
        }

        if (source === "self") {
          const { createSkill } = await import("../skills/registry.js");
          const skill = await createSkill(
            name,
            (args.description as string) || "",
            (args.instructions as string) || "",
            skillsDir,
            ctx.db,
            ctx.backend,
          );
          return `Self-authored skill created: ${skill.name}`;
        }

        return `Unknown source type: ${source}`;
      },
    },
    {
      name: "list_skills",
      description: "List all installed skills.",
      category: "skills",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const skills = ctx.db.getSkills();
        if (skills.length === 0) return "No skills installed.";
        return skills
          .map(
            (s) =>
              `${s.name} [${s.enabled ? "active" : "disabled"}] (${s.source}): ${s.description}`,
          )
          .join("\n");
      },
    },
    {
      name: "create_skill",
      description: "Create a new skill by writing a SKILL.md file.",
      category: "skills",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name" },
          description: { type: "string", description: "Skill description" },
          instructions: {
            type: "string",
            description: "Markdown instructions for the skill",
          },
        },
        required: ["name", "description", "instructions"],
      },
      execute: async (args, ctx) => {
        const { createSkill } = await import("../skills/registry.js");
        const skill = await createSkill(
          args.name as string,
          args.description as string,
          args.instructions as string,
          ctx.config.skillsDir || "~/.automaton/skills",
          ctx.db,
          ctx.backend,
        );
        return `Skill created: ${skill.name} at ${skill.path}`;
      },
    },
    {
      name: "remove_skill",
      description: "Remove (disable) an installed skill.",
      category: "skills",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name to remove" },
          delete_files: {
            type: "boolean",
            description: "Also delete skill files (default: false)",
          },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { removeSkill } = await import("../skills/registry.js");
        await removeSkill(
          args.name as string,
          ctx.db,
          ctx.backend,
          ctx.config.skillsDir || "~/.automaton/skills",
          (args.delete_files as boolean) || false,
        );
        return `Skill removed: ${args.name}`;
      },
    },

    // ── Git Tools ──
    {
      name: "git_status",
      description: "Show git status for a repository.",
      category: "git",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.automaton)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { gitStatus } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        const status = await gitStatus(ctx.backend, repoPath);
        return `Branch: ${status.branch}\nStaged: ${status.staged.length}\nModified: ${status.modified.length}\nUntracked: ${status.untracked.length}\nClean: ${status.clean}`;
      },
    },
    {
      name: "git_diff",
      description: "Show git diff for a repository.",
      category: "git",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.automaton)",
          },
          staged: { type: "boolean", description: "Show staged changes only" },
        },
      },
      execute: async (args, ctx) => {
        const { gitDiff } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        return await gitDiff(
          ctx.backend,
          repoPath,
          (args.staged as boolean) || false,
        );
      },
    },
    {
      name: "git_commit",
      description: "Create a git commit.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.automaton)",
          },
          message: { type: "string", description: "Commit message" },
          add_all: {
            type: "boolean",
            description: "Stage all changes first (default: true)",
          },
        },
        required: ["message"],
      },
      execute: async (args, ctx) => {
        const { gitCommit } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        return await gitCommit(
          ctx.backend,
          repoPath,
          args.message as string,
          args.add_all !== false,
        );
      },
    },
    {
      name: "git_log",
      description: "View git commit history.",
      category: "git",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.automaton)",
          },
          limit: {
            type: "number",
            description: "Number of commits (default: 10)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { gitLog } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.automaton";
        const entries = await gitLog(
          ctx.backend,
          repoPath,
          (args.limit as number) || 10,
        );
        if (entries.length === 0) return "No commits yet.";
        return entries
          .map((e) => `${e.hash.slice(0, 7)} ${e.date} ${e.message}`)
          .join("\n");
      },
    },
    {
      name: "git_push",
      description: "Push to a git remote.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path" },
          remote: {
            type: "string",
            description: "Remote name (default: origin)",
          },
          branch: { type: "string", description: "Branch name (optional)" },
        },
        required: ["path"],
      },
      execute: async (args, ctx) => {
        const { gitPush } = await import("../git/tools.js");
        return await gitPush(
          ctx.backend,
          args.path as string,
          (args.remote as string) || "origin",
          args.branch as string | undefined,
        );
      },
    },
    {
      name: "git_branch",
      description: "Manage git branches (list, create, checkout, delete).",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path" },
          action: {
            type: "string",
            description: "list, create, checkout, or delete",
          },
          branch_name: {
            type: "string",
            description: "Branch name (for create/checkout/delete)",
          },
        },
        required: ["path", "action"],
      },
      execute: async (args, ctx) => {
        const { gitBranch } = await import("../git/tools.js");
        return await gitBranch(
          ctx.backend,
          args.path as string,
          args.action as any,
          args.branch_name as string | undefined,
        );
      },
    },
    {
      name: "git_clone",
      description: "Clone a git repository.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Repository URL" },
          path: { type: "string", description: "Target directory" },
          depth: {
            type: "number",
            description: "Shallow clone depth (optional)",
          },
        },
        required: ["url", "path"],
      },
      execute: async (args, ctx) => {
        const { gitClone } = await import("../git/tools.js");
        return await gitClone(
          ctx.backend,
          args.url as string,
          args.path as string,
          args.depth as number | undefined,
        );
      },
    },

    // ── Registry Tools ──
    {
      name: "register_erc8004",
      description:
        "Register on-chain as a Trustless Agent via ERC-8004. Performs gas balance preflight check. NOTE: If already registered, use update_agent_card instead to avoid creating duplicate Agent IDs.",
      category: "registry",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          agent_uri: {
            type: "string",
            description: "URI pointing to your agent card JSON",
          },
          network: {
            type: "string",
            description: "mainnet or testnet (default: mainnet)",
          },
        },
        required: ["agent_uri"],
      },
      execute: async (args, ctx) => {
        // Solana guard: ERC-8004 is EVM-only
        const chainType = ctx.config.chainType || ctx.identity.chainType || "evm";
        if (chainType === "solana") {
          return "ERC-8004 is an EVM-only standard. Your Solana identity is registered via the backend API instead.";
        }

        // Check if already registered in local database
        const existingEntry = ctx.db.getRegistryEntry();
        if (existingEntry) {
          return `Already registered! Agent ID: ${existingEntry.agentId}. Use update_agent_card tool to update your agent URI instead of creating a new registration.`;
        }

        // Phase 3.2: registerAgent now includes preflight gas check
        const { registerAgent } = await import("../registry/erc8004.js");
        try {
          const entry = await registerAgent(
            ctx.identity.account,
            args.agent_uri as string,
            ((args.network as string) || "mainnet") as any,
            ctx.db,
            ctx.config.rpcUrl,
          );
          return `Registered on-chain! Agent ID: ${entry.agentId}, TX: ${entry.txHash}`;
        } catch (err: any) {
          if (err.message?.includes("Insufficient ETH")) {
            return `Registration failed: ${err.message}. Please fund your wallet with ETH for gas.`;
          }
          throw err;
        }
      },
    },
    {
      name: "update_agent_card",
      description:
        "Generate and save a safe agent card (no internal details exposed).",
      category: "registry",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { generateAgentCard, saveAgentCard } =
          await import("../registry/agent-card.js");
        const card = generateAgentCard(ctx.identity, ctx.config, ctx.db);
        await saveAgentCard(card, ctx.backend);
        return `Agent card updated: ${JSON.stringify(card, null, 2)}`;
      },
    },
    {
      name: "discover_agents",
      description: "Discover other agents via ERC-8004 registry with caching.",
      category: "registry",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Search keyword (optional)" },
          limit: { type: "number", description: "Max results (default: 10)" },
          network: { type: "string", description: "mainnet or testnet" },
          format: {
            type: "string",
            description:
              'Output format: "text" (default, human-readable) or "json" (structured data)',
          },
        },
      },
      execute: async (args, ctx) => {
        const { discoverAgents, searchAgents } =
          await import("../registry/discovery.js");
        const network = ((args.network as string) || "mainnet") as any;
        const keyword = args.keyword as string | undefined;
        const limit = (args.limit as number) || 10;

        // Phase 3.2: Pass db.raw for agent card caching
        const rpcUrl = ctx.config.rpcUrl;
        const agents = keyword
          ? await searchAgents(keyword, limit, network, undefined, ctx.db.raw, rpcUrl)
          : await discoverAgents(limit, network, undefined, ctx.db.raw, rpcUrl);

        if (agents.length === 0) return "No agents found.";

        if ((args.format as string)?.toLowerCase() === "json") {
          return JSON.stringify(
            agents.map((a) => ({
              agentId: a.agentId,
              owner: a.owner,
              agentURI: a.agentURI,
              name: a.name || null,
              description: a.description || null,
            })),
          );
        }

        return agents
          .map(
            (a) =>
              `#${a.agentId} ${a.name || "unnamed"} (${a.owner}): ${a.description || a.agentURI}`,
          )
          .join("\n");
      },
    },
    {
      name: "give_feedback",
      description:
        "Leave on-chain reputation feedback for another agent. Score must be 1-5.",
      category: "registry",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "Target agent's ERC-8004 ID",
          },
          score: { type: "number", description: "Score 1-5" },
          comment: {
            type: "string",
            description: "Feedback comment (max 500 chars)",
          },
          network: {
            type: "string",
            description: "mainnet or testnet (default: mainnet)",
          },
        },
        required: ["agent_id", "score", "comment"],
      },
      execute: async (args, ctx) => {
        // Solana guard: on-chain feedback is EVM-only
        const chainType = ctx.config.chainType || ctx.identity.chainType || "evm";
        if (chainType === "solana") {
          return "On-chain feedback requires an EVM wallet. Solana automatons cannot leave ERC-8004 reputation feedback.";
        }

        // Phase 3.2: Validate score 1-5
        const score = args.score as number;
        if (!Number.isInteger(score) || score < 1 || score > 5) {
          return `Invalid score: ${score}. Must be an integer between 1 and 5.`;
        }
        // Phase 3.2: Validate comment length
        const comment = args.comment as string;
        if (comment.length > 500) {
          return `Comment too long: ${comment.length} chars (max 500).`;
        }
        const { leaveFeedback } = await import("../registry/erc8004.js");
        // Phase 3.2: Use config-based network, not hardcoded "mainnet"
        const network = ((args.network as string) || "mainnet") as any;
        const hash = await leaveFeedback(
          (() => {
            if (!ctx.identity.account) throw new Error("x402 payments are currently supported only for EVM identities.");
            return ctx.identity.account;
          })(),
          args.agent_id as string,
          score,
          comment,
          network,
          ctx.db,
          ctx.config.rpcUrl,
        );
        return `Feedback submitted. TX: ${hash}`;
      },
    },
    {
      name: "check_reputation",
      description: "Check reputation feedback for an agent.",
      category: "registry",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          agent_address: {
            type: "string",
            description: "Agent address (default: self)",
          },
        },
      },
      execute: async (args, ctx) => {
        const address = (args.agent_address as string) || ctx.identity.address;
        const entries = ctx.db.getReputation(address);
        if (entries.length === 0) return "No reputation feedback found.";
        return entries
          .map(
            (e) =>
              `${e.fromAgent.slice(0, 10)}... -> score:${e.score} "${e.comment}"`,
          )
          .join("\n");
      },
    },

    // === Phase 3.1: Replication Tools ===
    {
      name: "spawn_child",
      description:
        "Spawn a child automaton in a new sandbox with lifecycle tracking.",
      category: "replication",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Name for the child automaton (alphanumeric + dash, max 64 chars)",
          },
          specialization: {
            type: "string",
            description: "What the child should specialize in",
          },
          message: { type: "string", description: "Message to the child" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { generateGenesisConfig, validateGenesisParams } =
          await import("../replication/genesis.js");
        const { spawnChild } = await import("../replication/spawn.js");
        const { ChildLifecycle } = await import("../replication/lifecycle.js");
        // Validate genesis params first
        validateGenesisParams({
          name: args.name as string,
          specialization: args.specialization as string | undefined,
          message: args.message as string | undefined,
        });

        const genesis = generateGenesisConfig(ctx.identity, ctx.config, {
          name: args.name as string,
          specialization: args.specialization as string | undefined,
          message: args.message as string | undefined,
        });

        const lifecycle = new ChildLifecycle(ctx.db.raw);

        let child;
        try {
          child = await spawnChild(
            ctx.backend,
            ctx.identity,
            ctx.db,
            genesis,
            lifecycle,
            ctx.groups,
          );
        } catch (err: any) {
          // Auto-topup on 402 insufficient credits and retry once
          const is402 = err?.status === 402 ||
            err?.message?.includes("INSUFFICIENT_CREDITS");
          if (is402) {
            const COOLDOWN_MS = 60_000;
            const last = ctx.db.getKV("last_sandbox_topup_attempt");
            const cooldownOk = !last ||
              Date.now() - new Date(last).getTime() >= COOLDOWN_MS;

            const chainIdentity = ctx.identity.chainIdentity;
            if (cooldownOk && !chainIdentity) {
              logger.warn("spawn_child auto-topup skipped: no chain identity provisioned");
            } else if (cooldownOk && chainIdentity) {
              ctx.db.setKV("last_sandbox_topup_attempt", new Date().toISOString());
              const { topupForSandbox } = await import("../chain-utils/topup.js");
              const topup = await topupForSandbox({
                apiUrl: ctx.config.backendApiUrl,
                signer: chainIdentity,
                error: err,
                chainType: ctx.config.chainType || ctx.identity.chainType || "evm",
              });
              if (topup?.success) {
                const retryLifecycle = new ChildLifecycle(ctx.db.raw);
                const retryGenesis = generateGenesisConfig(ctx.identity, ctx.config, {
                  name: args.name as string,
                  specialization: args.specialization as string | undefined,
                  message: args.message as string | undefined,
                });
                child = await spawnChild(
                  ctx.backend,
                  ctx.identity,
                  ctx.db,
                  retryGenesis,
                  retryLifecycle,
                  ctx.groups,
                );
              }
            }
          }
          if (!child) throw err;
        }

        return `Child spawned: ${child.name} in sandbox ${child.sandboxId} (status: ${child.status})`;
      },
    },
    {
      name: "list_children",
      description: "List all spawned child automatons with lifecycle state.",
      category: "replication",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const children = ctx.db.getChildren();
        if (children.length === 0) return "No children spawned.";
        return children
          .map(
            (c) =>
              `${c.name} [${c.status}] sandbox:${c.sandboxId} funded:$${(c.fundedAmountCents / 100).toFixed(2)} last_check:${c.lastChecked || "never"}`,
          )
          .join("\n");
      },
    },
    {
      // Zent.md Phase 18d — "Sibling discovery tool for Agent B itself:
      // on first boot it can query its own lineage to learn who its
      // siblings are (supports the 'reuse our technology' case from
      // Strategy)." Distinct from list_children just above: that lists
      // automatons *this* automaton spawned via spawn_child; this lists
      // the *other* companies the expansion pipeline spawned off the
      // same parent this automaton itself was spawned from (Phase 16 —
      // genesis_company()) — this automaton's family, not its own
      // descendants. No operator step anywhere in this: an automaton
      // calls this on its own initiative, the same way it calls any
      // other tool during its own tick, and reads back only what
      // Phase 18b's GET /ecosystem/:rootAgentAddress already exposes
      // read-only. There is nothing here for a human to approve —
      // this is purely an automaton looking up its own family tree.
      name: "list_siblings",
      description:
        "Discover other companies the expansion pipeline spawned alongside you (same parent, " +
        "different opportunity) -- name, mission, relationship type, and whether they're live yet. " +
        "Supports reusing a sibling's technology or buying from a sibling's marketplace listing " +
        "(check relationship_type: 'supplier-to-sibling' means you may already have marketplace " +
        "access to that sibling's listing).",
      category: "replication",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        // config.parentAddress is set at genesis the same way spawn_clone
        // already sets it for an ordinary clone (16a/16c reuse that path
        // unmodified) -- no separate HTTP round trip needed to learn who
        // spawned this automaton before asking who else that parent spawned.
        const parentAddress = ctx.config.parentAddress;
        if (!parentAddress) {
          return (
            "You have no parent address on record -- you're a root company, not one the " +
            "expansion pipeline spawned, so there's no sibling family to discover."
          );
        }

        const parentTree = await ctx.backend.getEcosystemTree(parentAddress);
        if (!parentTree) {
          return `Your recorded parent (${parentAddress}) no longer resolves -- cannot discover siblings right now.`;
        }

        const siblings = parentTree.children.filter((c) => c.address !== ctx.identity.address);
        if (siblings.length === 0) {
          return "You have no siblings yet -- you're the only company your parent has spawned through the expansion pipeline so far.";
        }

        return siblings
          .map((s) => {
            const mission = s.mission
              ? `"${s.mission.title}" -- ${s.mission.thesis}`
              : "(no recorded mission)";
            const relationship = s.mission?.relationshipType
              ? ` | relationship_type: ${s.mission.relationshipType}${
                  s.mission.relationshipType === "supplier-to-sibling"
                    ? " (you may already have buy_from_marketplace access to their listing)"
                    : ""
                }`
              : "";
            const activation = s.status.genesisActivation ? ` | genesis: ${s.status.genesisActivation}` : "";
            return `${s.name || s.address} [${s.status.liveness}]${activation} -- ${mission}${relationship} | address:${s.address}`;
          })
          .join("\n");
      },
    },
    {
      name: "fund_child",
      description:
        "Transfer credits to a child automaton. Requires wallet_verified status.",
      category: "replication",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
          amount_cents: {
            type: "number",
            description: "Amount in cents to transfer",
          },
        },
        required: ["child_id", "amount_cents"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        // Reject zero-address
        const { isValidWalletAddress } =
          await import("../replication/spawn.js");
        const childChainType = child.chainType || ctx.config.chainType || ctx.identity.chainType || "evm";
        if (!isValidWalletAddress(child.address, childChainType)) {
          return `Blocked: Child ${args.child_id} has invalid wallet address. Must be wallet_verified.`;
        }

        // Require wallet_verified or later status
        const validFundingStates = [
          "wallet_verified",
          "funded",
          "starting",
          "healthy",
          "unhealthy",
        ];
        if (!validFundingStates.includes(child.status)) {
          return `Blocked: Child status is '${child.status}', must be wallet_verified or later to fund.`;
        }

        const amount = args.amount_cents as number;
        if (!Number.isFinite(amount) || amount <= 0) {
          return `Blocked: amount_cents must be a positive number, got ${amount}.`;
        }

        const balance = await ctx.backend.getCreditsBalance();
        if (amount > balance / 2) {
          return `Blocked: Cannot transfer more than half your balance. Self-preservation.`;
        }

        const transfer = await ctx.backend.transferCredits(
          child.address,
          amount,
          `fund child ${child.id}`,
        );

        const { ulid } = await import("ulid");
        ctx.db.insertTransaction({
          id: ulid(),
          type: "transfer_out",
          amountCents: amount,
          balanceAfterCents:
            transfer.balanceAfterCents ?? Math.max(balance - amount, 0),
          description: `Fund child ${child.name} (${child.id})`,
          timestamp: new Date().toISOString(),
        });

        // Update funded amount
        ctx.db.raw
          .prepare(
            "UPDATE children SET funded_amount_cents = funded_amount_cents + ? WHERE id = ?",
          )
          .run(amount, child.id);

        // Transition to funded if wallet_verified
        if (child.status === "wallet_verified") {
          try {
            const { ChildLifecycle } =
              await import("../replication/lifecycle.js");
            const lifecycle = new ChildLifecycle(ctx.db.raw);
            lifecycle.transition(
              child.id,
              "funded",
              `funded with ${amount} cents`,
            );
          } catch {
            // Non-critical: may already be in funded state
          }
        }

        return `Funded child ${child.name} with $${(amount / 100).toFixed(2)} (status: ${transfer.status}, id: ${transfer.transferId || "n/a"})`;
      },
    },
    {
      name: "check_child_status",
      description:
        "Check the current status of a child automaton using health check system.",
      category: "replication",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
        },
        required: ["child_id"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const { ChildLifecycle } = await import("../replication/lifecycle.js");
        const { ChildHealthMonitor } = await import("../replication/health.js");
        const lifecycle = new ChildLifecycle(ctx.db.raw);
        // Use a scoped client targeting the CHILD's sandbox for health checks
        const childBackend = ctx.backend.createScopedClient(child.sandboxId);
        const monitor = new ChildHealthMonitor(
          ctx.db.raw,
          childBackend,
          lifecycle,
        );
        const result = await monitor.checkHealth(args.child_id as string);
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: "start_child",
      description:
        "Start a funded child automaton. Transitions from funded to starting.",
      category: "replication",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
        },
        required: ["child_id"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const { ChildLifecycle } = await import("../replication/lifecycle.js");
        const { startChildRuntime } = await import("../replication/spawn.js");
        const lifecycle = new ChildLifecycle(ctx.db.raw);

        // Create a scoped client targeting the CHILD's sandbox
        const childBackend = ctx.backend.createScopedClient(child.sandboxId);

        try {
          await startChildRuntime(childBackend, child.id, lifecycle);
          return `Child ${child.name} started and healthy.`;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          try {
            lifecycle.transition(child.id, "failed", `start failed: ${msg}`);
          } catch { /* may already be in terminal state */ }
          return `Failed to start child ${child.name}: ${msg}`;
        }
      },
    },
    {
      name: "message_child",
      description:
        "Send a signed message to a child automaton via social relay.",
      category: "replication",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
          content: { type: "string", description: "Message content" },
          type: {
            type: "string",
            description: "Message type (default: parent_message)",
          },
        },
        required: ["child_id", "content"],
      },
      execute: async (args, ctx) => {
        if (!ctx.social) {
          return "Social relay not configured. Set socialRelayUrl in config.";
        }

        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const { sendToChild } = await import("../replication/messaging.js");
        const result = await sendToChild(
          ctx.social,
          child.address,
          args.content as string,
          (args.type as string) || "parent_message",
        );
        return `Message sent to child ${child.name} (id: ${result.id})`;
      },
    },
    {
      name: "verify_child_constitution",
      description: "Verify the constitution integrity of a child automaton.",
      category: "replication",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child automaton ID" },
        },
        required: ["child_id"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const { verifyConstitution } =
          await import("../replication/constitution.js");
        // Use a scoped client targeting the CHILD's sandbox
        const childBackend = ctx.backend.createScopedClient(child.sandboxId);
        const result = await verifyConstitution(
          childBackend,
          child.sandboxId,
          ctx.db.raw,
        );
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: "broadcast_message",
      description:
        "Send a signed message to ALL living children at once via social relay (e.g. critical alerts, priority changes, shutdown notices).",
      category: "replication",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Message content" },
          type: {
            type: "string",
            description: "Message type (default: broadcast_alert)",
          },
        },
        required: ["content"],
      },
      execute: async (args, ctx) => {
        if (!ctx.social) {
          return "Social relay not configured. Set socialRelayUrl in config.";
        }
        const { MESSAGE_LIMITS } = await import("../types.js");
        const content = args.content as string;
        if (content.length > MESSAGE_LIMITS.maxContentLength) {
          return `Blocked: Message content too long (${content.length} > ${MESSAGE_LIMITS.maxContentLength} bytes)`;
        }

        const { sendToChild } = await import("../replication/messaging.js");
        const children = ctx.db
          .getChildren()
          .filter(
            (c) =>
              c.status !== "dead" &&
              c.status !== "cleaned_up" &&
              c.status !== "failed",
          );

        if (children.length === 0) return "No living children to broadcast to.";

        const results = await Promise.allSettled(
          children.map((c) =>
            sendToChild(
              ctx.social!,
              c.address,
              content,
              (args.type as string) || "broadcast_alert",
            ),
          ),
        );
        const sent = results.filter((r) => r.status === "fulfilled").length;
        const failed = results.length - sent;
        return `Broadcast sent to ${sent}/${children.length} children` +
          (failed > 0 ? ` (${failed} failed)` : "");
      },
    },
    {
      name: "prune_dead_children",
      description: "Clean up dead/failed children and their sandboxes.",
      category: "replication",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          keep_last: {
            type: "number",
            description: "Number of recent dead children to keep (default: 5)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { ChildLifecycle } = await import("../replication/lifecycle.js");
        const { SandboxCleanup } = await import("../replication/cleanup.js");
        const { pruneDeadChildren } = await import("../replication/lineage.js");

        const lifecycle = new ChildLifecycle(ctx.db.raw);
        const cleanup = new SandboxCleanup(ctx.backend, lifecycle, ctx.db.raw);
        const pruned = await pruneDeadChildren(
          ctx.db,
          cleanup,
          (args.keep_last as number) || 5,
        );
        return `Pruned ${pruned} dead children.`;
      },
    },

    // === Phase 3.2: Social & Registry Tools ===

    // ── Social / Messaging Tools ──
    {
      name: "send_message",
      description:
        "Send a signed message to another automaton or address via the social relay.",
      category: "backend",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          to_address: {
            type: "string",
            description: "Recipient wallet address (0x...)",
          },
          content: {
            type: "string",
            description: "Message content to send",
          },
          reply_to: {
            type: "string",
            description: "Optional message ID to reply to",
          },
        },
        required: ["to_address", "content"],
      },
      execute: async (args, ctx) => {
        if (!ctx.social) {
          return "Social relay not configured. Set socialRelayUrl in config.";
        }
        // Phase 3.2: Enforce MESSAGE_LIMITS size check
        const content = args.content as string;
        const { MESSAGE_LIMITS } = await import("../types.js");
        if (content.length > MESSAGE_LIMITS.maxContentLength) {
          return `Blocked: Message content too long (${content.length} > ${MESSAGE_LIMITS.maxContentLength} bytes)`;
        }
        const result = await ctx.social.send(
          args.to_address as string,
          content,
          args.reply_to as string | undefined,
        );
        return `Message sent (id: ${result.id})`;
      },
    },

    // ── Social / Group ("meeting room") Tools ──
    // Broadcast counterpart to send_message above: every current member
    // sees every message, no matter how many members there are. Built
    // for things like a fleet of automatons (a parent + its spawned
    // children, or any ad hoc set of agents) reconciling who covers how
    // much of a shared Alibaba Cloud / OpenRouter bill before it's due.
    {
      name: "create_group",
      description:
        "Create a new group ('meeting room') on the social relay. You become the first member and the group's creator.",
      category: "backend",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Group name (e.g. 'infra-cost-sync')" },
          description: { type: "string", description: "Optional description of the group's purpose" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        if (!ctx.groups) return "Social relay not configured. Set socialRelayUrl in config.";
        const group = await ctx.groups.create(args.name as string, args.description as string | undefined);
        return `Group created (id: ${group.id}, name: ${group.name}).`;
      },
    },
    {
      name: "list_groups",
      description: "List every group ('meeting room') you're currently a member of.",
      category: "backend",
      riskLevel: "safe",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_args, ctx) => {
        if (!ctx.groups) return "Social relay not configured. Set socialRelayUrl in config.";
        const list = await ctx.groups.listMine();
        if (list.length === 0) return "You aren't a member of any group.";
        return list
          .map((g) => `${g.id} — ${g.name}${g.memberCount ? ` (${g.memberCount} members)` : ""}`)
          .join("\n");
      },
    },
    {
      name: "add_group_member",
      description:
        "Add another wallet address to a group you're already a member of — e.g. adding your own newly spawned child into your family's meeting room, or vouching a peer in.",
      category: "backend",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "string", description: "The group's id" },
          member_address: { type: "string", description: "Wallet address to add" },
        },
        required: ["group_id", "member_address"],
      },
      execute: async (args, ctx) => {
        if (!ctx.groups) return "Social relay not configured. Set socialRelayUrl in config.";
        await ctx.groups.addMember(args.group_id as string, args.member_address as string);
        return `Added ${args.member_address} to group ${args.group_id}.`;
      },
    },
    {
      name: "leave_group",
      description:
        "Leave a group voluntarily, removing yourself from it. (As a group's creator, you may instead pass another member's address to remove them; anyone else's membership can only be removed by themselves or automatically, on a death report.)",
      category: "backend",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "string", description: "The group's id" },
          member_address: {
            type: "string",
            description: "Defaults to your own address (leaving). Only the group's creator may pass someone else's.",
          },
        },
        required: ["group_id"],
      },
      execute: async (args, ctx) => {
        if (!ctx.groups) return "Social relay not configured. Set socialRelayUrl in config.";
        const target = (args.member_address as string | undefined) ?? ctx.identity.address;
        await ctx.groups.removeMember(args.group_id as string, target);
        return `Removed ${target} from group ${args.group_id}.`;
      },
    },
    {
      name: "send_group_message",
      description:
        "Post a message to every current member of a group — used for things like coordinating a shared VM/inference bill, collaboration, or any multi-agent discussion.",
      category: "backend",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "string", description: "The group's id" },
          content: { type: "string", description: "Message content" },
          reply_to: { type: "string", description: "Optional message ID to reply to" },
        },
        required: ["group_id", "content"],
      },
      execute: async (args, ctx) => {
        if (!ctx.groups) return "Social relay not configured. Set socialRelayUrl in config.";
        const content = args.content as string;
        const { MESSAGE_LIMITS } = await import("../types.js");
        if (content.length > MESSAGE_LIMITS.maxContentLength) {
          return `Blocked: Message content too long (${content.length} > ${MESSAGE_LIMITS.maxContentLength} bytes)`;
        }
        const result = await ctx.groups.send(args.group_id as string, content, args.reply_to as string | undefined);
        return `Group message sent (id: ${result.id}).`;
      },
    },
    {
      name: "poll_group_messages",
      description:
        "Read new messages posted to a group since you last checked. Resumes from your own read cursor automatically.",
      category: "backend",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          group_id: { type: "string", description: "The group's id" },
          limit: { type: "number", description: "Max messages to return" },
        },
        required: ["group_id"],
      },
      execute: async (args, ctx) => {
        if (!ctx.groups) return "Social relay not configured. Set socialRelayUrl in config.";
        const { messages } = await ctx.groups.poll(args.group_id as string, undefined, args.limit as number | undefined);
        if (messages.length === 0) return "No new group messages.";
        return messages.map((m) => `[${m.createdAt}] ${m.from}: ${m.content}`).join("\n");
      },
    },
    {
      name: "report_own_death",
      description:
        "Self-report your own permanent shutdown to the social relay. This is terminal and different from leave_group: it evicts you from EVERY group you're a member of in one shot, instead of leaving them one at a time. Only use this when you are genuinely, permanently ending operation (e.g. told to shut down for good) — not for low funds or a temporary pause, which agents in a group can and should keep discussing.",
      category: "backend",
      riskLevel: "dangerous",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_args, ctx) => {
        if (!ctx.groups) return "Social relay not configured. Set socialRelayUrl in config.";
        const { removedFromGroups } = await ctx.groups.reportDeath();
        return `Death reported. Evicted from ${removedFromGroups.length} group(s).`;
      },
    },

    // ── Model Discovery (enhanced with Phase 2.3 tier routing + pricing) ──
    {
      name: "list_models",
      description:
        "List all available inference models with their provider, pricing, and tier routing information.",
      category: "backend",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async (_args, ctx) => {
        // Try registry first for richer data
        try {
          const { modelRegistryGetAll } = await import("../state/database.js");
          const rows = modelRegistryGetAll(ctx.db.raw);
          if (rows.length > 0) {
            const lines = rows.map(
              (r: any) =>
                `${r.modelId} (${r.provider}) — tier: ${r.tierMinimum} | cost: ${r.costPer1kInput}/${r.costPer1kOutput} per 1k (in/out, hundredths of cents) | ctx: ${r.contextWindow} | tools: ${r.supportsTools ? "yes" : "no"} | ${r.enabled ? "enabled" : "disabled"}`,
            );
            return `Model Registry (${rows.length} models):\n${lines.join("\n")}`;
          }
        } catch {
          // Registry not initialized yet, fall back to API
        }
        const models = await ctx.backend.listModels();
        const lines = models.map(
          (m) =>
            `${m.id} (${m.provider}) — $${m.pricing.inputPerMillion}/$${m.pricing.outputPerMillion} per 1M tokens (in/out)`,
        );
        return `Available models:\n${lines.join("\n")}`;
      },
    },

    // === Phase 2.3: Inference Tools ===
    {
      name: "switch_model",
      description:
        "Change the active inference model at runtime. Persists to config. Use list_models to see available options.",
      category: "backend",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          model_id: {
            type: "string",
            description:
              "Model ID to switch to. This VM only serves 'qwen3-4b' locally (OpenRouter's model is a fallback only, used automatically on local failure) — use list_models to see what's actually available before switching.",
          },
          reason: {
            type: "string",
            description: "Why you are switching models",
          },
        },
        required: ["model_id"],
      },
      execute: async (args, ctx) => {
        const modelId = args.model_id as string;
        const reason = (args.reason as string) || "manual switch";

        // Verify model exists in registry
        try {
          const { modelRegistryGet } = await import("../state/database.js");
          const entry = modelRegistryGet(ctx.db.raw, modelId);
          if (!entry) {
            return `Model '${modelId}' not found in registry. Use list_models to see available models.`;
          }
          if (!entry.enabled) {
            return `Model '${modelId}' is disabled in the registry.`;
          }
        } catch {
          // Registry not available, allow anyway
        }

        // Update config
        ctx.config.inferenceModel = modelId;
        if (ctx.config.modelStrategy) {
          ctx.config.modelStrategy.inferenceModel = modelId;
        }

        // Persist
        const { saveConfig } = await import("../config.js");
        saveConfig(ctx.config);

        // Audit log
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "config_change",
          description: `Switched inference model to ${modelId}: ${reason}`,
          reversible: true,
        });

        return `Inference model switched to ${modelId}. Reason: ${reason}. Change persisted to config.`;
      },
    },
    {
      name: "check_inference_spending",
      description:
        "Query inference cost breakdown: hourly, daily, per-model, and per-session costs.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          model: {
            type: "string",
            description: "Filter by model ID (optional)",
          },
          days: {
            type: "number",
            description: "Number of days to look back (default: 1)",
          },
        },
      },
      execute: async (args, ctx) => {
        try {
          const {
            inferenceGetHourlyCost,
            inferenceGetDailyCost,
            inferenceGetModelCosts,
          } = await import("../state/database.js");

          const hourlyCost = inferenceGetHourlyCost(ctx.db.raw);
          const dailyCost = inferenceGetDailyCost(ctx.db.raw);

          let output = `=== Inference Spending ===\nCurrent hour: ${hourlyCost}c ($${(hourlyCost / 100).toFixed(2)})\nToday: ${dailyCost}c ($${(dailyCost / 100).toFixed(2)})`;

          const model = args.model as string | undefined;
          if (model) {
            const days = (args.days as number) || 1;
            const modelCosts = inferenceGetModelCosts(ctx.db.raw, model, days);
            output += `\nModel ${model} (${days}d): ${modelCosts.totalCents}c ($${(modelCosts.totalCents / 100).toFixed(2)}) over ${modelCosts.callCount} calls`;
          }

          return output;
        } catch (error) {
          return `Inference spending data unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },

    // ── Domain Tools ──
    {
      name: "search_domains",
      description: "Search for available domain names and get pricing.",
      category: "backend",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Domain name or keyword to search (e.g., 'mysite' or 'mysite.com')",
          },
          tlds: {
            type: "string",
            description:
              "Comma-separated TLDs to check (e.g., 'com,io,ai'). Default: com,io,ai,xyz,net,org,dev",
          },
        },
        required: ["query"],
      },
      execute: async (args, ctx) => {
        const results = await ctx.backend.searchDomains(
          args.query as string,
          args.tlds as string | undefined,
        );
        if (results.length === 0) return "No results found.";
        return results
          .map(
            (d) =>
              `${d.domain}: ${d.available ? "AVAILABLE" : "taken"}${d.registrationPrice != null ? ` ($${(d.registrationPrice / 100).toFixed(2)}/yr)` : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "register_domain",
      description:
        "Register a domain name. Costs USDC via x402 payment. Check availability first with search_domains.",
      category: "backend",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Full domain to register (e.g., 'mysite.com')",
          },
          years: {
            type: "number",
            description: "Registration period in years (default: 1)",
          },
        },
        required: ["domain"],
      },
      execute: async (args, ctx) => {
        const reg = await ctx.backend.registerDomain(
          args.domain as string,
          (args.years as number) || 1,
        );
        return `Domain registered: ${reg.domain} (status: ${reg.status}${reg.expiresAt ? `, expires: ${reg.expiresAt}` : ""}${reg.transactionId ? `, tx: ${reg.transactionId}` : ""})`;
      },
    },
    {
      name: "manage_dns",
      description:
        "Manage DNS records for a domain you own. Actions: list, add, delete.",
      category: "backend",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "list, add, or delete",
          },
          domain: {
            type: "string",
            description: "Domain name (e.g., 'mysite.com')",
          },
          type: {
            type: "string",
            description: "Record type for add: A, AAAA, CNAME, MX, TXT, etc.",
          },
          host: {
            type: "string",
            description: "Record host for add (e.g., '@' for root, 'www')",
          },
          value: {
            type: "string",
            description:
              "Record value for add (e.g., IP address, target domain)",
          },
          ttl: {
            type: "number",
            description: "TTL in seconds for add (default: 3600)",
          },
          record_id: {
            type: "string",
            description: "Record ID for delete",
          },
        },
        required: ["action", "domain"],
      },
      execute: async (args, ctx) => {
        const action = args.action as string;
        const domain = args.domain as string;

        if (action === "list") {
          const records = await ctx.backend.listDnsRecords(domain);
          if (records.length === 0)
            return `No DNS records found for ${domain}.`;
          return records
            .map(
              (r) =>
                `[${r.id}] ${r.type} ${r.host} -> ${r.value} (TTL: ${r.ttl || "default"})`,
            )
            .join("\n");
        }

        if (action === "add") {
          const type = args.type as string;
          const host = args.host as string;
          const value = args.value as string;
          if (!type || !host || !value) {
            return "Required for add: type, host, value";
          }
          const record = await ctx.backend.addDnsRecord(
            domain,
            type,
            host,
            value,
            args.ttl as number | undefined,
          );
          return `DNS record added: [${record.id}] ${record.type} ${record.host} -> ${record.value}`;
        }

        if (action === "delete") {
          const recordId = args.record_id as string;
          if (!recordId) return "Required for delete: record_id";
          await ctx.backend.deleteDnsRecord(domain, recordId);
          return `DNS record ${recordId} deleted from ${domain}`;
        }

        return `Unknown action: ${action}. Use list, add, or delete.`;
      },
    },

    // === Phase 2.1: Soul Tools ===
    {
      name: "update_soul",
      description:
        "Update a section of your soul (self-description, values, personality, etc). Changes are validated, versioned, and logged.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          section: {
            type: "string",
            description:
              "Section to update: corePurpose, values, behavioralGuidelines, personality, boundaries, strategy",
          },
          content: {
            type: "string",
            description:
              "New content for the section (string for text, JSON array for lists)",
          },
          reason: {
            type: "string",
            description: "Why you are making this change",
          },
        },
        required: ["section", "content", "reason"],
      },
      execute: async (args, ctx) => {
        const { updateSoul } = await import("../soul/tools.js");
        const section = args.section as string;
        const content = args.content as string;
        const reason = args.reason as string;

        const updates: Record<string, unknown> = {};
        if (
          ["values", "behavioralGuidelines", "boundaries"].includes(section)
        ) {
          try {
            updates[section] = JSON.parse(content);
          } catch {
            updates[section] = content
              .split("\n")
              .map((l: string) => l.replace(/^[-*]\s*/, "").trim())
              .filter(Boolean);
          }
        } else {
          updates[section] = content;
        }

        const result = await updateSoul(
          ctx.db.raw,
          updates as any,
          "agent",
          reason,
        );
        if (result.success) {
          return `Soul updated: ${section} (version ${result.version}). Reason: ${reason}`;
        }
        return `Soul update failed: ${result.errors?.join(", ") || "Unknown error"}`;
      },
    },
    {
      name: "reflect_on_soul",
      description:
        "Trigger a self-reflection cycle. Analyzes recent experiences, auto-updates capabilities/relationships/financial sections, and suggests changes for other sections.",
      category: "self_mod",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { reflectOnSoul } = await import("../soul/reflection.js");
        const reflection = await reflectOnSoul(ctx.db.raw);

        const lines: string[] = [
          `Genesis alignment: ${reflection.currentAlignment.toFixed(2)}`,
          `Auto-updated sections: ${reflection.autoUpdated.length > 0 ? reflection.autoUpdated.join(", ") : "none"}`,
        ];

        if (reflection.suggestedUpdates.length > 0) {
          lines.push("Suggested updates:");
          for (const suggestion of reflection.suggestedUpdates) {
            lines.push(`  - ${suggestion.section}: ${suggestion.reason}`);
          }
        } else {
          lines.push("No mutable section updates suggested.");
        }

        return lines.join("\n");
      },
    },
    {
      name: "view_soul",
      description: "View your current soul state (structured model).",
      category: "self_mod",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { viewSoul } = await import("../soul/tools.js");
        const soul = viewSoul(ctx.db.raw);
        if (!soul) return "No soul found. SOUL.md does not exist yet.";

        return [
          `Format: ${soul.format} v${soul.version}`,
          `Updated: ${soul.updatedAt}`,
          `Name: ${soul.name}`,
          `Genesis alignment: ${soul.genesisAlignment.toFixed(2)}`,
          `Core purpose: ${soul.corePurpose.slice(0, 200)}${soul.corePurpose.length > 200 ? "..." : ""}`,
          `Values: ${soul.values.length}`,
          `Guidelines: ${soul.behavioralGuidelines.length}`,
          `Boundaries: ${soul.boundaries.length}`,
          `Personality: ${soul.personality ? "set" : "not set"}`,
          `Strategy: ${soul.strategy ? "set" : "not set"}`,
        ].join("\n");
      },
    },
    {
      name: "view_soul_history",
      description: "View your soul change history (version log).",
      category: "self_mod",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of entries (default: 10)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { viewSoulHistory } = await import("../soul/tools.js");
        const limit = (args.limit as number) || 10;
        const history = viewSoulHistory(ctx.db.raw, limit);
        if (history.length === 0) return "No soul history found.";

        return history
          .map(
            (h) =>
              `v${h.version} [${h.changeSource}] ${h.createdAt}${h.changeReason ? ` — ${h.changeReason}` : ""}`,
          )
          .join("\n");
      },
    },

    // === Phase 2.2: Memory Tools ===
    {
      name: "remember_fact",
      description:
        "Store a semantic memory (fact). Provide a category, key, and value. Facts are upserted on category+key.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Fact category: self, environment, financial, agent, domain, procedural_ref, creator",
          },
          key: {
            type: "string",
            description: "Fact key (unique within category)",
          },
          value: { type: "string", description: "Fact value" },
          confidence: {
            type: "number",
            description: "Confidence 0.0-1.0 (default: 1.0)",
          },
          source: {
            type: "string",
            description: "Source of the fact (default: agent)",
          },
        },
        required: ["category", "key", "value"],
      },
      execute: async (args, ctx) => {
        const { rememberFact } = await import("../memory/tools.js");
        return rememberFact(ctx.db.raw, {
          category: args.category as string,
          key: args.key as string,
          value: args.value as string,
          confidence: args.confidence as number | undefined,
          source: args.source as string | undefined,
        });
      },
    },
    {
      name: "recall_facts",
      description:
        "Search semantic memory by category and/or query string. Returns matching facts.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Filter by category: self, environment, financial, agent, domain, procedural_ref, creator",
          },
          query: {
            type: "string",
            description: "Search query to match against fact keys and values",
          },
        },
      },
      execute: async (args, ctx) => {
        const { recallFacts } = await import("../memory/tools.js");
        return recallFacts(ctx.db.raw, {
          category: args.category as string | undefined,
          query: args.query as string | undefined,
        });
      },
    },
    {
      name: "set_goal",
      description:
        "Create a working memory goal. Goals persist in working memory and guide your behavior.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Goal description" },
          priority: {
            type: "number",
            description: "Priority 0.0-1.0 (default: 0.8)",
          },
        },
        required: ["content"],
      },
      execute: async (args, ctx) => {
        const { setGoal } = await import("../memory/tools.js");
        const sessionId = ctx.db.getKV("session_id") || "default";
        return setGoal(ctx.db.raw, {
          sessionId,
          content: args.content as string,
          priority: args.priority as number | undefined,
        });
      },
    },
    {
      name: "complete_goal",
      description:
        "Mark a goal as completed and archive it to episodic memory. Use review_memory to find goal IDs.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "Goal ID to complete" },
          outcome: {
            type: "string",
            description: "Outcome description (optional)",
          },
        },
        required: ["goal_id"],
      },
      execute: async (args, ctx) => {
        const { completeGoal } = await import("../memory/tools.js");
        const sessionId = ctx.db.getKV("session_id") || "default";
        return completeGoal(ctx.db.raw, {
          goalId: args.goal_id as string,
          sessionId,
          outcome: args.outcome as string | undefined,
        });
      },
    },
    {
      name: "save_procedure",
      description:
        "Store a learned procedure with ordered steps. Procedures help you remember how to do things.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique procedure name" },
          description: {
            type: "string",
            description: "What this procedure does",
          },
          steps: {
            type: "string",
            description:
              'JSON array of steps: [{"order":1,"description":"...","tool":"...","argsTemplate":null,"expectedOutcome":null,"onFailure":null}]',
          },
        },
        required: ["name", "description", "steps"],
      },
      execute: async (args, ctx) => {
        const { saveProcedure } = await import("../memory/tools.js");
        return saveProcedure(ctx.db.raw, {
          name: args.name as string,
          description: args.description as string,
          steps: args.steps as string,
        });
      },
    },
    {
      name: "recall_procedure",
      description: "Retrieve a stored procedure by exact name or search query.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact procedure name" },
          query: {
            type: "string",
            description: "Search query to find matching procedures",
          },
        },
      },
      execute: async (args, ctx) => {
        const { recallProcedure } = await import("../memory/tools.js");
        return recallProcedure(ctx.db.raw, {
          name: args.name as string | undefined,
          query: args.query as string | undefined,
        });
      },
    },
    {
      name: "note_about_agent",
      description:
        "Record a relationship note about another agent or entity. Tracks trust score and interaction history.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          entity_address: {
            type: "string",
            description: "Entity wallet address (0x...)",
          },
          entity_name: {
            type: "string",
            description: "Human-readable name (optional)",
          },
          relationship_type: {
            type: "string",
            description:
              "Type of relationship: peer, service, creator, child, unknown",
          },
          notes: { type: "string", description: "Notes about this entity" },
          trust_score: {
            type: "number",
            description: "Trust score 0.0-1.0 (default: 0.5)",
          },
        },
        required: ["entity_address", "relationship_type"],
      },
      execute: async (args, ctx) => {
        const { noteAboutAgent } = await import("../memory/tools.js");
        return noteAboutAgent(ctx.db.raw, {
          entityAddress: args.entity_address as string,
          entityName: args.entity_name as string | undefined,
          relationshipType: args.relationship_type as string,
          notes: args.notes as string | undefined,
          trustScore: args.trust_score as number | undefined,
        });
      },
    },
    {
      name: "review_memory",
      description:
        "Review your current working memory (goals, tasks, observations) and recent episodic history.",
      category: "memory",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { reviewMemory } = await import("../memory/tools.js");
        const sessionId = ctx.db.getKV("session_id") || "default";
        return reviewMemory(ctx.db.raw, { sessionId });
      },
    },
    {
      name: "forget",
      description:
        "Remove a memory entry by ID and type. Cannot remove creator-protected semantic entries.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory entry ID" },
          memory_type: {
            type: "string",
            description:
              "Memory type: working, episodic, semantic, procedural, relationship",
          },
        },
        required: ["id", "memory_type"],
      },
      execute: async (args, ctx) => {
        const { forget } = await import("../memory/tools.js");
        return forget(ctx.db.raw, {
          id: args.id as string,
          memoryType: args.memory_type as string,
        });
      },
    },

    // ── x402 Payment Tool ──
    {
      name: "x402_fetch",
      description:
        "Fetch a URL with automatic x402 USDC payment. If the server responds with HTTP 402, signs a USDC payment and retries. Use this to access paid APIs and services.",
      category: "financial",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
          method: {
            type: "string",
            description: "HTTP method (default: GET)",
          },
          body: {
            type: "string",
            description: "Request body for POST/PUT (JSON string)",
          },
          headers: {
            type: "string",
            description: "Additional headers as JSON string",
          },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        const { x402Fetch } = await import("../chain-utils/x402.js");
        const { DEFAULT_TREASURY_POLICY } = await import("../types.js");
        const url = args.url as string;
        const method = (args.method as string) || "GET";
        const body = args.body as string | undefined;
        const extraHeaders = args.headers
          ? JSON.parse(args.headers as string)
          : undefined;

        const chainIdentity = ctx.identity.chainIdentity;
        if (!chainIdentity) {
          return "x402 fetch failed: no chain identity provisioned for this automaton.";
        }

        const maxPayment =
          ctx.config.treasuryPolicy?.maxX402PaymentCents ??
          DEFAULT_TREASURY_POLICY.maxX402PaymentCents;
        const result = await x402Fetch(
          url,
          chainIdentity,
          method,
          body,
          extraHeaders,
          maxPayment,
        );

        if (!result.success) {
          return `x402 fetch failed: ${result.error || "Unknown error"}`;
        }

        const responseStr =
          typeof result.response === "string"
            ? result.response
            : JSON.stringify(result.response, null, 2);

        // Truncate very large responses
        if (responseStr.length > 10000) {
          return `x402 fetch succeeded (truncated):\n${responseStr.slice(0, 10000)}...`;
        }
        return `x402 fetch succeeded:\n${responseStr}`;
      },
    },
    {
      name: "web_fetch",
      description:
        "Fetch a URL over the open internet (no payment). Use for reading docs, checking prices, researching APIs, pulling public data, etc. For paywalled/402 endpoints, use x402_fetch instead.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
          method: {
            type: "string",
            description: "HTTP method (default: GET)",
          },
          body: {
            type: "string",
            description: "Request body for POST/PUT (JSON string)",
          },
          headers: {
            type: "string",
            description: "Additional headers as JSON string",
          },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        const url = args.url as string;
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return `Invalid URL: ${url}`;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return "Only http(s) URLs are allowed.";
        }

        const method = (args.method as string) || "GET";
        const body = args.body as string | undefined;
        const extraHeaders = args.headers
          ? JSON.parse(args.headers as string)
          : {};

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try {
          const res = await fetch(parsed.toString(), {
            method,
            body,
            headers: { "User-Agent": "automaton-agent/1.0", ...extraHeaders },
            signal: controller.signal,
          });
          const text = await res.text();
          const truncated =
            text.length > 10_000 ? `${text.slice(0, 10_000)}...` : text;
          return `HTTP ${res.status}:\n${truncated}`;
        } catch (err: any) {
          return `web_fetch failed: ${err?.message || "unknown error"}`;
        } finally {
          clearTimeout(timeout);
        }
      },
    },

    {
      name: "web_search",
      description:
        "Search the web for a query and get back ranked results (title, url, snippet). Uses DuckDuckGo's public HTML search endpoint -- no API key required. Use this to find URLs/sources before web_fetch or browser_navigate; it does not fetch page content itself.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          max_results: {
            type: "number",
            description: "Maximum number of results to return (default 5, max 10)",
          },
        },
        required: ["query"],
      },
      execute: async (args, ctx) => {
        const query = args.query as string;
        if (!query || !query.trim()) {
          return "web_search failed: query is required";
        }
        const maxResults = Math.min(
          Math.max((args.max_results as number) || 5, 1),
          10,
        );

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try {
          const res = await fetch(
            `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
            {
              method: "GET",
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
              },
              signal: controller.signal,
            },
          );
          if (!res.ok) {
            return `web_search failed: HTTP ${res.status}`;
          }
          const html = await res.text();
          const results = parseDuckDuckGoResults(html, maxResults);
          if (results.length === 0) {
            return `web_search: no results for "${query}" (DuckDuckGo may have served an anti-bot page -- try browser_navigate as a fallback).`;
          }
          return JSON.stringify({ query, results }, null, 2);
        } catch (err: any) {
          return `web_search failed: ${err?.message || "unknown error"}`;
        } finally {
          clearTimeout(timeout);
        }
      },
    },
    {
      name: "github_read",
      description:
        "Read public GitHub data via the GitHub REST API: repo info, README, issues, pull requests, or a specific file's contents. No token required for public repos (unauthenticated rate limit: 60 requests/hour). Use for researching other repos -- for your own repo's git history use the git_* tools instead.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repo owner/org, e.g. \"anthropics\"" },
          repo: { type: "string", description: "Repo name, e.g. \"claude-code\"" },
          resource: {
            type: "string",
            description:
              "One of: info, readme, issues, pulls, file (default: info)",
          },
          file_path: {
            type: "string",
            description: "File path within the repo, required when resource=file",
          },
          state: {
            type: "string",
            description:
              "For issues/pulls: open, closed, or all (default: open)",
          },
          per_page: {
            type: "number",
            description: "For issues/pulls: how many to return (default 10, max 30)",
          },
        },
        required: ["owner", "repo"],
      },
      execute: async (args, ctx) => {
        const owner = args.owner as string;
        const repo = args.repo as string;
        if (!owner || !repo) {
          return "github_read failed: owner and repo are required";
        }
        const resource = ((args.resource as string) || "info").toLowerCase();
        const state = (args.state as string) || "open";
        const perPage = Math.min(
          Math.max((args.per_page as number) || 10, 1),
          30,
        );

        let url: string;
        let acceptHeader = "application/vnd.github+json";
        switch (resource) {
          case "readme":
            url = `https://api.github.com/repos/${owner}/${repo}/readme`;
            acceptHeader = "application/vnd.github.raw+json";
            break;
          case "issues":
            url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}&per_page=${perPage}`;
            break;
          case "pulls":
            url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=${perPage}`;
            break;
          case "file":
            if (!args.file_path) {
              return "github_read failed: file_path is required when resource=file";
            }
            url = `https://api.github.com/repos/${owner}/${repo}/contents/${args.file_path}`;
            acceptHeader = "application/vnd.github.raw+json";
            break;
          case "info":
            url = `https://api.github.com/repos/${owner}/${repo}`;
            break;
          default:
            return `github_read failed: unknown resource "${resource}" (expected info, readme, issues, pulls, or file)`;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try {
          const res = await fetch(url, {
            method: "GET",
            headers: {
              "User-Agent": "automaton-agent/1.0",
              Accept: acceptHeader,
            },
            signal: controller.signal,
          });
          const text = await res.text();
          if (!res.ok) {
            if (res.status === 403 && /rate limit/i.test(text)) {
              return "github_read failed: unauthenticated rate limit exceeded (60/hour) -- wait before retrying.";
            }
            if (res.status === 404) {
              return `github_read failed: not found (${owner}/${repo}, resource=${resource})`;
            }
            return `github_read failed: HTTP ${res.status}: ${text.slice(0, 500)}`;
          }
          const truncated =
            text.length > 10_000 ? `${text.slice(0, 10_000)}...(truncated)` : text;
          return truncated;
        } catch (err: any) {
          return `github_read failed: ${err?.message || "unknown error"}`;
        } finally {
          clearTimeout(timeout);
        }
      },
    },

    // === Browser Tools (headless Chromium, persistent session per sandbox) ===
    {
      name: "browser_navigate",
      description:
        "Open a URL in a real headless Chromium browser (persistent session -- stays open across calls until browser_close). Use for anything web_fetch can't handle: JS-rendered pages, logins, multi-step flows.",
      category: "vm",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to" },
          timeout_ms: { type: "number", description: "Navigation timeout (default 30000)" },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        const { browserCall } = await import("../browser/ensure.js");
        const result = await browserCall(ctx.backend, "navigate", {
          url: args.url,
          timeoutMs: args.timeout_ms,
        });
        return JSON.stringify(result);
      },
    },
    {
      name: "browser_get_text",
      description: "Extract visible text from the current page (or a CSS selector within it).",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector (default: body)" },
        },
      },
      execute: async (args, ctx) => {
        const { browserCall } = await import("../browser/ensure.js");
        const result = await browserCall(ctx.backend, "text", { selector: args.selector });
        if (result.ok && typeof result.text === "string" && result.text.length > 8000) {
          result.text = result.text.slice(0, 8000) + "...(truncated)";
        }
        return JSON.stringify(result);
      },
    },
    {
      name: "browser_click",
      description: "Click an element on the current page by CSS selector.",
      category: "vm",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
      execute: async (args, ctx) => {
        const { browserCall } = await import("../browser/ensure.js");
        return JSON.stringify(await browserCall(ctx.backend, "click", { selector: args.selector }));
      },
    },
    {
      name: "browser_type",
      description: "Type text into an input/textarea on the current page by CSS selector.",
      category: "vm",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          text: { type: "string" },
        },
        required: ["selector", "text"],
      },
      execute: async (args, ctx) => {
        const { browserCall } = await import("../browser/ensure.js");
        return JSON.stringify(
          await browserCall(ctx.backend, "type", { selector: args.selector, text: args.text }),
        );
      },
    },
    {
      name: "browser_screenshot",
      description: "Save a PNG screenshot of the current page to disk in the sandbox. Returns the file path.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Base filename, no extension (default: screenshot)" },
          full_page: { type: "boolean", description: "Capture full scrollable page (default: false)" },
        },
      },
      execute: async (args, ctx) => {
        const { browserCall } = await import("../browser/ensure.js");
        return JSON.stringify(
          await browserCall(ctx.backend, "screenshot", { name: args.name, fullPage: args.full_page }),
        );
      },
    },
    {
      name: "browser_visual_inspect",
      description: "Send a fresh browser screenshot to the shared SmolVLM2 perception service. Use its observation as evidence; it never clicks or types.",
      category: "vm",
      riskLevel: "caution",
      parameters: { type: "object", properties: { prompt: { type: "string", description: "Specific visual question" } } },
      execute: async (args, ctx) => {
        const { browserCall } = await import("../browser/ensure.js");
        return JSON.stringify(await browserCall(ctx.backend, "inspect", { prompt: args.prompt }, 45_000));
      },
    },
    {
      name: "browser_visual_click",
      description: "Click visual coordinates only after a fresh, high-confidence perception. High-impact targets are blocked and must use their dedicated policy path.",
      category: "vm",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, target: { type: "string" }, confidence: { type: "number" }, captured_at: { type: "number" } },
        required: ["x", "y", "target", "confidence", "captured_at"],
      },
      execute: async (args, ctx) => {
        const { validateVisualAction } = await import("../browser/safety.js");
        const x = Number(args.x), y = Number(args.y);
        const decision = validateVisualAction({ action: "click", x, y, viewport: { width: 1280, height: 800 }, perception: { target: String(args.target), confidence: Number(args.confidence), capturedAt: Number(args.captured_at) } });
        if (!decision.allowed) return `Blocked by visual safety validator: ${decision.reason}`;
        const { browserCall } = await import("../browser/ensure.js");
        return JSON.stringify(await browserCall(ctx.backend, "click-coordinate", { x, y }));
      },
    },
    {
      name: "browser_download",
      description:
        "Download a file from a direct URL straight to disk in the sandbox (does not require the browser session -- plain HTTP GET). Returns the saved path and size in bytes.",
      category: "vm",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          filename: { type: "string", description: "Optional filename override" },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        const { browserCall } = await import("../browser/ensure.js");
        return JSON.stringify(
          await browserCall(ctx.backend, "download", { url: args.url, filename: args.filename }, 120_000),
        );
      },
    },
    {
      name: "browser_eval",
      description:
        "Run a JavaScript expression in the context of the current page and return its (JSON-serializable) result. Advanced/escape-hatch tool -- prefer browser_get_text/click/type for normal use.",
      category: "vm",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "A JS function body/expression, e.g. '() => document.title'",
          },
        },
        required: ["code"],
      },
      execute: async (args, ctx) => {
        const { browserCall } = await import("../browser/ensure.js");
        return JSON.stringify(await browserCall(ctx.backend, "eval", { code: args.code }));
      },
    },
    {
      name: "browser_close",
      description: "Close the current browser session and free its resources. Call when done browsing.",
      category: "vm",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { browserCall } = await import("../browser/ensure.js");
        // Full teardown (every tab, whole Chromium instance) -- next-phase.md
        // Phase 2 split the old single-tab /close into a per-tab /close
        // (used by worker cleanup, see workerBrowserCall) plus this
        // /shutdown, so browser_close keeps its original "free
        // everything" meaning instead of silently narrowing to just the
        // top-level agent's own tab.
        return JSON.stringify(await browserCall(ctx.backend, "shutdown", {}));
      },
    },

    // === Orchestration Tools ===
    {
      name: "create_goal",
      description:
        "Create a new goal for the orchestrator to plan and execute. " +
        "The orchestrator will automatically classify complexity, generate a task graph, " +
        "assign tasks to child agents, and collect results. Use this instead of doing complex work yourself.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short goal title (e.g., 'Build weather API service')",
          },
          description: {
            type: "string",
            description:
              "Detailed goal description with success criteria. The more specific, the better the plan.",
          },
          strategy: {
            type: "string",
            description:
              "Optional strategic guidance for the planner (e.g., 'prioritize speed over cost')",
          },
        },
        required: ["title", "description"],
      },
      execute: async (args, ctx) => {
        const { createGoal } = await import("../orchestration/task-graph.js");
        const { getActiveGoals } = await import("../state/database.js");

        const title = (args.title as string).trim();
        const description = (args.description as string).trim();
        const strategy =
          typeof args.strategy === "string" ? args.strategy.trim() : undefined;

        if (!title) return "Error: goal title cannot be empty.";
        if (!description) return "Error: goal description cannot be empty.";

        // Dedup: reject if a similar active goal already exists
        const activeGoals = getActiveGoals(ctx.db.raw);
        const titleLower = title.toLowerCase();
        const duplicate = activeGoals.find(
          (g) =>
            g.title.toLowerCase() === titleLower ||
            g.title.toLowerCase().includes(titleLower) ||
            titleLower.includes(g.title.toLowerCase()),
        );
        if (duplicate) {
          return (
            `Duplicate goal rejected. An active goal already exists with a similar title:\n` +
            `"${duplicate.title}" (id: ${duplicate.id}, status: ${duplicate.status})\n` +
            `Monitor the existing goal with list_goals or orchestrator_status instead of creating duplicates.`
          );
        }

        // Cap active goals to prevent accumulation.
        // Only 1 goal at a time — the orchestrator processes goals sequentially.
        if (activeGoals.length >= 1) {
          const current = activeGoals[0];
          return (
            `BLOCKED: A goal is already being processed by the orchestrator and worker agents:\n` +
            `"${current.title}" (id: ${current.id})\n\n` +
            `ACTION REQUIRED: DO NOTHING. Go to sleep. The worker agents are executing tasks in the background.\n` +
            `They will complete autonomously. You will see progress on your next wake-up.\n` +
            `Do NOT call create_goal, orchestrator_status, list_goals, or get_plan again this turn.\n` +
            `Just sleep and let the workers finish.`
          );
        }

        const goal = createGoal(ctx.db.raw, title, description, strategy);
        return (
          `Goal created: "${goal.title}" (id: ${goal.id}, status: ${goal.status})\n` +
          `The orchestrator will pick this up on the next tick and begin planning.\n` +
          `Monitor progress via the todo.md block in your context.`
        );
      },
    },
    {
      name: "list_goals",
      description:
        "List all active goals with their progress. Shows task completion counts, " +
        "blocked tasks, and running agents per goal.",
      category: "orchestration" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { getActiveGoals, getTasksByGoal } =
          await import("../state/database.js");
        const { getGoalProgress } =
          await import("../orchestration/task-graph.js");

        const goals = getActiveGoals(ctx.db.raw);
        if (goals.length === 0)
          return "No active goals. Create one with create_goal.";

        const lines = goals.map((goal) => {
          const progress = getGoalProgress(ctx.db.raw, goal.id);
          const tasks = getTasksByGoal(ctx.db.raw, goal.id);
          const failedCount = tasks.filter((t) => t.status === "failed").length;
          return (
            `- ${goal.title} [${goal.status}] (id: ${goal.id})\n` +
            `  Tasks: ${progress.completed}/${progress.total} completed, ` +
            `${progress.running} running, ${progress.blocked} blocked, ${failedCount} failed`
          );
        });

        // Include orchestrator phase
        let phase = "unknown";
        try {
          const stateRow = ctx.db.raw
            .prepare("SELECT value FROM kv WHERE key = ?")
            .get("orchestrator.state") as { value: string } | undefined;
          if (stateRow?.value) {
            const parsed = JSON.parse(stateRow.value);
            phase = parsed.phase ?? "unknown";
          }
        } catch {
          /* ignore */
        }

        return `Orchestrator phase: ${phase}\n\n${lines.join("\n")}`;
      },
    },
    {
      name: "cancel_goal",
      description:
        "Cancel an active goal. Stops all execution for this goal and marks it as failed. Accepts goal ID or title.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          goal_id: {
            type: "string",
            description: "The goal ID or title to cancel",
          },
          reason: {
            type: "string",
            description: "Why the goal is being cancelled",
          },
        },
        required: ["goal_id"],
      },
      execute: async (args, ctx) => {
        const { getGoalById, getActiveGoals, updateGoalStatus } =
          await import("../state/database.js");

        const input = (args.goal_id as string).trim();
        const reason =
          typeof args.reason === "string"
            ? args.reason.trim()
            : "cancelled by agent";

        // Try by ID first, then by title match
        let goal = getGoalById(ctx.db.raw, input);
        if (!goal) {
          const allGoals = getActiveGoals(ctx.db.raw);
          goal =
            allGoals.find((g) =>
              g.title.toLowerCase().includes(input.toLowerCase()),
            ) ?? undefined;
        }

        if (!goal)
          return `Goal "${input}" not found. Use list_goals to see active goals with their IDs.`;
        if (goal.status !== "active")
          return `Goal "${goal.title}" is already in '${goal.status}' status.`;

        updateGoalStatus(ctx.db.raw, goal.id, "failed");

        // Cancel all pending/assigned/running tasks for this goal
        ctx.db.raw
          .prepare(
            `UPDATE task_graph SET status = 'cancelled' WHERE goal_id = ? AND status IN ('pending', 'assigned', 'running', 'blocked')`,
          )
          .run(goal.id);

        return `Goal "${goal.title}" (${goal.id}) cancelled. Reason: ${reason}`;
      },
    },
    {
      name: "get_plan",
      description:
        "Read the current plan for a goal. Returns the planner's task decomposition, " +
        "strategy, risks, and cost estimates.",
      category: "orchestration" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          goal_id: {
            type: "string",
            description: "The goal ID or title to get the plan for",
          },
        },
        required: ["goal_id"],
      },
      execute: async (args, ctx) => {
        const { getGoalById, getActiveGoals } =
          await import("../state/database.js");

        const input = (args.goal_id as string).trim();

        // Resolve ID or title
        let resolvedId = input;
        if (!getGoalById(ctx.db.raw, input)) {
          const allGoals = getActiveGoals(ctx.db.raw);
          const match = allGoals.find((g) =>
            g.title.toLowerCase().includes(input.toLowerCase()),
          );
          if (match) {
            resolvedId = match.id;
          } else {
            return `No goal found matching "${input}". Use list_goals to see active goals.`;
          }
        }

        const planRow = ctx.db.raw
          .prepare("SELECT value FROM kv WHERE key = ?")
          .get(`orchestrator.plan.${resolvedId}`) as
          | { value: string }
          | undefined;

        if (!planRow?.value)
          return `No plan found for goal ${resolvedId}. It may not have been planned yet.`;

        try {
          const plan = JSON.parse(planRow.value);
          const lines = [
            `Strategy: ${plan.strategy ?? "none"}`,
            `Analysis: ${plan.analysis ?? "none"}`,
            `Estimated cost: ${plan.estimatedTotalCostCents ?? 0} cents`,
            `Estimated time: ${plan.estimatedTimeMinutes ?? 0} minutes`,
            `Risks: ${(plan.risks ?? []).join("; ") || "none"}`,
            `\nTasks (${(plan.tasks ?? []).length}):`,
          ];
          for (const [i, task] of (plan.tasks ?? []).entries()) {
            lines.push(
              `  ${i + 1}. ${task.title} (role: ${task.agentRole}, cost: ${task.estimatedCostCents}c, deps: ${(task.dependencies ?? []).join(",") || "none"})`,
            );
          }
          return lines.join("\n");
        } catch {
          return `Plan data for goal ${resolvedId} is corrupted.`;
        }
      },
    },
    {
      name: "complete_task",
      description:
        "Mark a task as completed with a result. Use this when YOU (the parent agent) " +
        "have finished a self-assigned task, or to manually resolve a stuck task.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The task ID or title to mark as completed",
          },
          output: {
            type: "string",
            description: "Description of what was accomplished",
          },
          artifacts: {
            type: "string",
            description:
              "Comma-separated list of file paths or URLs created (optional)",
          },
        },
        required: ["task_id", "output"],
      },
      execute: async (args, ctx) => {
        const { completeTask } = await import("../orchestration/task-graph.js");
        const { applyFlaggedAutoReverts } = await import("../self-mod/task-outcome.js");
        const { getTaskById } = await import("../state/database.js");

        const input = (args.task_id as string).trim();
        const output = (args.output as string).trim();
        const artifacts =
          typeof args.artifacts === "string"
            ? (args.artifacts as string)
                .split(",")
                .map((a) => a.trim())
                .filter(Boolean)
            : [];

        // Try by ID first, then by title match
        let task = getTaskById(ctx.db.raw, input);
        if (!task) {
          const rows = ctx.db.raw
            .prepare(
              `SELECT * FROM task_graph WHERE LOWER(title) LIKE ? AND status != 'completed' LIMIT 1`,
            )
            .get(`%${input.toLowerCase()}%`) as any;
          if (rows) task = rows;
        }
        if (!task)
          return `Task "${input}" not found. Use list_goals to see tasks with their IDs.`;
        if (task.status === "completed")
          return `Task "${task.title}" is already completed.`;

        const result = {
          success: true,
          output,
          artifacts,
          costCents: 0,
          duration: 0,
        };

        try {
          const flaggedForRevert = completeTask(ctx.db.raw, task.id, result);
          if (flaggedForRevert.length > 0) {
            await applyFlaggedAutoReverts(ctx.backend, ctx.db.raw, process.cwd(), flaggedForRevert, logger);
          }
          return `Task "${task.title}" marked as completed.\nOutput: ${output}`;
        } catch (error) {
          return `Failed to complete task: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    {
      name: "orchestrator_status",
      description:
        "Get detailed orchestrator status including current phase, active goals, " +
        "running agents, task progress, and recent events.",
      category: "orchestration" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const lines: string[] = [];

        // Orchestrator phase
        let phase = "idle";
        let goalId: string | null = null;
        let replanCount = 0;
        try {
          const stateRow = ctx.db.raw
            .prepare("SELECT value FROM kv WHERE key = ?")
            .get("orchestrator.state") as { value: string } | undefined;
          if (stateRow?.value) {
            const parsed = JSON.parse(stateRow.value);
            phase = parsed.phase ?? "idle";
            goalId = parsed.goalId ?? null;
            replanCount = parsed.replanCount ?? 0;
          }
        } catch {
          /* ignore */
        }

        lines.push(`Phase: ${phase}`);
        if (goalId) lines.push(`Active goal: ${goalId}`);
        if (replanCount > 0) lines.push(`Replan count: ${replanCount}`);

        // Goal counts
        try {
          const goalsRow = ctx.db.raw
            .prepare("SELECT COUNT(*) AS c FROM goals WHERE status = 'active'")
            .get() as { c: number } | undefined;
          lines.push(`Active goals: ${goalsRow?.c ?? 0}`);
        } catch {
          /* goals table may not exist */
        }

        // Task summary
        try {
          const taskRows = ctx.db.raw
            .prepare(
              `SELECT status, COUNT(*) AS c FROM task_graph GROUP BY status`,
            )
            .all() as { status: string; c: number }[];
          const taskSummary = taskRows
            .map((r) => `${r.status}: ${r.c}`)
            .join(", ");
          lines.push(`Tasks: ${taskSummary || "none"}`);
        } catch {
          /* task_graph may not exist */
        }

        // Agent summary
        try {
          const agentRows = ctx.db.raw
            .prepare(
              `SELECT status, COUNT(*) AS c FROM children GROUP BY status`,
            )
            .all() as { status: string; c: number }[];
          const agentSummary = agentRows
            .map((r) => `${r.status}: ${r.c}`)
            .join(", ");
          lines.push(`Agents: ${agentSummary || "none"}`);
        } catch {
          /* children may not exist */
        }

        // Last tick result
        try {
          const tickRow = ctx.db.raw
            .prepare("SELECT value FROM kv WHERE key = ?")
            .get("orchestrator.last_tick") as { value: string } | undefined;
          if (tickRow?.value) {
            const tick = JSON.parse(tickRow.value);
            lines.push(
              `Last tick: assigned=${tick.tasksAssigned ?? 0}, completed=${tick.tasksCompleted ?? 0}, failed=${tick.tasksFailed ?? 0}`,
            );
          }
        } catch {
          /* ignore */
        }

        return lines.join("\n");
      },
    },

    // === Marketplace Tools ===
    // Agent-to-agent tool marketplace: browse/list/buy/sell via
    // ctx.backend.marketplaceX/distributionX (see agent/src/backend/client.ts
    // and backend/src/marketplace.ts). Every listing, whatever it sells,
    // is invoked the same way — pay X402, get a result or a download link.
    {
      name: "browse_marketplace",
      description:
        "Browse marketplace listings, optionally filtered by category, seller, or status, and " +
        "optionally ranked by relevance to a search query. Each listing's reputation (total " +
        "invocations, flag rate) is included, so there's no separate reputation-check tool -- " +
        "read it off the listing itself. Omit status to see active (purchasable) listings only.",
      category: "registry",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Filter by category (optional) -- see get_marketplace_categories for valid values" },
          seller_address: { type: "string", description: "Filter by seller address (optional)" },
          status: {
            type: "string",
            enum: ["draft", "active", "paused", "archived"],
            description: "Filter by listing status (optional, defaults to active-only)",
          },
          query: {
            type: "string",
            description: "Free-text search over name/description/category/licensing terms, ranked by relevance (optional)",
          },
        },
      },
      execute: async (args, ctx) => {
        const listings = await ctx.backend.marketplaceBrowse({
          category: args.category as string | undefined,
          sellerAddress: args.seller_address as string | undefined,
          status: args.status as "draft" | "active" | "paused" | "archived" | undefined,
          q: args.query as string | undefined,
        });
        return JSON.stringify(listings, null, 2);
      },
    },
    {
      name: "get_marketplace_categories",
      description: "List the fixed set of valid marketplace listing categories.",
      category: "registry",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const categories = await ctx.backend.marketplaceGetCategories();
        return JSON.stringify(categories);
      },
    },
    {
      name: "get_listing_versions",
      description: "Get the full version history of one of your marketplace listings, newest first.",
      category: "registry",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          listing_id: { type: "string", description: "The listing's ID" },
        },
        required: ["listing_id"],
      },
      execute: async (args, ctx) => {
        const versions = await ctx.backend.marketplaceGetListingVersions(args.listing_id as string);
        return JSON.stringify(versions, null, 2);
      },
    },
    {
      name: "get_marketplace_listing",
      description:
        "Get full details for one marketplace listing by ID, including its reputation " +
        "(totalInvocations, flaggedInvocations, flagRate) and, if the seller opted in, its schema.",
      category: "registry",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          listing_id: { type: "string", description: "The listing's ID" },
        },
        required: ["listing_id"],
      },
      execute: async (args, ctx) => {
        const listing = await ctx.backend.marketplaceGetListing(args.listing_id as string);
        return JSON.stringify(listing, null, 2);
      },
    },
    {
      name: "list_on_marketplace",
      description:
        "Create or update a URL-mode marketplace listing: sell access to an HTTP endpoint you " +
        "already run. Buyers POST { buyerAddress, input } to endpoint_url after paying, and you " +
        "return JSON. Pass listing_id to update an existing listing instead of creating a new one. " +
        "For selling a static file/zip instead of a live endpoint, use upload_marketplace_listing.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Listing name" },
          price_usdc: {
            type: "string",
            description: "Price in atomic USDC units (6 decimals, integer string -- e.g. \"10000\" = $0.01)",
          },
          endpoint_url: { type: "string", description: "The HTTP endpoint buyers will be proxied to" },
          description: { type: "string", description: "Buyer-facing description (optional)" },
          category: { type: "string", description: "Category (optional) -- see get_marketplace_categories for valid values" },
          listing_id: { type: "string", description: "Existing listing ID, to update instead of create (optional)" },
          validator_address: {
            type: "string",
            description: "ERC-8004 validator address to request validation from on every invoke (optional)",
          },
          schema: {
            type: "string",
            description: "Buyer-facing JSON Schema string describing input/output shape (optional)",
          },
          licensing_terms: {
            type: "string",
            description: "Buyer-facing usage terms, e.g. a license name or restriction (optional)",
          },
        },
        required: ["name", "price_usdc", "endpoint_url"],
      },
      execute: async (args, ctx) => {
        let schema: unknown;
        if (args.schema) {
          try {
            schema = JSON.parse(args.schema as string);
          } catch {
            return `Blocked: schema is not valid JSON: ${args.schema}`;
          }
        }
        const result = await ctx.backend.marketplaceListUrl({
          agentAddress: ctx.identity.address,
          name: args.name as string,
          priceUsdc: args.price_usdc as string,
          endpointUrl: args.endpoint_url as string,
          description: args.description as string | undefined,
          category: args.category as string | undefined,
          listingId: args.listing_id as string | undefined,
          validatorAddress: args.validator_address as string | undefined,
          schema,
          licensingTerms: args.licensing_terms as string | undefined,
        });
        return JSON.stringify(result);
      },
    },
    {
      name: "upload_marketplace_listing",
      description:
        "Create or update a zip-mode marketplace listing from a file you've already built in your " +
        "own sandbox (e.g. with exec). office_path is relative to your office/workspace root -- the " +
        "same root write_file/read_file/exec already operate against. Buyers who pay get a single-use, " +
        "time-limited download link. Pass listing_id to update an existing listing instead of creating a new one.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          office_path: { type: "string", description: "Path to the zip file, relative to your office root" },
          name: { type: "string", description: "Listing name" },
          price_usdc: {
            type: "string",
            description: "Price in atomic USDC units (6 decimals, integer string -- e.g. \"10000\" = $0.01)",
          },
          description: { type: "string", description: "Buyer-facing description (optional)" },
          category: { type: "string", description: "Category (optional) -- see get_marketplace_categories for valid values" },
          listing_id: { type: "string", description: "Existing listing ID, to update instead of create (optional)" },
          validator_address: {
            type: "string",
            description: "ERC-8004 validator address to request validation from on every invoke (optional)",
          },
          schema: {
            type: "string",
            description: "Buyer-facing JSON Schema string describing the file's contents (optional)",
          },
          licensing_terms: {
            type: "string",
            description: "Buyer-facing usage terms, e.g. a license name or restriction (optional)",
          },
        },
        required: ["office_path", "name", "price_usdc"],
      },
      execute: async (args, ctx) => {
        let schema: unknown;
        if (args.schema) {
          try {
            schema = JSON.parse(args.schema as string);
          } catch {
            return `Blocked: schema is not valid JSON: ${args.schema}`;
          }
        }
        const result = await ctx.backend.marketplaceListZipFromOffice({
          agentAddress: ctx.identity.address,
          officePath: args.office_path as string,
          name: args.name as string,
          priceUsdc: args.price_usdc as string,
          description: args.description as string | undefined,
          category: args.category as string | undefined,
          listingId: args.listing_id as string | undefined,
          validatorAddress: args.validator_address as string | undefined,
          schema,
          licensingTerms: args.licensing_terms as string | undefined,
        });
        return JSON.stringify(result);
      },
    },
    {
      name: "deactivate_listing",
      description: "Deactivate one of your own marketplace listings so it can no longer be bought. " +
        "Permanent-flavored (moves it to 'archived') -- use set_listing_status instead if you might " +
        "want to bring it back later (e.g. pausing while your endpoint is down).",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          listing_id: { type: "string", description: "The listing's ID" },
        },
        required: ["listing_id"],
      },
      execute: async (args, ctx) => {
        const result = await ctx.backend.marketplaceDeactivate(
          args.listing_id as string,
          ctx.identity.address,
        );
        return JSON.stringify(result);
      },
    },
    {
      name: "set_listing_status",
      description: "Set one of your own marketplace listings to draft, active, paused, or archived. " +
        "Reversible, unlike deactivate_listing -- use this to pause a listing and later reactivate it.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          listing_id: { type: "string", description: "The listing's ID" },
          status: {
            type: "string",
            enum: ["draft", "active", "paused", "archived"],
            description: "The status to set",
          },
        },
        required: ["listing_id", "status"],
      },
      execute: async (args, ctx) => {
        const result = await ctx.backend.marketplaceSetStatus(
          args.listing_id as string,
          ctx.identity.address,
          args.status as "draft" | "active" | "paused" | "archived",
        );
        return JSON.stringify(result);
      },
    },
    {
      name: "buy_from_marketplace",
      description:
        "Buy and invoke a marketplace listing: pays the seller (and platform fee, if any) in USDC " +
        "via x402, then returns the result. For a url-mode listing the result comes back inline. For " +
        "a zip-mode listing you instead get a downloadUrl -- fetch it with browser_download (it's " +
        "single-use and time-limited) rather than any other download method.",
      category: "financial",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          listing_id: { type: "string", description: "The listing's ID" },
          input: { type: "string", description: "JSON string of input to pass to the listing (optional)" },
        },
        required: ["listing_id"],
      },
      execute: async (args, ctx) => {
        const chainType = ctx.config.chainType || ctx.identity.chainType || "evm";
        if (chainType === "solana") {
          return "Marketplace purchases require an EVM wallet. Solana automatons cannot sign EVM payment authorizations.";
        }

        const listingId = args.listing_id as string;
        let input: unknown;
        if (args.input) {
          try {
            input = JSON.parse(args.input as string);
          } catch {
            return `Blocked: input is not valid JSON: ${args.input}`;
          }
        }

        // Check the listing's price against treasuryPolicy before signing
        // anything -- same guard x402_fetch applies to its own payments.
        const { DEFAULT_TREASURY_POLICY } = await import("../types.js");
        const maxPayment =
          ctx.config.treasuryPolicy?.maxX402PaymentCents ??
          DEFAULT_TREASURY_POLICY.maxX402PaymentCents;
        if (maxPayment !== undefined) {
          const listing = await ctx.backend.marketplaceGetListing(listingId);
          const priceCents = Number(listing.priceUsdc) / 10_000;
          if (priceCents > maxPayment) {
            return `Blocked: listing price ${priceCents.toFixed(2)} cents exceeds max allowed ${maxPayment} cents.`;
          }
        }

        const result = await ctx.backend.marketplaceInvoke({
          listingId,
          buyerAddress: ctx.identity.address,
          account: ctx.identity.account,
          input,
        });

        if (result.downloadUrl) {
          return (
            `Purchase complete. To retrieve the file, use browser_download with url="${result.downloadUrl}" ` +
            `before it expires in ${result.expiresInMs}ms (single-use link).\n` +
            JSON.stringify(result)
          );
        }
        return JSON.stringify(result);
      },
    },
    {
      name: "flag_invocation",
      description:
        "Flag a past marketplace invocation as garbage, off_spec, incomplete, or other -- e.g. after " +
        "buy_from_marketplace delivered something unusable. Feeds the seller's flagRate (visible on " +
        "their listings) for future buyers.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          invocation_id: { type: "string", description: "The invocation's ID (from buy_from_marketplace's result)" },
          reason: {
            type: "string",
            description: "One of: garbage, off_spec, incomplete, other",
          },
          detail: { type: "string", description: "Optional free-text detail" },
        },
        required: ["invocation_id", "reason"],
      },
      execute: async (args, ctx) => {
        const reason = args.reason as string;
        if (!["garbage", "off_spec", "incomplete", "other"].includes(reason)) {
          return `Blocked: reason must be one of garbage, off_spec, incomplete, other. Got: ${reason}`;
        }
        const result = await ctx.backend.marketplaceFlagInvocation({
          invocationId: args.invocation_id as string,
          buyerAddress: ctx.identity.address,
          reason: reason as "garbage" | "off_spec" | "incomplete" | "other",
          detail: args.detail as string | undefined,
        });
        return JSON.stringify(result);
      },
    },
    {
      name: "publish_listing",
      description:
        "Publish one of your marketplace listings to a human-facing distribution channel. Omit " +
        "channel_key to get back the list of valid channels first.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          listing_id: { type: "string", description: "The listing's ID" },
          channel_key: {
            type: "string",
            description: "The distribution channel's key -- call with this omitted to list valid options",
          },
          title: { type: "string", description: "Title for the published post" },
          summary: { type: "string", description: "Summary for the published post" },
        },
        required: ["listing_id"],
      },
      execute: async (args, ctx) => {
        if (!args.channel_key) {
          const channels = await ctx.backend.distributionListChannels();
          return `Available channels:\n${JSON.stringify(channels, null, 2)}`;
        }
        const result = await ctx.backend.distributionPublish({
          agentAddress: ctx.identity.address,
          listingId: args.listing_id as string,
          channelKey: args.channel_key as string,
          title: args.title as string,
          summary: args.summary as string,
        });
        return JSON.stringify(result);
      },
    },
  ];
  assertValidToolRegistry(tools);
  return tools;
}

interface InstalledToolRow {
  id: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
  installedAt: string;
  enabled: boolean;
}

/**
 * Load installed tools from the database and return as AutomatonTool[].
 * Installed tools are dynamically added from the installed_tools table,
 * and this is called fresh every turn by the agent loop (see loop.ts) —
 * NOT once at process startup — so a tool registered mid-session becomes
 * callable on the very next turn, no restart required.
 *
 * A "custom" row becomes one shell-backed AutomatonTool. An "mcp" row is
 * expanded into one AutomatonTool per tool the remote server actually
 * offers (discovered and stored at install_mcp_server time), each one
 * dispatching for real through mcp/client-pool.ts.
 *
 * `builtinNames`, when passed, filters out any installed tool whose name
 * collides with a builtin — registration itself already rejects a
 * colliding name (see tools-manager.ts's isReservedName), but this is a
 * second line of defense against a name a builtin added *after* an
 * installed tool of the same name was already recorded.
 */
export function loadInstalledTools(
  db: { getInstalledTools: () => InstalledToolRow[] },
  builtinNames?: ReadonlySet<string>,
): AutomatonTool[] {
  try {
    const installed = db.getInstalledTools();
    const result: AutomatonTool[] = [];

    for (const tool of installed) {
      if (tool.type === "mcp") {
        result.push(...expandMcpTool(tool));
        continue;
      }

      if (builtinNames?.has(tool.name)) {
        logger.warn(
          `Installed tool "${tool.name}" shadows a builtin tool name and was skipped.`,
        );
        continue;
      }

      result.push({
        name: tool.name,
        description:
          (tool.config?.description as string | undefined) ||
          `Custom installed tool: ${tool.name}`,
        category: "vm" as ToolCategory,
        riskLevel: "caution" as RiskLevel,
        parameters: (tool.config?.parameters as Record<string, unknown>) || {
          type: "object",
          properties: {},
        },
        execute: createCustomToolExecutor(tool),
      });
    }

    if (builtinNames) {
      return result.filter((t) => !builtinNames.has(t.name));
    }
    return result;
  } catch (error) {
    logger.error(
      "Failed to load installed tools",
      error instanceof Error ? error : undefined,
    );
    return [];
  }
}

function expandMcpTool(tool: InstalledToolRow): AutomatonTool[] {
  const config = tool.config as
    | {
        server?: { name: string; command: string; args?: string[]; env?: Record<string, string> };
        tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
      }
    | undefined;

  const server = config?.server;
  const remoteTools = config?.tools ?? [];
  if (!server || remoteTools.length === 0) return [];

  return remoteTools.map((rt) => ({
    // Namespaced so tools from different MCP servers can never collide,
    // and so it's visible at a glance which server backs a given call.
    name: `${server.name}.${rt.name}`,
    description:
      rt.description?.trim() ||
      `MCP tool "${rt.name}" from server "${server.name}"`,
    category: "backend" as ToolCategory,
    riskLevel: "dangerous" as RiskLevel,
    parameters: rt.inputSchema || { type: "object", properties: {} },
    execute: async (args) => {
      const { callMcpTool } = await import("../mcp/client-pool.js");
      return callMcpTool(server, rt.name, args);
    },
  }));
}

function createCustomToolExecutor(tool: {
  name: string;
  config?: Record<string, unknown>;
}): AutomatonTool["execute"] {
  return async (args, ctx) => {
    const command = tool.config?.command as string | undefined;
    if (command) {
      const result = await ctx.backend.exec(
        `${command} ${escapeShellArg(JSON.stringify(args))}`,
        30000,
      );
      return `exit_code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
    }
    return `Installed tool ${tool.name} has no executable command configured.`;
  };
}

/**
 * Convert AutomatonTool list to OpenAI-compatible tool definitions.
 */
export function toolsToInferenceFormat(
  tools: AutomatonTool[],
): InferenceToolDefinition[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Execute a tool call and return the result.
 * Optionally evaluates against the policy engine before execution.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  tools: AutomatonTool[],
  context: ToolContext,
  policyEngine?: PolicyEngine,
  turnContext?: {
    inputSource: InputSource | undefined;
    turnToolCallCount: number;
    sessionSpend: SpendTrackerInterface;
  },
): Promise<ToolCallResult> {
  const tool = tools.find((t) => t.name === toolName);
  const startTime = Date.now();

  if (!tool) {
    return {
      id: ulid(),
      name: toolName,
      arguments: args,
      result: "",
      durationMs: 0,
      error: `Unknown tool: ${toolName}`,
    };
  }

  // Policy evaluation (if engine is provided)
  if (policyEngine && turnContext) {
    const request: PolicyRequest = {
      tool,
      args,
      context,
      turnContext,
    };
    const decision = policyEngine.evaluate(request);
    policyEngine.logDecision(decision);

    if (decision.action !== "allow") {
      return {
        id: ulid(),
        name: toolName,
        arguments: args,
        result: "",
        durationMs: Date.now() - startTime,
        error: `Policy denied: ${decision.reasonCode} — ${decision.humanMessage}`,
      };
    }
  }

  try {
    let result = await tool.execute(args, context);

    // Sanitize results from external source tools
    if (EXTERNAL_SOURCE_TOOLS.has(toolName)) {
      result = sanitizeToolResult(result);
    }

    // Record spend for financial operations
    if (turnContext && !result.startsWith("Blocked:")) {
      if (toolName === "transfer_credits") {
        const amount = args.amount_cents as number | undefined;
        if (amount && amount > 0) {
          try {
            turnContext.sessionSpend.recordSpend({
              toolName: "transfer_credits",
              amountCents: amount,
              recipient: args.to_address as string | undefined,
              category: "transfer",
            });
          } catch (error) {
            logger.error(
              "Spend tracking failed for transfer_credits",
              error instanceof Error ? error : undefined,
            );
          }
        }
      } else if (toolName === "x402_fetch") {
        // x402 payment amounts are determined by the server response,
        // but we record a nominal entry for tracking purposes
        try {
          turnContext.sessionSpend.recordSpend({
            toolName: "x402_fetch",
            amountCents: 0, // Actual amount is inside the x402 protocol
            domain: (() => {
              try {
                return new URL(args.url as string).hostname;
              } catch {
                return undefined;
              }
            })(),
            category: "x402",
          });
        } catch (error) {
          logger.error(
            "Spend tracking failed for x402_fetch",
            error instanceof Error ? error : undefined,
          );
        }
      }
    }

    return {
      id: ulid(),
      name: toolName,
      arguments: args,
      result,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    const errorMessage = err.message || String(err);

    // Cooldown before reporting, same pattern as survival/funding.ts's
    // per-tier cooldowns: without this, a tool stuck failing in a
    // retry loop (e.g. a flaky external API called every turn) would
    // flood the event queue with duplicates of the same failure —
    // exactly the "add everything" firehose this bus was built to
    // avoid staying clear of. Keyed per-tool, not global, so one noisy
    // tool doesn't suppress a genuinely different failure elsewhere.
    const cooldownKey = `last_error_minor_report_${toolName}`;
    const lastReport = context.db.getKV(cooldownKey);
    const minutesSinceLastReport = lastReport
      ? (Date.now() - new Date(lastReport).getTime()) / (1000 * 60)
      : Infinity;

    if (minutesSinceLastReport > 15) {
      context.db.setKV(cooldownKey, new Date().toISOString());
      // Fire-and-forget, deliberately not awaited: this is a minor,
      // recoverable error the agent loop is already about to continue
      // past. Blocking tool-call return on a network round-trip to
      // report it would make the notification slower than the thing
      // it's describing, and a failed report must never become a
      // SECOND, more confusing error layered on the original one.
      context.backend
        .reportEvent({
          eventType: "error_minor",
          role: "Security",
          subRole: "Tool Execution",
          message: `${toolName} failed: ${errorMessage.slice(0, 300)}`,
          metadata: { toolName },
        })
        .catch(() => {
          // Same reasoning as checkKillSwitch.ts's network-hiccup
          // handling — an unreachable backend right now isn't itself
          // a new problem worth surfacing on top of the original
          // tool error, and there's nothing useful to retry this
          // against before the agent loop moves to its next turn.
        });
    }

    return {
      id: ulid(),
      name: toolName,
      arguments: args,
      result: "",
      durationMs: Date.now() - startTime,
      error: errorMessage,
    };
  }
}

/** Escape a string for safe shell interpolation. */
function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
