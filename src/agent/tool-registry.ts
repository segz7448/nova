import { TOOL_CATEGORIES } from "../types.js";
import type { AutomatonTool, ToolCategory, RiskLevel } from "../types.js";

// Derived from TOOL_CATEGORIES (types.ts) rather than hand-listed here, so
// this allowlist and the ToolCategory type can never drift apart again.
const CATEGORIES: ReadonlySet<ToolCategory> = new Set(TOOL_CATEGORIES);
const RISKS: ReadonlySet<RiskLevel> = new Set(["safe", "caution", "dangerous"]);

export type RegistryIssue = { tool: string; message: string };

/** Validate the registry as one contract before exposing it to inference. */
export function inspectToolRegistry(tools: readonly AutomatonTool[]): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool.name.trim()) issues.push({ tool: "<unnamed>", message: "tool name is empty" });
    if (names.has(tool.name)) issues.push({ tool: tool.name, message: "duplicate tool name" });
    names.add(tool.name);
    if (!tool.description.trim()) issues.push({ tool: tool.name, message: "description is empty" });
    if (!CATEGORIES.has(tool.category)) issues.push({ tool: tool.name, message: `invalid category: ${tool.category}` });
    if (!RISKS.has(tool.riskLevel)) issues.push({ tool: tool.name, message: `invalid risk level: ${tool.riskLevel}` });
    if (typeof tool.execute !== "function") issues.push({ tool: tool.name, message: "execute handler is missing" });
    if (!tool.parameters || typeof tool.parameters !== "object") issues.push({ tool: tool.name, message: "parameters schema is missing" });
  }
  return issues;
}

/** Fail closed: a malformed capability must never reach the model. */
export function assertValidToolRegistry(tools: readonly AutomatonTool[]): void {
  const issues = inspectToolRegistry(tools);
  if (issues.length) throw new Error(`Invalid tool registry: ${issues.map((i) => `${i.tool}: ${i.message}`).join("; ")}`);
}

export function toolNames(tools: readonly AutomatonTool[]): ReadonlySet<string> {
  return new Set(tools.map((tool) => tool.name));
}
