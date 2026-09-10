import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PlanModeController,
  loadPlan,
  persistPlan,
  reviewPlan,
  shouldReplan,
  getApprovalRequest,
  getPendingApprovalRequests,
  resolveSupervisedApprovals,
  type ExecutionState,
  type PlanApprovalConfig,
} from "../../orchestration/plan-mode.js";
import type { PlannerOutput } from "../../orchestration/planner.js";
import type { UnifiedInferenceClient, UnifiedInferenceResult } from "../../inference/inference-client.js";
import { createInMemoryDb } from "./test-db.js";

function makeChatResult(content: string): UnifiedInferenceResult {
  return {
    content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: { inputCostCredits: 0, outputCostCredits: 0, totalCostCredits: 0 },
    metadata: { providerId: "test", modelId: "test", tier: "reasoning", latencyMs: 1, retries: 0, failedProviders: [] },
  };
}

function makePlan(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return {
    analysis: "Analyze constraints",
    strategy: "Ship incrementally",
    customRoles: [],
    tasks: [
      {
        title: "Implement core",
        description: "Implement the core feature and validate behavior.",
        agentRole: "engineer",
        dependencies: [],
        estimatedCostCents: 1200,
        priority: 1,
        timeoutMs: 60_000,
      },
    ],
    risks: ["Risk: unknown dependency"],
    estimatedTotalCostCents: 1200,
    estimatedTimeMinutes: 30,
    ...overrides,
  };
}

