/**
 * Resolve a `maxChildren` config value (where -1 means "unlimited") into a
 * plain number for interfaces that only accept a finite numeric bound
 * (e.g. planner context display fields). Does NOT affect actual spawn
 * enforcement, which lives in replication/spawn.ts and checks the raw
 * sentinel directly.
 */
export function resolveMaxAgents(maxChildren: number | undefined): number {
  if (typeof maxChildren !== "number" || !Number.isFinite(maxChildren) || maxChildren < 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return maxChildren;
}

export interface AgentTracker {
  getIdle(): { address: string; name: string; role: string; status: string }[];
  getBestForTask(role: string): { address: string; name: string } | null;
  updateStatus(address: string, status: string): void;
  register(agent: { address: string; name: string; role: string; sandboxId: string }): void;
}

export interface FundingProtocol {
  fundChild(childAddress: string, amountCents: number): Promise<{ success: boolean }>;
  recallCredits(childAddress: string): Promise<{ success: boolean; amountCents: number }>;
  getBalance(childAddress: string): Promise<number>;
}

export interface OrchestratorTickResult {
  phase: string;
  tasksAssigned: number;
  tasksCompleted: number;
  tasksFailed: number;
  goalsActive: number;
  agentsActive: number;
}

export interface AgentAssignment {
  agentAddress: string;
  agentName: string;
  spawned: boolean;
}
