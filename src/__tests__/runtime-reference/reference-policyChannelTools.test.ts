/**
 * REFERENCE ONLY — not wired into agent/'s vitest suite.
 *
 * Merged from backend/agent-runtime/src/__tests__/policyChannelTools.test.ts as part of the
 * agent-runtime -> agent merge (see /MERGE-NOTES.md). This test exercises
 * agent-runtime's agent-runtime's policy.ts, which was intentionally NOT duplicated into
 * agent/ because agent/ already has its own, more capable native
 * equivalent (agent/src/agent/policy-engine.ts + policy-rules/). Porting agent-runtime's policy.ts itself would have meant running
 * two competing implementations side by side, which is what this merge
 * is meant to eliminate.
 *
 * Kept here, unmodified apart from this note, as a reference for anyone
 * porting its specific assertions over to agent/'s equivalent module.
 * It will not compile as-is in this repo (its imports point at files
 * that were deliberately not moved).
 */
/**
 * next-phase.md Phase 3g-iii — closing verification for 3g-ii's rate
 * limits, the "confirms 3g-ii's rate limits actually deny past their
 * configured threshold" half of 3g-iii's own checklist line (the
 * state-machine/audit-hook half lives in
 * backend/src/__tests__/channels.test.ts — a separate file because
 * policy.ts lives in this package, not backend/src, and the two
 * packages don't share a tsconfig/module graph).
 *
 * Unlike channelService.ts (express/better-sqlite3/dockerode, none of
 * which can be installed in this no-network environment — see
 * channels.test.ts's own header for why that file mirrors decision
 * logic instead), policy.ts has no runtime dependency on anything
 * outside itself: its only import is `import type { ToolCall } from
 * "./tools.js"`, erased entirely at compile time. That means this suite
 * imports and exercises the REAL evaluateToolCall()/recordToolCall()/
 * DEFAULT_POLICY_CONFIG from policy.ts directly — no inlined mirror
 * needed, same "no db import, can run standalone" reasoning
 * toolRegistrySeedData.test.ts's own header already used for the one
 * other backend/src file that also had no disqualifying import.
 *
 * Run with: `npx tsx --test src/__tests__/policyChannelTools.test.ts`
 * (tsx already used by every other agent-runtime test file in this
 * directory, per their own header comments — no test framework added).
 *
 * IMPORTANT — shared module state across tests in this file: policy.ts's
 * seven new rolling-window arrays (one per tool) are private, module-
 * level, and never reset between tests in the same process — the exact
 * same real behavior a long-running agent-runtime process has. Each
 * test below therefore tracks and accounts for that tool's own
 * cumulative recorded-call count from earlier tests in this file rather
 * than assuming it starts at zero (each tool's own comment states the
 * count it inherits). Per-tool `cfg` overrides (evaluateToolCall's own
 * `cfg` parameter) keep each test's own cap small and independent of
 * every other tool's cap, without needing to touch the private arrays
 * directly.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluateToolCall, recordToolCall, DEFAULT_POLICY_CONFIG, type PolicyConfig } from "../policy.js";
import type { ToolCall } from "../tools.js";

function call(tool: string, input: Record<string, any> = {}): ToolCall {
  return { tool, input };
}

/**
 * Drives `n` allowed calls through evaluate+record (the same two-step
 * sequence a real caller uses — see policy.ts's own doc comment: "Call
 * [recordToolCall] once a call has actually been allowed through"),
 * asserting each is still allowed, then returns the (n+1)th call's
 * decision so the caller can assert the expected denial shape.
 */
function exhaustCapAndDeny(tool: string, cfg: PolicyConfig, remainingAllowedCalls: number) {
  for (let i = 0; i < remainingAllowedCalls; i++) {
    const decision = evaluateToolCall(call(tool), cfg);
    assert.equal(decision.action, "allow", `call ${i + 1}/${remainingAllowedCalls} for ${tool} should still be allowed`);
    recordToolCall(call(tool));
  }
  return evaluateToolCall(call(tool), cfg);
}

