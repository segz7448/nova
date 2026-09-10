/**
 * Remote Working-Memory Compaction — merged into agent/ from
 * backend/agent-runtime/src/memoryCompaction.ts.
 *
 * MERGE NOTE: the original imported agent-runtime's own `backendClient.ts`
 * (for `chat()`) and `state.ts` (for the `AgentState` shape). Neither of
 * those was ported — agent/ already has its own, richer equivalents
 * (../../backend/client.ts + ../../backend/inference.ts, and its own
 * conversation-history shape used by ../../agent/loop.ts). Porting
 * agent-runtime's versions alongside agent/'s own would just create two
 * competing implementations of the same thing, which is exactly the mess
 * this merge is meant to remove.
 *
 * Instead this module is decoupled: it takes a `chat` function and a
 * plain `{ history, address, iteration, lastCompactedIteration }` object
 * as parameters, rather than importing a concrete client/state type. Any
 * caller — agent/'s own loop, a heartbeat task, or a future
 * backend-delegated harness — can use this against whatever backend
 * client and state shape it already has, by passing them in.
 *
 * This is separate from agent/'s local SQLite memory (../episodic.ts,
 * ../semantic.ts, etc.) — it's specifically for the case where episodic
 * summaries should also be persisted to a *remote* backend's
 * `/memory/episodic` endpoint via ../backend-sync/remote-memory-client.ts,
 * e.g. when running against a self-hosted `automaton-backend` instead of
 * (or in addition to) local storage. See /MERGE-NOTES.md for wiring.
 */

import * as remoteMemory from "./remote-memory-client.js";

export interface CompactableMessage {
  role: string;
  content: string;
}

export interface CompactableState {
  address: string;
  iteration: number;
  lastCompactedIteration: number;
  history: CompactableMessage[];
}

export interface ChatResult {
  content: string;
  usedTokens?: number;
  chargedUsdc?: number;
}

export type ChatFn = (
  address: string,
  messages: CompactableMessage[],
  maxTokens: number,
) => Promise<ChatResult>;

export interface CompactionOptions {
  /** Function used to summarize the oldest chunk of working memory. */
  chat: ChatFn;
  /** Working-memory message count above which compaction triggers. */
  maxWorkingMessages?: number;
  /** How many of the most recent messages to leave untouched. */
  keepRecentMessages?: number;
  /** Optional logger; defaults to console.log. */
  log?: (message: string) => void;
}

const DEFAULT_MAX_WORKING_MESSAGES = 30;
const DEFAULT_KEEP_RECENT_MESSAGES = 10;

/**
 * Working memory (state.history) grows by roughly two messages per
 * iteration forever if left alone — eventually blowing past context
 * limits and costing more per call as it grows, since tokens are paid
 * for on every request. This keeps it bounded: once it passes a
 * threshold, the oldest chunk gets summarized via the caller-supplied
 * `chat` function (a real, paid inference call — compression isn't
 * free, it's just cheaper than carrying the raw transcript forever)
 * and persisted to remote episodic memory, then replaced in the
 * working set with a single condensed note.
 *
 * This is separate from remember/recall (semantic memory): compaction
 * is automatic and lossy-but-complete (a summary of everything), while
 * remember/recall is the agent deliberately choosing what's worth
 * keeping in full detail.
 */
export async function compactIfNeeded<S extends CompactableState>(
  state: S,
  options: CompactionOptions,
): Promise<S> {
  const maxWorkingMessages = options.maxWorkingMessages ?? DEFAULT_MAX_WORKING_MESSAGES;
  const keepRecentMessages = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES;
  const log = options.log ?? ((msg: string) => console.log(msg));

  // history[0] is always the system prompt — don't count or touch it.
  const workingCount = state.history.length - 1;
  if (workingCount <= maxWorkingMessages) return state;

  const systemMsg = state.history[0];
  const toCompress = state.history.slice(1, state.history.length - keepRecentMessages);
  const toKeep = state.history.slice(state.history.length - keepRecentMessages);

  if (toCompress.length === 0) return state; // nothing old enough to compress yet

  const transcript = toCompress
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  const summaryResult = await options.chat(
    state.address,
    [
      {
        role: "system",
        content:
          "Summarize this agent transcript concisely. Preserve concrete facts, " +
          "decisions made, tool results, and anything an agent would need to " +
          "continue its work correctly. Discard filler and repeated reasoning. " +
          "Write it as plain prose, not a transcript.",
      },
      { role: "user", content: transcript },
    ],
    400,
  );

  const iterationRange = `${state.lastCompactedIteration}-${state.iteration}`;
  await remoteMemory.saveEpisode(state.address, iterationRange, summaryResult.content);

  log(
    `[memory] compacted iterations ${iterationRange} into remote episodic memory ` +
      `(${summaryResult.usedTokens ?? "?"} tokens, $${summaryResult.chargedUsdc ?? "?"})`,
  );

  state.history = [
    systemMsg,
    {
      role: "user",
      content: `EARLIER CONTEXT (compressed summary of your own past work):\n${summaryResult.content}`,
    },
    ...toKeep,
  ];
  state.lastCompactedIteration = state.iteration;

  return state;
}
