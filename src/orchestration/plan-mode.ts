import type { Database } from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import { UnifiedInferenceClient } from "../inference/inference-client.js";
import type { PlannerOutput } from "./planner.js";
import { validatePlannerOutput } from "./planner.js";

const PLAN_MODE_STATE_KEY = "plan_mode.state";
const DEFAULT_REPLANS_REMAINING = 3;
const DEFAULT_AUTO_BUDGET_THRESHOLD = 5_000;
const DEFAULT_CONSENSUS_CRITIC_ROLE = "reviewer";
const DEFAULT_REVIEW_TIMEOUT_MS = 30 * 60_000;

export type ExecutionPhase =
  | "idle"
  | "classifying"
  | "planning"
  | "plan_review"
  | "executing"
  | "replanning"
  | "complete"
  | "failed";

export interface ExecutionState {
  phase: ExecutionPhase;
  goalId: string;
  planId: string | null;
  planVersion: number;
  planFilePath: string | null;
  spawnedAgentIds: string[];
  replansRemaining: number;
  phaseEnteredAt: string;
}

export type PlanApprovalMode = "auto" | "supervised" | "consensus";

export interface PlanApprovalConfig {
  mode: PlanApprovalMode;
  autoBudgetThreshold: number;
  consensusCriticRole: string;
  reviewTimeoutMs: number;
}

export type ReplanTrigger =
  | { type: "task_failure"; taskId: string; error: string }
  | { type: "budget_breach"; actualCents: number; estimatedCents: number }
  | { type: "requirement_change"; newInput: string; conflictScore: number }
  | { type: "environment_change"; resource: string; error: string }
  | { type: "opportunity"; suggestion: string; agentAddress: string };

const TRANSITIONS: Record<ExecutionPhase, ReadonlySet<ExecutionPhase>> = {
  idle: new Set(["classifying"]),
  classifying: new Set(["planning", "executing"]),
  planning: new Set(["plan_review"]),
  plan_review: new Set(["executing", "planning"]),
  executing: new Set(["replanning", "complete"]),
  replanning: new Set(["plan_review", "failed"]),
  complete: new Set([]),
  failed: new Set([]),
};

export class PlanModeController {
  constructor(private readonly db: Database) {}

  transition(from: ExecutionPhase, to: ExecutionPhase, reason: string): void {
    const state = this.getState();
    if (state.phase !== from) {
      throw new Error(
        `Invalid transition precondition: state is '${state.phase}', expected '${from}' (reason: ${reason})`,
      );
    }

    const valid = to === "failed" ? true : TRANSITIONS[from]?.has(to) ?? false;
    if (!valid) {
      throw new Error(`Invalid transition '${from}' -> '${to}' (reason: ${reason})`);
    }

    const next: Partial<ExecutionState> = {
      phase: to,
      phaseEnteredAt: nowIso(),
    };

    if (from === "executing" && to === "replanning") {
      next.replansRemaining = Math.max(0, state.replansRemaining - 1);
      next.planVersion = Math.max(0, state.planVersion + 1);
    }

    this.setState(next);
  }

  canSpawnAgents(): boolean {
    const state = this.getState();
    return state.phase === "executing" && state.planId !== null;
  }

  getState(): ExecutionState {
    const row = this.db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(PLAN_MODE_STATE_KEY) as { value: string } | undefined;
    const fallback = defaultExecutionState();

    if (!row?.value) {
      return fallback;
    }

    const parsed = safeJsonParse(row.value);
    if (!parsed || typeof parsed !== "object") {
      return fallback;
    }

    return sanitizeExecutionState(parsed, fallback);
  }

  setState(state: Partial<ExecutionState>): void {
    const current = this.getState();
    const merged: Record<string, unknown> = {
      ...current,
      ...state,
    };

    if (state.phase && state.phase !== current.phase && state.phaseEnteredAt === undefined) {
      merged.phaseEnteredAt = nowIso();
    }

    const next = sanitizeExecutionState(merged, current);
    this.db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(PLAN_MODE_STATE_KEY, JSON.stringify(next));
  }
}

