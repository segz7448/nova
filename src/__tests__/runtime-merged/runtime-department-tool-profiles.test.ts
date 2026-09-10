/**
 * MERGED from backend/agent-runtime/src/__tests__/departmentToolProfiles.test.ts as part of the
 * agent-runtime -> agent merge (see /MERGE-NOTES.md). Originally used Node's
 * built-in `node:test` runner; ported to vitest (test/describe/assert
 * imports swapped for vitest's own, which mirrors node:assert/strict's
 * API for the assertions this file uses) so it runs under `vitest run`
 * like the rest of agent/'s suite, per vitest.config.ts. See
 * /MERGE-NOTES.md item 5.
 */
/**
 * next-phase.md Phase 2f-ii-d — fidelity tests, departmentToolProfiles.ts half.
 *
 * This file locks two things that 2f-ii-a built but never itself asserted
 * in a running test: (1) `lookupDepartmentToolProfile()`'s role -> profile
 * resolution (canonical name, alias, case/whitespace normalization,
 * fail-closed default), and (2) `resolveProfileActions()`'s exact resolved
 * ACTION set per canonical role, hardcoded here rather than re-derived from
 * CAPABILITY_TO_ACTIONS at test time — a test that recomputes the expected
 * answer the same way the code under test does can't catch a bug in that
 * shared derivation itself. The expected sets below are transcribed from
 * `resolveProfileActions`'s own doc comment (the "KNOWN LIMITATION" block)
 * and confirmed by direct execution during this phase's own verification
 * pass (see next-phase.md's Phase 2f-ii-d entry), not invented fresh here.
 *
 * Run with: node --test (Node 22's built-in test runner — no framework
 * install needed, consistent with this repo having no test dependency in
 * package.json as of this phase). Compile first (`tsc`) or run via a
 * TS-aware loader (e.g. `tsx`, already a devDependency) since this file is
 * TypeScript and package.json's "type": "module" gives plain `node --test`
 * no ESM TS loader on its own.
 */
import { test, describe } from "vitest";
import { assert } from "vitest";
import {
  lookupDepartmentToolProfile,
  resolveProfileActions,
  DEFAULT_TOOL_PROFILE,
  DEPARTMENT_TOOL_PROFILES,
  type DepartmentType,
} from "../../agent/policy-rules/department-profiles.js";
import type { Action } from "../../agent/policy-rules/department-profiles.js";

// Exact expected resolved ACTION sets per canonical role, order-independent.
// See this file's header comment for provenance. Phase 8a updated two of
// these to reflect real, intentional changes to the underlying mapping —
// not stale expectations: Software's "github" capability now additionally
// resolves to github_read (a new no-auth read primitive, additive
// alongside its existing shell-based git/gh path — see
// departmentToolProfiles.ts's own Phase 8a comment on that row), and
// Marketing's "web search"/"market research"/"competitor research"/
// "customer research"/"lead research" capabilities now resolve to the
// new web_search/web_fetch primitives instead of an empty array (closing
// the gap that same file's pre-Phase-8a comment named by hand: "No
// web-search... integration exists anywhere in tools.ts").
const EXPECTED_ACTIONS: Record<DepartmentType, Action[]> = {
  software: [
    "run_command",
    "pty_create",
    "pty_write",
    "pty_read",
    "pty_close",
    "pty_list",
    "read_file",
    "write_file",
    "github_read",
  ],
  marketing: ["web_search", "web_fetch"],
  finance: ["check_balance"],
  // error-fix.md Phase 12a: Security/Server gained "vulnerability
  // research"/"infrastructure research" (web_search/web_fetch/
  // github_read) — mediated, agent-runtime-process primitives, not
  // sandbox network, so they don't conflict with these departments'
  // HARDENED_NETWORK_DEPARTMENT_TYPES status. Updated here to reflect
  // that real, intentional change, same as Phase 8a's own updates above.
  security: ["run_command", "read_file", "web_search", "web_fetch", "github_read"],
  server: [
    "run_command",
    "pty_create",
    "pty_write",
    "pty_read",
    "pty_close",
    "read_file",
    "web_search",
    "web_fetch",
    "github_read",
  ],
  // next-phase.md Phase 9a-ii set Domain Management's five capability
  // names (dns/ssl/vhost/mailbox/registry) to an empty ACTION[] —
  // "named, not yet implemented," same status Marketing's own row
  // carried before Phase 8a. Phase 9c and Phase 9d-i/9d-ii/9d-iii have
  // since filled in two of those five: "domain-resource registry"
  // (9c's atomic provision_subdomain/list_subdomains/release_subdomain
  // consolidation — see tools.ts's own comment on that naming
  // decision) and "mailbox provisioning" (9d-i's mail_create_mailbox,
  // 9d-ii's mail_list_mailboxes/reveal_mailbox_credential, 9d-iii's
  // mail_delete_mailbox). "dns record management"/"ssl certificate
  // issuance"/"reverse-proxy vhost management" stay empty on purpose —
  // 9c's own consolidation deliberately never exposed granular
  // dns_*/ssl_*/nginx_* ACTIONs. This entry was NOT updated when 9c
  // landed (a stale-test gap already present before this pass, not
  // introduced by it) — corrected here, now that 9d-iii's own changes
  // would otherwise have compounded the same staleness a third time.
  domain: [
    "provision_subdomain",
    "list_subdomains",
    "release_subdomain",
    "mail_create_mailbox",
    "mail_list_mailboxes",
    "reveal_mailbox_credential",
    "mail_delete_mailbox",
  ],
};

