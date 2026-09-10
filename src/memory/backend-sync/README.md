# Backend-Sync Memory (merged from `backend/agent-runtime`)

This folder holds the memory code that was merged in from
`backend/agent-runtime/src/{memoryClient.ts,memoryCompaction.ts}` as part
of the agent-runtime → agent merge (see `/MERGE-NOTES.md` at the repo
root for the full picture).

- `remote-memory-client.ts` — HTTP client for a self-hosted backend's
  `/memory/{episodic,semantic,procedural,knowledge}` endpoints
  (episode save/list, remember/recall, procedures, categorized facts).
- `remote-compaction.ts` — bounds working-memory growth by summarizing
  the oldest chunk of conversation and pushing it to the remote client
  above, once a message-count threshold is passed.

## Relationship to agent/'s existing memory system

agent/'s own memory system (`../episodic.ts`, `../semantic.ts`,
`../procedural.ts`, `../knowledge-store.ts`, `../relationship.ts`,
`../working.ts`, backed by local SQLite) is **not replaced or touched**
by this merge. It remains the primary memory store.

This folder is an *additional*, opt-in layer for the case where memory
should also (or instead) live on a remote self-hosted backend — the
model agent-runtime used, where deleting the local agent process's state
file doesn't lose remembered facts because they were never local to
begin with.

## Wiring status (not yet done)

Nobody in agent/ calls into this folder yet. To actually use it:

1. Decide where remote sync should be triggered from — most likely
   `../agent-context-aggregator.ts` or a new heartbeat task in
   `../../heartbeat/tasks.ts`.
2. Pass agent/'s own `chat` function (from `../../backend/inference.ts`)
   into `compactIfNeeded()`'s `chat` option — it takes a plain function,
   not a specific client type, precisely so it doesn't require
   duplicating agent-runtime's `backendClient.ts`.
3. Point `remote-memory-client.ts`'s `BACKEND_URL`/`BACKEND_API_KEY` env
   reads at agent/'s config (`../../config.ts`'s `loadConfig()`) instead
   of raw `process.env`, for consistency with the rest of agent/.
