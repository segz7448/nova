import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";
import { createDatabase } from "../state/database.js";
import { createTestConfig, createTestIdentity, MockBackendClient } from "./mocks.js";

describe("transfer_credits concurrency", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("serializes concurrent transfers so the combined amount cannot exceed half", async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "transfer-race-"));
    const db = createDatabase(path.join(tempDir, "state.db"));
    const identity = createTestIdentity();
    const backend = new MockBackendClient();
    const originalBalance = 10_000;
    backend.creditsCents = originalBalance;
    const tools = createBuiltinTools(identity.sandboxId);
    const transfer = tools.find((tool) => tool.name === "transfer_credits")!;
    const ctx = {
      identity,
      config: createTestConfig({ dbPath: path.join(tempDir, "state.db") }),
      db,
      backend,
      inference: { chat: async () => ({ content: "" }) },
    } as any;

    const results = await Promise.all([
      transfer.execute({ to_address: "0x1", amount_cents: 4_000 }, ctx),
      transfer.execute({ to_address: "0x2", amount_cents: 4_000 }, ctx),
    ]);

    expect(results.filter((result) => result.startsWith("Credit transfer submitted")).length).toBe(1);
    expect(results.filter((result) => result.startsWith("Blocked:")).length).toBe(1);
    expect(backend.creditsCents).toBeGreaterThanOrEqual(originalBalance / 2);
    db.close();
  });
});
