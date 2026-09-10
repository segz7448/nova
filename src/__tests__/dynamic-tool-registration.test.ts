/**
 * Dynamic Tool Registration Tests
 *
 * Covers the "agents can't register new tools at runtime" fix:
 *  1. registerCustomTool()/installMcpServer()/removeInstalledTool()
 *     (self-mod/tools-manager.ts) round-trip through the database.
 *  2. loadInstalledTools() (agent/tools.ts) turns those DB rows back
 *     into real, callable AutomatonTool entries — including expanding
 *     one MCP server row into one entry per remote tool.
 *  3. The specific bug this whole fix targets: a tool list built BEFORE
 *     a registration call must NOT be what later turns use — each
 *     "turn" must reload from the database, which is what makes a
 *     newly registered tool usable without restarting the process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createDatabase } from "../state/database.js";
import type { AutomatonDatabase } from "../types.js";

// Mock erc8004.js to avoid ABI parse error at import time (same pattern
// used by data-layer.test.ts for anything that transitively imports it).
vi.mock("../registry/erc8004.js", () => ({
  queryAgent: vi.fn(),
  getTotalAgents: vi.fn().mockResolvedValue(0),
  registerAgent: vi.fn(),
  leaveFeedback: vi.fn(),
}));

vi.mock("../agent/injection-defense.js", () => ({
  sanitizeToolResult: vi.fn((s: string) => s),
  sanitizeInput: vi.fn((s: string) => ({ content: s, blocked: false })),
}));

// Mock the MCP client pool so no real process is spawned — this test
// verifies OUR wiring (discovery -> storage -> expansion -> dispatch),
// not the third-party SDK's transport.
vi.mock("../mcp/client-pool.js", () => ({
  listMcpTools: vi.fn(async () => [
    { name: "search", description: "Search things", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    { name: "fetch", description: "Fetch a thing" },
  ]),
  callMcpTool: vi.fn(async (_server: unknown, toolName: string, args: Record<string, unknown>) =>
    `called ${toolName} with ${JSON.stringify(args)}`,
  ),
}));

const { loadInstalledTools } = await import("../agent/tools.js");
const {
  registerCustomTool,
  installMcpServer,
  removeInstalledTool,
  listInstalledTools,
} = await import("../self-mod/tools-manager.js");

function makeTmpDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-tool-reg-test-"));
  return path.join(tmpDir, "test.db");
}

describe("Custom tool registration", () => {
  let dbPath: string;
  let db: AutomatonDatabase;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("registers a custom tool and it's immediately loadable", () => {
    const result = registerCustomTool(
      db,
      "my_tool",
      "Does a thing",
      { type: "object", properties: { x: { type: "string" } } },
      "echo",
    );
    expect(result.success).toBe(true);

    const tools = loadInstalledTools(db);
    expect(tools.map((t) => t.name)).toContain("my_tool");
    const tool = tools.find((t) => t.name === "my_tool")!;
    expect(tool.description).toBe("Does a thing");
    expect(tool.riskLevel).toBe("caution");
  });

  it("rejects an invalid tool name", () => {
    const result = registerCustomTool(db, "bad name!", "desc", {}, "echo");
    expect(result.success).toBe(false);
    expect(loadInstalledTools(db)).toHaveLength(0);
  });

  it("rejects a duplicate tool name", () => {
    registerCustomTool(db, "dup", "first", {}, "echo");
    const second = registerCustomTool(db, "dup", "second", {}, "echo");
    expect(second.success).toBe(false);
    expect(loadInstalledTools(db)).toHaveLength(1);
  });

  it("does not register an installed tool that shadows a builtin", () => {
    registerCustomTool(db, "exec", "shadow attempt", {}, "echo");
    const builtinNames = new Set(["exec"]);
    const tools = loadInstalledTools(db, builtinNames);
    expect(tools.map((t) => t.name)).not.toContain("exec");
  });

  it("removing a tool makes it disappear from the next load", () => {
    registerCustomTool(db, "temp_tool", "temporary", {}, "echo");
    expect(loadInstalledTools(db).map((t) => t.name)).toContain("temp_tool");

    const removed = removeInstalledTool(db, "temp_tool");
    expect(removed.success).toBe(true);
    expect(loadInstalledTools(db).map((t) => t.name)).not.toContain("temp_tool");
  });

  it("listInstalledTools reflects registrations and removals", () => {
    registerCustomTool(db, "a", "a", {}, "echo");
    registerCustomTool(db, "b", "b", {}, "echo");
    expect(listInstalledTools(db).map((t) => t.name).sort()).toEqual(["a", "b"]);
    removeInstalledTool(db, "a");
    expect(listInstalledTools(db).map((t) => t.name)).toEqual(["b"]);
  });
});

describe("MCP server registration", () => {
  let dbPath: string;
  let db: AutomatonDatabase;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("discovers real tools and expands one row into one tool per remote tool", async () => {
    const result = await installMcpServer(db, "search_server", "npx", ["-y", "@some/mcp"]);
    expect(result.success).toBe(true);
    expect(result.toolNames).toEqual(["search_server.search", "search_server.fetch"]);

    const tools = loadInstalledTools(db);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["search_server.fetch", "search_server.search"]);
  });

  it("an expanded MCP tool dispatches through the client pool for real", async () => {
    await installMcpServer(db, "search_server", "npx", ["-y", "@some/mcp"]);
    const tools = loadInstalledTools(db);
    const searchTool = tools.find((t) => t.name === "search_server.search")!;

    const result = await searchTool.execute({ q: "hello" }, {} as any);
    expect(result).toBe(`called search with {"q":"hello"}`);
  });

  it("removing an MCP server by its short name removes all its tools", async () => {
    await installMcpServer(db, "search_server", "npx", ["-y", "@some/mcp"]);
    expect(loadInstalledTools(db).length).toBe(2);

    const removed = removeInstalledTool(db, "search_server");
    expect(removed.success).toBe(true);
    expect(loadInstalledTools(db)).toHaveLength(0);
  });

  it("rejects a duplicate server name", async () => {
    await installMcpServer(db, "dup_server", "npx", ["-y", "@some/mcp"]);
    const second = await installMcpServer(db, "dup_server", "npx", ["-y", "@some/mcp"]);
    expect(second.success).toBe(false);
  });
});

describe("Runtime registration without restart (the core bug)", () => {
  let dbPath: string;
  let db: AutomatonDatabase;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("a tool list captured before registration does not see it, but a fresh load does — proving per-turn reload (not a one-time snapshot) is what makes runtime registration work", () => {
    // Simulate what the OLD buggy loop.ts did: capture `tools` once.
    const staleSnapshot = loadInstalledTools(db);
    expect(staleSnapshot.map((t) => t.name)).not.toContain("new_tool");

    // Agent calls register_tool mid-session (writes to DB only).
    registerCustomTool(db, "new_tool", "registered mid-session", {}, "echo");

    // The stale snapshot variable itself is still unaware — this is
    // exactly the bug: it's just a plain array, nothing more to check.
    expect(staleSnapshot.map((t) => t.name)).not.toContain("new_tool");

    // What loop.ts now does every turn: reload from the DB fresh.
    const freshLoad = loadInstalledTools(db);
    expect(freshLoad.map((t) => t.name)).toContain("new_tool");
  });
});
