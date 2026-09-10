/**
 * Remote Memory Sync — Heartbeat Task
 *
 * Follow-up wiring from /MERGE-NOTES.md item 1: nothing called
 * ./remote-compaction.ts's compactIfNeeded() anywhere. This module is
 * the caller, built as a heartbeat task (the second option the merge
 * notes offered, alongside agent-context-aggregator.ts — a heartbeat
 * task fits better because it can run independently of whether the
 * agent is awake, and doesn't require threading a `chat` fn through
 * the hot path of agent/loop.ts).
 *
 * What it does, once per tick: pull recent turns from local SQLite
 * (agent/'s own primary memory store — this does NOT replace it),
 * adapt them into remote-compaction's plain {role, content} shape,
 * and hand them to compactIfNeeded(). If the working set has grown
 * past the threshold, the oldest chunk gets summarized via a real
 * inference call and persisted to the self-hosted backend's
 * /memory/episodic endpoint through ./remote-memory-client.ts.
 *
 * Opt-in only: registered from src/index.ts only when
 * REMOTE_MEMORY_SYNC_ENABLED=true, same "absence is not fatal, presence
 * is additive" posture as the Alibaba infra tasks right above it in
 * index.ts. An automaton that hasn't set this keeps using local SQLite
 * memory exactly as before.
 */

import type { AgentTurn, ChatMessage, HeartbeatLegacyContext, InferenceClient, TickContext } from "../../types.js";
import { createLogger } from "../../observability/logger.js";
import { compactIfNeeded, type ChatFn, type CompactableMessage } from "./remote-compaction.js";

const logger = createLogger("memory.remote-sync");

/** How many recent turns to consider on each check. Compaction only
 *  fires once the resulting message count clears remote-compaction's
 *  own DEFAULT_MAX_WORKING_MESSAGES (30) threshold, so pulling more
 *  than that here just gives it a bigger window to work with. */
const TURN_WINDOW = 200;

const KV_LAST_COMPACTED_ITERATION = "remote_memory_last_compacted_iteration";

export const REMOTE_MEMORY_TASK_INTERVALS_MS = {
  remote_memory_compaction: 30 * 60_000, // every 30 minutes
} as const;

/**
 * Flattens one AgentTurn (agent/'s richer, structured turn record —
 * input/thinking/toolCalls/tokenUsage) into the plain user/assistant
 * message pairs remote-compaction's CompactableState expects. This is
 * a lossy projection (tool-call durations, errors, and cost are
 * dropped) — acceptable here because the *output* of compaction is
 * itself a lossy summary; the local SQLite turns table remains the
 * lossless record.
 */
function turnToMessages(turn: AgentTurn): CompactableMessage[] {
  const messages: CompactableMessage[] = [];
  if (turn.input) {
    messages.push({ role: "user", content: turn.input });
  }

  const assistantParts: string[] = [];
  if (turn.thinking) assistantParts.push(turn.thinking);
  for (const call of turn.toolCalls) {
    const outcome = call.error ? `ERROR: ${call.error}` : call.result;
    assistantParts.push(`[tool:${call.name}] ${JSON.stringify(call.arguments)} -> ${outcome}`);
  }

  if (assistantParts.length > 0) {
    messages.push({ role: "assistant", content: assistantParts.join("\n") });
  }

  return messages;
}

function makeChatFn(inference: InferenceClient): ChatFn {
  return async (_address, messages, maxTokens) => {
    const response = await inference.chat(messages as ChatMessage[], { maxTokens });
    return {
      content: response.message.content,
      usedTokens: response.usage?.totalTokens,
    };
  };
}

export interface RemoteMemorySyncDeps {
  inference: InferenceClient;
  agentAddress: string;
}

/**
 * Returns a task map suitable for `Object.assign(BUILTIN_TASKS, ...)`,
 * matching the exact pattern src/index.ts already uses for
 * createInfraTasks() — see the Alibaba Cloud block above the heartbeat
 * daemon construction.
 */
export function createRemoteMemorySyncTasks(
  deps: RemoteMemorySyncDeps,
): Record<string, (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => Promise<{ shouldWake: boolean; message?: string }>> {
  const chat = makeChatFn(deps.inference);

  return {
    remote_memory_compaction: async (_ctx, taskCtx) => {
      const recentTurns = taskCtx.db.getRecentTurns(TURN_WINDOW);
      if (recentTurns.length === 0) {
        return { shouldWake: false };
      }

      const history: CompactableMessage[] = [
        { role: "system", content: "(local turn history, compacted on a rolling basis)" },
        ...recentTurns.flatMap(turnToMessages),
      ];

      const lastCompactedRaw = taskCtx.db.getKV(KV_LAST_COMPACTED_ITERATION);
      const lastCompactedIteration = lastCompactedRaw ? Number.parseInt(lastCompactedRaw, 10) || 0 : 0;

      try {
        const result = await compactIfNeeded(
          {
            address: deps.agentAddress,
            iteration: recentTurns.length,
            lastCompactedIteration,
            history,
          },
          { chat, log: (msg) => logger.info(msg) },
        );

        if (result.lastCompactedIteration !== lastCompactedIteration) {
          taskCtx.db.setKV(KV_LAST_COMPACTED_ITERATION, String(result.lastCompactedIteration));
        }
      } catch (err: any) {
        // Remote backend being unreachable shouldn't take the agent down —
        // local SQLite memory is unaffected either way.
        logger.warn(`Remote memory compaction failed: ${err?.message ?? err}`);
      }

      return { shouldWake: false };
    },
  };
}
