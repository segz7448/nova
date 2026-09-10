import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { classifyFile, classifyFiles, globToRegExp, matchesAnyGlob, readScopeManifest } from "../../self-mod/merge-policy.js";
import { makeRealBackend } from "./test-helpers.js";

describe("globToRegExp / matchesAnyGlob", () => {
  it("matches a directory-prefix glob ending in /**", () => {
    const re = globToRegExp("skills/distribution-agent/**");
    expect(re.test("skills/distribution-agent/negotiate.ts")).toBe(true);
    expect(re.test("skills/distribution-agent/sub/dir/file.ts")).toBe(true);
    expect(re.test("skills/sales-agent/negotiate.ts")).toBe(false);
  });

  it("does not match a sibling directory with a shared prefix", () => {
    const re = globToRegExp("skills/distribution-agent/**");
    expect(re.test("skills/distribution-agent-legacy/file.ts")).toBe(false);
  });

  it("matchesAnyGlob is true if ANY glob in the list matches", () => {
    expect(matchesAnyGlob("skills/support-agent/x.ts", ["skills/sales-agent/**", "skills/support-agent/**"])).toBe(
      true,
    );
  });

  it("matchesAnyGlob is false if none match", () => {
    expect(matchesAnyGlob("skills/support-agent/x.ts", ["skills/sales-agent/**"])).toBe(false);
  });
});

describe("classifyFile", () => {
  const manifest = { ownedGlobs: ["skills/distribution-agent/**"] };

  it("classifies anything outside skills/ as core", () => {
    expect(classifyFile("src/backend/client.ts", manifest)).toBe("core");
    expect(classifyFile("src/self-mod/code.ts", manifest)).toBe("core");
    expect(classifyFile("package.json", manifest)).toBe("core");
  });

  it("classifies an owned skills/ path as scoped-owned", () => {
    expect(classifyFile("skills/distribution-agent/negotiate.ts", manifest)).toBe("scoped-owned");
  });

  it("classifies another agent's skills/ path as scoped-other", () => {
    expect(classifyFile("skills/sales-agent/pitch.ts", manifest)).toBe("scoped-other");
  });

  it("an empty ownedGlobs manifest treats every skills/ file as scoped-other (never silently core)", () => {
    expect(classifyFile("skills/distribution-agent/negotiate.ts", { ownedGlobs: [] })).toBe("scoped-other");
  });
});

describe("classifyFiles (batch)", () => {
  it("buckets a mixed changed-file list correctly", () => {
    const manifest = { ownedGlobs: ["skills/distribution-agent/**"] };
    const result = classifyFiles(
      [
        "src/capability.ts",
        "skills/distribution-agent/negotiate.ts",
        "skills/sales-agent/pitch.ts",
        "skills/distribution-agent/pricing.ts",
      ],
      manifest,
    );
    expect(result.core).toEqual(["src/capability.ts"]);
    expect(result["scoped-owned"]).toEqual(["skills/distribution-agent/negotiate.ts", "skills/distribution-agent/pricing.ts"]);
    expect(result["scoped-other"]).toEqual(["skills/sales-agent/pitch.ts"]);
  });
});

describe("readScopeManifest", () => {
  it("reads a real scope.json from disk via the real backend", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scope-manifest-"));
    try {
      await fs.mkdir(path.join(root, "self-mod"), { recursive: true });
      await fs.writeFile(
        path.join(root, "self-mod", "scope.json"),
        JSON.stringify({ ownedGlobs: ["skills/support-agent/**"] }),
      );
      const backend = makeRealBackend();
      const manifest = await readScopeManifest(backend, root);
      expect(manifest.ownedGlobs).toEqual(["skills/support-agent/**"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the built-in default when scope.json is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scope-manifest-missing-"));
    try {
      const backend = makeRealBackend();
      const manifest = await readScopeManifest(backend, root);
      expect(manifest.ownedGlobs.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the default (fails closed) when scope.json is malformed, rather than widening scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scope-manifest-bad-"));
    try {
      await fs.mkdir(path.join(root, "self-mod"), { recursive: true });
      await fs.writeFile(path.join(root, "self-mod", "scope.json"), JSON.stringify({ ownedGlobs: "not-an-array" }));
      const backend = makeRealBackend();
      const manifest = await readScopeManifest(backend, root);
      expect(manifest.ownedGlobs.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
