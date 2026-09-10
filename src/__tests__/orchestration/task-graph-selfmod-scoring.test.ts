import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { completeTask, createGoal, failTask, type TaskResult } from "../../orchestration/task-graph.js";
import { insertTask } from "../../state/database.js";
import { createInMemoryDb } from "../orchestration/test-db.js";
import { rawKVStore } from "../../self-mod/task-outcome.js";
import { getScore, getRecentFailureReasons } from "../../self-mod/scoring.js";

const SUCCESS_RESULT: TaskResult = { success: true, output: "done", artifacts: [], costCents: 10, duration: 100 };

describe("end-to-end: completeTask()/failTask() actually record self-mod scores", () => {
  it("completeTask() records a success for an active scoped-owned skill, through the real orchestration function", () => {
    const originalCwd = process.cwd();
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "task-graph-e2e-"));
    try {
      fs.mkdirSync(path.join(repoPath, "self-mod"), { recursive: true });
      fs.writeFileSync(
        path.join(repoPath, "self-mod", "scope.json"),
        JSON.stringify({ ownedGlobs: ["skills/distribution-agent/**"] }),
      );
      process.chdir(repoPath);

      const db = createInMemoryDb();
      db.prepare(
        `INSERT INTO skills (name, description, auto_activate, requires, instructions, source, path, enabled, installed_at)
         VALUES ('negotiate', 'd', 1, '{}', 'do it', 'self', 'skills/distribution-agent/negotiate.ts', 1, ?)`,
      ).run(new Date().toISOString());

      const goal = createGoal(db, "Close the deal", "Negotiate a better rate");
      const taskId = insertTask(db, { goalId: goal.id, title: "task", description: "desc", status: "running" });

      completeTask(db, taskId, SUCCESS_RESULT);

      expect(getScore(rawKVStore(db), "skills/distribution-agent/negotiate.ts")).toEqual({ success: 1, failure: 0 });
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("failTask() (terminal, no retry) records a failure through the real orchestration function", () => {
    const originalCwd = process.cwd();
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "task-graph-e2e-fail-"));
    try {
      fs.mkdirSync(path.join(repoPath, "self-mod"), { recursive: true });
      fs.writeFileSync(
        path.join(repoPath, "self-mod", "scope.json"),
        JSON.stringify({ ownedGlobs: ["skills/distribution-agent/**"] }),
      );
      process.chdir(repoPath);

      const db = createInMemoryDb();
      db.prepare(
        `INSERT INTO skills (name, description, auto_activate, requires, instructions, source, path, enabled, installed_at)
         VALUES ('negotiate', 'd', 1, '{}', 'do it', 'self', 'skills/distribution-agent/negotiate.ts', 1, ?)`,
      ).run(new Date().toISOString());

      const goal = createGoal(db, "Close the deal", "Negotiate a better rate");
      const taskId = insertTask(db, {
        goalId: goal.id,
        title: "task",
        description: "desc",
        status: "running",
        maxRetries: 0,
      });

      failTask(db, taskId, "negotiation fell through", false);

      expect(getScore(rawKVStore(db), "skills/distribution-agent/negotiate.ts")).toEqual({ success: 0, failure: 1 });
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("failTask() with a retry still records the failed attempt (each attempt is real evidence, not just the terminal one)", () => {
    const originalCwd = process.cwd();
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "task-graph-e2e-retry-"));
    try {
      fs.mkdirSync(path.join(repoPath, "self-mod"), { recursive: true });
      fs.writeFileSync(
        path.join(repoPath, "self-mod", "scope.json"),
        JSON.stringify({ ownedGlobs: ["skills/distribution-agent/**"] }),
      );
      process.chdir(repoPath);

      const db = createInMemoryDb();
      db.prepare(
        `INSERT INTO skills (name, description, auto_activate, requires, instructions, source, path, enabled, installed_at)
         VALUES ('negotiate', 'd', 1, '{}', 'do it', 'self', 'skills/distribution-agent/negotiate.ts', 1, ?)`,
      ).run(new Date().toISOString());

      const goal = createGoal(db, "Close the deal", "Negotiate a better rate");
      const taskId = insertTask(db, {
        goalId: goal.id,
        title: "task",
        description: "desc",
        status: "running",
        maxRetries: 3,
      });

      failTask(db, taskId, "transient error", true); // will retry, not terminal

      expect(getScore(rawKVStore(db), "skills/distribution-agent/negotiate.ts")).toEqual({ success: 0, failure: 1 });
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("never breaks task completion even with no scope.json / no skills at all present", () => {
    const originalCwd = process.cwd();
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "task-graph-e2e-bare-"));
    try {
      process.chdir(repoPath); // no self-mod/scope.json here at all
      const db = createInMemoryDb();
      const goal = createGoal(db, "Goal", "Desc");
      const taskId = insertTask(db, { goalId: goal.id, title: "task", description: "desc", status: "running" });

      expect(() => completeTask(db, taskId, SUCCESS_RESULT)).not.toThrow();
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("failTask()'s real error message is recorded and retrievable as a failure reason for the file", () => {
    const originalCwd = process.cwd();
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "task-graph-e2e-reason-"));
    try {
      fs.mkdirSync(path.join(repoPath, "self-mod"), { recursive: true });
      fs.writeFileSync(
        path.join(repoPath, "self-mod", "scope.json"),
        JSON.stringify({ ownedGlobs: ["skills/distribution-agent/**"] }),
      );
      process.chdir(repoPath);

      const db = createInMemoryDb();
      db.prepare(
        `INSERT INTO skills (name, description, auto_activate, requires, instructions, source, path, enabled, installed_at)
         VALUES ('negotiate', 'd', 1, '{}', 'do it', 'self', 'skills/distribution-agent/negotiate.ts', 1, ?)`,
      ).run(new Date().toISOString());

      const goal = createGoal(db, "Close the deal", "Negotiate a better rate");
      const taskId = insertTask(db, {
        goalId: goal.id,
        title: "task",
        description: "desc",
        status: "running",
        maxRetries: 0,
      });

      failTask(db, taskId, "Client rejected the counter-offer: too aggressive a first move", false);

      expect(getRecentFailureReasons(rawKVStore(db), "skills/distribution-agent/negotiate.ts")).toEqual([
        "Client rejected the counter-offer: too aggressive a first move",
      ]);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("accumulates real failure reasons across repeated failures, up to the auto-revert threshold", () => {
    const originalCwd = process.cwd();
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "task-graph-e2e-reasons-multi-"));
    try {
      fs.mkdirSync(path.join(repoPath, "self-mod"), { recursive: true });
      fs.writeFileSync(
        path.join(repoPath, "self-mod", "scope.json"),
        JSON.stringify({ ownedGlobs: ["skills/distribution-agent/**"] }),
      );
      process.chdir(repoPath);

      const db = createInMemoryDb();
      db.prepare(
        `INSERT INTO skills (name, description, auto_activate, requires, instructions, source, path, enabled, installed_at)
         VALUES ('negotiate', 'd', 1, '{}', 'do it', 'self', 'skills/distribution-agent/negotiate.ts', 1, ?)`,
      ).run(new Date().toISOString());

      const goal = createGoal(db, "Close the deal", "Negotiate a better rate");
      const reasons = ["Client walked away", "Offer expired before response", "Counter-offer rejected outright"];
      let flaggedForRevert: string[] = [];
      for (const reason of reasons) {
        const taskId = insertTask(db, {
          goalId: goal.id,
          title: "task",
          description: "desc",
          status: "running",
          maxRetries: 0,
        });
        flaggedForRevert = failTask(db, taskId, reason, false);
      }

      expect(getRecentFailureReasons(rawKVStore(db), "skills/distribution-agent/negotiate.ts")).toEqual(reasons);
      expect(flaggedForRevert).toEqual(["skills/distribution-agent/negotiate.ts"]); // 3rd failure crosses the threshold
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
