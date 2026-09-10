/**
 * Infra-Financial Policy Rules
 *
 * These gate the tool(s) that trigger runInfraPurchase (see
 * infra/README.md for wiring a `infra_purchase` tool into agent/tools.ts
 * if you want the agent able to trigger one manually, in addition to
 * the automatic heartbeat triggers). The heartbeat path already checks
 * these same caps inside ops.ts directly — these rules are the belt to
 * that suspenders for anything reachable via a tool call instead.
 */

import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import type { InfraPolicy } from "../../infra/types.js";

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

function createInfraMaxSingleRule(policy: InfraPolicy): PolicyRule {
  return {
    id: "infra.max_single_purchase",
    description: `Deny infra purchases above $${policy.maxSinglePurchaseUsd}`,
    priority: 500,
    appliesTo: { by: "name", names: ["infra_purchase"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const cost = request.args.predicted_cost_usd as number | undefined;
      if (cost === undefined) return null;
      if (cost > policy.maxSinglePurchaseUsd) {
        return deny(
          "infra.max_single_purchase",
          "SPEND_LIMIT_EXCEEDED",
          `Infra purchase of $${cost} exceeds single-purchase cap of $${policy.maxSinglePurchaseUsd}`,
        );
      }
      return null;
    },
  };
}

function createInfraGpuConfirmationRule(policy: InfraPolicy): PolicyRule {
  return {
    id: "infra.gpu_migration_confirmation",
    description: "Quarantine GPU migrations for operator confirmation",
    priority: 500,
    appliesTo: { by: "name", names: ["infra_purchase"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const resourceType = request.args.resource_type as string | undefined;
      if (resourceType !== "gpu_migration") return null;
      return {
        rule: "infra.gpu_migration_confirmation",
        action: "quarantine",
        reasonCode: "CONFIRMATION_REQUIRED",
        humanMessage: "GPU migrations always require operator confirmation via resumeAndPurchase, regardless of cost.",
      };
    },
  };
}

function createInfraWalletAllowlistRule(allowedAddress: string): PolicyRule {
  return {
    id: "infra.wallet_allowlist",
    description: "Deny USDC sends to any address other than the configured Alibaba wallet",
    priority: 500,
    appliesTo: { by: "name", names: ["infra_purchase"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const toAddress = request.args.to_address as string | undefined;
      if (!toAddress) return null;
      if (toAddress.toLowerCase() !== allowedAddress.toLowerCase()) {
        return deny(
          "infra.wallet_allowlist",
          "ADDRESS_NOT_ALLOWED",
          `Infra USDC sends may only go to the configured Alibaba wallet (${allowedAddress}), not ${toAddress}`,
        );
      }
      return null;
    },
  };
}

export function createInfraFinancialRules(policy: InfraPolicy, alibabaWalletAddress: string): PolicyRule[] {
  return [
    createInfraMaxSingleRule(policy),
    createInfraGpuConfirmationRule(policy),
    createInfraWalletAllowlistRule(alibabaWalletAddress),
  ];
}