describe("Phase 3g-ii — rate limits for the seven Phase 3 channel/file/project tools", () => {
  // propose_channel: untouched by any earlier test in this file — cap 3
  // means all 3 calls made here are the tool's entire cumulative count.
  test("propose_channel: check-only calls never advance the counter, and it denies once maxChannelProposalsPerDay is reached", () => {
    const cfg = { ...DEFAULT_POLICY_CONFIG, maxChannelProposalsPerDay: 3 };
    // Five pure "would this be allowed" checks, deliberately more than
    // the cap, none of them recorded — none should move the counter.
    for (let i = 0; i < 5; i++) {
      assert.equal(evaluateToolCall(call("propose_channel"), cfg).action, "allow");
    }
    const denial = exhaustCapAndDeny("propose_channel", cfg, 3);
    assert.equal(denial.action, "deny");
    assert.equal(denial.reasonCode, "RATE_LIMIT");
    assert.equal(denial.ruleId, "rate.channel_proposal_daily");
    assert.match(denial.message, /3 propose_channel calls/);
  });

  test("accept_channel: denies once maxChannelAcceptsPerDay is reached", () => {
    const cfg = { ...DEFAULT_POLICY_CONFIG, maxChannelAcceptsPerDay: 2 };
    const denial = exhaustCapAndDeny("accept_channel", cfg, 2);
    assert.equal(denial.action, "deny");
    assert.equal(denial.reasonCode, "RATE_LIMIT");
    assert.equal(denial.ruleId, "rate.channel_accept_daily");
    assert.match(denial.message, /2 accept_channel calls/);
  });

  test("reject_channel: denies once maxChannelRejectsPerDay is reached", () => {
    const cfg = { ...DEFAULT_POLICY_CONFIG, maxChannelRejectsPerDay: 2 };
    const denial = exhaustCapAndDeny("reject_channel", cfg, 2);
    assert.equal(denial.action, "deny");
    assert.equal(denial.reasonCode, "RATE_LIMIT");
    assert.equal(denial.ruleId, "rate.channel_reject_daily");
    assert.match(denial.message, /2 reject_channel calls/);
  });

  test("revoke_channel: denies once maxChannelRevokesPerDay is reached", () => {
    const cfg = { ...DEFAULT_POLICY_CONFIG, maxChannelRevokesPerDay: 4 };
    const denial = exhaustCapAndDeny("revoke_channel", cfg, 4);
    assert.equal(denial.action, "deny");
    assert.equal(denial.reasonCode, "RATE_LIMIT");
    assert.equal(denial.ruleId, "rate.channel_revoke_daily");
    assert.match(denial.message, /4 revoke_channel calls/);
  });

  test("send_file: denies once maxFileSendsPerDay is reached (independent, higher-cap counter)", () => {
    const cfg = { ...DEFAULT_POLICY_CONFIG, maxFileSendsPerDay: 5 };
    const denial = exhaustCapAndDeny("send_file", cfg, 5);
    assert.equal(denial.action, "deny");
    assert.equal(denial.reasonCode, "RATE_LIMIT");
    assert.equal(denial.ruleId, "rate.file_send_daily");
    assert.match(denial.message, /5 send_file calls/);
  });

  test("request_file: denies once maxFileRequestsPerDay is reached", () => {
    const cfg = { ...DEFAULT_POLICY_CONFIG, maxFileRequestsPerDay: 3 };
    const denial = exhaustCapAndDeny("request_file", cfg, 3);
    assert.equal(denial.action, "deny");
    assert.equal(denial.reasonCode, "RATE_LIMIT");
    assert.equal(denial.ruleId, "rate.file_request_daily");
    assert.match(denial.message, /3 request_file calls/);
  });

  test("join_project: denies once maxProjectJoinsPerDay is reached", () => {
    const cfg = { ...DEFAULT_POLICY_CONFIG, maxProjectJoinsPerDay: 2 };
    const denial = exhaustCapAndDeny("join_project", cfg, 2);
    assert.equal(denial.action, "deny");
    assert.equal(denial.reasonCode, "RATE_LIMIT");
    assert.equal(denial.ruleId, "rate.project_join_daily");
    assert.match(denial.message, /2 join_project calls/);
  });

  test("DEFAULT_POLICY_CONFIG carries all seven new fields with sane, positive defaults", () => {
    const fields: (keyof PolicyConfig)[] = [
      "maxChannelProposalsPerDay",
      "maxChannelAcceptsPerDay",
      "maxChannelRejectsPerDay",
      "maxChannelRevokesPerDay",
      "maxFileSendsPerDay",
      "maxFileRequestsPerDay",
      "maxProjectJoinsPerDay",
    ];
    for (const field of fields) {
      const value = DEFAULT_POLICY_CONFIG[field];
      assert.equal(typeof value, "number", `${field} should be a number`);
      assert.ok(value > 0, `${field} should be a positive default`);
    }
    // send_file/request_file are the two tools meant for repeated use
    // against an already-active channel (§7) — their defaults should
    // sit meaningfully above the five one-off-transition tools' shared
    // 20/day default, not just at or below it.
    assert.ok(DEFAULT_POLICY_CONFIG.maxFileSendsPerDay > DEFAULT_POLICY_CONFIG.maxChannelProposalsPerDay);
    assert.ok(DEFAULT_POLICY_CONFIG.maxFileRequestsPerDay > DEFAULT_POLICY_CONFIG.maxChannelAcceptsPerDay);
  });

  // At this point in the file each tool's own cumulative recorded count
  // (from its own test above) is: propose_channel=3, accept_channel=2,
  // reject_channel=2, revoke_channel=4, send_file=5, request_file=3,
  // join_project=2 — every one comfortably under DEFAULT_POLICY_CONFIG's
  // own real defaults (20/20/20/20/200/50/20), so evaluating each again
  // here with NO cfg override (the real defaults) should still allow —
  // confirming none of the seven still falls through to the bare
  // `default:` case (which also returns allow, but via a distinct,
  // untracked path — the per-tool ruleId assertions above already
  // confirm each one's OWN named case is what actually fires on denial).
  test("every one of the seven tools gets a decision under real default caps, not a bare default: fallthrough", () => {
    const unknownToolDecision = evaluateToolCall(call("some_totally_unrecognized_tool_xyz"));
    assert.equal(unknownToolDecision.action, "allow");
    assert.equal(unknownToolDecision.reasonCode, "ALLOWED");

    for (const tool of [
      "propose_channel",
      "accept_channel",
      "reject_channel",
      "revoke_channel",
      "send_file",
      "request_file",
      "join_project",
    ]) {
      assert.equal(evaluateToolCall(call(tool)).action, "allow", `${tool} should still be well under its real default cap`);
    }
  });

  // Cross-tool isolation: propose_channel currently sits at a cumulative
  // count of 3 (from its own test above) and accept_channel at 2. A cfg
  // that gives propose_channel exactly one more slot (cap 4) and gives
  // accept_channel a cap far above its own current count (100) proves
  // that exhausting propose_channel's counter has no effect on
  // accept_channel's — they are independent arrays, not a shared one.
  test("cross-tool isolation: exhausting one tool's cap never denies a different tool", () => {
    const cfg: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, maxChannelProposalsPerDay: 4, maxChannelAcceptsPerDay: 100 };

    assert.equal(evaluateToolCall(call("propose_channel"), cfg).action, "allow");
    recordToolCall(call("propose_channel"));
    assert.equal(
      evaluateToolCall(call("propose_channel"), cfg).action,
      "deny",
      "propose_channel should now be exhausted at its cumulative count of 4",
    );

    assert.equal(
      evaluateToolCall(call("accept_channel"), cfg).action,
      "allow",
      "accept_channel's own counter (cumulative 2) must be unaffected by propose_channel's exhaustion",
    );
  });
});