// The fail-closed default's own expected set, kept separate from
// EXPECTED_ACTIONS.software now that the two have diverged (Phase 8a):
// DEFAULT_TOOL_PROFILE is deliberately just "file system" + "terminal" —
// it must never pick up github_read (or anything else) just because a
// real department type happens to have it, per this file's own
// "an unrecognized role's resolved set equals the fail-closed default"
// test below. Before Phase 8a this was byte-for-byte identical to
// Software's own resolved set (a known limitation Phase 2f-ii-a's own
// doc comment named explicitly: "Software's resolved set is identical to
// the default's today"); Phase 8a's github_read addition to Software
// specifically is what finally makes the two distinguishable, so this
// constant existing on its own — no longer borrowed from
// EXPECTED_ACTIONS.software — is itself part of that fix, not a
// workaround for it.
const EXPECTED_DEFAULT_ACTIONS: Action[] = [
  "run_command",
  "pty_create",
  "pty_write",
  "pty_read",
  "pty_close",
  "pty_list",
  "read_file",
  "write_file",
];

function assertSameSet(actual: Action[], expected: Action[], label: string) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  assert.deepEqual(a, e, `${label}: resolved action set mismatch\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(e)}`);
}

describe("lookupDepartmentToolProfile", () => {
  for (const type of Object.keys(DEPARTMENT_TOOL_PROFILES) as DepartmentType[]) {
    test(`resolves the canonical name "${type}"`, () => {
      const profile = lookupDepartmentToolProfile(type);
      assert.equal(profile.departmentType, type);
    });

    test(`is case-insensitive and trims whitespace for "${type}"`, () => {
      const profile = lookupDepartmentToolProfile(`  ${type.toUpperCase()}  `);
      assert.equal(profile.departmentType, type);
    });
  }

  const aliasCases: Array<[string, DepartmentType]> = [
    ["engineering", "software"],
    ["eng", "software"],
    ["dev", "software"],
    ["growth", "marketing"],
    ["marcomm", "marketing"],
    ["accounting", "finance"],
    ["fin", "finance"],
    ["infosec", "security"],
    ["sec", "security"],
    ["infra", "server"],
    ["devops", "server"],
    ["dns", "domain"],
    ["domains", "domain"],
    ["webmaster", "domain"],
  ];
  for (const [alias, expectedType] of aliasCases) {
    test(`resolves alias "${alias}" to ${expectedType}`, () => {
      const profile = lookupDepartmentToolProfile(alias);
      assert.equal(profile.departmentType, expectedType);
    });
  }

  test("an unrecognized role falls through to DEFAULT_TOOL_PROFILE, not a merge of everything", () => {
    const profile = lookupDepartmentToolProfile("totally-unknown-role");
    assert.equal(profile, DEFAULT_TOOL_PROFILE);
    assert.equal(profile.departmentType, null);
  });

  test("null, undefined, and empty-string role all fall through to DEFAULT_TOOL_PROFILE", () => {
    assert.equal(lookupDepartmentToolProfile(null), DEFAULT_TOOL_PROFILE);
    assert.equal(lookupDepartmentToolProfile(undefined), DEFAULT_TOOL_PROFILE);
    assert.equal(lookupDepartmentToolProfile(""), DEFAULT_TOOL_PROFILE);
    assert.equal(lookupDepartmentToolProfile("   "), DEFAULT_TOOL_PROFILE);
  });

  test("a near-miss substring of a real type does not fuzzy-match", () => {
    // "softwar" is not "software" and not a listed alias — must fail
    // closed, not partially match.
    const profile = lookupDepartmentToolProfile("softwar");
    assert.equal(profile, DEFAULT_TOOL_PROFILE);
  });
});