function baseState(overrides: Partial<ExecutionState> = {}): ExecutionState {
  return {
    phase: "executing",
    goalId: "goal-1",
    planId: "plan-1",
    planVersion: 1,
    planFilePath: "/tmp/plan.json",
    spawnedAgentIds: [],
    replansRemaining: 3,
    phaseEnteredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("orchestration/plan-mode", () => {
  let db: BetterSqlite3.Database;
  let controller: PlanModeController;
  let tempDirs: string[];

  beforeEach(() => {
    db = createInMemoryDb();
    controller = new PlanModeController(db);
    tempDirs = [];
  });

  afterEach(async () => {
    db.close();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function newTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "plan-mode-test-"));
    tempDirs.push(dir);
    return dir;
  }

  describe("PlanModeController transitions", () => {
    it("returns default state when KV is empty", () => {
      const state = controller.getState();
      expect(state.phase).toBe("idle");
      expect(state.goalId).toBe("");
      expect(state.planId).toBeNull();
      expect(state.replansRemaining).toBe(3);
      expect(state.phaseEnteredAt.length).toBeGreaterThan(0);
    });

    it("allows idle -> classifying", () => {
      controller.transition("idle", "classifying", "start");
      expect(controller.getState().phase).toBe("classifying");
    });

    it("allows classifying -> planning", () => {
      controller.setState({ phase: "classifying" });
      controller.transition("classifying", "planning", "needs plan");
      expect(controller.getState().phase).toBe("planning");
    });

    it("allows classifying -> executing", () => {
      controller.setState({ phase: "classifying" });
      controller.transition("classifying", "executing", "simple task");
      expect(controller.getState().phase).toBe("executing");
    });

    it("allows planning -> plan_review", () => {
      controller.setState({ phase: "planning" });
      controller.transition("planning", "plan_review", "draft complete");
      expect(controller.getState().phase).toBe("plan_review");
    });

    it("allows plan_review -> executing", () => {
      controller.setState({ phase: "plan_review" });
      controller.transition("plan_review", "executing", "approved");
      expect(controller.getState().phase).toBe("executing");
    });

    it("allows plan_review -> planning", () => {
      controller.setState({ phase: "plan_review" });
      controller.transition("plan_review", "planning", "needs revision");
      expect(controller.getState().phase).toBe("planning");
    });

    it("allows executing -> replanning and updates counters", () => {
      controller.setState({ phase: "executing", replansRemaining: 2, planVersion: 4 });
      controller.transition("executing", "replanning", "failure");

      const state = controller.getState();
      expect(state.phase).toBe("replanning");
      expect(state.replansRemaining).toBe(1);
      expect(state.planVersion).toBe(5);
    });

    it("allows replanning -> plan_review", () => {
      controller.setState({ phase: "replanning" });
      controller.transition("replanning", "plan_review", "new plan drafted");
      expect(controller.getState().phase).toBe("plan_review");
    });

    it("allows transition to failed from any phase", () => {
      controller.setState({ phase: "planning" });
      controller.transition("planning", "failed", "fatal");
      expect(controller.getState().phase).toBe("failed");
    });

    it("throws when from phase does not match current phase", () => {
      controller.setState({ phase: "planning" });
      expect(() => controller.transition("idle", "classifying", "bad precondition")).toThrow(
        /Invalid transition precondition/,
      );
    });

    it("throws for invalid transition edge", () => {
      controller.setState({ phase: "idle" });
      expect(() => controller.transition("idle", "executing", "skip")).toThrow(
        "Invalid transition 'idle' -> 'executing' (reason: skip)",
      );
    });

    it("throws for transitions out of complete", () => {
      controller.setState({ phase: "complete" });
      expect(() => controller.transition("complete", "planning", "reopen")).toThrow(/Invalid transition/);
    });
  });

  describe("canSpawnAgents", () => {
    it("returns false while idle", () => {
      controller.setState({ phase: "idle", planId: "plan-1" });
      expect(controller.canSpawnAgents()).toBe(false);
    });

    it("returns false in executing when planId is null", () => {
      controller.setState({ phase: "executing", planId: null });
      expect(controller.canSpawnAgents()).toBe(false);
    });

    it("returns true only in executing with planId", () => {
      controller.setState({ phase: "executing", planId: "plan-1" });
      expect(controller.canSpawnAgents()).toBe(true);
    });

    it("returns false in non-executing phase even with planId", () => {
      controller.setState({ phase: "planning", planId: "plan-1" });
      expect(controller.canSpawnAgents()).toBe(false);
    });
  });

  describe("state persistence", () => {
    it("setState persists to KV and getState reads it", () => {
      controller.setState({ phase: "executing", goalId: "g-1", planId: "p-1", replansRemaining: 2 });

      const row = db.prepare("SELECT value FROM kv WHERE key = 'plan_mode.state'").get() as
        | { value: string }
        | undefined;

      expect(row).toBeDefined();
      expect(controller.getState()).toMatchObject({
        phase: "executing",
        goalId: "g-1",
        planId: "p-1",
        replansRemaining: 2,
      });
    });

    it("setState merges partial state", () => {
      controller.setState({ phase: "executing", goalId: "g-1", planId: "p-1", planVersion: 2 });
      controller.setState({ replansRemaining: 1 });

      expect(controller.getState()).toMatchObject({
        phase: "executing",
        goalId: "g-1",
        planId: "p-1",
        planVersion: 2,
        replansRemaining: 1,
      });
    });

    it("phase changes update phaseEnteredAt automatically", () => {
      controller.setState({ phase: "idle", phaseEnteredAt: "2026-01-01T00:00:00.000Z" });
      controller.setState({ phase: "classifying" });

      expect(controller.getState().phaseEnteredAt).not.toBe("2026-01-01T00:00:00.000Z");
    });

    it("explicit phaseEnteredAt is preserved", () => {
      controller.setState({ phase: "planning", phaseEnteredAt: "2026-02-01T00:00:00.000Z" });
      expect(controller.getState().phaseEnteredAt).toBe("2026-02-01T00:00:00.000Z");
    });

    it("getState falls back on malformed JSON", () => {
      db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))")
        .run("plan_mode.state", "{bad json");

      expect(controller.getState().phase).toBe("idle");
    });

    it("getState sanitizes invalid values", () => {
      db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))")
        .run("plan_mode.state", JSON.stringify({
          phase: "not-a-phase",
          goalId: 123,
          planId: 456,
          planVersion: -10,
          planFilePath: 111,
          spawnedAgentIds: ["a", 1, "b"],
          replansRemaining: -5,
          phaseEnteredAt: "",
        }));

      const state = controller.getState();
      expect(state.phase).toBe("idle");
      expect(state.goalId).toBe("");
      expect(state.planId).toBeNull();
      expect(state.planVersion).toBe(0);
      expect(state.planFilePath).toBeNull();
      expect(state.spawnedAgentIds).toEqual(["a", "b"]);
      expect(state.replansRemaining).toBeGreaterThanOrEqual(0);
      expect(state.phaseEnteredAt.length).toBeGreaterThan(0);
    });
  });

  describe("persistPlan / loadPlan", () => {
    it("persistPlan writes plan.json and plan.md", async () => {
      const dir = await newTempDir();
      const result = await persistPlan({
        goalId: "goal-1",
        version: 1,
        plan: makePlan(),
        workspacePath: dir,
      });

      expect(await stat(result.jsonPath)).toBeDefined();
      expect(await stat(result.mdPath)).toBeDefined();

      const json = await readFile(result.jsonPath, "utf8");
      const md = await readFile(result.mdPath, "utf8");
      expect(json).toContain("\"analysis\"");
      expect(md).toContain("# Plan: goal-1 (v1)");
      expect(md).toContain("## Tasks");
    });

    it("persistPlan archives previous json version", async () => {
      const dir = await newTempDir();

      await persistPlan({
        goalId: "goal-1",
        version: 1,
        plan: makePlan({ analysis: "first" }),
        workspacePath: dir,
      });

      await persistPlan({
        goalId: "goal-1",
        version: 2,
        plan: makePlan({ analysis: "second" }),
        workspacePath: dir,
      });

      const archived = await readFile(path.join(dir, "plan-v1.json"), "utf8");
      const latest = await readFile(path.join(dir, "plan.json"), "utf8");

      expect(archived).toContain("first");
      expect(latest).toContain("second");
    });

    it("persistPlan validates planner output", async () => {
      const dir = await newTempDir();
      await expect(persistPlan({
        goalId: "goal-1",
        version: 1,
        plan: {
          ...makePlan(),
          tasks: [
            {
              title: "bad",
              agentRole: "engineer",
              dependencies: [],
              estimatedCostCents: 10,
              priority: 1,
              timeoutMs: 1000,
            },
          ],
        } as unknown as PlannerOutput,
        workspacePath: dir,
      })).rejects.toThrow(/tasks\[0\]\.description must be a string/);
    });

    it("loadPlan reads and validates a plan json", async () => {
      const dir = await newTempDir();
      const { jsonPath } = await persistPlan({
        goalId: "goal-1",
        version: 1,
        plan: makePlan({ strategy: "Validated strategy" }),
        workspacePath: dir,
      });

      const plan = await loadPlan(jsonPath);
      expect(plan.strategy).toBe("Validated strategy");
      expect(plan.tasks).toHaveLength(1);
    });

    it("loadPlan throws on invalid JSON", async () => {
      const dir = await newTempDir();
      const filePath = path.join(dir, "bad-plan.json");
      await rm(filePath, { force: true }).catch(() => undefined);
      await writeFile(filePath, "{not-json}");

      await expect(loadPlan(filePath)).rejects.toThrow("Invalid plan JSON");
    });

    it("loadPlan throws on invalid plan shape", async () => {
      const dir = await newTempDir();
      const filePath = path.join(dir, "bad-shape.json");
      await writeFile(filePath, JSON.stringify({ analysis: "x", strategy: "y", tasks: [] }));

      await expect(loadPlan(filePath)).rejects.toThrow(/customRoles must be an array/);
    });
  });

  describe("reviewPlan", () => {
    const autoConfig: PlanApprovalConfig = {
      mode: "auto",
      autoBudgetThreshold: 5000,
      consensusCriticRole: "reviewer",
      reviewTimeoutMs: 10_000,
    };

    it("auto mode approves immediately under threshold", async () => {
      const result = await reviewPlan(makePlan({ estimatedTotalCostCents: 1200 }), autoConfig);
      expect(result).toEqual({ approved: true });
    });

    it("auto mode rejects above threshold with a safety feedback", async () => {
      const result = await reviewPlan(makePlan({ estimatedTotalCostCents: 9000 }), autoConfig);
      expect(result.approved).toBe(false);
      expect(result.feedback).toContain("Auto-rejected above budget threshold");
      expect(result.concerns).toEqual(["estimated_cost_exceeds_auto_budget_threshold"]);
    });

    it("supervised mode with no queue context provided fails loudly (visible error, not a silent stall)", async () => {
      const supervised: PlanApprovalConfig = { ...autoConfig, mode: "supervised" };
      await expect(reviewPlan(makePlan(), supervised)).rejects.toThrow("no queue context provided");
    });

    it("supervised mode: first review enqueues a real pending request and throws 'awaiting supervised approval'", async () => {
      const db = createInMemoryDb();
      const supervised: PlanApprovalConfig = { ...autoConfig, mode: "supervised", consensusCriticRole: "risk-analyst" };

      await expect(
        reviewPlan(makePlan(), supervised, undefined, { db, goalId: "goal-1", planVersion: 0 }),
      ).rejects.toThrow("awaiting supervised approval");

      const request = getApprovalRequest(db, "goal-1", 0);
      expect(request).not.toBeNull();
      expect(request!.status).toBe("pending");
      expect(request!.criticRole).toBe("risk-analyst");
    });

    it("supervised mode: re-reviewing the SAME plan version doesn't create a second queue entry", async () => {
      const db = createInMemoryDb();
      const supervised: PlanApprovalConfig = { ...autoConfig, mode: "supervised" };
      const context = { db, goalId: "goal-1", planVersion: 0 };

      await expect(reviewPlan(makePlan(), supervised, undefined, context)).rejects.toThrow();
      await expect(reviewPlan(makePlan(), supervised, undefined, context)).rejects.toThrow();

      const allRows = db.prepare("SELECT COUNT(*) as n FROM plan_approvals WHERE goal_id = ?").get("goal-1") as {
        n: number;
      };
      expect(allRows.n).toBe(1);
    });

    it("supervised mode: once resolved (approved), the next review call returns the real outcome instead of throwing again", async () => {
      const db = createInMemoryDb();
      const supervised: PlanApprovalConfig = { ...autoConfig, mode: "supervised" };
      const context = { db, goalId: "goal-1", planVersion: 0 };

      await expect(reviewPlan(makePlan(), supervised, undefined, context)).rejects.toThrow();

      const fakeInference = {
        chat: async () => makeChatResult(JSON.stringify({ approved: true, concerns: [], feedback: "Looks solid." })),
      } as unknown as UnifiedInferenceClient;
      await resolveSupervisedApprovals(db, fakeInference);

      const result = await reviewPlan(makePlan(), supervised, undefined, context);
      expect(result.approved).toBe(true);
      expect(result.feedback).toBe("Looks solid.");
    });

    it("supervised mode: once resolved (rejected), the next review call returns rejected with concerns", async () => {
      const db = createInMemoryDb();
      const supervised: PlanApprovalConfig = { ...autoConfig, mode: "supervised" };
      const context = { db, goalId: "goal-1", planVersion: 0 };

      await expect(reviewPlan(makePlan(), supervised, undefined, context)).rejects.toThrow();

      const fakeInference = {
        chat: async () =>
          makeChatResult(
            JSON.stringify({ approved: false, concerns: ["Budget estimate is unrealistic"], feedback: "Not sound." }),
          ),
      } as unknown as UnifiedInferenceClient;
      await resolveSupervisedApprovals(db, fakeInference);

      const result = await reviewPlan(makePlan(), supervised, undefined, context);
      expect(result.approved).toBe(false);
      expect(result.concerns).toEqual(["Budget estimate is unrealistic"]);
    });

    it("a replan (new plan version) gets its own independent queue entry", async () => {
      const db = createInMemoryDb();
      const supervised: PlanApprovalConfig = { ...autoConfig, mode: "supervised" };

      await expect(
        reviewPlan(makePlan(), supervised, undefined, { db, goalId: "goal-1", planVersion: 0 }),
      ).rejects.toThrow();
      await expect(
        reviewPlan(makePlan(), supervised, undefined, { db, goalId: "goal-1", planVersion: 1 }),
      ).rejects.toThrow();

      const allRows = db.prepare("SELECT COUNT(*) as n FROM plan_approvals WHERE goal_id = ?").get("goal-1") as {
        n: number;
      };
      expect(allRows.n).toBe(2);
    });

    describe("resolveSupervisedApprovals (the autonomous resolver — no human involved anywhere)", () => {
      it("drains multiple pending requests in one pass", async () => {
        const db = createInMemoryDb();
        const supervised: PlanApprovalConfig = { ...autoConfig, mode: "supervised" };
        for (let v = 0; v < 3; v++) {
          await expect(
            reviewPlan(makePlan(), supervised, undefined, { db, goalId: "goal-1", planVersion: v }),
          ).rejects.toThrow();
        }

        const fakeInference = {
          chat: async () => makeChatResult(JSON.stringify({ approved: true, concerns: [], feedback: "fine" })),
        } as unknown as UnifiedInferenceClient;
        const result = await resolveSupervisedApprovals(db, fakeInference);

        expect(result.approved).toBe(3);
        expect(result.rejected).toBe(0);
        expect(getPendingApprovalRequests(db)).toEqual([]);
      });

      it("is a no-op when the queue is empty", async () => {
        const db = createInMemoryDb();
        const fakeInference = { chat: async () => makeChatResult("{}") } as unknown as UnifiedInferenceClient;
        const result = await resolveSupervisedApprovals(db, fakeInference);
        expect(result).toEqual({ approved: 0, rejected: 0, stillPending: 0 });
      });

      it("leaves a request pending (not silently approved) when the critic call fails for that one request", async () => {
        const db = createInMemoryDb();
        const supervised: PlanApprovalConfig = { ...autoConfig, mode: "supervised" };
        await expect(
          reviewPlan(makePlan(), supervised, undefined, { db, goalId: "goal-1", planVersion: 0 }),
        ).rejects.toThrow();

        const fakeInference = {
          chat: async () => {
            throw new Error("provider down");
          },
        } as unknown as UnifiedInferenceClient;
        const result = await resolveSupervisedApprovals(db, fakeInference);

        expect(result.stillPending).toBe(1);
        expect(getApprovalRequest(db, "goal-1", 0)!.status).toBe("pending");
      });

      it("a failed request stays resolvable on a later pass once the critic succeeds", async () => {
        const db = createInMemoryDb();
        const supervised: PlanApprovalConfig = { ...autoConfig, mode: "supervised" };
        await expect(
          reviewPlan(makePlan(), supervised, undefined, { db, goalId: "goal-1", planVersion: 0 }),
        ).rejects.toThrow();

        const failingInference = {
          chat: async () => {
            throw new Error("provider down");
          },
        } as unknown as UnifiedInferenceClient;
        await resolveSupervisedApprovals(db, failingInference);

        const workingInference = {
          chat: async () => makeChatResult(JSON.stringify({ approved: true, concerns: [], feedback: "recovered" })),
        } as unknown as UnifiedInferenceClient;
        const secondPass = await resolveSupervisedApprovals(db, workingInference);

        expect(secondPass.approved).toBe(1);
        expect(getApprovalRequest(db, "goal-1", 0)!.status).toBe("approved");
      });

      it("resolving one goal's request doesn't touch another goal's still-pending request", async () => {
        const db = createInMemoryDb();
        const supervised: PlanApprovalConfig = { ...autoConfig, mode: "supervised" };
        await expect(
          reviewPlan(makePlan(), supervised, undefined, { db, goalId: "goal-A", planVersion: 0 }),
        ).rejects.toThrow();
        await expect(
          reviewPlan(makePlan(), supervised, undefined, { db, goalId: "goal-B", planVersion: 0 }),
        ).rejects.toThrow();

        let callCount = 0;
        const fakeInference = {
          chat: async () => {
            callCount += 1;
            // Only the first call (goal-A, oldest first) succeeds.
            if (callCount === 1) return makeChatResult(JSON.stringify({ approved: true, concerns: [], feedback: "ok" }));
            throw new Error("provider down");
          },
        } as unknown as UnifiedInferenceClient;
        await resolveSupervisedApprovals(db, fakeInference);

        expect(getApprovalRequest(db, "goal-A", 0)!.status).toBe("approved");
        expect(getApprovalRequest(db, "goal-B", 0)!.status).toBe("pending");
      });
    });

    it("consensus mode: a real critic approval is returned as-is, with concerns", async () => {
      const fakeInference = {
        chat: async () =>
          makeChatResult(
            JSON.stringify({ approved: true, concerns: [], feedback: "Plan is well-structured and risks are addressed." }),
          ),
      } as unknown as UnifiedInferenceClient;

      const consensus: PlanApprovalConfig = { ...autoConfig, mode: "consensus", consensusCriticRole: "critic" };
      const result = await reviewPlan(makePlan(), consensus, fakeInference);

      expect(result.approved).toBe(true);
      expect(result.feedback).toContain("well-structured");
      expect(result.concerns).toEqual([]);
    });

    it("consensus mode: a real critic rejection is returned with its concerns", async () => {
      const fakeInference = {
        chat: async () =>
          makeChatResult(
            JSON.stringify({
              approved: false,
              concerns: ["Task 3 depends on task 7, which does not exist", "No task addresses the stated compliance risk"],
              feedback: "Plan has unresolved dependency and risk-coverage issues.",
            }),
          ),
      } as unknown as UnifiedInferenceClient;

      const consensus: PlanApprovalConfig = { ...autoConfig, mode: "consensus", consensusCriticRole: "critic" };
      const result = await reviewPlan(makePlan(), consensus, fakeInference);

      expect(result.approved).toBe(false);
      expect(result.concerns).toEqual([
        "Task 3 depends on task 7, which does not exist",
        "No task addresses the stated compliance risk",
      ]);
      expect(result.feedback).toContain("unresolved dependency");
    });

    it("consensus mode: fails CLOSED (not approved) on a malformed/unparseable critic response", async () => {
      const fakeInference = {
        chat: async () => makeChatResult("this is not json at all"),
      } as unknown as UnifiedInferenceClient;

      const consensus: PlanApprovalConfig = { ...autoConfig, mode: "consensus" };
      const result = await reviewPlan(makePlan(), consensus, fakeInference);

      expect(result.approved).toBe(false);
      expect(result.feedback).toContain("unparseable");
    });

    it("consensus mode: fails CLOSED on a response missing the required 'approved' boolean", async () => {
      const fakeInference = {
        chat: async () => makeChatResult(JSON.stringify({ feedback: "looks fine" })), // no `approved` field
      } as unknown as UnifiedInferenceClient;

      const consensus: PlanApprovalConfig = { ...autoConfig, mode: "consensus" };
      const result = await reviewPlan(makePlan(), consensus, fakeInference);

      expect(result.approved).toBe(false);
    });

    it("consensus mode: fails CLOSED when the inference call itself throws", async () => {
      const fakeInference = {
        chat: async () => {
          throw new Error("provider unavailable");
        },
      } as unknown as UnifiedInferenceClient;

      const consensus: PlanApprovalConfig = { ...autoConfig, mode: "consensus" };
      const result = await reviewPlan(makePlan(), consensus, fakeInference);

      expect(result.approved).toBe(false);
      expect(result.feedback).toContain("provider unavailable");
    });

    it("consensus mode: fails CLOSED when the critic call exceeds the configured timeout", async () => {
      const fakeInference = {
        chat: () => new Promise(() => {}), // never resolves
      } as unknown as UnifiedInferenceClient;

      const consensus: PlanApprovalConfig = { ...autoConfig, mode: "consensus", reviewTimeoutMs: 50 };
      const result = await reviewPlan(makePlan(), consensus, fakeInference);

      expect(result.approved).toBe(false);
      expect(result.feedback).toContain("timed out");
    });

    it("consensus mode: fails CLOSED (not the old stub's auto-approve) when no inference client is provided at all", async () => {
      const consensus: PlanApprovalConfig = { ...autoConfig, mode: "consensus", consensusCriticRole: "critic" };
      const result = await reviewPlan(makePlan(), consensus); // no third argument

      expect(result.approved).toBe(false);
      expect(result.feedback).toContain("real independent review");
    });

    it("consensus mode: the critic prompt actually includes the plan's real content", async () => {
      let capturedUserMessage = "";
      const fakeInference = {
        chat: async (params: any) => {
          capturedUserMessage = params.messages.find((m: any) => m.role === "user")?.content ?? "";
          return makeChatResult(JSON.stringify({ approved: true, concerns: [], feedback: "fine" }));
        },
      } as unknown as UnifiedInferenceClient;

      const plan = makePlan({ estimatedTotalCostCents: 4242 });
      const consensus: PlanApprovalConfig = { ...autoConfig, mode: "consensus" };
      await reviewPlan(plan, consensus, fakeInference);

      expect(capturedUserMessage).toContain("4242");
    });

    it("consensus mode: falls back to a default feedback string when the critic omits one", async () => {
      const fakeInference = {
        chat: async () => makeChatResult(JSON.stringify({ approved: true })), // no feedback field
      } as unknown as UnifiedInferenceClient;

      const consensus: PlanApprovalConfig = { ...autoConfig, mode: "consensus" };
      const result = await reviewPlan(makePlan(), consensus, fakeInference);

      expect(result.approved).toBe(true);
      expect(result.feedback).toBeTruthy();
    });

    it("normalizes invalid config values", async () => {
      // autoBudgetThreshold: NaN normalizes to the real default (5_000
      // cents). The plan's cost (99999) is deliberately far above that
      // default, so normalization should still produce a *rejection* —
      // this test's job is to prove NaN fell back to 5000 rather than,
      // say, 0 or Infinity, and the rejection feedback naming "5000" is
      // exactly that proof. (Previously this asserted `approved: true`,
      // which could never happen once the threshold fell back to a real
      // number below the plan's cost — that expectation was simply
      // wrong, not a product bug.)
      const result = await reviewPlan(makePlan({ estimatedTotalCostCents: 99999 }), {
        mode: "unknown" as unknown as "auto",
        autoBudgetThreshold: Number.NaN,
        consensusCriticRole: "   ",
        reviewTimeoutMs: Number.NaN,
      });

      expect(result.approved).toBe(false);
      expect(result.feedback).toContain("5000");
      expect(result.feedback).toContain("99999");
    });
  });

  describe("shouldReplan", () => {
    it("returns false when no replans remain", () => {
      const state = baseState({ replansRemaining: 0 });
      expect(shouldReplan(state, { type: "task_failure", taskId: "t1", error: "boom" })).toBe(false);
    });

    it("task_failure requires taskId and error", () => {
      const state = baseState();
      expect(shouldReplan(state, { type: "task_failure", taskId: "t1", error: "boom" })).toBe(true);
      expect(shouldReplan(state, { type: "task_failure", taskId: "", error: "boom" })).toBe(false);
      expect(shouldReplan(state, { type: "task_failure", taskId: "t1", error: "  " })).toBe(false);
    });

    it("budget_breach uses 1.5x threshold", () => {
      const state = baseState();
      expect(shouldReplan(state, { type: "budget_breach", estimatedCents: 100, actualCents: 151 })).toBe(true);
      expect(shouldReplan(state, { type: "budget_breach", estimatedCents: 100, actualCents: 150 })).toBe(false);
    });

    it("budget_breach with non-positive estimate checks actual > 0", () => {
      const state = baseState();
      expect(shouldReplan(state, { type: "budget_breach", estimatedCents: 0, actualCents: 1 })).toBe(true);
      expect(shouldReplan(state, { type: "budget_breach", estimatedCents: -100, actualCents: 0 })).toBe(false);
    });

    it("requirement_change needs conflictScore >= 0.55", () => {
      const state = baseState();
      expect(shouldReplan(state, { type: "requirement_change", newInput: "x", conflictScore: 0.55 })).toBe(true);
      expect(shouldReplan(state, { type: "requirement_change", newInput: "x", conflictScore: 0.54 })).toBe(false);
    });

    it("environment_change requires non-empty fields", () => {
      const state = baseState();
      expect(shouldReplan(state, { type: "environment_change", resource: "db", error: "down" })).toBe(true);
      expect(shouldReplan(state, { type: "environment_change", resource: "", error: "down" })).toBe(false);
      expect(shouldReplan(state, { type: "environment_change", resource: "db", error: " " })).toBe(false);
    });

    it("opportunity requires enough replans and long suggestion", () => {
      expect(shouldReplan(
        baseState({ replansRemaining: 2 }),
        { type: "opportunity", suggestion: "This opportunity is long enough to justify a replan", agentAddress: "0x1" },
      )).toBe(true);

      expect(shouldReplan(
        baseState({ replansRemaining: 1 }),
        { type: "opportunity", suggestion: "This opportunity is long enough to justify a replan", agentAddress: "0x1" },
      )).toBe(false);

      expect(shouldReplan(
        baseState({ replansRemaining: 3 }),
        { type: "opportunity", suggestion: "too short", agentAddress: "0x1" },
      )).toBe(false);
    });
  });
});
