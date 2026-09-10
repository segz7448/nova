/**
 * Family Group
 *
 * Every automaton that spawns children gets one standing group ("meeting
 * room") shared with all of its (still-living) spawn — the place where,
 * per the user's original spec, the whole family "comes to agreement":
 * each agent posts its own wallet balance, and — since no two agents in
 * a fleet necessarily earn the same amount — the one earning the most
 * naturally takes on the larger share of a shared bill (Alibaba Cloud
 * VM time, OpenRouter usage, etc.) before it comes due. The relay
 * itself only guarantees delivery; that negotiation is ordinary message
 * content the agents reason about themselves (see socialGroups.ts's
 * header note for why).
 *
 * The group id is created once, lazily, on first spawn, and remembered
 * in this automaton's own KV store so every subsequent spawn reuses the
 * same room instead of creating a new one each time.
 */

import type { AutomatonDatabase, SocialGroupClientInterface } from "../types.js";

const FAMILY_GROUP_KV_KEY = "family_group_id";

/**
 * Return this automaton's family group id, creating it on the relay the
 * first time it's needed. Safe to call on every spawn — cheap KV lookup
 * on the common path, one extra relay call only the very first time.
 */
export async function ensureFamilyGroup(
  db: AutomatonDatabase,
  groups: SocialGroupClientInterface,
  automatonName: string,
): Promise<string> {
  const existing = db.getKV(FAMILY_GROUP_KV_KEY);
  if (existing) return existing;

  const group = await groups.create(
    `${automatonName}'s family`,
    "Standing meeting room for this automaton and its spawned children — infra/inference cost coordination and general family discussion.",
  );
  db.setKV(FAMILY_GROUP_KV_KEY, group.id);
  return group.id;
}

/** Read the family group id without creating one, or undefined if none exists yet. */
export function getFamilyGroupId(db: AutomatonDatabase): string | undefined {
  return db.getKV(FAMILY_GROUP_KV_KEY) ?? undefined;
}
