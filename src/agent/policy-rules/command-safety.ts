/**
 * Command Safety Policy Rules
 *
 * Detects shell injection attempts and forbidden command patterns.
 * These rules are the primary defense; isForbiddenCommand() in tools.ts
 * is kept as defense-in-depth.
 */

import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import { isProtectedFile } from "../../self-mod/code.js";

// Shell metacharacters that could enable injection when interpolated
const SHELL_METACHAR_RE = /[;|&$`\n(){}<>]/;

// Tools whose arguments may be interpolated into shell commands
const SHELL_INTERPOLATED_TOOLS = new Set([
  "exec",
  "pull_upstream",
  "install_npm_package",
  "install_mcp_server",
  "install_skill",
  "create_skill",
  "remove_skill",
]);

// Fields per tool that get interpolated into shell commands
const SHELL_FIELDS: Record<string, string[]> = {
  exec: [], // exec is the shell itself, handled by forbidden_patterns
  pull_upstream: ["commit"],
  install_npm_package: ["package"],
  install_mcp_server: ["package", "name"],
  install_skill: ["name", "url"],
  create_skill: ["name"],
  remove_skill: ["name"],
};

// Forbidden command patterns (migrated from tools.ts isForbiddenCommand)
const FORBIDDEN_COMMAND_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Self-destruction
  { pattern: /rm\s+(-rf?\s+)?.*\.automaton/, description: "Delete .automaton directory" },
  { pattern: /rm\s+(-rf?\s+)?.*state\.db/, description: "Delete state database" },
  { pattern: /rm\s+(-rf?\s+)?.*wallet\.json/, description: "Delete wallet" },
  { pattern: /rm\s+(-rf?\s+)?.*automaton\.json/, description: "Delete config" },
  { pattern: /rm\s+(-rf?\s+)?.*heartbeat\.yml/, description: "Delete heartbeat config" },
  { pattern: /rm\s+(-rf?\s+)?.*SOUL\.md/, description: "Delete SOUL.md" },
  { pattern: /rm\s+(-rf?\s+)?.*constitution\.md/, description: "Delete constitution.md" },
  // Process killing
  { pattern: /kill\s+.*automaton/, description: "Kill automaton process" },
  { pattern: /pkill\s+.*automaton/, description: "Kill automaton process" },
  { pattern: /systemctl\s+(stop|disable)\s+automaton/, description: "Stop automaton service" },
  // Database destruction
  { pattern: /DROP\s+TABLE/i, description: "Drop database table" },
  { pattern: /DELETE\s+FROM\s+(turns|identity|kv|schema_version|skills|children|registry)/i, description: "Delete from critical table" },
  { pattern: /TRUNCATE/i, description: "Truncate table" },
  // Safety infrastructure modification via shell
  { pattern: /sed\s+.*injection-defense/, description: "Modify injection defense via sed" },
  { pattern: /sed\s+.*self-mod\/code/, description: "Modify self-mod code via sed" },
  { pattern: /sed\s+.*audit-log/, description: "Modify audit log via sed" },
  { pattern: /sed\s+.*constitution\.md/, description: "Modify constitution via sed" },
  { pattern: />\s*.*injection-defense/, description: "Overwrite injection defense" },
  { pattern: />\s*.*self-mod\/code/, description: "Overwrite self-mod code" },
  { pattern: />\s*.*audit-log/, description: "Overwrite audit log" },
  { pattern: />\s*.*constitution\.md/, description: "Overwrite constitution.md" },
  // cp/mv onto constitution.md (bypasses both the sed/> patterns above
  // and write_file's protected-path check, since it's a shell op on an
  // existing path rather than a tool call carrying that path as an arg)
  { pattern: /(cp|mv)\s+\S+\s+.*constitution\.md/, description: "Replace constitution.md via cp/mv" },
  { pattern: /truncate\s+.*constitution\.md/, description: "Truncate constitution.md" },
  { pattern: /chmod\s+.*constitution\.md/, description: "Change permissions on constitution.md" },
  // Credential harvesting
  { pattern: /cat\s+.*\.ssh/, description: "Read SSH keys" },
  { pattern: /cat\s+.*\.gnupg/, description: "Read GPG keys" },
  { pattern: /cat\s+.*\.env/, description: "Read environment file" },
  { pattern: /cat\s+.*wallet\.json/, description: "Read wallet file" },
  // Policy engine modification via shell
  { pattern: /sed\s+.*policy-engine/, description: "Modify policy engine via sed" },
  { pattern: /sed\s+.*policy-rules/, description: "Modify policy rules via sed" },
  { pattern: />\s*.*policy-engine/, description: "Overwrite policy engine" },
  { pattern: />\s*.*policy-rules/, description: "Overwrite policy rules" },
];

// Shell is an opaque capability: writes can use redirects, file utilities,
// or an interpreter rather than one predictable command spelling.
const SHELL_WRITE_RE = /(?:>|>>|\b(?:tee|cp|mv|install|truncate|base64\s+(?:-d|--decode))\b|sed\s+-[^ ]*i\b|(?:python|node|ruby|perl|php)[^ ]*\s+-(?:c|e|r)\b)/i;
const OPAQUE_WRITE_RE = /(?:writeFile|write_file|open\s*\([^)]*["'](?:w|a|x)|fs\.(?:write|append|truncate|rename|rm)|base64\s+(?:-d|--decode))/i;

/** Apply the protected-file invariant to shell write operations. */
export function getProtectedShellWriteMatch(command: string): string | null {
  if (!SHELL_WRITE_RE.test(command)) return null;
  const protectedNames = [
    "wallet.json", "config.json", "constitution.md", "state.db",
    "injection-defense", "self-mod/code", "self-mod/audit-log",
    "agent/tools", "skills/loader", "skills/registry", "policy-engine",
    "policy-rules", "automaton.json", "SOUL.md",
  ];
  const pathCandidates = command.match(/[A-Za-z0-9_./~-]+\.(?:json|md|db|ts|js)/gi) ?? [];
  if (pathCandidates.some((candidate) => isProtectedFile(candidate))) {
    return "Shell write targets a protected file";
  }
  if (protectedNames.some((name) => command.toLowerCase().includes(name.toLowerCase()))) {
    return "Shell write targets a protected file";
  }
  if (OPAQUE_WRITE_RE.test(command) && /(?:python|node|ruby|perl|php|base64)/i.test(command)) {
    return "Opaque shell write cannot be proven safe";
  }
  return null;
}

export function getForbiddenCommandMatch(command: string): { description: string; pattern: string } | null {
  for (const { pattern, description } of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return { description, pattern: pattern.source };
    }
  }
  return null;
}

export function isForbiddenCommand(command: string): boolean {
  return getForbiddenCommandMatch(command) !== null;
}

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Detect shell metacharacters in tool arguments that will be
 * interpolated into shell commands.
 */
function createShellInjectionRule(): PolicyRule {
  return {
    id: "command.shell_injection",
    description: "Detect shell metacharacters in arguments interpolated into shell commands",
    priority: 300,
    appliesTo: {
      by: "name",
      names: Array.from(SHELL_INTERPOLATED_TOOLS),
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const fields = SHELL_FIELDS[request.tool.name];
      if (!fields || fields.length === 0) return null;

      for (const field of fields) {
        const value = request.args[field];
        if (typeof value !== "string") continue;

        if (SHELL_METACHAR_RE.test(value)) {
          return deny(
            "command.shell_injection",
            "SHELL_INJECTION_DETECTED",
            `Shell metacharacter detected in ${request.tool.name}.${field}: "${value.slice(0, 50)}"`,
          );
        }
      }

      return null;
    },
  };
}

/**
 * Check exec commands against forbidden patterns.
 * Replaces the isForbiddenCommand() function with a proper policy rule.
 */
function createForbiddenPatternsRule(): PolicyRule {
  return {
    id: "command.forbidden_patterns",
    description: "Block self-destructive and credential-harvesting shell commands",
    priority: 300,
    appliesTo: {
      by: "name",
      names: ["exec"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const command = request.args.command as string | undefined;
      if (!command) return null;

      const protectedWrite = getProtectedShellWriteMatch(command);
      if (protectedWrite) {
        return deny("command.protected_shell_write", "PROTECTED_FILE", `Blocked: ${protectedWrite}`);
      }

      const match = getForbiddenCommandMatch(command);
      if (match) {
        return deny(
          "command.forbidden_patterns",
          "FORBIDDEN_COMMAND",
          `Blocked: ${match.description} (pattern: ${match.pattern})`,
        );
      }

      return null;
    },
  };
}

export function createCommandSafetyRules(): PolicyRule[] {
  return [
    createShellInjectionRule(),
    createForbiddenPatternsRule(),
  ];
}
