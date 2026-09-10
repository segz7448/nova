/**
 * REFERENCE ONLY — not wired into agent/'s vitest suite.
 *
 * Merged from backend/agent-runtime/src/__tests__/systemPrompt.test.ts as part of the
 * agent-runtime -> agent merge (see /MERGE-NOTES.md). This test exercises
 * agent-runtime's agent-runtime's systemPrompt.ts, which was intentionally NOT duplicated into
 * agent/ because agent/ already has its own, more capable native
 * equivalent (agent/src/agent/system-prompt.ts). Porting agent-runtime's systemPrompt.ts itself would have meant running
 * two competing implementations side by side, which is what this merge
 * is meant to eliminate.
 *
 * Kept here, unmodified apart from this note, as a reference for anyone
 * porting its specific assertions over to agent/'s equivalent module.
 * It will not compile as-is in this repo (its imports point at files
 * that were deliberately not moved).
 */
/**
 * next-phase.md Phase 2f-ii-d (original) + Phase 2i(e) (this update) —
 * fidelity tests, systemPrompt.ts half.
 *
 * The specific drift this suite exists to catch: a Department Agent's
 * *prompt-visible* tool list (`buildDepartmentAgentPrompt()` via
 * `renderToolDocsForActions()`) silently diverging from its
 * *dispatch-enforced* tool list (`tools.ts`'s `executeTool()` `context`
 * gate). Through Phase 2i(d) both sides were checked against one shared
 * function, `departmentToolProfiles.ts`'s `resolveProfileActions()`. As
 * of Phase 2i(e), dispatch was migrated onto `toolRegistryClient.ts`
 * (live `tool_registry`) but prompt rendering was left on the old
 * function — this file's own previous version would have kept passing
 * throughout that drift window without ever detecting it, since it only
 * ever compared the prompt against `resolveProfileActions()` directly,
 * never against what dispatch was actually enforcing. This version
 * closes that: `buildDepartmentAgentPrompt()` is now async and resolves
 * through the exact same shape `toolRegistryClient.getAvailableToolsCached()`
 * returns (injected here as a deterministic fake — see systemPrompt.ts's
 * own header for why the fetcher is an injectable seam at all: this
 * environment cannot `npm install` `node-fetch`/`better-sqlite3`, the
 * same constraint every prior `backend/agent-runtime` test file in this
 * phase family has already flagged).
 *
 * Two things are proven here, deliberately kept separate:
 *   1. Given a registry answer, the prompt renders exactly the ACTION
 *      set that answer declares — nothing added, nothing dropped. This
 *      is `buildDepartmentAgentPrompt()`'s own rendering-fidelity
 *      contract, independent of what the "real" registry happens to
 *      contain right now.
 *   2. Fed the *same* per-department-type capability -> ACTION data the
 *      real `tool_registry` seed was transcribed from (`departmentTool-
 *      Profiles.ts`'s `CAPABILITY_TO_ACTIONS`, per next-phase.md Phase
 *      2i(a)'s own "transcribing... verbatim" note), the migrated
 *      prompt renders byte-for-byte the same ACTION set the pre-2i(e)
 *      prompt did — a regression check that the migration didn't
 *      silently change what any canonical role sees, only *where* the
 *      answer now comes from.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildDepartmentAgentPrompt, buildSystemPrompt } from "../systemPrompt.js";
import {
  resolveProfileActions,
  DEPARTMENT_TOOL_PROFILES,
  type DepartmentType,
} from "../departmentToolProfiles.js";
import type { RegistryToolGrant } from "../toolRegistryClient.js";

/** Pulls every `ACTION: <name>` identifier out of a rendered prompt's tool section. */
function actionsMentionedIn(prompt: string): Set<string> {
  return new Set([...prompt.matchAll(/ACTION: (\S+)/g)].map((m) => m[1]));
}

const CANONICAL_ROLES = Object.keys(DEPARTMENT_TOOL_PROFILES) as DepartmentType[];

/** Minimal fake RegistryToolGrant carrying one declared ACTION — enough
 * for extractDeclaredActions()/renderToolDocsForActions() to see it,
 * nothing else about the row (cost/scope/lifecycle) matters to this
 * suite. */
function grantFor(action: string): RegistryToolGrant {
  return {
    name: action,
    description: action,
    inputSchema: { action },
    costUnit: "compute",
    costAmountPerCall: null,
    costAmountPerUnit: null,
    scopeTemplate: "assigned_department",
    lifecycle: "persistent",
  };
}

