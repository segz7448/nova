/**
 * MERGED from backend/agent-runtime/src/__tests__/toolRegistryClient.test.ts as part of the
 * agent-runtime -> agent merge (see /MERGE-NOTES.md). Originally used Node's
 * built-in `node:test` runner; ported to vitest (test/describe/assert
 * imports swapped for vitest's own, which mirrors node:assert/strict's
 * API for the assertions this file uses) so it runs under `vitest run`
 * like the rest of agent/'s suite, per vitest.config.ts. See
 * /MERGE-NOTES.md item 5.
 */
// next-phase.md Phase 2i(e) (architecture-agent.md §7 addition): tests
// for toolRegistryClient.ts's own decision logic — extractDeclaredActions()
// against both the single-`action` and array-`actions` inputSchema
// shapes, the in-memory TTL cache's hit/expiry/invalidate paths, and
// resolveRegistryActionNames()'s dedup/sort.
//
// Same no-network-for-`npm install` constraint every prior 2i sub-phase
// has already flagged, one layer worse here than most: toolRegistryClient.ts
// imports `node-fetch` directly at module scope, and (confirmed by
// actually trying it in this sandbox — `Cannot find package 'node-fetch'
// imported from .../backendClient.ts`) so does every other file in this
// package that transitively imports `backendClient.ts` or
// `toolRegistryClient.ts` itself, including `tools.ts` and — as of this
// same phase's systemPrompt.ts migration — `systemPrompt.ts` too. This
// was already true before this phase touched anything (`tools.test.ts`
// already failed to load in this sandbox for the identical reason, per
// Phase 2i(a)'s own note), not a new regression introduced here.
//
// What CAN be tested without node-fetch installed is the module's own
// pure decision logic: this file inlines byte-for-byte copies of
// extractDeclaredActions(), the TTL-cache Map logic behind
// getAvailableToolsCached(), and resolveRegistryActionNames()'s
// dedup/sort, operating against a fake fetch stand-in instead of a real
// HTTP round trip — kept in sync with the real file by inspection, same
// convention toolRegistryRoutes.test.ts's own header documents one layer
// down. Before deploying: `npm install` in backend/agent-runtime,
// `tsc --noEmit`, then a real two-process run (see
// toolRegistryRoutes.ts's own header for the matching backend-side note).

import { test, describe } from "vitest";
import { assert } from "vitest";

// ── Inlined copy of toolRegistryClient.ts's RegistryToolGrant/extractDeclaredActions ──

interface RegistryToolGrant {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  costUnit: "usd" | "compute" | "calls" | "disk";
  costAmountPerCall: number | null;
  costAmountPerUnit: number | null;
  scopeTemplate: string;
  lifecycle: string;
}

