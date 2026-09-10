/**
 * Local Agent Worker
 *
 * Runs inference-driven task execution in-process as an async background task.
 * Each worker executes through a harness chosen by role via HarnessRegistry.
 */

import path from "node:path";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
import type { HarnessContext, WorkerInferenceClient } from "../agent/harness-types.js";
import { buildWisdomFromGoal, createBudgetFromTask } from "../agent/harness-types.js";
import { HarnessRegistry } from "../agent/harness-registry.js";
import { completeTask, failTask } from "./task-graph.js";
import { applyFlaggedAutoReverts } from "../self-mod/task-outcome.js";
import type { TaskNode } from "./task-graph.js";
import { AgentWorkspace } from "./workspace.js";
import type {
  AutomatonConfig,
  AutomatonIdentity,
  AutomatonTool,
  BackendClient,
  InputSource,
  SpendTrackerInterface,
  ToolContext,
} from "../types.js";
import type { Database } from "better-sqlite3";
import type { PolicyEngine } from "../agent/policy-engine.js";

const logger = createLogger("orchestration.local-worker");
const DEFAULT_ALLOWED_EDIT_ROOT = process.cwd();

interface LocalWorkerConfig {
  db: Database;
  inference: WorkerInferenceClient;
  backend: BackendClient;
  maxTurns?: number;
  harnessRegistry: HarnessRegistry;
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  allowedEditRoot?: string;
  tools?: AutomatonTool[];
  toolContext?: ToolContext;
  policyEngine?: PolicyEngine;
  spendTracker?: SpendTrackerInterface;
  inputSource?: InputSource;
}

export class LocalWorkerPool {
  private activeWorkers = new Map<string, { promise: Promise<void>; abortController: AbortController }>();

  constructor(private readonly config: LocalWorkerConfig) {}

  spawn(task: TaskNode): { address: string; name: string; sandboxId: string } {
    const workerId = `local-worker-${ulid()}`;
    const workerName = `worker-${task.agentRole ?? "generalist"}-${workerId.slice(-6)}`;
    const address = `local://${workerId}`;
    const abortController = new AbortController();

    const workerPromise = this.runWorker(workerId, task, abortController.signal)
      .catch(async (error) => {
        logger.error("Local worker crashed", error instanceof Error ? error : new Error(String(error)), {
          workerId,
          taskId: task.id,
        });
        try {
          const flaggedForRevert = failTask(
            this.config.db,
            task.id,
            `Worker crashed: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
          if (flaggedForRevert.length > 0) {
            await applyFlaggedAutoReverts(this.config.backend, this.config.db, process.cwd(), flaggedForRevert, logger);
          }
        } catch {
          // Task may already be in a terminal state.
        }
      })
      .finally(() => {
        this.activeWorkers.delete(workerId);
      });

    this.activeWorkers.set(workerId, { promise: workerPromise, abortController });
    return { address, name: workerName, sandboxId: workerId };
  }

  getActiveCount(): number {
    return this.activeWorkers.size;
  }

  hasWorker(addressOrId: string): boolean {
    const id = addressOrId.replace("local://", "");
    return this.activeWorkers.has(id);
  }

  async shutdown(): Promise<void> {
    for (const [, worker] of this.activeWorkers) {
      worker.abortController.abort();
    }
    await Promise.allSettled([...this.activeWorkers.values()].map((worker) => worker.promise));
    this.activeWorkers.clear();
  }

  private async runWorker(workerId: string, task: TaskNode, signal: AbortSignal): Promise<void> {
    const harness = this.config.harnessRegistry.createForRole(task.agentRole);
    const workspace = new AgentWorkspace(task.goalId);
    const allowedEditRoot = path.resolve(this.config.allowedEditRoot ?? DEFAULT_ALLOWED_EDIT_ROOT);
    const workerIdentity = createWorkerIdentity(this.config.identity, workerId, task.agentRole);
    const context: HarnessContext = {
      workspaceRoot: workspace.basePath,
      allowedEditRoot,
      workspace,
      identity: workerIdentity,
      config: this.config.config,
      db: this.config.db,
      backend: this.config.backend,
      inference: {
        chat: async (params) => this.config.inference.chat(params),
      },
      budget: createBudgetFromTask(task),
      wisdom: buildWisdomFromGoal(this.config.db, task.goalId, workspace),
      abortSignal: signal,
      goalId: task.goalId,
      toolCatalog: this.config.tools,
      toolContext: this.config.toolContext
        ? {
            ...this.config.toolContext,
            identity: workerIdentity,
          }
        : undefined,
      policyEngine: this.config.policyEngine,
      spendTracker: this.config.spendTracker,
      inputSource: this.config.inputSource,
    };

    if (this.config.maxTurns) {
      context.budget.maxTurns = this.config.maxTurns;
    }
    if (harness.id === "orchestrator" && !this.config.maxTurns) {
      context.budget.maxTurns = Math.max(context.budget.maxTurns, 50);
    }

    logger.info(
      `[WORKER ${workerId}] Starting task "${task.title}" (${task.id}), role: ${task.agentRole ?? "generalist"}, harness: ${harness.id}`,
    );

    try {
      await harness.initialize(task, context);
      const result = await harness.execute();

      if (result.success) {
        const flaggedForRevert = completeTask(this.config.db, task.id, result);
        logger.info("Local worker completed task", {
          workerId,
          taskId: task.id,
          title: task.title,
          duration: result.duration,
          harness: harness.id,
        });
        if (flaggedForRevert.length > 0) {
          await applyFlaggedAutoReverts(this.config.backend, this.config.db, process.cwd(), flaggedForRevert, logger);
        }
      } else {
        const flaggedForRevert = failTask(this.config.db, task.id, result.output || "Task reported failure", true);
        logger.warn("Local worker reported task failure", {
          workerId,
          taskId: task.id,
          title: task.title,
          harness: harness.id,
          output: result.output.slice(0, 200),
        });
        if (flaggedForRevert.length > 0) {
          await applyFlaggedAutoReverts(this.config.backend, this.config.db, process.cwd(), flaggedForRevert, logger);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[WORKER ${workerId}] Harness execution failed: ${message}`);
      const flaggedForRevert = failTask(this.config.db, task.id, message, true);
      if (flaggedForRevert.length > 0) {
        await applyFlaggedAutoReverts(this.config.backend, this.config.db, process.cwd(), flaggedForRevert, logger);
      }
    }
  }
}

function createWorkerIdentity(
  parentIdentity: AutomatonIdentity,
  workerId: string,
  role: string | null,
): AutomatonIdentity {
  return {
    ...parentIdentity,
    name: `worker-${role ?? "generalist"}-${workerId.slice(-6)}`,
    address: `local://${workerId}`,
    sandboxId: workerId,
  };
}
