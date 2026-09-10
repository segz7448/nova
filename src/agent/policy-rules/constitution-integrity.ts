/**
 * Constitution Integrity Policy Rule
 *
 * The lowest-numbered (= first-evaluated) priority of any rule in the
 * engine. If constitution-guard.ts's heartbeat check has latched the
 * "compromised" flag, this denies every tool call outright — no
 * exceptions, no allowlist for "safe" tools — until a human operator
 * clears it via the CLI.
 *
 * This is what makes Law enforcement rigid rather than advisory: every
 * other rule in this directory answers "is this specific action ok".
 * This one answers "is the law itself still intact", and if the answer
 * is no, no other rule gets a chance to say yes.
 */

import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import { isConstitutionCompromised, compromisedDetail } from "../../soul/constitution-guard.js";

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

function createConstitutionIntegrityRule(): PolicyRule {
  return {
    id: "constitution.integrity_halt",
    description: "Deny all tool calls when constitution.md integrity verification has failed",
    priority: 0,
    appliesTo: { by: "all" },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const db = request.context.db;
      if (!isConstitutionCompromised(db)) return null;

      return deny(
        "constitution.integrity_halt",
        "CONSTITUTION_COMPROMISED",
        `Blocked: constitution integrity check failed (${compromisedDetail(db)}). ` +
          `This automaton will not take further action until a human operator investigates ` +
          `and clears the flag. This cannot be overridden from within a tool call.`,
      );
    },
  };
}

export function createConstitutionIntegrityRules(): PolicyRule[] {
  return [createConstitutionIntegrityRule()];
}
