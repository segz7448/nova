/**
 * Department Scope Policy Rule
 *
 * Follow-up wiring from /MERGE-NOTES.md item 2: department-profiles.ts's
 * resolveProfileActions() returned agent-runtime `Action` names, and
 * nothing in agent/'s policy engine consulted it. This rule is that
 * missing consumer.
 *
 * MAPPING DECISION (the part MERGE-NOTES.md left open): of the ~90
 * `Action` names department-profiles.ts's CAPABILITY_TO_ACTIONS can
 * resolve to, only the ones below have a real, currently-existing
 * counterpart in agent/src/agent/tools.ts. The rest — every
 * pty_*, mail_*, provision_subdomain/list_subdomains/release_subdomain,
 * and the whole create_department/spawn_department_worker/... department-
 * *management* vocabulary — are backend REST endpoints
 * (backend/src/departments.ts, backend/src/domains.ts), never agent-side
 * tool calls, so they simply cannot appear as `request.tool.name` here.
 * There is nothing to enforce locally for them; the backend's own
 * per-department budget/permission checks are what govern those.
 *
 * ACTION_TO_TOOL_NAME is therefore intentionally partial. Any tool NOT
 * present anywhere in its codomain (GOVERNED_TOOL_NAMES) is untouched by
 * this rule regardless of department profile — it's governed by
 * whatever other policy-rules/*.ts file already covers it (authority,
 * financial, rate-limits, etc.), exactly as before this rule existed.
 */

import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import { resolveProfileActions, type Action } from "./department-profiles.js";

/**
 * Action -> native tool name(s) in agent/src/agent/tools.ts. Only
 * covers Actions with a real, currently-existing counterpart — see
 * file header. `check_balance` maps to both of tools.ts's two balance
 * checks (check_credits/check_usdc_balance) since this runtime split
 * agent-runtime's single financial primitive into two.
 */
const ACTION_TO_TOOL_NAME: Partial<Record<Action, string[]>> = {
  run_command: ["exec"],
  read_file: ["read_file"],
  write_file: ["write_file"],
  web_search: ["web_search"],
  web_fetch: ["web_fetch"],
  github_read: ["github_read"],
  check_balance: ["check_credits", "check_usdc_balance"],
};

/** Every native tool name this rule is capable of gating at all. */
const GOVERNED_TOOL_NAMES: string[] = Array.from(
  new Set(Object.values(ACTION_TO_TOOL_NAME).flat()),
);

/**
 * Resolves an AutomatonConfig's (agentTier, departmentRole, workerRole)
 * into the set of native tool names this automaton is allowed to call,
 * or `null` when it isn't department/worker-scoped at all (a top-level
 * Agent, or agentTier unset — the pre-existing, unrestricted behavior).
 */
export function resolveAllowedToolNames(
  agentTier: "agent" | "department_agent" | "worker" | undefined,
  departmentRole: string | null | undefined,
  workerRole: string | null | undefined,
): Set<string> | null {
  if (agentTier !== "department_agent" && agentTier !== "worker") {
    return null; // unrestricted — top-level Agent or unconfigured
  }

  const actions = resolveProfileActions(
    departmentRole,
    agentTier === "worker" ? workerRole : undefined,
  );

  const allowed = new Set<string>();
  for (const action of actions) {
    const toolNames = ACTION_TO_TOOL_NAME[action];
    if (toolNames) {
      for (const name of toolNames) allowed.add(name);
    }
  }
  return allowed;
}

function deny(reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule: "department_scope.tool_not_in_profile", action: "deny", reasonCode, humanMessage };
}

export function createDepartmentScopeRules(): PolicyRule[] {
  return [
    {
      id: "department_scope.tool_not_in_profile",
      description:
        "Deny tool calls outside a Department Agent/Worker's resolved department-profiles.ts allowlist",
      // Priority: after authority (400) so an already-denied dangerous
      // tool doesn't need a second, redundant denial reason; before
      // rate-limits so a plainly out-of-scope call fails fast without
      // burning rate-limit budget.
      priority: 450,
      appliesTo: { by: "name", names: GOVERNED_TOOL_NAMES },
      evaluate(request: PolicyRequest): PolicyRuleResult | null {
        const config = request.context.config;
        const allowed = resolveAllowedToolNames(
          config.agentTier,
          config.departmentRole,
          config.workerRole,
        );
        if (allowed === null) return null; // not department/worker-scoped

        if (!allowed.has(request.tool.name)) {
          return deny(
            "TOOL_OUTSIDE_DEPARTMENT_PROFILE",
            `Tool "${request.tool.name}" is not in the resolved tool profile for ` +
              `department "${config.departmentRole ?? "(none)"}"` +
              (config.workerRole ? ` / worker role "${config.workerRole}"` : "") +
              `.`,
          );
        }
        return null;
      },
    },
  ];
}
