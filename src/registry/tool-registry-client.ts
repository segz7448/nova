/**
 * Tool Registry Client — merged into agent/ from
 * backend/agent-runtime/src/toolRegistryClient.ts.
 *
 * Fetches allowed-tool grants per (tier, role) from a live backend
 * tool_registry over HTTP. This is a different concept from
 * agent/src/registry/{agent-card,discovery,erc8004}.ts, which is about
 * *on-chain agent discovery* (ERC-8004) — this module is about *tool
 * permissions*, and pairs with ../agent/policy-rules/department-profiles.ts.
 *
 * Credentials come from agent/'s own config.ts loadConfig()
 * (backendApiUrl/backendApiKey), same as ../memory/backend-sync/
 * remote-memory-client.ts's fix — not raw process.env reads. The
 * TOOL_REGISTRY_* retry/cache tuning vars remain env-only; they're
 * genuinely deployment-tuning knobs, not credentials, so there's no
 * config.ts field for them to live in.
 */

// Uses Node's built-in global `fetch` (Node 18+), matching the
// convention already used by agent/'s own ../backend/http-client.ts,
// rather than adding a node-fetch dependency for this merged module.

import { loadConfig } from "../config.js";

/**
 * next-phase.md Phase 2i(e) — Tool introspection: `list_available_tools`
 * (architecture-agent.md §7 addition)
 *
 * The agent-runtime-side half of this phase. `backend/src`'s
 * `toolRegistryRoutes.ts` (mounted at `/tool-registry`) is a thin HTTP
 * wrapper around `toolRegistry.ts`'s `assignTools()` (Phase 2i(b)) — this
 * file is the client for that endpoint, the first time agent-runtime (a
 * separate process with no direct DB access — see `backendClient.ts`'s
 * own header) can ask the registry "what would this tier/role be granted"
 * instead of only reading `departmentToolProfiles.ts`'s hand-maintained
 * map. `tools.ts`'s `executeTool()` dispatch gate and its new
 * `list_available_tools` ACTION are this file's two real callers.
 *
 * Deliberately its own module rather than added to `backendClient.ts`:
 * `resolveRegistryActionNames()` below needs to be callable from
 * `tools.ts` without `tools.ts` importing anything that itself imports
 * `tools.ts` — the same import-cycle concern
 * `departmentToolProfiles.ts`'s own header already flags for its
 * `import type { Action } from "./tools.js"`. This module goes one step
 * further and avoids the question entirely: it never imports `tools.ts`
 * at all, not even a type-only import. It returns raw, unvalidated
 * runtime-action-identifier *strings* pulled out of the registry's own
 * `inputSchema.action`/`inputSchema.actions` fields (see
 * `toolRegistrySeedData.ts`'s `actionRows()`/`walletRows()`/
 * per-department-type-table generation for where those fields come
 * from) — validating a returned string against this runtime's actual
 * `ACTIONS` list is left to `tools.ts` itself, the one place that
 * already owns that list.
 */

export type Tier = "agent" | "department_agent" | "worker";

export interface RegistryToolGrant {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  costUnit: "usd" | "compute" | "calls" | "disk";
  costAmountPerCall: number | null;
  costAmountPerUnit: number | null;
  scopeTemplate: string;
  lifecycle: string;
}

export interface AvailableToolsResult {
  tier: Tier;
  role: string | null;
  resolvedDepartmentType: string | null;
  count: number;
  tools: RegistryToolGrant[];
}

function resolveBackendCreds(): { apiUrl: string; apiKey: string } {
  const cfg = loadConfig();
  const apiUrl = cfg?.backendApiUrl || process.env.BACKEND_URL || "http://localhost:8080";
  const apiKey = cfg?.backendApiKey || process.env.BACKEND_API_KEY || "";
  if (!apiKey) {
    throw new Error(
      "tool-registry-client: no backend API key available (checked automaton config " +
        "backendApiKey and BACKEND_API_KEY env var).",
    );
  }
  return { apiUrl, apiKey };
}

// Deliberately separate env vars from backendClient.ts's own
// RETRY_MAX_ATTEMPTS/RETRY_BASE_DELAY_MS — this endpoint sits on the
// hot dispatch path (a cache miss here happens on every out-of-profile
// check, not once per tool call the way e.g. spawn_subagent does), so
// it defaults to fewer, faster retries rather than sharing the
// long-tail-tolerant defaults a one-shot backend.* call can afford.
const RETRY_MAX_ATTEMPTS = Number(process.env.TOOL_REGISTRY_RETRY_MAX_ATTEMPTS || "3");
const RETRY_BASE_DELAY_MS = Number(process.env.TOOL_REGISTRY_RETRY_BASE_DELAY_MS || "250");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Same transient-vs-semantic retry split as backendClient.ts's own
 * `call()`: retries network errors and 5xx, never 4xx (a 400 here means
 * a bad tier/departmentType, which retrying identically will never fix).
 * Not exported — every real caller goes through getAvailableTools()
 * below so there's exactly one place request-shape/query-string
 * construction happens.
 */
