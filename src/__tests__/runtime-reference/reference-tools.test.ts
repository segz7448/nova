/**
 * REFERENCE ONLY — not wired into agent/'s vitest suite.
 *
 * Merged from backend/agent-runtime/src/__tests__/tools.test.ts as part of the
 * agent-runtime -> agent merge (see /MERGE-NOTES.md). This test exercises
 * agent-runtime's agent-runtime's ACTION/INPUT tool dispatcher (tools.ts), which was intentionally NOT duplicated into
 * agent/ because agent/ already has its own, more capable native
 * equivalent (agent/src/agent/tools.ts + harnesses/). Porting agent-runtime's ACTION/INPUT tool dispatcher (tools.ts) itself would have meant running
 * two competing implementations side by side, which is what this merge
 * is meant to eliminate.
 *
 * Kept here, unmodified apart from this note, as a reference for anyone
 * porting its specific assertions over to agent/'s equivalent module.
 * It will not compile as-is in this repo (its imports point at files
 * that were deliberately not moved).
 */
/**
 * next-phase.md Phase 2f-ii-d — fidelity tests, tools.ts half.
 *
 * Proves `executeTool()`'s `context`-gated dispatch (2f-ii-c) resolves
 * against exactly the same set `resolveProfileActions()` produces — the
 * dispatch-side half of the prompt/dispatch parity this phase locks down
 * (see systemPrompt.test.ts for the prompt-visible half; both are checked
 * independently against the shared `resolveProfileActions()` source rather
 * than against each other, per that file's header comment).
 *
 * Network note: an *allowed* action still proceeds past the profile check
 * into real dispatch (policy gate, then the backend/memory call) — this
 * process has no backend to talk to in a test environment, so allowed-path
 * assertions below only require that the result is NOT an
 * OUT_OF_PROFILE_TOOL denial (i.e. that it reached dispatch), not that the
 * underlying backend call itself succeeded. RETRY_MAX_ATTEMPTS is forced to
 * 1 and RETRY_BASE_DELAY_MS to 0 below (before importing tools.js) so an
 * unreachable backend fails on the first attempt instead of retrying with
 * exponential backoff, keeping this suite fast without a live backend.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

// Must run before tools.js (and therefore backendClient.js) is imported,
// since backendClient.ts reads these into module-level consts at import
// time. Using a dynamic import below (rather than a static top-of-file
// import) is what makes setting these env vars first actually effective.
process.env.BACKEND_API_KEY ??= "test-key-not-a-real-secret";
process.env.RETRY_MAX_ATTEMPTS = "1";
process.env.RETRY_BASE_DELAY_MS = "0";

let executeTool: typeof import("../tools.js").executeTool;
let ACTIONS: typeof import("../tools.js").ACTIONS;
let OUT_OF_PROFILE_TOOL: typeof import("../tools.js").OUT_OF_PROFILE_TOOL;
let resolveProfileActions: typeof import("../departmentToolProfiles.js").resolveProfileActions;
let DEPARTMENT_TOOL_PROFILES: typeof import("../departmentToolProfiles.js").DEPARTMENT_TOOL_PROFILES;
type Action = import("../tools.js").Action;

before(async () => {
  const toolsModule = await import("../tools.js");
  executeTool = toolsModule.executeTool;
  ACTIONS = toolsModule.ACTIONS;
  OUT_OF_PROFILE_TOOL = toolsModule.OUT_OF_PROFILE_TOOL;
  const profilesModule = await import("../departmentToolProfiles.js");
  resolveProfileActions = profilesModule.resolveProfileActions;
  DEPARTMENT_TOOL_PROFILES = profilesModule.DEPARTMENT_TOOL_PROFILES;
});

/** A minimal, harmless input payload for any ACTION — dispatch may still
 * error on missing/invalid fields for actions we don't fully populate,
 * which is fine: we only ever assert on whether OUT_OF_PROFILE_TOOL fired,
 * never on the downstream call's own success. */
const DUMMY_INPUT: Record<string, any> = { path: "x", content: "y", command: "true", args: [] };

describe("executeTool — dispatch-enforced set matches resolveProfileActions exactly, per role", () => {
  test("setup sanity: canonical roles are loaded", () => {
    assert.deepEqual(
      Object.keys(DEPARTMENT_TOOL_PROFILES).sort(),
      ["finance", "marketing", "security", "server", "software"],
    );
  });

  for (const role of ["software", "marketing", "finance", "security", "server"] as const) {
    test(`${role}: every ACTION not in resolveProfileActions("${role}") is denied with OUT_OF_PROFILE_TOOL`, async () => {
      const resolved = new Set(resolveProfileActions(role));
      for (const action of ACTIONS) {
        if (resolved.has(action)) continue; // allowed-path is covered below
        const result = await executeTool(
          "0xtest",
          { tool: action, input: DUMMY_INPUT },
          { role, callerId: `dept_${role}_test` },
        );
        assert.ok(
          result.output.startsWith(OUT_OF_PROFILE_TOOL),
          `${role} + "${action}" (out of profile) should be denied but got: ${result.output.slice(0, 120)}`,
        );
      }
    });

    test(`${role}: every ACTION in resolveProfileActions("${role}") is NOT denied with OUT_OF_PROFILE_TOOL`, async () => {
      const resolved = resolveProfileActions(role);
      for (const action of resolved) {
        const result = await executeTool(
          "0xtest",
          { tool: action, input: DUMMY_INPUT },
          { role, callerId: `dept_${role}_test` },
        );
        assert.ok(
          !result.output.startsWith(OUT_OF_PROFILE_TOOL),
          `${role} + "${action}" (in profile) was wrongly denied at the profile layer: ${result.output.slice(0, 120)}`,
        );
      }
    });
  }
});