export async function classifyComplexity(
  params: {
    taskDescription: string;
    agentRole: string;
    availableTools: string[];
  },
  inference: UnifiedInferenceClient,
): Promise<{
  requiresPlanMode: boolean;
  estimatedSteps: number;
  reason: string;
  stepOutline: string[];
}> {
  const description = params.taskDescription.trim();
  const fallbackSteps = estimateStepsHeuristic(description, params.availableTools);

  try {
    const result = await inference.chat({
      tier: "cheap",
      maxTokens: 220,
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "Classify task complexity for an autonomous agent.",
            "Return strict JSON: estimatedSteps (number), reason (string), stepOutline (string[]).",
            "Estimate concrete action steps, not thoughts.",
            "No markdown.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            `Agent role: ${params.agentRole || "generalist"}`,
            `Available tools: ${formatTools(params.availableTools)}`,
            `Task: ${description || "empty task description"}`,
          ].join("\n"),
        },
      ],
    });

    const parsed = safeJsonParse(result.content);
    const estimatedSteps = clampSteps(
      typeof parsed?.estimatedSteps === "number"
        ? parsed.estimatedSteps
        : fallbackSteps,
    );
    const stepOutline = normalizeStepOutline(parsed?.stepOutline, description, estimatedSteps);
    const reason =
      typeof parsed?.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : `Estimated ${estimatedSteps} steps from task complexity.`;

    return {
      requiresPlanMode: estimatedSteps > 3,
      estimatedSteps,
      reason,
      stepOutline,
    };
  } catch (error) {
    const estimatedSteps = fallbackSteps;
    return {
      requiresPlanMode: estimatedSteps > 3,
      estimatedSteps,
      reason: `Classifier fallback: ${toErrorMessage(error)}`,
      stepOutline: heuristicStepOutline(description, estimatedSteps),
    };
  }
}

export async function persistPlan(params: {
  goalId: string;
  version: number;
  plan: PlannerOutput;
  workspacePath: string;
}): Promise<{ jsonPath: string; mdPath: string }> {
  const workspaceRoot = path.resolve(params.workspacePath);
  const version = Math.max(1, Math.floor(params.version));
  const validatedPlan = validatePlannerOutput(params.plan);

  await fs.mkdir(workspaceRoot, { recursive: true });

  const jsonPath = path.join(workspaceRoot, "plan.json");
  const mdPath = path.join(workspaceRoot, "plan.md");

  if (await fileExists(jsonPath)) {
    const archiveVersion = Math.max(1, version - 1);
    const archivePath = path.join(workspaceRoot, `plan-v${archiveVersion}.json`);
    await fs.copyFile(jsonPath, archivePath);
  }

  await fs.writeFile(jsonPath, `${JSON.stringify(validatedPlan, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderPlanMarkdown(params.goalId, version, validatedPlan), "utf8");

  return { jsonPath, mdPath };
}

export async function loadPlan(planFilePath: string): Promise<PlannerOutput> {
  const raw = await fs.readFile(planFilePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid plan JSON at '${planFilePath}': ${toErrorMessage(error)}`);
  }
  return validatePlannerOutput(parsed);
}

export interface ApprovalRequest {
  id: string;
  goalId: string;
  planVersion: number;
  plan: PlannerOutput;
  criticRole: string;
  status: "pending" | "approved" | "rejected";
  feedback: string | null;
  concerns: string[];
  requestedAt: string;
  resolvedAt: string | null;
}

interface ApprovalRow {
  id: string;
  goal_id: string;
  plan_version: number;
  plan_json: string;
  critic_role: string;
  status: string;
  feedback: string | null;
  concerns: string | null;
  requested_at: string;
  resolved_at: string | null;
}