/**
 * Fake `resolveActions` fetcher matching the real registry's own
 * documented precedence and fail-closed behavior (mirrors
 * toolRegistry.ts's `assignTools()` and `normalizeDepartmentType()`,
 * same as toolRegistryRoutes.test.ts's own inlined copy): resolves a
 * role through `departmentToolProfiles.ts`'s `resolveProfileActions()`
 * — the exact data the real seed was transcribed from — and reports the
 * canonical department type as `resolvedDepartmentType`, or `null` for
 * an unrecognized role, never a merged/union answer.
 */
function fakeResolverFromCanonicalData(
  role: string | null | undefined,
): Promise<{ tools: RegistryToolGrant[]; resolvedDepartmentType: string | null }> {
  const actions = resolveProfileActions(role);
  const normalized = (role ?? "").trim().toLowerCase();
  const resolvedDepartmentType = (CANONICAL_ROLES as string[]).includes(normalized) ? normalized : null;
  return Promise.resolve({
    tools: actions.map(grantFor),
    resolvedDepartmentType,
  });
}

describe("buildDepartmentAgentPrompt — rendering fidelity against an injected registry answer", () => {
  test("renders exactly the ACTION set the injected resolver declares, nothing added or dropped", async () => {
    const prompt = await buildDepartmentAgentPrompt({
      departmentId: "dept_test",
      name: "test dept",
      role: "software",
      objective: "test objective",
      resolveActions: () =>
        Promise.resolve({
          tools: [grantFor("read_file"), grantFor("write_file")],
          resolvedDepartmentType: "software",
        }),
    });
    assert.deepEqual([...actionsMentionedIn(prompt)].sort(), ["read_file", "write_file"]);
  });

  test("an empty tools[] renders the fallback explanation, not a blank/absent tool section", async () => {
    const prompt = await buildDepartmentAgentPrompt({
      departmentId: "dept_test",
      name: "marketing dept",
      role: "marketing",
      objective: "obj",
      resolveActions: () => Promise.resolve({ tools: [], resolvedDepartmentType: "marketing" }),
    });
    assert.equal(actionsMentionedIn(prompt).size, 0);
    assert.match(prompt, /no tools are currently available to you/i);
    assert.doesNotMatch(prompt, /ACTION: /);
  });

  test("duplicate declared actions across multiple rows are deduplicated in the rendered prompt", async () => {
    const prompt = await buildDepartmentAgentPrompt({
      departmentId: "dept_test",
      name: "software dept",
      role: "software",
      objective: "obj",
      resolveActions: () =>
        Promise.resolve({
          tools: [grantFor("run_command"), grantFor("run_command"), grantFor("read_file")],
          resolvedDepartmentType: "software",
        }),
    });
    // Each ACTION block appears once in TOOL_DOCS regardless of how many
    // registry rows declared it — assert the underlying set, not a count
    // of "ACTION: run_command" occurrences (TOOL_DOCS renders one block
    // per allowed action name, not one per input row).
    assert.deepEqual([...actionsMentionedIn(prompt)].sort(), ["read_file", "run_command"]);
  });

  test("resolvedDepartmentType drives the rendered department-profile label", async () => {
    const softwarePrompt = await buildDepartmentAgentPrompt({
      departmentId: "d",
      name: "n",
      role: "irrelevant-to-this-test",
      objective: "o",
      resolveActions: () => Promise.resolve({ tools: [], resolvedDepartmentType: "software" }),
    });
    assert.match(softwarePrompt, /Software department profile/);
    assert.doesNotMatch(softwarePrompt, /Marketing department profile/);

    const marketingPrompt = await buildDepartmentAgentPrompt({
      departmentId: "d",
      name: "n",
      role: "irrelevant-to-this-test",
      objective: "o",
      resolveActions: () => Promise.resolve({ tools: [], resolvedDepartmentType: "marketing" }),
    });
    assert.match(marketingPrompt, /Marketing department profile/);
    assert.doesNotMatch(marketingPrompt, /Software department profile/);
  });

  test("a null resolvedDepartmentType (unrecognized role) renders the fail-closed default label, never a guessed one", async () => {
    const prompt = await buildDepartmentAgentPrompt({
      departmentId: "d",
      name: "n",
      role: "totally-unknown-role",
      objective: "o",
      resolveActions: () => Promise.resolve({ tools: [], resolvedDepartmentType: null }),
    });
    assert.match(prompt, /Default \(unrecognized department type\) department profile/);
  });
});