describe("executeTool — denial-path spot checks per role (§4e's own illustrative examples)", () => {
  const denialCases: Array<{ role: string; tool: string }> = [
    { role: "marketing", tool: "run_command" }, // exec, out of Marketing's profile
    { role: "marketing", tool: "read_file" }, // Marketing has no "file system" capability either
    { role: "security", tool: "write_file" }, // Security's profile has no "file system" capability
    { role: "finance", tool: "run_command" }, // Finance is check_balance-only
    { role: "server", tool: "write_file" }, // Server's profile has no "file system" capability
    { role: "software", tool: "check_balance" }, // Software has no Finance capability
  ];

  for (const { role, tool } of denialCases) {
    test(`${role} + "${tool}" is rejected by the dispatcher itself, with an audit-carrying denial`, async () => {
      const result = await executeTool(
        "0xtest",
        { tool, input: DUMMY_INPUT },
        { role, callerId: `dept_${role}_denial_test` },
      );
      assert.ok(result.output.startsWith(OUT_OF_PROFILE_TOOL));
      // The denial's own output carries the caller/action/role fields, per
      // 2f-ii-c's "Done when" line — auditable from the ToolResult alone,
      // not only from the console.error side-channel.
      assert.match(result.output, new RegExp(`role=${role}`));
      assert.match(result.output, new RegExp(`action "${tool}"`));
      assert.match(result.output, new RegExp(`caller: dept_${role}_denial_test`));
    });
  }

  test("a denied call never reaches dispatch: an intentionally malformed input on a denied tool does not surface a downstream/backend error", async () => {
    // If the profile gate ran AFTER dispatch instead of before it, this
    // malformed run_command call for Marketing would fail with some other
    // (backend/validation) error instead of OUT_OF_PROFILE_TOOL. Asserting
    // the exact denial (not just "some error") is what proves pre-dispatch
    // ordering, not merely eventual failure.
    const result = await executeTool(
      "0xtest",
      { tool: "run_command", input: {} }, // no `command` field at all
      { role: "marketing", callerId: "dept_marketing_malformed" },
    );
    assert.ok(result.output.startsWith(OUT_OF_PROFILE_TOOL));
  });
});

describe("executeTool — unrecognized-role regression: default profile only, never the union of every profile", () => {
  test("an unmapped role string resolves to exactly the fail-closed default set, both allowed and denied", async () => {
    const role = "totally-unknown-role";
    const resolved = new Set(resolveProfileActions(role));

    // Every ACTION granted to at least one *other* real department but not
    // in the default set must still be denied for the unrecognized role —
    // this is the check that would catch a "fail open to the union" bug.
    const unionOfAllRealProfiles = new Set<Action>();
    for (const knownRole of ["software", "marketing", "finance", "security", "server"] as const) {
      for (const action of resolveProfileActions(knownRole)) unionOfAllRealProfiles.add(action);
    }
    const notInDefault = [...unionOfAllRealProfiles].filter((a) => !resolved.has(a));
    assert.ok(notInDefault.length > 0, "test setup sanity: expected at least one action outside the default set");

    for (const action of notInDefault) {
      const result = await executeTool(
        "0xtest",
        { tool: action, input: DUMMY_INPUT },
        { role, callerId: "dept_unknown_test" },
      );
      assert.ok(
        result.output.startsWith(OUT_OF_PROFILE_TOOL),
        `unrecognized role must not inherit "${action}" from a real department's profile`,
      );
    }

    // And the default's own granted actions are still allowed through.
    for (const action of resolved) {
      const result = await executeTool(
        "0xtest",
        { tool: action, input: DUMMY_INPUT },
        { role, callerId: "dept_unknown_test" },
      );
      assert.ok(!result.output.startsWith(OUT_OF_PROFILE_TOOL));
    }
  });

  test('specifically: check_balance (Finance-only) is denied for an unrecognized role', async () => {
    const result = await executeTool(
      "0xtest",
      { tool: "check_balance", input: {} },
      { role: "totally-unknown-role", callerId: "dept_unknown_test" },
    );
    assert.ok(result.output.startsWith(OUT_OF_PROFILE_TOOL));
  });
});

describe("executeTool — omitting `context` preserves the unrestricted Agent tier (pre-2f-ii-c behavior)", () => {
  test("a context-less call to an action no department profile grants reaches real dispatch, not OUT_OF_PROFILE_TOOL", async () => {
    // spawn_clone is not in CAPABILITY_TO_ACTIONS' image for any
    // department — a context-less (Agent-tier) call to it must still
    // reach dispatch, proving the gate is opt-in via `context`, not
    // globally applied.
    const result = await executeTool("0xtest", { tool: "spawn_clone", input: {} });
    assert.ok(!result.output.startsWith(OUT_OF_PROFILE_TOOL));
  });

  test("a context-less call to an out-of-every-profile action still isn't silently dropped — it reaches dispatch and gets a real (non-profile) outcome", async () => {
    const result = await executeTool("0xtest", { tool: "update_soul", input: { field: "strategy", value: "x" } });
    assert.ok(!result.output.startsWith(OUT_OF_PROFILE_TOOL));
  });
});