async function call(path: string): Promise<{ status: number; body: any }> {
  let lastError: unknown;
  const { apiUrl, apiKey } = resolveBackendCreds();

  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${apiUrl}${path}`, {
        method: "GET",
        headers: { "x-backend-key": apiKey },
      });

      if (res.status >= 500) {
        lastError = new Error(`backend_5xx: ${res.status} on ${path}`);
        throw lastError;
      }

      return { status: res.status, body: (await res.json()) as any };
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === RETRY_MAX_ATTEMPTS - 1;
      if (isLastAttempt) break;

      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 100;
      console.warn(
        `[tool-registry] transient failure on ${path} (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS}): ${
          (err as Error).message
        } — retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }

  throw new Error(
    `tool_registry_unreachable: ${path} failed after ${RETRY_MAX_ATTEMPTS} attempts — last error: ${
      (lastError as Error)?.message
    }`,
  );
}

/**
 * GET /tool-registry/available?tier=&role=&departmentType= — the direct,
 * uncached client for toolRegistryRoutes.ts. Throws on a non-2xx
 * response (including a 400 for a bad tier/departmentType, since every
 * real caller in this file already only ever passes a validated Tier)
 * or on exhausted retries. Most callers want getAvailableToolsCached()
 * below instead; this is exported for a caller that genuinely needs a
 * guaranteed-fresh read (e.g. a future admin/debug surface).
 */
export async function getAvailableTools(
  tier: Tier,
  options?: { role?: string | null; departmentType?: string | null },
): Promise<AvailableToolsResult> {
  const qs = new URLSearchParams({ tier });
  if (options?.role) qs.set("role", options.role);
  if (options?.departmentType) qs.set("departmentType", options.departmentType);

  const { status, body } = await call(`/tool-registry/available?${qs.toString()}`);
  if (status !== 200) {
    throw new Error(`tool_registry_available_failed: ${status} ${JSON.stringify(body)}`);
  }
  return body as AvailableToolsResult;
}

// ── In-memory TTL cache ──────────────────────────────────────────────
// executeTool()'s profile-check gate (tools.ts) calls this once per
// dispatched tool call for every Department/Worker-context caller — a
// real HTTP round trip on every single ACTION would add real latency to
// the hottest path in this runtime for no benefit (the registry changes
// on a Founder/admin timescale, not a per-tool-call one). Keyed on
// tier|role|departmentType so two different roles never share a cache
// entry. Deliberately process-local, in-memory, no persistence — the
// same "no browser storage" reasoning artifacts.ts's own rules apply
// here for a different reason: this cache existing across a process
// restart would mean a stale grant could outlive a registry edit for
// longer than TOOL_REGISTRY_CACHE_TTL_MS promises, which defeats the
// point of a TTL cache in the first place.
const CACHE_TTL_MS = Number(process.env.TOOL_REGISTRY_CACHE_TTL_MS || "30000");
const cache = new Map<string, { expiresAt: number; data: AvailableToolsResult }>();
let registryVersion: number | null = null;

function cacheKey(tier: Tier, options?: { role?: string | null; departmentType?: string | null }): string {
  return `${tier}|${options?.role ?? ""}|${options?.departmentType ?? ""}`;
}

/**
 * Cached wrapper around getAvailableTools(). A cache miss/expiry still
 * goes through the full retry loop above — this only saves the round
 * trip on a hit, it never suppresses or softens a real failure. Callers
 * that need to force a fresh read (e.g. right after an admin edits the
 * registry) can call invalidateAvailableToolsCache() first.
 */
export async function getAvailableToolsCached(
  tier: Tier,
  options?: { role?: string | null; departmentType?: string | null },
): Promise<AvailableToolsResult> {
  const key = cacheKey(tier, options);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    const currentVersion = await getRegistryVersion();
    if (registryVersion === currentVersion) return cached.data;
    cache.clear();
  }

  const data = await getAvailableTools(tier, options);
  registryVersion = await getRegistryVersion();
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, data });
  return data;
}

/** Drops one entry (or, with no args, the entire cache) — for tests and any future admin-triggered refresh. */
export function invalidateAvailableToolsCache(tier?: Tier, options?: { role?: string | null; departmentType?: string | null }): void {
  if (tier === undefined) {
    cache.clear();
    registryVersion = null;
    return;
  }
  cache.delete(cacheKey(tier, options));
}

