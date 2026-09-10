/**
 * MCP Client Pool
 *
 * install_mcp_server (self-mod/tools-manager.ts) records an MCP server's
 * connection details and its discovered tool list in the installed_tools
 * table. This module is what actually SPEAKS the MCP protocol: it spawns
 * (or reuses) a stdio connection to a given server and lets callers list
 * or invoke that server's tools for real, instead of the previous stub
 * that just echoed the call back as a string.
 *
 * Connections are cached per server key (name+command+args+env) for the
 * lifetime of the agent process and reconnected lazily on first use —
 * NOT at install time — so `install_mcp_server` stays fast and doesn't
 * fail the whole registration just because the server is briefly
 * unreachable. A dead/broken connection is dropped from the cache on
 * error so the next call gets a fresh reconnect attempt rather than
 * repeating the same failure forever.
 */

import { createLogger } from "../observability/logger.js";

const logger = createLogger("mcp-pool");

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

function serverKey(server: McpServerConfig): string {
  return JSON.stringify({
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// Minimal structural type for the pieces of the MCP SDK client this pool
// actually uses, so this file typechecks even in a workspace snapshot
// where @modelcontextprotocol/sdk hasn't been installed yet — the real
// class shape is a superset of this.
interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: McpToolDescriptor[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

type Entry = { client: McpClientLike; connectedAt: number };

const connections = new Map<string, Entry>();

async function connect(server: McpServerConfig): Promise<McpClientLike> {
  const key = serverKey(server);
  const cached = connections.get(key);
  if (cached) return cached.client;

  // Dynamic import: keeps this module (and everything that imports it)
  // loadable even in environments/tests that don't have the MCP SDK
  // installed, and avoids paying stdio-transport startup cost unless an
  // MCP tool is actually installed and used.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: server.env,
  });

  const client = new Client(
    { name: "automaton-agent", version: "1.0.0" },
    { capabilities: {} },
  ) as unknown as McpClientLike;

  await withTimeout(
    client.connect(transport),
    CONNECT_TIMEOUT_MS,
    `MCP connect to "${server.name}"`,
  );

  connections.set(key, { client, connectedAt: Date.now() });
  return client;
}

function dropConnection(server: McpServerConfig): void {
  connections.delete(serverKey(server));
}

/**
 * Connect (or reuse) and return the server's current tool list. Used both
 * at install_mcp_server time (to discover what to register) and can be
 * called again later to refresh a server's tool set.
 */
export async function listMcpTools(
  server: McpServerConfig,
): Promise<McpToolDescriptor[]> {
  try {
    const client = await connect(server);
    const { tools } = await withTimeout(
      client.listTools(),
      CALL_TIMEOUT_MS,
      `MCP listTools on "${server.name}"`,
    );
    return tools;
  } catch (error) {
    dropConnection(server);
    throw error;
  }
}

/**
 * Invoke a single tool on an MCP server, returning its result serialized
 * to a string for the agent's tool-result channel.
 */
export async function callMcpTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const client = await connect(server);
    const result = await withTimeout(
      client.callTool({ name: toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      `MCP callTool "${toolName}" on "${server.name}"`,
    );
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (error) {
    // A failed call may mean a wedged connection (not just a bad
    // argument) — drop it so the next attempt reconnects fresh rather
    // than repeatedly hitting a broken pipe.
    dropConnection(server);
    const message = error instanceof Error ? error.message : String(error);
    return `MCP tool "${toolName}" on server "${server.name}" failed: ${message}`;
  }
}

/**
 * Close every cached connection. Call on agent shutdown so child MCP
 * server processes don't leak past the parent's lifetime.
 */
export async function closeAllMcpConnections(): Promise<void> {
  const entries = [...connections.values()];
  connections.clear();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await entry.client.close();
      } catch (error) {
        logger.warn(
          `Error closing MCP connection: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
}