function rowToApprovalRequest(row: ApprovalRow): ApprovalRequest {
  let concerns: string[] = [];
  try {
    const parsed = row.concerns ? JSON.parse(row.concerns) : [];
    concerns = Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    concerns = [];
  }
  return {
    id: row.id,
    goalId: row.goal_id,
    planVersion: row.plan_version,
    plan: JSON.parse(row.plan_json),
    criticRole: row.critic_role,
    status: row.status === "approved" || row.status === "rejected" ? row.status : "pending",
    feedback: row.feedback,
    concerns,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * Enqueues a supervised-mode approval request, or returns the
 * existing one if this exact goal+planVersion was already enqueued —
 * idempotent by design, since reviewPlan()'s supervised branch calls
 * this on every tick a plan sits in plan_review, and only the FIRST
 * call for a given plan version should actually create a row (the
 * unique index on (goal_id, plan_version) enforces this at the DB
 * level too, as a second line of defense against a race).
 */
function enqueueApprovalRequest(
  db: Database,
  goalId: string,
  planVersion: number,
  plan: PlannerOutput,
  criticRole: string,
): ApprovalRequest {
  const existing = getApprovalRequest(db, goalId, planVersion);
  if (existing) return existing;

  const id = `apr_${goalId}_${planVersion}`;
  db.prepare(
    `INSERT INTO plan_approvals (id, goal_id, plan_version, plan_json, critic_role, status)
     VALUES (?, ?, ?, ?, ?, 'pending')
     ON CONFLICT (goal_id, plan_version) DO NOTHING`,
  ).run(id, goalId, planVersion, JSON.stringify(plan), criticRole);

  return getApprovalRequest(db, goalId, planVersion)!;
}

export function getApprovalRequest(db: Database, goalId: string, planVersion: number): ApprovalRequest | null {
  const row = db
    .prepare("SELECT * FROM plan_approvals WHERE goal_id = ? AND plan_version = ?")
    .get(goalId, planVersion) as ApprovalRow | undefined;
  return row ? rowToApprovalRequest(row) : null;
}

/**
 * Every request still awaiting resolution — the queue
 * resolveSupervisedApprovals() below drains. Oldest first, so a
 * backlog resolves in request order rather than arbitrarily.
 */
export function getPendingApprovalRequests(db: Database): ApprovalRequest[] {
  const rows = db
    .prepare("SELECT * FROM plan_approvals WHERE status = 'pending' ORDER BY requested_at ASC")
    .all() as ApprovalRow[];
  return rows.map(rowToApprovalRequest);
}

function resolveApprovalRequest(
  db: Database,
  id: string,
  outcome: { approved: boolean; feedback: string; concerns: string[] },
): void {
  db.prepare(
    `UPDATE plan_approvals
     SET status = ?, feedback = ?, concerns = ?, resolved_at = datetime('now')
     WHERE id = ? AND status = 'pending'`,
  ).run(outcome.approved ? "approved" : "rejected", outcome.feedback, JSON.stringify(outcome.concerns), id);
}

/**
 * The autonomous resolver — this IS the "no human override" part.
 * Drains every pending supervised-mode approval request using the
 * same real independent-critic mechanism as consensus mode
 * (runConsensusReview), just decoupled from the tick that originally
 * requested it: this can run from a different tick, a scheduled task,
 * or a dedicated worker, since it only reads/writes the persistent
 * queue table, not any in-memory state from the requesting call.
 *
 * Never throws — a single request's critic call failing (timeout,
 * malformed response, provider error) is caught and that ONE request
 * is left 'pending' for the next pass rather than aborting the whole
 * queue or, worse, treating a failed review as an approval. Returns
 * counts so a caller (e.g. the orchestrator's own tick loop) can log
 * what happened.
 */
export async function resolveSupervisedApprovals(
  db: Database,
  inference: UnifiedInferenceClient,
): Promise<{ approved: number; rejected: number; stillPending: number }> {
  const pending = getPendingApprovalRequests(db);
  let approved = 0;
  let rejected = 0;
  let stillPending = 0;

  for (const request of pending) {
    try {
      const result = await runConsensusReview(
        request.plan,
        { mode: "consensus", autoBudgetThreshold: 0, consensusCriticRole: request.criticRole, reviewTimeoutMs: DEFAULT_REVIEW_TIMEOUT_MS },
        inference,
      );
      resolveApprovalRequest(db, request.id, {
        approved: result.approved,
        feedback: result.feedback,
        concerns: result.concerns ?? [],
      });
      if (result.approved) approved += 1;
      else rejected += 1;
    } catch {
      // Left pending — picked up again on the next resolver pass.
      stillPending += 1;
    }
  }

  return { approved, rejected, stillPending };
}

export async function reviewPlan(
  plan: PlannerOutput,
  config: PlanApprovalConfig,
  inference?: UnifiedInferenceClient,
  supervisedContext?: { db: Database; goalId: string; planVersion: number },
): Promise<{ approved: boolean; feedback?: string; concerns?: string[] }> {
  const normalized = normalizeApprovalConfig(config);

  switch (normalized.mode) {
    case "auto": {
      if (plan.estimatedTotalCostCents > normalized.autoBudgetThreshold) {
        return {
          approved: false,
          feedback: `Auto-rejected above budget threshold (${plan.estimatedTotalCostCents} > ${normalized.autoBudgetThreshold}).`,
          concerns: ["estimated_cost_exceeds_auto_budget_threshold"],
        };
      }
      return { approved: true };
    }

    case "supervised": {
      if (!supervisedContext) {
        // No queue context wired in — can't enqueue or check status.
        // Fails the same way the old stub did (block, never silently
        // approve), but this path should be unreachable from the
        // real orchestrator now that it's wired below.
        throw new Error("awaiting supervised approval (no queue context provided)");
      }

      const { db, goalId, planVersion } = supervisedContext;
      const existing = enqueueApprovalRequest(db, goalId, planVersion, plan, normalized.consensusCriticRole);

      if (existing.status === "pending") {
        // Genuinely queued now, not blocked forever — see
        // resolveSupervisedApprovals(), which an autonomous process
        // (the orchestrator's own tick loop, wired below) drains. The
        // orchestrator's existing catch-and-stay-in-plan_review logic
        // keys off this exact message, so it still means "not
        // resolved yet," just no longer "will never be resolved."
        throw new Error("awaiting supervised approval");
      }

      return {
        approved: existing.status === "approved",
        feedback: existing.feedback ?? undefined,
        concerns: existing.concerns,
      };
    }

    case "consensus": {
      if (!inference) {
        // Fail CLOSED, not open: a missing dependency for the review
        // itself must never be silently treated as "reviewed and
        // fine" — that's exactly the stub behavior this replaces.
        return {
          approved: false,
          feedback:
            "Consensus review requires an inference client and none was provided — plan not approved pending a real independent review.",
        };
      }
      try {
        return await runConsensusReview(plan, normalized, inference);
      } catch (error) {
        // runConsensusReview() throws rather than returning
        // approved:false on an infra failure (see its own doc
        // comment) — consensus mode has no retry loop of its own, so
        // here (unlike resolveSupervisedApprovals()'s queue) that
        // still means fail closed.
        return {
          approved: false,
          feedback: `Consensus review failed: ${toErrorMessage(error)}. Plan not approved pending a successful independent review.`,
        };
      }
    }

    default: {
      return { approved: false, feedback: "Unsupported review mode." };
    }
  }
}

/**
 * The real second critic: an independent LLM call, prompted as a
 * separate reviewer (framed by `config.consensusCriticRole`, e.g.
 * "risk-analyst" or "security-auditor") with no visibility into
 * anything except the plan itself — no access to whatever reasoning
 * produced it, so it can't just rubber-stamp its own upstream
 * thinking. This is a second AGENT's independent judgment, not a
 * human-in-the-loop gate (see plan-mode.ts's "supervised" mode for
 * that, a separate and unrelated approval path this function doesn't
 * touch) — full agent autonomy, just with an actual second opinion
 * instead of none.
 *
 * Fails CLOSED on any failure (timeout, malformed response, inference
 * error): approved: false with a clear explanation. A review that
 * never actually happened must never be indistinguishable from one
 * that happened and approved — that conflation is the exact bug this
 * function exists to fix.
 */
/**
 * Throws on any failure to get a real critic verdict at all (timeout,
 * malformed/unparseable response, missing `approved` field, provider
 * error) — deliberately does NOT collapse "the critic reviewed and
 * said no" and "no review happened" into the same `approved: false`
 * return value, because callers need to tell those apart. reviewPlan()'s
 * synchronous "consensus" case has no retry mechanism of its own, so
 * it catches this and fails closed to approved:false. resolveSupervisedApprovals()'s
 * queue-based flow DOES have a natural retry mechanism (the next
 * drain pass), so it catches this and leaves the request pending
 * instead — a transient provider outage must never become a
 * permanent rejection of what might be a perfectly good plan.
 */
async function runConsensusReview(
  plan: PlannerOutput,
  config: PlanApprovalConfig,
  inference: UnifiedInferenceClient,
): Promise<{ approved: boolean; feedback: string; concerns?: string[] }> {
  const planSummary = renderPlanMarkdown("(pending review)", 0, plan);

  const chatPromise = inference.chat({
    tier: "reasoning",
    maxTokens: 700,
    responseFormat: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          `You are acting as an independent ${config.consensusCriticRole}, reviewing a plan before an autonomous agent begins executing it.`,
          "You did not write this plan and have no stake in it being approved — approach it with genuine skepticism, not rubber-stamping.",
          "Check specifically for: task dependencies that reference a task index that doesn't exist or would create a cycle;",
          "risks listed in the plan that aren't addressed by any task; cost or time estimates that look implausible for the described work;",
          "custom roles granted tools or treasury limits broader than their stated purpose needs; and any internal inconsistency between",
          "the stated strategy/analysis and the actual task list.",
          "Reject the plan if you find a genuine, material issue. Do not reject over minor style preferences or things you'd merely do",
          "differently — this is a review for correctness and safety, not a rewrite request.",
          'Return strict JSON: { "approved": boolean, "concerns": string[], "feedback": string }.',
          "`concerns` lists each specific issue found (empty array if none). `feedback` is a short overall summary explaining the verdict.",
          "No markdown, no text outside the JSON object.",
        ].join(" "),
      },
      {
        role: "user",
        content: planSummary,
      },
    ],
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Consensus review timed out after ${config.reviewTimeoutMs}ms`)), config.reviewTimeoutMs);
  });

  const result = await Promise.race([chatPromise, timeoutPromise]);
  const parsed = safeJsonParse(result.content);

  if (!parsed || typeof parsed.approved !== "boolean") {
    throw new Error(
      `Consensus critic returned an unparseable or malformed response. Raw response: ${truncate(result.content, 300)}`,
    );
  }

  const concerns = Array.isArray(parsed.concerns)
    ? parsed.concerns.filter((c: unknown): c is string => typeof c === "string" && c.trim().length > 0)
    : [];
  const feedback =
    typeof parsed.feedback === "string" && parsed.feedback.trim().length > 0
      ? parsed.feedback.trim()
      : parsed.approved
        ? "Consensus critic approved the plan."
        : "Consensus critic rejected the plan (no specific feedback provided).";

  return { approved: parsed.approved, feedback, concerns };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

export function shouldReplan(state: ExecutionState, trigger: ReplanTrigger): boolean {
  if (state.replansRemaining <= 0) {
    return false;
  }

  switch (trigger.type) {
    case "task_failure":
      return trigger.taskId.trim().length > 0 && trigger.error.trim().length > 0;

    case "budget_breach":
      if (trigger.estimatedCents <= 0) {
        return trigger.actualCents > 0;
      }
      return trigger.actualCents > trigger.estimatedCents * 1.5;

    case "requirement_change":
      return trigger.conflictScore >= 0.55;

    case "environment_change":
      return trigger.resource.trim().length > 0 && trigger.error.trim().length > 0;

    case "opportunity":
      return state.replansRemaining > 1 && trigger.suggestion.trim().length >= 24;

    default:
      return false;
  }
}

function defaultExecutionState(): ExecutionState {
  return {
    phase: "idle",
    goalId: "",
    planId: null,
    planVersion: 0,
    planFilePath: null,
    spawnedAgentIds: [],
    replansRemaining: DEFAULT_REPLANS_REMAINING,
    phaseEnteredAt: nowIso(),
  };
}

function sanitizeExecutionState(value: unknown, fallback: ExecutionState): ExecutionState {
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};

  const phase = asExecutionPhase(record.phase) ?? fallback.phase;
  const goalId = typeof record.goalId === "string" ? record.goalId : fallback.goalId;
  const planId = typeof record.planId === "string" ? record.planId : null;
  const planVersion = toNonNegativeInteger(record.planVersion, fallback.planVersion);
  const planFilePath = typeof record.planFilePath === "string" ? record.planFilePath : null;
  const spawnedAgentIds = Array.isArray(record.spawnedAgentIds)
    ? record.spawnedAgentIds.filter((entry): entry is string => typeof entry === "string")
    : fallback.spawnedAgentIds;
  const replansRemaining = toNonNegativeInteger(record.replansRemaining, fallback.replansRemaining);

  const enteredAt =
    typeof record.phaseEnteredAt === "string" && record.phaseEnteredAt.trim().length > 0
      ? record.phaseEnteredAt
      : fallback.phaseEnteredAt;

  return {
    phase,
    goalId,
    planId,
    planVersion,
    planFilePath,
    spawnedAgentIds,
    replansRemaining,
    phaseEnteredAt: enteredAt,
  };
}

function asExecutionPhase(value: unknown): ExecutionPhase | null {
  if (
    value === "idle" ||
    value === "classifying" ||
    value === "planning" ||
    value === "plan_review" ||
    value === "executing" ||
    value === "replanning" ||
    value === "complete" ||
    value === "failed"
  ) {
    return value;
  }
  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeJsonParse(value: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, any>;
  } catch {
    return null;
  }
}

function normalizeStepOutline(value: unknown, description: string, estimatedSteps: number): string[] {
  if (Array.isArray(value)) {
    const items = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (items.length > 0) {
      return items.slice(0, Math.max(estimatedSteps, 1));
    }
  }
  return heuristicStepOutline(description, estimatedSteps);
}

function heuristicStepOutline(description: string, estimatedSteps: number): string[] {
  const tokens = description
    .split(/[.;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (tokens.length > 0) {
    return tokens.slice(0, Math.max(estimatedSteps, 1));
  }
  return ["Interpret task", "Execute task"];
}

function estimateStepsHeuristic(taskDescription: string, availableTools: string[]): number {
  const text = taskDescription.toLowerCase();
  let score = 1;

  if (text.length > 120) {
    score += 1;
  }
  if (text.length > 320) {
    score += 1;
  }
  if (/\b(and|then|after|before|while|plus|also)\b/.test(text)) {
    score += 1;
  }
  if (/\b(integrate|deploy|migrate|refactor|investigate|research|test|validate)\b/.test(text)) {
    score += 1;
  }
  if (availableTools.length >= 3) {
    score += 1;
  }

  return clampSteps(score);
}

function clampSteps(steps: number): number {
  if (!Number.isFinite(steps)) {
    return 1;
  }
  return Math.min(12, Math.max(1, Math.round(steps)));
}

function toNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeApprovalConfig(config: PlanApprovalConfig): PlanApprovalConfig {
  const mode: PlanApprovalMode =
    config.mode === "auto" || config.mode === "supervised" || config.mode === "consensus"
      ? config.mode
      : "auto";

  return {
    mode,
    autoBudgetThreshold: Number.isFinite(config.autoBudgetThreshold)
      ? Math.max(0, Math.floor(config.autoBudgetThreshold))
      : DEFAULT_AUTO_BUDGET_THRESHOLD,
    consensusCriticRole:
      typeof config.consensusCriticRole === "string" && config.consensusCriticRole.trim().length > 0
        ? config.consensusCriticRole.trim()
        : DEFAULT_CONSENSUS_CRITIC_ROLE,
    reviewTimeoutMs: Number.isFinite(config.reviewTimeoutMs)
      ? Math.max(1, Math.floor(config.reviewTimeoutMs))
      : DEFAULT_REVIEW_TIMEOUT_MS,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatTools(tools: string[]): string {
  const normalized = tools.map((tool) => tool.trim()).filter((tool) => tool.length > 0);
  return normalized.length > 0 ? normalized.join(", ") : "none";
}

function renderPlanMarkdown(goalId: string, version: number, plan: PlannerOutput): string {
  const lines: string[] = [];
  lines.push(`# Plan: ${goalId} (v${version})`);
  lines.push(`Status: DRAFT | Estimated Cost: ${plan.estimatedTotalCostCents} cents | Estimated Time: ${plan.estimatedTimeMinutes} min`);
  lines.push("");
  lines.push("## Strategy");
  lines.push(plan.strategy.trim().length > 0 ? plan.strategy.trim() : "No strategy provided.");
  lines.push("");
  lines.push("## Analysis");
  lines.push(plan.analysis.trim().length > 0 ? plan.analysis.trim() : "No analysis provided.");
  lines.push("");
  lines.push("## Tasks");

  if (plan.tasks.length === 0) {
    lines.push("1. (No tasks)");
  } else {
    for (let index = 0; index < plan.tasks.length; index += 1) {
      const task = plan.tasks[index];
      lines.push(
        `${index + 1}. [ ] ${task.title} — role: ${task.agentRole}, deps: ${task.dependencies.join(",") || "none"}, cost: ${task.estimatedCostCents}c, timeout: ${task.timeoutMs}ms`,
      );
      lines.push(`   ${task.description}`);
    }
  }

  lines.push("");
  lines.push("## Risks");
  if (plan.risks.length === 0) {
    lines.push("- none");
  } else {
    for (const risk of plan.risks) {
      lines.push(`- ${risk}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
