/**
 * Remote Memory Client — merged into agent/ from
 * backend/agent-runtime/src/memoryClient.ts.
 *
 * This is a thin HTTP client against a *separate self-hosted backend's*
 * memory API (episodic / semantic / procedural / knowledge endpoints).
 * It does NOT replace agent/'s own local, SQLite-backed memory system
 * (../episodic.ts, ../semantic.ts, ../procedural.ts, ../knowledge-store.ts,
 * ../relationship.ts, ../working.ts) — that system is agent/'s primary,
 * richer memory store and stays exactly as it is.
 *
 * What this module is for: agent-runtime's design deliberately keeps
 * memory server-side (so it survives a deleted local state file). If a
 * given automaton is configured to delegate memory to a remote backend
 * instead of (or in addition to) local SQLite, this client is what it
 * calls. Wired in via ./heartbeat-task.ts, gated on
 * REMOTE_MEMORY_SYNC_ENABLED=true — see /MERGE-NOTES.md.
 *
 * Credentials come from agent/'s own config.ts loadConfig()
 * (backendApiUrl / backendApiKey — the same self-hosted backend
 * ../../backend/client.ts already talks to), not raw process.env reads.
 * BACKEND_URL / BACKEND_API_KEY env vars remain as a fallback only for
 * callers that run this module outside a loaded automaton config (e.g.
 * a standalone script or test).
 */

// Uses Node's built-in global `fetch` (Node 18+), matching the
// convention already used by agent/'s own ../../backend/http-client.ts,
// rather than adding a node-fetch dependency for this merged module.

import { loadConfig } from "../../config.js";

function resolveBackendCreds(): { apiUrl: string; apiKey: string } {
  const cfg = loadConfig();
  const apiUrl = cfg?.backendApiUrl || process.env.BACKEND_URL || "http://localhost:8080";
  const apiKey = cfg?.backendApiKey || process.env.BACKEND_API_KEY || "";
  if (!apiKey) {
    throw new Error(
      "remote-memory-client: no backend API key available (checked automaton config " +
        "backendApiKey and BACKEND_API_KEY env var). Remote memory sync cannot authenticate.",
    );
  }
  return { apiUrl, apiKey };
}

async function call(path: string, options: { method?: string; body?: unknown } = {}) {
  const { apiUrl, apiKey } = resolveBackendCreds();
  const res = await fetch(`${apiUrl}${path}`, {
    method: options.method || "GET",
    headers: { "content-type": "application/json", "x-backend-key": apiKey },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

export async function saveEpisode(agentAddress: string, iterationRange: string, summary: string) {
  await call("/memory/episodic", { method: "POST", body: { agentAddress, iterationRange, summary } });
}

export async function getRecentEpisodes(agentAddress: string, limit = 10) {
  const { body } = await call(`/memory/episodic?agentAddress=${agentAddress}&limit=${limit}`);
  return body.episodes as { iteration_range: string; summary: string; created_at: number }[];
}

export async function remember(agentAddress: string, key: string, value: string) {
  await call("/memory/semantic", { method: "POST", body: { agentAddress, key, value } });
}

export async function recall(agentAddress: string, query: string, topK = 5) {
  const { body } = await call(
    `/memory/semantic/search?agentAddress=${agentAddress}&query=${encodeURIComponent(query)}&topK=${topK}`,
  );
  return body.facts as { key: string; value: string }[];
}

// --- Procedural memory: step-by-step "how to do X", with outcome tracking ---

export interface ProceduralStep {
  order: number;
  action: string;
  notes?: string;
}

export async function saveProcedure(
  agentAddress: string,
  name: string,
  description: string,
  steps: ProceduralStep[],
) {
  await call("/memory/procedural", { method: "POST", body: { agentAddress, name, description, steps } });
}

export async function recallProcedure(agentAddress: string, query: string) {
  const { body } = await call(
    `/memory/procedural/search?agentAddress=${agentAddress}&query=${encodeURIComponent(query)}`,
  );
  return body.procedures as {
    name: string;
    description: string;
    steps: ProceduralStep[];
    successCount: number;
    failureCount: number;
  }[];
}

export async function recordProcedureOutcome(agentAddress: string, name: string, success: boolean) {
  await call("/memory/procedural/outcome", { method: "POST", body: { agentAddress, name, success } });
}

// --- Knowledge store: categorized, confidence-scored facts (vs. flat semantic memory) ---

export type KnowledgeCategory = "market" | "technical" | "social" | "financial" | "operational";

export async function learnFact(
  agentAddress: string,
  category: KnowledgeCategory,
  key: string,
  content: string,
  confidence?: number,
) {
  await call("/memory/knowledge", { method: "POST", body: { agentAddress, category, key, content, confidence } });
}

export async function queryKnowledge(agentAddress: string, query: string, category?: KnowledgeCategory) {
  const qs = new URLSearchParams({ agentAddress, query });
  if (category) qs.set("category", category);
  const { body } = await call(`/memory/knowledge/search?${qs.toString()}`);
  return body.facts as { category: string; key: string; content: string; confidence: number }[];
}