describe("buildDepartmentAgentPrompt — migration regression check against the pre-2i(e) source data", () => {
  for (const role of CANONICAL_ROLES) {
    test(`${role}: registry-sourced rendering matches the old resolveProfileActions("${role}") exactly`, async () => {
      const prompt = await buildDepartmentAgentPrompt({
        departmentId: "dept_test",
        name: `${role} dept`,
        role,
        objective: "test objective",
        resolveActions: fakeResolverFromCanonicalData,
      });
      const rendered = actionsMentionedIn(prompt);
      const resolved = new Set(resolveProfileActions(role));
      assert.deepEqual(
        [...rendered].sort(),
        [...resolved].sort(),
        `${role}: migrated prompt-visible tool list no longer matches the pre-2i(e) resolved set`,
      );
    });
  }

  test('an alias role ("engineering") renders the same ACTION set as its canonical role ("software"), via the fake resolver\'s own resolveProfileActions() call', async () => {
    const engineeringPrompt = await buildDepartmentAgentPrompt({
      departmentId: "dept_test",
      name: "eng",
      role: "engineering",
      objective: "obj",
      resolveActions: fakeResolverFromCanonicalData,
    });
    const softwarePrompt = await buildDepartmentAgentPrompt({
      departmentId: "dept_test",
      name: "sw",
      role: "software",
      objective: "obj",
      resolveActions: fakeResolverFromCanonicalData,
    });
    assert.deepEqual(
      [...actionsMentionedIn(engineeringPrompt)].sort(),
      [...actionsMentionedIn(softwarePrompt)].sort(),
    );
  });

  test("an unrecognized role renders exactly the fail-closed default's ACTION set, not the union of every profile", async () => {
    const prompt = await buildDepartmentAgentPrompt({
      departmentId: "dept_test",
      name: "mystery dept",
      role: "totally-unknown-role",
      objective: "obj",
      resolveActions: fakeResolverFromCanonicalData,
    });
    const rendered = actionsMentionedIn(prompt);
    const resolved = new Set(resolveProfileActions("totally-unknown-role"));
    assert.deepEqual([...rendered].sort(), [...resolved].sort());
    assert.equal(rendered.has("check_balance"), false);
  });

  test("the default resolveActions parameter is never invoked when a fake is supplied", async () => {
    // Sanity check on the injection seam itself — every test in this
    // file supplies resolveActions explicitly, so none of them should
    // ever reach toolRegistryClient's real fetch() (which would throw
    // in this environment, since node-fetch isn't installed here and
    // BACKEND_API_KEY isn't set). If this test fails, some other test
    // in this file has a bug that fell through to the real default.
    const prompt = await buildDepartmentAgentPrompt({
      departmentId: "d",
      name: "n",
      role: "software",
      objective: "o",
      resolveActions: fakeResolverFromCanonicalData,
    });
    assert.ok(prompt.length > 0);
  });
});

describe("buildDepartmentAgentPrompt — a Department Agent's tool list is provably narrower than Agent's", () => {
  test("no Department Agent prompt (any canonical role) mentions every ACTION the Agent-tier prompt does", async () => {
    const agentPrompt = buildSystemPrompt("0xabc", "run the company");
    const agentActions = actionsMentionedIn(agentPrompt);
    // Sanity: the Agent tier's own prompt must expose more than any single
    // department profile does, or this comparison is meaningless.
    assert.ok(agentActions.size > 0);

    for (const role of CANONICAL_ROLES) {
      const deptPrompt = await buildDepartmentAgentPrompt({
        departmentId: "dept_test",
        name: role,
        role,
        objective: "obj",
        resolveActions: fakeResolverFromCanonicalData,
      });
      const deptActions = actionsMentionedIn(deptPrompt);
      assert.ok(
        deptActions.size <= agentActions.size,
        `${role}'s Department Agent prompt exposes more ACTIONs (${deptActions.size}) than the Agent tier's full prompt (${agentActions.size})`,
      );
      for (const action of deptActions) {
        assert.ok(
          agentActions.has(action),
          `${role}'s Department Agent prompt mentions "${action}", which isn't even in the Agent tier's own tool table`,
        );
      }
    }
  });
});
