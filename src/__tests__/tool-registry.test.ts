import { describe, expect, it } from "vitest";
import type { AutomatonTool } from "../types.js";
import { assertValidToolRegistry, inspectToolRegistry, toolNames } from "../agent/tool-registry.js";

const tool = (name: string): AutomatonTool => ({
  name,
  description: "test capability",
  category: "vm",
  riskLevel: "safe",
  parameters: { type: "object", properties: {} },
  execute: async () => "ok",
});

describe("tool registry contract", () => {
  it("rejects duplicate names and malformed capabilities", () => {
    const issues = inspectToolRegistry([tool("same"), tool("same")]);
    expect(issues).toContainEqual({ tool: "same", message: "duplicate tool name" });
    expect(() => assertValidToolRegistry([tool("same"), tool("same")])).toThrow(/duplicate tool name/);
  });

  it("exposes an immutable-name view for collision checks", () => {
    const names = toolNames([tool("a"), tool("b")]);
    expect(names.has("a")).toBe(true);
    expect(names.has("missing")).toBe(false);
  });
});
