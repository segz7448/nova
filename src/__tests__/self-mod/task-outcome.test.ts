import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createInMemoryDb } from "../orchestration/test-db.js";
import { recordTaskOutcomeForActiveSkills, rawKVStore } from "../../self-mod/task-outcome.js";
import { getScore } from "../../self-mod/scoring.js";

function seedSkill(
  db: ReturnType<typeof createInMemoryDb>,
  opts: { name: string; path: string; enabled: boolean; autoActivate: boolean },
): void {
  db.prepare(
    `INSERT INTO skills (name, description, auto_activate, requires, instructions, source, path, enabled, installed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.name,
    "test skill",
    opts.autoActivate ? 1 : 0,
    "{}",
    "do the thing",
    "self",
    opts.path,
    opts.enabled ? 1 : 0,
    new Date().toISOString(),
  );
}

function withScopeManifest(fn: (repoPath: string) => void): void {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "task-outcome-"));
  try {
    fs.mkdirSync(path.join(repoPath, "self-mod"), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, "self-mod", "scope.json"),
      JSON.stringify({ ownedGlobs: ["skills/distribution-agent/**"] }),
    );
    fn(repoPath);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

describe("recordTaskOutcomeForActiveSkills", () => {
  it("records a success for an active, enabled, scoped-owned skill", () => {
    withScopeManifest((repoPath) => {
      const db = createInMemoryDb();
      seedSkill(db, {
        name: "negotiate",
        path: "skills/distribution-agent/negotiate.ts",
        enabled: true,
        autoActivate: true,
      });

      recordTaskOutcomeForActiveSkills(db, repoPath, true);

      expect(getScore(rawKVStore(db), "skills/distribution-agent/negotiate.ts")).toEqual({ success: 1, failure: 0 });
    });
  });

  it("records a failure for an active, enabled, scoped-owned skill", () => {
    withScopeManifest((repoPath) => {
      const db = createInMemoryDb();
      seedSkill(db, {
        name: "negotiate",
        path: "skills/distribution-agent/negotiate.ts",
        enabled: true,
        autoActivate: true,
      });

      recordTaskOutcomeForActiveSkills(db, repoPath, false);

      expect(getScore(rawKVStore(db), "skills/distribution-agent/negotiate.ts")).toEqual({ success: 0, failure: 1 });
    });
  });

  it("never records anything for a disabled skill", () => {
    withScopeManifest((repoPath) => {
      const db = createInMemoryDb();
      seedSkill(db, {
        name: "negotiate",
        path: "skills/distribution-agent/negotiate.ts",
        enabled: false,
        autoActivate: true,
      });

      recordTaskOutcomeForActiveSkills(db, repoPath, true);

      expect(getScore(rawKVStore(db), "skills/distribution-agent/negotiate.ts")).toEqual({ success: 0, failure: 0 });
    });
  });

  it("never records anything for a skill that isn't auto-activate", () => {
    withScopeManifest((repoPath) => {
      const db = createInMemoryDb();
      seedSkill(db, {
        name: "negotiate",
        path: "skills/distribution-agent/negotiate.ts",
        enabled: true,
        autoActivate: false,
      });

      recordTaskOutcomeForActiveSkills(db, repoPath, true);

      expect(getScore(rawKVStore(db), "skills/distribution-agent/negotiate.ts")).toEqual({ success: 0, failure: 0 });
    });
  });

  it("never records anything for a core (non-skills/) file, even if somehow present in the skills table", () => {
    withScopeManifest((repoPath) => {
      const db = createInMemoryDb();
      seedSkill(db, { name: "weird", path: "src/backend/client.ts", enabled: true, autoActivate: true });

      recordTaskOutcomeForActiveSkills(db, repoPath, true);

      expect(getScore(rawKVStore(db), "src/backend/client.ts")).toEqual({ success: 0, failure: 0 });
    });
  });

  it("never records anything for another agent's scoped skill", () => {
    withScopeManifest((repoPath) => {
      const db = createInMemoryDb();
      seedSkill(db, { name: "pitch", path: "skills/sales-agent/pitch.ts", enabled: true, autoActivate: true });

      recordTaskOutcomeForActiveSkills(db, repoPath, true);

      expect(getScore(rawKVStore(db), "skills/sales-agent/pitch.ts")).toEqual({ success: 0, failure: 0 });
    });
  });

  it("splits credit/blame across every currently active scoped-owned skill, not just one", () => {
    withScopeManifest((repoPath) => {
      const db = createInMemoryDb();
      seedSkill(db, { name: "negotiate", path: "skills/distribution-agent/negotiate.ts", enabled: true, autoActivate: true });
      seedSkill(db, { name: "pricing", path: "skills/distribution-agent/pricing.ts", enabled: true, autoActivate: true });

      recordTaskOutcomeForActiveSkills(db, repoPath, true);

      expect(getScore(rawKVStore(db), "skills/distribution-agent/negotiate.ts")).toEqual({ success: 1, failure: 0 });
      expect(getScore(rawKVStore(db), "skills/distribution-agent/pricing.ts")).toEqual({ success: 1, failure: 0 });
    });
  });

  it("accumulates across repeated calls (multiple tasks over time)", () => {
    withScopeManifest((repoPath) => {
      const db = createInMemoryDb();
      seedSkill(db, { name: "negotiate", path: "skills/distribution-agent/negotiate.ts", enabled: true, autoActivate: true });

      recordTaskOutcomeForActiveSkills(db, repoPath, true);
      recordTaskOutcomeForActiveSkills(db, repoPath, true);
      recordTaskOutcomeForActiveSkills(db, repoPath, false);

      expect(getScore(rawKVStore(db), "skills/distribution-agent/negotiate.ts")).toEqual({ success: 2, failure: 1 });
    });
  });

  it("never throws even with a missing scope.json (falls back to default) or an empty skills table", () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "task-outcome-empty-"));
    try {
      const db = createInMemoryDb();
      expect(() => recordTaskOutcomeForActiveSkills(db, repoPath, true)).not.toThrow();
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
