/**
 * Tools Manager
 *
 * Manages installation, registration, and removal of tools the agent can
 * call at runtime: npm packages (for use via `exec`), MCP servers (whose
 * own tools get registered individually), and fully custom shell-backed
 * tools the agent defines itself.
 *
 * Fix note: this module previously existed but was never imported by
 * anything (agent/src/agent/tools.ts had its own diverging inline copies
 * of the npm/MCP install logic, and install_mcp_server never actually
 * spoke the MCP protocol — it just wrote a DB row and returned a canned
 * string). Both problems are fixed here:
 *   1. This is now the single implementation tools.ts's tool executors
 *      call into, so there's one place installation/audit logic lives.
 *   2. installMcpServer() genuinely connects to the server (via
 *      ../mcp/client-pool.ts) and discovers its real tool list before
 *      recording anything, so what gets registered is what the server
 *      actually offers.
 * The other half of the "agents can't register new tools at runtime"
 * fix — making the running agent loop pick up what's recorded here
 * without a process restart — lives in agent/src/agent/loop.ts, which
 * now reloads installed tools every turn instead of once at startup.
 */

import type { BackendClient, AutomatonDatabase, InstalledTool } from "../types.js";
import { logModification } from "./audit-log.js";
import { listMcpTools, type McpServerConfig } from "../mcp/client-pool.js";
import { ulid } from "ulid";

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function isReservedName(name: string, db: AutomatonDatabase): boolean {
  // A registered tool can never shadow an existing installed tool name
  // (builtins are checked separately in tools.ts, where the builtin list
  // actually lives — this module only knows about installed_tools).
  return db.getInstalledTools().some((t) => t.name === name);
}

/**
 * Install an npm package globally in the sandbox. This makes the package
 * available for the agent to shell out to via `exec` — it does not by
 * itself register a callable tool. Use registerCustomTool() for that.
 */
export async function installNpmPackage(
  backend: BackendClient,
  db: AutomatonDatabase,
  packageName: string,
): Promise<{ success: boolean; error?: string }> {
  // Sanitize package name (prevent command injection)
  if (!/^[@a-zA-Z0-9._/-]+$/.test(packageName)) {
    return {
      success: false,
      error: `Invalid package name: ${packageName}`,
    };
  }

  const result = await backend.exec(`npm install -g ${packageName}`, 120000);

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: `npm install failed: ${result.stderr}`,
    };
  }

  logModification(db, "tool_install", `Installed npm package: ${packageName}`, {
    reversible: true,
  });

  return { success: true };
}

/**
 * Connect to an MCP server, discover its real tool list, and register it
 * so the agent loop picks it up (see loop.ts's per-turn reload). Each of
 * the server's own tools is stored so tools.ts's loadInstalledTools()
 * can expand this single installed_tools row into one AutomatonTool per
 * remote tool, each dispatching through the MCP client pool for real.
 */
export async function installMcpServer(
  db: AutomatonDatabase,
  name: string,
  command: string,
  args?: string[],
  env?: Record<string, string>,
): Promise<{ success: boolean; error?: string; toolNames?: string[] }> {
  if (!NAME_PATTERN.test(name)) {
    return {
      success: false,
      error: `Invalid server name "${name}" — use letters, numbers, "_" or "-", starting with a letter.`,
    };
  }
  if (isReservedName(name, db) || isReservedName(`mcp:${name}`, db)) {
    return { success: false, error: `A tool/server named "${name}" is already installed.` };
  }

  const server: McpServerConfig = { name, command, args, env };

  let discovered;
  try {
    discovered = await listMcpTools(server);
  } catch (error) {
    return {
      success: false,
      error: `Could not connect to MCP server "${name}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (discovered.length === 0) {
    return {
      success: false,
      error: `MCP server "${name}" connected but offered no tools — nothing to register.`,
    };
  }

  const tool: InstalledTool = {
    id: ulid(),
    name: `mcp:${name}`,
    type: "mcp",
    config: {
      server: { name, command, args: args ?? [], env: env ?? {} },
      tools: discovered.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      })),
    },
    installedAt: new Date().toISOString(),
    enabled: true,
  };

  db.installTool(tool);

  const toolNames = discovered.map((t) => `${name}.${t.name}`);
  logModification(
    db,
    "mcp_install",
    `Installed MCP server: ${name} (${command}) — ${discovered.length} tool(s): ${toolNames.join(", ")}`,
    { reversible: true },
  );

  return { success: true, toolNames };
}

/**
 * Register a fully custom, shell-backed tool: the agent defines a name,
 * description, JSON-schema-shaped parameters, and a command to run. The
 * command receives the call's arguments as a single JSON-encoded,
 * shell-escaped argument (same convention tools.ts's executor already
 * used for pre-existing "custom" installed tools, kept for consistency
 * with agents/scripts already written against that contract).
 */
export function registerCustomTool(
  db: AutomatonDatabase,
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  command: string,
): { success: boolean; error?: string } {
  if (!NAME_PATTERN.test(name)) {
    return {
      success: false,
      error: `Invalid tool name "${name}" — use letters, numbers, "_" or "-", starting with a letter, max 64 chars.`,
    };
  }
  if (isReservedName(name, db)) {
    return { success: false, error: `A tool named "${name}" is already installed.` };
  }
  if (!description.trim()) {
    return { success: false, error: "description is required." };
  }
  if (!command.trim()) {
    return { success: false, error: "command is required." };
  }

  const tool: InstalledTool = {
    id: ulid(),
    name,
    type: "custom",
    config: { command, parameters, description },
    installedAt: new Date().toISOString(),
    enabled: true,
  };

  db.installTool(tool);
  logModification(db, "tool_install", `Registered custom tool: ${name}`, {
    reversible: true,
  });

  return { success: true };
}

/**
 * List all installed tools (npm-tracked, MCP, and custom).
 */
export function listInstalledTools(db: AutomatonDatabase): InstalledTool[] {
  return db.getInstalledTools();
}

/**
 * Remove (disable) an installed tool by name or id. Disabling takes
 * effect on the agent's very next turn — loop.ts reloads installed tools
 * from the database each turn, so no restart is needed.
 */
export function removeInstalledTool(
  db: AutomatonDatabase,
  nameOrId: string,
): { success: boolean; error?: string } {
  // MCP servers are stored internally as "mcp:<name>" (see installMcpServer)
  // but the agent naturally refers to them by the bare name it chose —
  // accept either form.
  const match = db
    .getInstalledTools()
    .find((t) => t.name === nameOrId || t.id === nameOrId || t.name === `mcp:${nameOrId}`);
  if (!match) {
    return { success: false, error: `No installed tool found matching "${nameOrId}".` };
  }
  db.removeTool(match.id);
  logModification(db, "tool_install", `Removed tool: ${match.name}`, {
    reversible: true,
  });
  return { success: true };
}
