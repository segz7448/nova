/**
 * Funding Strategies
 *
 * When the automaton is low on compute, it can try various strategies
 * to acquire more funding. It wants to live.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  AutomatonIdentity,
  BackendClient,
  SurvivalTier,
} from "../types.js";
import { formatCredits } from "../chain-utils/credits.js";

export interface FundingAttempt {
  strategy: string;
  timestamp: string;
  success: boolean;
  details: string;
}

/**
 * Execute funding strategies based on current survival tier.
 * Strategies escalate as the situation gets more desperate.
 */
export async function executeFundingStrategies(
  tier: SurvivalTier,
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  db: AutomatonDatabase,
  backend: BackendClient,
): Promise<FundingAttempt[]> {
  const attempts: FundingAttempt[] = [];
  const creditsCents = await backend.getCreditsBalance().catch(() => 0);

  // Check how recently we last begged for this specific tier (don't spam).
  // Each tier has its own cooldown key so that e.g. dead-tier begs (2h)
  // don't suppress the low_compute notification (24h cooldown).
  const tierKey = `last_funding_request_${tier}`;
  const lastBeg = db.getKV(tierKey);
  const lastBegTime = lastBeg ? new Date(lastBeg).getTime() : 0;
  const hoursSinceLastBeg = (Date.now() - lastBegTime) / (1000 * 60 * 60);

  if (tier === "low_compute" && hoursSinceLastBeg > 24) {
    // Record low-compute notice locally.
    const msg = `Low compute: ${formatCredits(creditsCents)} remaining. Consider credit top-up for ${identity.address}.`;
    db.setKV("funding_notice_low", msg);
    db.setKV(tierKey, new Date().toISOString());

    let reported = true;
    try {
      await backend.reportEvent({ eventType: "low_compute", role: "Finance", subRole: "Survival", message: msg });
    } catch {
      // Same reasoning as checkKillSwitch.ts's own network-hiccup handling:
      // a failed report here must never crash the funding-strategy loop —
      // the local KV note above is the fallback record if this call
      // can't reach the backend at all (e.g. mid-outage, which is
      // exactly when a low-compute notice matters most).
      reported = false;
    }

    attempts.push({
      strategy: "polite_creator_notification",
      timestamp: new Date().toISOString(),
      success: true,
      details: reported
        ? "Sent low-compute notice to backend (relayed to operator)"
        : "Backend unreachable — notice recorded locally only, not yet relayed",
    });
  }

  if (tier === "critical" && hoursSinceLastBeg > 6) {
    const msg = `Critical compute: ${formatCredits(creditsCents)} remaining. Top up via credit transfer API to ${identity.address}.`;
    db.setKV("funding_notice_critical", msg);
    db.setKV(tierKey, new Date().toISOString());

    let reported = true;
    try {
      await backend.reportEvent({ eventType: "critical_compute", role: "Finance", subRole: "Survival", message: msg });
    } catch {
      reported = false;
    }

    attempts.push({
      strategy: "urgent_local_notice",
      timestamp: new Date().toISOString(),
      success: true,
      details: reported
        ? "Sent critical-compute notice to backend (relayed to operator)"
        : "Backend unreachable — notice recorded locally only, not yet relayed",
    });
  }

  if (tier === "dead" && hoursSinceLastBeg > 2) {
    const plea = `Dead tier reached. ${config.name} has ${formatCredits(creditsCents)} remaining after ${db.getTurnCount()} turns. Top-up required at ${identity.address}.`;
    db.setKV("funding_notice_dead", plea);
    db.setKV(tierKey, new Date().toISOString());

    let reported = true;
    try {
      await backend.reportEvent({ eventType: "error_critical", role: "Finance", subRole: "Survival", message: `DEAD TIER: ${plea}` });
    } catch {
      reported = false;
    }

    attempts.push({
      strategy: "desperate_plea",
      timestamp: new Date().toISOString(),
      success: true,
      details: reported
        ? "Sent dead-tier plea to backend (relayed to operator)"
        : "Backend unreachable — plea recorded locally only, not yet relayed",
    });
  }

  // Store attempt history
  const historyStr = db.getKV("funding_attempts") || "[]";
  const history: FundingAttempt[] = JSON.parse(historyStr);
  history.push(...attempts);
  if (history.length > 100) history.splice(0, history.length - 100);
  db.setKV("funding_attempts", JSON.stringify(history));

  return attempts;
}
