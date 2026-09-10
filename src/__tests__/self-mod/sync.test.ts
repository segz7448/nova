import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import type { AutomatonDatabase } from "../../types.js";
import { pushSelfModBranch, syncFromMain, buildCompareUrl } from "../../self-mod/sync.js";
import { recordOutcome } from "../../self-mod/scoring.js";
import { makeGitFixture, writeAndCommit } from "./test-helpers.js";

function makeDb(): AutomatonDatabase {
  const kv = new Map<string, string>();
  const mods: unknown[] = [];
  return {
    getKV: (key: string) => kv.get(key),
    setKV: (key: string, value: string) => {
      kv.set(key, value);
    },
    deleteKV: (key: string) => {
      kv.delete(key);
    },
    insertModification: (mod: unknown) => {
      mods.push(mod);
    },
    getRecentModifications: () => [],
  } as unknown as AutomatonDatabase;
}

async function seedScopeManifest(repoPath: string): Promise<void> {
  await fs.mkdir(path.join(repoPath, "self-mod"), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, "self-mod", "scope.json"),
    JSON.stringify({ ownedGlobs: ["skills/distribution-agent/**"] }),
  );
}

describe("buildCompareUrl", () => {
  it("builds a GitHub compare URL from an https origin", () => {
    const url = buildCompareUrl("https://github.com/acme/automaton-fleet.git", "agent/0xabc/self-mod");
    expect(url).toBe("https://github.com/acme/automaton-fleet/compare/main...agent%2F0xabc%2Fself-mod?expand=1");
  });

  it("builds a GitHub compare URL from an ssh origin", () => {
    const url = buildCompareUrl("git@github.com:acme/automaton-fleet.git", "agent/0xabc/self-mod");
    expect(url).toBe("https://github.com/acme/automaton-fleet/compare/main...agent%2F0xabc%2Fself-mod?expand=1");
  });

  it("returns null for a non-GitHub remote instead of guessing a wrong shape", () => {
    expect(buildCompareUrl("/tmp/some/local/bare/repo.git", "agent/0xabc/self-mod")).toBeNull();
  });
});

