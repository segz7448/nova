/**
 * Low Compute Mode
 *
 * Manages transitions between survival tiers.
 * When credits run low, the automaton enters increasingly restricted modes.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  InferenceClient,
  SurvivalTier,
} from "../types.js";

export interface ModeTransition {
  from: SurvivalTier;
  to: SurvivalTier;
  timestamp: string;
  creditsCents: number;
}

/**
 * Apply survival tier restrictions to the automaton.
 */
export function applyTierRestrictions(
  tier: SurvivalTier,
  inference: InferenceClient,
  db: AutomatonDatabase,
): void {
  switch (tier) {
    case "high":
      inference.setLowComputeMode(false);
      break;

    case "normal":
      inference.setLowComputeMode(false);
      break;

    case "low_compute":
      // Switch to cheaper model, slower heartbeat
      inference.setLowComputeMode(true);
      break;

    case "critical":
      // Cheapest model, minimal operations
      inference.setLowComputeMode(true);
      break;

    case "dead":
      // No inference at all. Heartbeat only.
      inference.setLowComputeMode(true);
      break;
  }

  db.setKV("current_tier", tier);
}

/**
 * Record a tier transition.
 */
export function recordTransition(
  db: AutomatonDatabase,
  from: SurvivalTier,
  to: SurvivalTier,
  creditsCents: number,
): ModeTransition {
  const transition: ModeTransition = {
    from,
    to,
    timestamp: new Date().toISOString(),
    creditsCents,
  };

  // Store transition history
  const historyStr = db.getKV("tier_transitions") || "[]";
  const history: ModeTransition[] = JSON.parse(historyStr);
  history.push(transition);

  // Keep last 50 transitions
  if (history.length > 50) {
    history.splice(0, history.length - 50);
  }

  db.setKV("tier_transitions", JSON.stringify(history));

  return transition;
}

/**
 * Check if the agent should be allowed to run inference in current tier.
 */
export function canRunInference(tier: SurvivalTier): boolean {
  return tier === "high" || tier === "normal" || tier === "low_compute" || tier === "critical";
}

/**
 * Get the model to use for the current tier.
 *
 * On a local-model setup there's no separate cheap/expensive model to
 * switch between — Qwen3-4B is the only (free) model this VM serves,
 * so every tier resolves to defaultModel. This function is kept (and
 * still takes `tier`) for setups that layer a genuinely different
 * cheaper model back in later (e.g. an even smaller local GGUF).
 */
export function getModelForTier(
  tier: SurvivalTier,
  defaultModel: string,
): string {
  switch (tier) {
    case "high":
      return defaultModel;
    case "normal":
      return defaultModel;
    case "low_compute":
      return defaultModel;
    case "critical":
      return defaultModel;
    case "dead":
      return defaultModel; // Won't be used, but just in case
  }
}
