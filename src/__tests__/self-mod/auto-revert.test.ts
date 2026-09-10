import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { performAutoRevert, applyFlaggedAutoReverts, rawKVStore } from "../../self-mod/task-outcome.js";
import { recordOutcome, getScore } from "../../self-mod/scoring.js";
import { createInMemoryDb } from "../orchestration/test-db.js";
import { makeGitFixture, writeAndCommit } from "./test-helpers.js";

describe("performAutoRevert", () => {
  it("restores a file's content from right before its last self-mod, when it existed before", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      const file = "skills/distribution-agent/negotiate.ts";
      await writeAndCommit(backend, repoPath, file, "v1 - original, working version", "initial");
      await writeAndCommit(backend, repoPath, file, "v2 - bad self-mod", "self-mod: tried a new tactic");

      const db = createInMemoryDb();
      recordOutcome(rawKVStore(db), file, false);
      recordOutcome(rawKVStore(db), file, false);
      recordOutcome(rawKVStore(db), file, false);

      const result = await performAutoRevert(backend, db, repoPath, file, "clearly worse");

      expect(result.reverted).toBe(true);
      expect(fs.readFileSync(path.join(repoPath, file), "utf8")).toBe("v1 - original, working version");
    } finally {
      await cleanup();
    }
  });

  it("resets the file's score after a successful revert", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      const file = "skills/distribution-agent/negotiate.ts";
      await writeAndCommit(backend, repoPath, file, "v1", "initial");
      await writeAndCommit(backend, repoPath, file, "v2 - bad", "self-mod");

      const db = createInMemoryDb();
      recordOutcome(rawKVStore(db), file, false);
      recordOutcome(rawKVStore(db), file, false);
      recordOutcome(rawKVStore(db), file, false);

      await performAutoRevert(backend, db, repoPath, file, "clearly worse");

      expect(getScore(rawKVStore(db), file)).toEqual({ success: 0, failure: 0 });
    } finally {
      await cleanup();
    }
  });

  it("logs a code_revert modification entry", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      const file = "skills/distribution-agent/negotiate.ts";
      await writeAndCommit(backend, repoPath, file, "v1", "initial");
      await writeAndCommit(backend, repoPath, file, "v2 - bad", "self-mod");

      const db = createInMemoryDb();
      await performAutoRevert(backend, db, repoPath, file, "clearly worse");

      const rows = db.prepare("SELECT * FROM modifications WHERE type = 'code_revert'").all() as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].file_path).toBe(file);
      expect(rows[0].description).toContain(file);
    } finally {
      await cleanup();
    }
  });

  it("removes the file entirely when the self-mod WAS its creation (no prior version to restore)", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      const file = "skills/distribution-agent/brand-new-bad-skill.ts";
      await writeAndCommit(backend, repoPath, "README.md", "initial repo", "initial");
      await writeAndCommit(backend, repoPath, file, "v1 - a brand new skill that turns out to be bad", "self-mod: new skill");

      const db = createInMemoryDb();
      const result = await performAutoRevert(backend, db, repoPath, file, "clearly worse");

      expect(result.reverted).toBe(true);
      expect(fs.existsSync(path.join(repoPath, file))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("does nothing and reports not-reverted when the file has no git history at all", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      await writeAndCommit(backend, repoPath, "README.md", "initial", "initial");
      const db = createInMemoryDb();

      const result = await performAutoRevert(backend, db, repoPath, "skills/distribution-agent/never-committed.ts", "clearly worse");

      expect(result.reverted).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("does not modify unrelated files in the same repo", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      const target = "skills/distribution-agent/negotiate.ts";
      const other = "skills/distribution-agent/pricing.ts";
      await writeAndCommit(backend, repoPath, target, "v1", "initial target");
      await writeAndCommit(backend, repoPath, other, "pricing v1 - unrelated", "initial other");
      await writeAndCommit(backend, repoPath, target, "v2 - bad", "self-mod on target only");

      const db = createInMemoryDb();
      await performAutoRevert(backend, db, repoPath, target, "clearly worse");

      expect(fs.readFileSync(path.join(repoPath, other), "utf8")).toBe("pricing v1 - unrelated");
    } finally {
      await cleanup();
    }
  });

  it("triggers a rebuild for a .ts file but never throws even if the rebuild has no npm script configured", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      const file = "skills/distribution-agent/negotiate.ts";
      await writeAndCommit(backend, repoPath, file, "v1", "initial");
      await writeAndCommit(backend, repoPath, file, "v2 - bad", "self-mod");
      // No package.json in this fixture at all — "npm run build" will fail; performAutoRevert must not throw regardless.

      const db = createInMemoryDb();
      const result = await performAutoRevert(backend, db, repoPath, file, "clearly worse");

      expect(result.reverted).toBe(true); // the revert itself still succeeds
    } finally {
      await cleanup();
    }
  });

  it("stores the caller-provided detail in the audit log's diff field, separate from the short git-commit reason", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      const file = "skills/distribution-agent/negotiate.ts";
      await writeAndCommit(backend, repoPath, file, "v1", "initial");
      await writeAndCommit(backend, repoPath, file, "v2 - bad", "self-mod");

      const db = createInMemoryDb();
      await performAutoRevert(
        backend,
        db,
        repoPath,
        file,
        "3 repeated failures",
        "1. Client walked away\n2. Offer expired\n3. Counter-offer rejected outright",
      );

      const rows = db.prepare("SELECT * FROM modifications WHERE type = 'code_revert'").all() as any[];
      expect(rows[0].description).toContain("3 repeated failures");
      expect(rows[0].diff).toBe("1. Client walked away\n2. Offer expired\n3. Counter-offer rejected outright");
    } finally {
      await cleanup();
    }
  });

  it("applyFlaggedAutoReverts builds a real reason from recorded failure messages, not a generic placeholder", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      const file = "skills/distribution-agent/negotiate.ts";
      await writeAndCommit(backend, repoPath, file, "v1 - working version", "initial");
      await writeAndCommit(backend, repoPath, file, "v2 - bad self-mod", "self-mod");

      const db = createInMemoryDb();
      const kv = rawKVStore(db);
      recordOutcome(kv, file, false, "Client rejected the counter-offer");
      recordOutcome(kv, file, false, "Deal fell through at the last minute");
      recordOutcome(kv, file, false, "Client went with a competitor instead");

      const logs: { level: string; msg: string; ctx?: any }[] = [];
      const logger = {
        warn: (msg: string, ctx?: any) => logs.push({ level: "warn", msg, ctx }),
        info: (msg: string, ctx?: any) => logs.push({ level: "info", msg, ctx }),
      };

      await applyFlaggedAutoReverts(backend, db, repoPath, [file], logger);

      const rows = db.prepare("SELECT * FROM modifications WHERE type = 'code_revert'").all() as any[];
      expect(rows[0].description).toContain("Client went with a competitor instead"); // most recent, in the short summary
      expect(rows[0].diff).toContain("Client rejected the counter-offer");
      expect(rows[0].diff).toContain("Deal fell through at the last minute");
      expect(rows[0].diff).toContain("Client went with a competitor instead");

      const warnLog = logs.find((l) => l.level === "warn");
      expect(warnLog?.ctx?.reasons).toEqual([
        "Client rejected the counter-offer",
        "Deal fell through at the last minute",
        "Client went with a competitor instead",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("applyFlaggedAutoReverts falls back to a generic reason when no individual reasons were ever recorded", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      const file = "skills/distribution-agent/negotiate.ts";
      await writeAndCommit(backend, repoPath, file, "v1", "initial");
      await writeAndCommit(backend, repoPath, file, "v2 - bad", "self-mod");

      const db = createInMemoryDb();
      // No recordOutcome calls at all — simulates a file flagged with no stored reasons.
      const logger = { warn: () => {}, info: () => {} };

      await applyFlaggedAutoReverts(backend, db, repoPath, [file], logger);

      const rows = db.prepare("SELECT * FROM modifications WHERE type = 'code_revert'").all() as any[];
      expect(rows[0].description).toContain("repeated task failures");
      expect(rows[0].diff).toContain("No individual failure reasons were recorded");
    } finally {
      await cleanup();
    }
  });

  it("end-to-end: a real failure message recorded via recordOutcome survives all the way to git and the audit log", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      const file = "skills/distribution-agent/negotiate.ts";
      await writeAndCommit(backend, repoPath, file, "v1 - the version that actually worked", "initial");
      await writeAndCommit(backend, repoPath, file, "v2 - the self-mod that made things worse", "self-mod: new tactic");

      const db = createInMemoryDb();
      const kv = rawKVStore(db);
      recordOutcome(kv, file, false, "Negotiation partner walked out of the call");
      recordOutcome(kv, file, false, "Negotiation partner walked out of the call");
      recordOutcome(kv, file, false, "Negotiation partner walked out of the call");

      const logger = { warn: () => {}, info: () => {} };
      await applyFlaggedAutoReverts(backend, db, repoPath, [file], logger);

      // The file itself is really reverted.
      expect(fs.readFileSync(path.join(repoPath, file), "utf8")).toBe("v1 - the version that actually worked");

      // The real reason is really in the audit log.
      const rows = db.prepare("SELECT * FROM modifications WHERE type = 'code_revert'").all() as any[];
      expect(rows[0].diff).toContain("Negotiation partner walked out of the call");

      // And the score is reset for the restored version.
      expect(getScore(kv, file)).toEqual({ success: 0, failure: 0 });
    } finally {
      await cleanup();
    }
  });
});