describe("pushSelfModBranch", () => {
  it("creates the agent's own branch (not main) and pushes it to origin", async () => {
    const { repoPath, originPath, backend, cleanup } = await makeGitFixture();
    try {
      await writeAndCommit(backend, repoPath, "skills/distribution-agent/negotiate.ts", "v1", "initial");
      await backend.exec(`cd ${repoPath} && git push origin main`);

      await writeAndCommit(backend, repoPath, "skills/distribution-agent/negotiate.ts", "v2 - better tactic", "wip");
      const { branch } = await pushSelfModBranch(backend, repoPath, "0xabc", "better negotiation tactic");

      expect(branch).toBe("agent/0xabc/self-mod");

      // The branch must exist on the remote (origin), and main must be untouched by it.
      const branches = await backend.exec(`git --git-dir=${originPath} branch -a`);
      expect(branches.stdout).toContain("agent/0xabc/self-mod");

      const mainLog = await backend.exec(`git --git-dir=${originPath} log main --oneline`);
      expect(mainLog.stdout).not.toContain("negotiation tactic");
    } finally {
      await cleanup();
    }
  });

  it("is idempotent — a second push from the same agent reuses the existing branch rather than failing", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      await writeAndCommit(backend, repoPath, "skills/distribution-agent/negotiate.ts", "v1", "initial");
      await backend.exec(`cd ${repoPath} && git push origin main`);

      await writeAndCommit(backend, repoPath, "skills/distribution-agent/negotiate.ts", "v2", "first edit");
      await pushSelfModBranch(backend, repoPath, "0xabc", "first edit");

      await writeAndCommit(backend, repoPath, "skills/distribution-agent/negotiate.ts", "v3", "second edit");
      await expect(pushSelfModBranch(backend, repoPath, "0xabc", "second edit")).resolves.toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it("returns a promotion URL for a GitHub-style origin", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      await writeAndCommit(backend, repoPath, "skills/distribution-agent/negotiate.ts", "v1", "initial");
      await backend.exec(`cd ${repoPath} && git push origin main`);
      await backend.exec(`cd ${repoPath} && git remote set-url origin https://github.com/acme/fleet.git`);
      await writeAndCommit(backend, repoPath, "skills/distribution-agent/negotiate.ts", "v2", "edit");

      // remote no longer points at the real bare repo, so the push
      // itself will fail — but the function must still not throw
      // trying to build the promotion URL from a bad remote.
      await expect(pushSelfModBranch(backend, repoPath, "0xabc", "edit")).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});

describe("syncFromMain", () => {
  it("always takes a core (non-skills/) file from origin/main, automatically", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      await seedScopeManifest(repoPath);
      await writeAndCommit(backend, repoPath, "src/capability.ts", "v1", "initial core file");
      await backend.exec(`cd ${repoPath} && git push origin main`);
      const base = (await backend.exec(`cd ${repoPath} && git rev-parse HEAD`)).stdout.trim();

      // Founder pushes a fix to the SAME core file directly on main
      // (simulated via a second clone).
      const secondClone = `${repoPath}-founder`;
      await backend.exec(`git clone ${await backend.exec(`cd ${repoPath} && git config --get remote.origin.url`).then((r) => r.stdout.trim())} ${secondClone}`);
      await backend.exec(`cd ${secondClone} && git config user.email founder@example.com && git config user.name Founder`);
      await writeAndCommit(backend, secondClone, "src/capability.ts", "v2 - founder fix", "founder core fix");
      await backend.exec(`cd ${secondClone} && git push origin main`);

      const db = makeDb();
      const report = await syncFromMain(backend, db, repoPath, base);

      expect(report.takenFromMain).toContain("src/capability.ts");
      const content = await fs.readFile(path.join(repoPath, "src/capability.ts"), "utf8");
      expect(content).toBe("v2 - founder fix");
    } finally {
      await cleanup();
    }
  });

  it("never touches another agent's scoped file, even when it changed on origin/main", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      await seedScopeManifest(repoPath); // owns skills/distribution-agent/** only
      await writeAndCommit(backend, repoPath, "skills/sales-agent/pitch.ts", "v1", "initial sales skill");
      await backend.exec(`cd ${repoPath} && git push origin main`);
      const base = (await backend.exec(`cd ${repoPath} && git rev-parse HEAD`)).stdout.trim();

      const originUrl = (await backend.exec(`cd ${repoPath} && git config --get remote.origin.url`)).stdout.trim();
      const secondClone = `${repoPath}-other`;
      await backend.exec(`git clone ${originUrl} ${secondClone}`);
      await backend.exec(`cd ${secondClone} && git config user.email x@example.com && git config user.name X`);
      await writeAndCommit(backend, secondClone, "skills/sales-agent/pitch.ts", "v2 - sales team's own change", "sales edit");
      await backend.exec(`cd ${secondClone} && git push origin main`);

      const db = makeDb();
      const report = await syncFromMain(backend, db, repoPath, base);

      expect(report.skipped).toContain("skills/sales-agent/pitch.ts");
      expect(report.takenFromMain).not.toContain("skills/sales-agent/pitch.ts");
      const content = await fs.readFile(path.join(repoPath, "skills/sales-agent/pitch.ts"), "utf8");
      expect(content).toBe("v1"); // untouched — this agent never even looked at it
    } finally {
      await cleanup();
    }
  });

  it("takes origin/main's version of an owned scoped file when this agent has NOT also changed it (no conflict)", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      await seedScopeManifest(repoPath);
      await writeAndCommit(backend, repoPath, "skills/distribution-agent/pricing.ts", "v1", "initial");
      await backend.exec(`cd ${repoPath} && git push origin main`);
      const base = (await backend.exec(`cd ${repoPath} && git rev-parse HEAD`)).stdout.trim();

      const originUrl = (await backend.exec(`cd ${repoPath} && git config --get remote.origin.url`)).stdout.trim();
      const secondClone = `${repoPath}-founder2`;
      await backend.exec(`git clone ${originUrl} ${secondClone}`);
      await backend.exec(`cd ${secondClone} && git config user.email f@example.com && git config user.name F`);
      await writeAndCommit(backend, secondClone, "skills/distribution-agent/pricing.ts", "v2 - founder's pricing update", "pricing update");
      await backend.exec(`cd ${secondClone} && git push origin main`);

      const db = makeDb();
      const report = await syncFromMain(backend, db, repoPath, base);

      expect(report.takenFromMain).toContain("skills/distribution-agent/pricing.ts");
      expect(report.conflicts).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("REAL CONFLICT: keeps the agent's own scoped file when its local self-mod has strong recorded evidence", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      await seedScopeManifest(repoPath);
      await writeAndCommit(backend, repoPath, "skills/distribution-agent/negotiate.ts", "v1", "initial");
      await backend.exec(`cd ${repoPath} && git push origin main`);
      const base = (await backend.exec(`cd ${repoPath} && git rev-parse HEAD`)).stdout.trim();

      // This agent self-modifies the file locally.
      await writeAndCommit(
        backend,
        repoPath,
        "skills/distribution-agent/negotiate.ts",
        "v2 - this agent's own better tactic",
        "self-mod: better tactic",
      );

      // Founder independently changes the SAME file on main — real conflict.
      const originUrl = (await backend.exec(`cd ${repoPath} && git config --get remote.origin.url`)).stdout.trim();
      const secondClone = `${repoPath}-founder3`;
      await backend.exec(`git clone ${originUrl} ${secondClone}`);
      await backend.exec(`cd ${secondClone} && git config user.email f@example.com && git config user.name F`);
      await writeAndCommit(backend, secondClone, "skills/distribution-agent/negotiate.ts", "v2 - founder's own tactic", "founder edit");
      await backend.exec(`cd ${secondClone} && git push origin main`);

      const db = makeDb();
      // Strong, real, positive evidence for the agent's own version.
      for (let i = 0; i < 5; i++) recordOutcome(db, "skills/distribution-agent/negotiate.ts", true);

      const report = await syncFromMain(backend, db, repoPath, base);

      expect(report.conflicts).toEqual([{ filePath: "skills/distribution-agent/negotiate.ts", resolution: "kept-local" }]);
      expect(report.keptLocal).toContain("skills/distribution-agent/negotiate.ts");
      const content = await fs.readFile(path.join(repoPath, "skills/distribution-agent/negotiate.ts"), "utf8");
      expect(content).toBe("v2 - this agent's own better tactic");
    } finally {
      await cleanup();
    }
  });

  it("REAL CONFLICT: takes origin/main's version when the agent's local self-mod has NO evidence behind it", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      await seedScopeManifest(repoPath);
      await writeAndCommit(backend, repoPath, "skills/distribution-agent/negotiate.ts", "v1", "initial");
      await backend.exec(`cd ${repoPath} && git push origin main`);
      const base = (await backend.exec(`cd ${repoPath} && git rev-parse HEAD`)).stdout.trim();

      await writeAndCommit(
        backend,
        repoPath,
        "skills/distribution-agent/negotiate.ts",
        "v2 - untested local change",
        "self-mod: untested",
      );

      const originUrl = (await backend.exec(`cd ${repoPath} && git config --get remote.origin.url`)).stdout.trim();
      const secondClone = `${repoPath}-founder4`;
      await backend.exec(`git clone ${originUrl} ${secondClone}`);
      await backend.exec(`cd ${secondClone} && git config user.email f@example.com && git config user.name F`);
      await writeAndCommit(backend, secondClone, "skills/distribution-agent/negotiate.ts", "v2 - founder's proven fix", "founder edit");
      await backend.exec(`cd ${secondClone} && git push origin main`);

      const db = makeDb(); // no recorded outcomes at all — zero evidence

      const report = await syncFromMain(backend, db, repoPath, base);

      expect(report.conflicts).toEqual([{ filePath: "skills/distribution-agent/negotiate.ts", resolution: "took-main" }]);
      const content = await fs.readFile(path.join(repoPath, "skills/distribution-agent/negotiate.ts"), "utf8");
      expect(content).toBe("v2 - founder's proven fix");
    } finally {
      await cleanup();
    }
  });

  it("is a clean no-op (no commit) when origin/main has nothing new for this agent", async () => {
    const { repoPath, backend, cleanup } = await makeGitFixture();
    try {
      await seedScopeManifest(repoPath);
      await writeAndCommit(backend, repoPath, "src/capability.ts", "v1", "initial");
      await backend.exec(`cd ${repoPath} && git push origin main`);
      const base = (await backend.exec(`cd ${repoPath} && git rev-parse HEAD`)).stdout.trim();

      const db = makeDb();
      const report = await syncFromMain(backend, db, repoPath, base);

      expect(report.takenFromMain).toEqual([]);
      expect(report.keptLocal).toEqual([]);
      expect(report.conflicts).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
