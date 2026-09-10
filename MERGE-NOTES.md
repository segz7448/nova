# agent-runtime → agent merge

`backend/agent-runtime` has been merged into `agent/` and deleted. This
document records what moved where, what was intentionally *not*
duplicated (and why), and what follow-up wiring is still needed.

## What moved

| From (`backend/agent-runtime/src/...`) | To (`agent/src/...`) | Status |
|---|---|---|
| `memoryClient.ts` | `memory/backend-sync/remote-memory-client.ts` | Moved, unwired |
| `memoryCompaction.ts` | `memory/backend-sync/remote-compaction.ts` | Moved, decoupled from agent-runtime's `backendClient.ts`/`state.ts` (now takes a `chat` fn + plain state object instead), unwired |
| `departmentToolProfiles.ts` | `agent/policy-rules/department-profiles.ts` | Moved, with `tools.ts`'s `Action`/`ACTIONS` inlined (see file header) |
| `toolRegistryClient.ts` | `registry/tool-registry-client.ts` | Moved as-is (self-contained) |
| `automaton-agent.service` | `../scripts/automaton-agent.service` | Moved as-is (already marked deprecated in the original) |
| `.env.example` (relevant vars) | `../.env.example` (appended section) | Merged, var names kept distinct from agent's own `BACKEND_API_URL` — see comment in that file |
| `__tests__/departmentToolProfiles.test.ts` | `__tests__/runtime-merged/runtime-department-tool-profiles.test.ts` | Moved, imports repointed at merged modules |
| `__tests__/toolRegistryClient.test.ts` | `__tests__/runtime-merged/runtime-tool-registry-client.test.ts` | Moved, self-contained (inlines its own logic copy) |
| `__tests__/tools.test.ts` | `__tests__/runtime-reference/reference-tools.test.ts` | Moved as **reference only** — see below |
| `__tests__/systemPrompt.test.ts` | `__tests__/runtime-reference/reference-systemPrompt.test.ts` | Moved as **reference only** — see below |
| `__tests__/policyChannelTools.test.ts` | `__tests__/runtime-reference/reference-policyChannelTools.test.ts` | Moved as **reference only** — see below |

## What was NOT duplicated, and why

agent-runtime was a from-scratch reimplementation of concepts agent/
already had, built for a different deployment shape (a slim process
delegating everything to a remote backend, vs. agent/'s all-in-one
package). The following agent-runtime files have no counterpart moved
over, because agent/ already has a richer, native version of the same
thing, and running both would mean two competing implementations
instead of one merged one:

- `backendClient.ts` → agent/ has `backend/client.ts` (+ `http-client.ts`,
  `x402.ts`) — already talks to a self-hosted backend, same idea.
- `index.ts` + `tools.ts` (ACTION/INPUT text protocol, 148KB) → agent/'s
  tool dispatch is `agent/tools.ts` + `agent/harnesses/*.ts`, using
  native tool-calling rather than a text protocol. The "same ReAct
  shape, every capability from your own backend" property you listed is
  already true of agent/'s own harness + backend client — it doesn't
  need a separate port. The one genuinely new idea in agent-runtime's
  version — a text-based ACTION/INPUT fallback protocol for models with
  weak native tool-calling — isn't ported as running code, but its
  action vocabulary is preserved verbatim as the `Action`/`ACTIONS`
  export now sitting in `agent/policy-rules/department-profiles.ts`, so
  a future fallback harness can be built on top of it without
  re-deriving that list from scratch.
- `git.ts` → agent/ has `git/{tools,state-versioning}.ts`.
- `soul.ts` → agent/ has `soul/{model,reflection,tools,validator,constitution-guard}.ts`.
- `state.ts` → agent/ has `state/{database,schema}.ts`.
- `policy.ts` → agent/ has `agent/policy-engine.ts` + `agent/policy-rules/*.ts`.
- `systemPrompt.ts` → agent/ has `agent/system-prompt.ts`.
- `injectionDefense.ts` → agent/ has `agent/injection-defense.ts`.
- `browserDaemon.ts` → agent/ has `browser/{daemon-script,ensure}.ts`.
- `spawner.ts` → agent/ has the full `replication/` module (spawner.ts
  only funds a wallet and explicitly doesn't launch a process; agent/'s
  replication system does both, plus lineage/family tracking).