describe("resolveProfileActions — exact resolved sets per canonical role", () => {
  for (const type of Object.keys(EXPECTED_ACTIONS) as DepartmentType[]) {
    test(`${type}'s resolved ACTION set matches §4e-derived expectation exactly`, () => {
      assertSameSet(resolveProfileActions(type), EXPECTED_ACTIONS[type], type);
    });
  }

  test("an unrecognized role's resolved set equals the fail-closed default (fs + exec only)", () => {
    const unrecognized = resolveProfileActions("totally-unknown-role");
    const byDefault = resolveProfileActions(null);
    assertSameSet(unrecognized, byDefault, "unrecognized-vs-default");
    assertSameSet(unrecognized, EXPECTED_DEFAULT_ACTIONS, "unrecognized-vs-expected-default");
  });

  // Phase 8a regression guard: before this phase, Software's resolved set
  // happened to be byte-for-byte identical to the fail-closed default's
  // (a known limitation this repo's own doc comments named explicitly).
  // github_read's addition to Software specifically means that's no
  // longer true — confirm it stays that way, since a future change that
  // accidentally added github_read to DEFAULT_TOOL_PROFILE too would
  // silently resurrect the exact "can't distinguish a real department
  // from an unrecognized one" gap Phase 8a fixed.
  test("the fail-closed default no longer coincides with Software's own (now strictly larger) resolved set", () => {
    const byDefault = new Set(resolveProfileActions(null));
    const software = new Set(resolveProfileActions("software"));
    assert.equal(byDefault.has("github_read"), false, "the default must never pick up github_read");
    assert.ok(software.has("github_read"), "software's own resolved set must include github_read");
    assert.notDeepEqual([...byDefault].sort(), [...software].sort());
  });

  test("the default profile's resolved set is NOT the union of every department's set", () => {
    const byDefault = new Set(resolveProfileActions(null));
    // Finance's one distinguishing action must never leak into the
    // fail-closed default — a union-of-everything default would be a
    // privilege-escalation bug for any unmapped/typo'd role string.
    assert.equal(byDefault.has("check_balance"), false);
  });

  test("an alias resolves to the exact same set as its canonical role", () => {
    assertSameSet(resolveProfileActions("engineering"), resolveProfileActions("software"), "engineering-vs-software");
    assertSameSet(resolveProfileActions("infosec"), resolveProfileActions("security"), "infosec-vs-security");
  });

  test("resolveProfileActions returns a deduplicated array (no repeated ACTION identifiers)", () => {
    for (const type of Object.keys(EXPECTED_ACTIONS) as DepartmentType[]) {
      const actions = resolveProfileActions(type);
      assert.equal(actions.length, new Set(actions).size, `${type} resolved set contains duplicates`);
    }
  });

  // next-phase.md Phase 9a-ii regression guard, updated by inspection
  // now that 9c/9d-i/9d-ii/9d-iii have filled in two of Domain's five
  // capability names (see EXPECTED_ACTIONS.domain's own comment above):
  // Domain Management is a real, recognized department type (distinct
  // from an unrecognized role) — confirm the profile itself still
  // resolves correctly, independent of how big its resolved ACTION set
  // is.
  test("domain resolves to a real, recognized profile distinct from the fail-closed default", () => {
    const profile = lookupDepartmentToolProfile("domain");
    assert.equal(profile.departmentType, "domain");
    assert.notEqual(profile, DEFAULT_TOOL_PROFILE);
    assert.equal(profile.tools.length, 5);
  });

  test("domain never gets exec/pty access — same fail-closed posture Marketing's own row has", () => {
    const granted = new Set(resolveProfileActions("domain"));
    assert.equal(granted.has("run_command"), false);
    assert.equal(granted.has("pty_create"), false);
  });
});
