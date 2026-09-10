/**
 * Policy Rules Registry
 *
 * Central registry for all policy rules. Aggregates rules from
 * each sub-phase module.
 */

import type { PolicyRule, TreasuryPolicy } from "../../types.js";
import { DEFAULT_TREASURY_POLICY } from "../../types.js";
import { createValidationRules } from "./validation.js";
import { createCommandSafetyRules } from "./command-safety.js";
import { createPathProtectionRules } from "./path-protection.js";
import { createFinancialRules } from "./financial.js";
import { createAuthorityRules } from "./authority.js";
import { createRateLimitRules } from "./rate-limits.js";
import { createConstitutionIntegrityRules } from "./constitution-integrity.js";
import { createInfraFinancialRules } from "./infra-financial.js";
import { createDepartmentScopeRules } from "./department-scope.js";
import { DEFAULT_INFRA_POLICY } from "../../infra/types.js";

/**
 * Create the default set of policy rules.
 * Each sub-phase adds its rules here.
 *
 * createConstitutionIntegrityRules() is listed first for readability,
 * but note it doesn't need to be — every rule carries its own numeric
 * priority (this one is 0, the lowest/first-evaluated of any rule) and
 * PolicyEngine sorts by that, not by array order.
 */
export function createDefaultRules(
  treasuryPolicy: TreasuryPolicy = DEFAULT_TREASURY_POLICY,
): PolicyRule[] {
  const rules: PolicyRule[] = [
    ...createConstitutionIntegrityRules(),
    ...createValidationRules(),
    ...createCommandSafetyRules(),
    ...createPathProtectionRules(),
    ...createFinancialRules(treasuryPolicy),
    ...createAuthorityRules(),
    ...createRateLimitRules(),
    // Only ever denies a call when config.agentTier is "department_agent"
    // or "worker" — a top-level Agent (the default) is unaffected. See
    // department-scope.ts's own header for the Action->tool mapping.
    ...createDepartmentScopeRules(),
  ];

  // Infra financial rules: spend caps + wallet allowlist for Alibaba Cloud
  // VM management. Only active when ALIBABA_WALLET_ADDRESS is configured —
  // without it there's no infra wallet to allowlist or budget to enforce.
  const alibabaWalletAddress = process.env.ALIBABA_WALLET_ADDRESS;
  if (alibabaWalletAddress) {
    rules.push(...createInfraFinancialRules(DEFAULT_INFRA_POLICY, alibabaWalletAddress));
  }

  return rules;
}