## Follow-up wiring status (updated post-merge — see also automaton-vm-merged-1.zip wiring pass)

1. **DONE — Remote memory sync.** `src/memory/backend-sync/heartbeat-task.ts`
   now calls `compactIfNeeded()`, registered as an opt-in heartbeat task
   (`REMOTE_MEMORY_SYNC_ENABLED=true`) from `src/index.ts`, following the
   same `Object.assign(BUILTIN_TASKS, ...)` pattern the Alibaba infra
   tasks block uses. It pulls recent turns via `db.getRecentTurns()`,
   adapts `AgentTurn` (thinking/toolCalls) into the flat
   `{role, content}` shape `remote-compaction.ts` expects, and passes
   agent/'s own `inference.chat()` as the `chat` fn. Local SQLite
   remains the primary memory store either way; this only adds an
   optional remote episodic summary sync on top.

2. **DONE (partial, by design) — department-profiles.ts /
   tool-registry-client.ts wiring.** New
   `src/agent/policy-rules/department-scope.ts` consumes
   `resolveProfileActions()` and enforces it in the live policy engine,
   gated on three new `AutomatonConfig` fields (`agentTier`,
   `departmentRole`, `workerRole` — set via `automaton.json` or the
   `AGENT_TIER`/`DEPARTMENT_ROLE`/`WORKER_ROLE` env vars, meant to be
   set by the backend when it spawns a department worker's process).
   The mapping from agent-runtime `Action` names to agent/'s native
   `tools.ts` tool names (`ACTION_TO_TOOL_NAME` in that file) is
   **intentionally partial**: only `run_command`, `read_file`,
   `write_file`, `web_search`, `web_fetch`, `github_read`, and
   `check_balance` have a real native-tool counterpart today. Every
   `pty_*`, `mail_*`, `provision_subdomain`/`list_subdomains`/
   `release_subdomain`, and the whole `create_department`/
   `spawn_department_worker`/... department-*management* vocabulary are
   backend REST endpoints (`backend/src/departments.ts`,
   `backend/src/domains.ts`), never agent-side tool calls — there is
   nothing for a local policy rule to gate for those; the backend's own
   per-department budget/permission checks already cover them.
   `tool-registry-client.ts` now reads credentials from `config.ts`'s
   `loadConfig()` instead of raw `process.env`, matching
   `remote-memory-client.ts`'s fix below.

3. **DONE — env var unification.** Both `remote-memory-client.ts` and
   `tool-registry-client.ts` now read `backendApiUrl`/`backendApiKey`
   from `config.ts`'s `loadConfig()` first, falling back to
   `BACKEND_URL`/`BACKEND_API_KEY` only when no automaton config is
   loaded (e.g. a standalone script). The `TOOL_REGISTRY_*` retry/cache
   tuning vars remain env-only — they're deployment knobs, not
   credentials.

4. N/A — the three reference-only tests (`tools`, `systemPrompt`,
   `policyChannelTools`) still don't compile against this repo as-is;
   untouched by this pass.

5. **DONE — test runner mismatch.** The two tests under
   `runtime-merged/` (`runtime-department-tool-profiles.test.ts`,
   `runtime-tool-registry-client.test.ts`) were ported from
   `node:test`/`node:assert/strict` to `vitest`'s own `test`/`describe`/
   `assert` exports (API-compatible for every assertion method these
   files use — `equal`/`deepEqual`/`notEqual`/`notDeepEqual`/`ok`).
   They now run under the same `vitest run` as the rest of agent/'s
   suite (60/60 passing), no separate `node --test` CI step needed.

## `backend/agent-runtime` has been deleted

Everything in it is now accounted for above — either moved, or
deliberately left out in favor of agent/'s existing equivalent.