async function getRegistryVersion(): Promise<number> {
  const { status, body } = await call("/tool-registry/version");
  if (status !== 200 || !Number.isFinite(body?.version)) {
    throw new Error(`tool_registry_version_failed: ${status}`);
  }
  return Number(body.version);
}

/**
 * Pulls the runtime ACTION identifier(s) a single registry row declares
 * it maps to — `{ action: "run_command" }` (single, from actionRows()/
 * walletRows()) or `{ actions: ["run_command", "pty_create", ...] }`
 * (the department-type table's CAPABILITY_TO_ACTIONS-derived rows, see
 * toolRegistrySeedData.ts's own generation for that table). A row with
 * neither (empty `{}` `inputSchema`, e.g. a pure-reasoning §4d/§4e/§4f
 * bullet with "no dedicated runtime ACTION yet") contributes nothing —
 * that capability is named in the registry for list_available_tools to
 * surface, but there is genuinely no dispatcher ACTION to gate.
 */
export function extractDeclaredActions(grant: RegistryToolGrant): string[] {
  const schema = grant.inputSchema as { action?: unknown; actions?: unknown };
  const out: string[] = [];
  if (typeof schema?.action === "string") out.push(schema.action);
  if (Array.isArray(schema?.actions)) {
    for (const a of schema.actions) {
      if (typeof a === "string") out.push(a);
    }
  }
  return out;
}

/**
 * role -> deduped, sorted runtime-action-identifier strings, resolved
 * against the live tool_registry (tier="department_agent") rather than
 * departmentToolProfiles.ts's hardcoded CAPABILITY_TO_ACTIONS map. This
 * is the direct registry-sourced replacement for that file's
 * `resolveProfileActions()` — same input (a role string), same "fail
 * closed on an unrecognized role" behavior (an unrecognized role simply
 * resolves no departmentType, so assignTools() returns only the
 * department-type-unrestricted rows, per toolRegistry.ts's own doc
 * comment), but sourced live from data instead of a hand-maintained
 * switch. Not validated against this runtime's own ACTIONS list here —
 * see this file's header for why that's tools.ts's job, not this
 * module's.
 */
export async function resolveRegistryActionNames(role: string | null | undefined): Promise<string[]> {
  const result = await getAvailableToolsCached("department_agent", { role: role ?? undefined });
  const names = new Set<string>();
  for (const grant of result.tools) {
    for (const action of extractDeclaredActions(grant)) names.add(action);
  }
  return Array.from(names).sort();
}

/**
 * next-phase.md Phase 7b — the client half of `toolRegistryRoutes.ts`'s
 * new `GET /grant-status`. Answers "has the most recent `tool_grants`
 * row for this (holderId, toolName) pair been revoked" — see
 * `backend/src/toolGrants.ts`'s own `isGrantRevoked()` doc comment for
 * the exact "no row → not revoked" / "most recent row wins" semantics
 * this mirrors, byte-for-byte, over HTTP.
 *
 * Deliberately UNCACHED, unlike `getAvailableToolsCached()` above: that
 * cache exists because the registry's own contents change on a
 * Founder/admin timescale, so a 30s-stale answer is an acceptable
 * trade for saving a round trip on the hottest path in this runtime. A
 * grant's revocation status is different in kind — Phase 2i(d)'s three
 * triggers (`revokeGrantsBySession`/`revokeGrantsByTask`/
 * `revokeGrantsByProject`) fire in direct response to something the
 * SAME agent's own tool calls just did (closed its own session,
 * completed its own task, had its own project retired), so the very
 * next call from that holder is exactly the call this check exists to
 * catch — caching this would mean a revocation doesn't actually take
 * effect until some TTL window (however short) has elapsed, silently
 * reopening the gap this sub-phase exists to close.
 *
 * Reuses `call()`'s own retry/backoff behavior (not exported from this
 * module, so this function makes its own direct `fetch` rather than a
 * second copy of that logic) via the same low-latency retry defaults
 * `getAvailableTools()` already uses — this sits on the same hot
 * dispatch path.
 */
export async function isGrantRevoked(holderId: string, toolName: string): Promise<boolean> {
  const qs = new URLSearchParams({ holderId, toolName });
  const { status, body } = await call(`/tool-registry/grant-status?${qs.toString()}`);
  if (status !== 200) {
    throw new Error(`grant_status_check_failed: ${status} ${JSON.stringify(body)}`);
  }
  return Boolean((body as { revoked?: boolean }).revoked);
}