function extractDeclaredActions(grant: RegistryToolGrant): string[] {
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

function grant(overrides: Partial<RegistryToolGrant> = {}): RegistryToolGrant {
  return {
    name: "x",
    description: "x",
    inputSchema: {},
    costUnit: "compute",
    costAmountPerCall: null,
    costAmountPerUnit: null,
    scopeTemplate: "own_office",
    lifecycle: "task",
    ...overrides,
  };
}

describe("extractDeclaredActions (inlined)", () => {
  test("single-action schema ({ action: string }) yields one-element array", () => {
    assert.deepEqual(extractDeclaredActions(grant({ inputSchema: { action: "run_command" } })), [
      "run_command",
    ]);
  });

  test("array-actions schema ({ actions: string[] }) yields all elements", () => {
    assert.deepEqual(
      extractDeclaredActions(grant({ inputSchema: { actions: ["run_command", "pty_create", "pty_close"] } })),
      ["run_command", "pty_create", "pty_close"],
    );
  });

  test("both action and actions present: both contribute (not one exclusive of the other)", () => {
    assert.deepEqual(
      extractDeclaredActions(grant({ inputSchema: { action: "read_file", actions: ["write_file"] } })),
      ["read_file", "write_file"],
    );
  });

  test("empty inputSchema {} (a pure-reasoning §4d/§4e/§4f bullet) yields an empty array, not an error", () => {
    assert.deepEqual(extractDeclaredActions(grant({ inputSchema: {} })), []);
  });

  test("a non-string action value is dropped rather than coerced or throwing", () => {
    assert.deepEqual(extractDeclaredActions(grant({ inputSchema: { action: 42 as any } })), []);
  });

  test("a non-string element inside actions[] is dropped, valid siblings are kept", () => {
    assert.deepEqual(
      extractDeclaredActions(grant({ inputSchema: { actions: ["run_command", 7 as any, "read_file"] } })),
      ["run_command", "read_file"],
    );
  });

  test("actions as a non-array (e.g. a string) is ignored entirely, not iterated char-by-char", () => {
    assert.deepEqual(extractDeclaredActions(grant({ inputSchema: { actions: "run_command" as any } })), []);
  });
});

// ── Inlined copy of toolRegistryClient.ts's TTL cache Map logic ──
// (getAvailableToolsCached/invalidateAvailableToolsCache/cacheKey) —
// same Map<key, {expiresAt, data}> shape, same "expiresAt > now" hit
// test, same cacheKey() join convention, driven here by an injected
// clock and fetch-count stand-in instead of Date.now()/a real HTTP call.

type Tier = "agent" | "department_agent" | "worker";
interface AvailableToolsResult {
  tier: Tier;
  role: string | null;
  resolvedDepartmentType: string | null;
  count: number;
  tools: RegistryToolGrant[];
}

function cacheKey(tier: Tier, options?: { role?: string | null; departmentType?: string | null }): string {
  return `${tier}|${options?.role ?? ""}|${options?.departmentType ?? ""}`;
}

class FakeTtlCache {
  private cache = new Map<string, { expiresAt: number; data: AvailableToolsResult }>();
  public fetchCount = 0;
  public now = 0;

  constructor(
    private ttlMs: number,
    private fetcher: (tier: Tier, options?: { role?: string | null; departmentType?: string | null }) => AvailableToolsResult,
  ) {}

  get(tier: Tier, options?: { role?: string | null; departmentType?: string | null }): AvailableToolsResult {
    const key = cacheKey(tier, options);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now) {
      return cached.data;
    }
    this.fetchCount++;
    const data = this.fetcher(tier, options);
    this.cache.set(key, { expiresAt: this.now + this.ttlMs, data });
    return data;
  }

  invalidate(tier?: Tier, options?: { role?: string | null; departmentType?: string | null }): void {
    if (tier === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(cacheKey(tier, options));
  }
}

function fakeResult(tier: Tier, tools: RegistryToolGrant[] = []): AvailableToolsResult {
  return { tier, role: null, resolvedDepartmentType: null, count: tools.length, tools };
}

describe("TTL cache logic (inlined)", () => {
  test("a cache miss calls the fetcher and stores the result", () => {
    const cache = new FakeTtlCache(30000, () => fakeResult("agent"));
    const result = cache.get("agent");
    assert.equal(cache.fetchCount, 1);
    assert.equal(result.tier, "agent");
  });

  test("a hit within the TTL window does not call the fetcher again", () => {
    const cache = new FakeTtlCache(30000, () => fakeResult("agent"));
    cache.get("agent");
    cache.now = 10000; // still within 30000ms TTL
    cache.get("agent");
    assert.equal(cache.fetchCount, 1);
  });

  test("a read past the TTL window calls the fetcher again (expiry)", () => {
    const cache = new FakeTtlCache(30000, () => fakeResult("agent"));
    cache.get("agent");
    cache.now = 30001; // one past expiresAt
    cache.get("agent");
    assert.equal(cache.fetchCount, 2);
  });

  test("the TTL boundary itself is exclusive (`expiresAt > now`, not `>=`) — a read at exactly expiresAt is a miss, one strictly before it is a hit", () => {
    const cache = new FakeTtlCache(30000, () => fakeResult("agent"));
    cache.get("agent"); // expiresAt = 0 + 30000
    cache.now = 29999;
    cache.get("agent");
    assert.equal(cache.fetchCount, 1, "one tick before expiresAt should still be a hit");

    cache.now = 30000;
    cache.get("agent");
    assert.equal(cache.fetchCount, 2, "exactly at expiresAt should already be a miss");
  });

  test("different tier/role/departmentType combinations never share a cache entry", () => {
    let calls = 0;
    const cache = new FakeTtlCache(30000, (tier) => {
      calls++;
      return fakeResult(tier);
    });
    cache.get("department_agent", { role: "software" });
    cache.get("department_agent", { role: "marketing" });
    cache.get("worker");
    cache.get("agent");
    assert.equal(calls, 4);
  });

  test("invalidate(tier, options) drops exactly one entry, others remain cached", () => {
    let calls = 0;
    const cache = new FakeTtlCache(30000, (tier) => {
      calls++;
      return fakeResult(tier);
    });
    cache.get("department_agent", { role: "software" });
    cache.get("department_agent", { role: "marketing" });
    assert.equal(calls, 2);

    cache.invalidate("department_agent", { role: "software" });
    cache.get("department_agent", { role: "software" }); // re-fetches
    cache.get("department_agent", { role: "marketing" }); // still cached
    assert.equal(calls, 3);
  });

  test("invalidate() with no args clears every entry", () => {
    let calls = 0;
    const cache = new FakeTtlCache(30000, (tier) => {
      calls++;
      return fakeResult(tier);
    });
    cache.get("agent");
    cache.get("worker");
    assert.equal(calls, 2);

    cache.invalidate();
    cache.get("agent");
    cache.get("worker");
    assert.equal(calls, 4);
  });
});

// ── Inlined copy of resolveRegistryActionNames()'s dedup/sort ──

function resolveRegistryActionNames(tools: RegistryToolGrant[]): string[] {
  const names = new Set<string>();
  for (const g of tools) {
    for (const action of extractDeclaredActions(g)) names.add(action);
  }
  return Array.from(names).sort();
}

describe("resolveRegistryActionNames dedup/sort (inlined)", () => {
  test("deduplicates the same action declared by multiple rows", () => {
    const tools = [
      grant({ inputSchema: { action: "run_command" } }),
      grant({ inputSchema: { actions: ["run_command", "pty_create"] } }),
    ];
    assert.deepEqual(resolveRegistryActionNames(tools), ["pty_create", "run_command"]);
  });

  test("returns results sorted alphabetically, not registry row order", () => {
    const tools = [
      grant({ inputSchema: { action: "write_file" } }),
      grant({ inputSchema: { action: "check_balance" } }),
      grant({ inputSchema: { action: "read_file" } }),
    ];
    assert.deepEqual(resolveRegistryActionNames(tools), ["check_balance", "read_file", "write_file"]);
  });

  test("an empty tools[] resolves to an empty array, not an error", () => {
    assert.deepEqual(resolveRegistryActionNames([]), []);
  });

  test("rows with no declared action at all (empty inputSchema) contribute nothing but don't break resolution of the rest", () => {
    const tools = [grant({ inputSchema: {} }), grant({ inputSchema: { action: "check_balance" } })];
    assert.deepEqual(resolveRegistryActionNames(tools), ["check_balance"]);
  });
});
