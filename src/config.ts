/**
 * Automaton Configuration
 *
 * Loads and saves the automaton's configuration from ~/.automaton/automaton.json
 */

import fs from "fs";
import path from "path";
import type { AutomatonConfig, TreasuryPolicy, ModelStrategyConfig, SoulConfig } from "./types.js";
import { DEFAULT_CONFIG, DEFAULT_TREASURY_POLICY, DEFAULT_MODEL_STRATEGY_CONFIG, DEFAULT_SOUL_CONFIG } from "./types.js";
import { getAutomatonDir } from "./identity/wallet.js";
import { loadApiKeyFromConfig } from "./identity/provision.js";
import { createLogger } from "./observability/logger.js";
import type { ChainType } from "./identity/chain.js";

const logger = createLogger("config");
const CONFIG_FILENAME = "automaton.json";

export function getConfigPath(): string {
  return path.join(getAutomatonDir(), CONFIG_FILENAME);
}

/**
 * Load the automaton config from disk.
 * Merges with defaults for any missing fields.
 */
export function loadConfig(): AutomatonConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const apiKey = raw.backendApiKey || loadApiKeyFromConfig();

    // Deep-merge treasury policy with defaults
    const treasuryPolicy: TreasuryPolicy = {
      ...DEFAULT_TREASURY_POLICY,
      ...(raw.treasuryPolicy ?? {}),
    };

    // Validate all treasury values are positive numbers
    for (const [key, value] of Object.entries(treasuryPolicy)) {
      if (key === "x402AllowedDomains") continue; // array, not number
      if (typeof value === "number" && (value < 0 || !Number.isFinite(value))) {
        logger.warn(`Invalid treasury value for ${key}: ${value}, using default`);
        (treasuryPolicy as any)[key] = (DEFAULT_TREASURY_POLICY as any)[key];
      }
    }

    // Deep-merge model strategy config with defaults
    const modelStrategy: ModelStrategyConfig = {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      ...(raw.modelStrategy ?? {}),
    };

    // Deep-merge soul config with defaults
    const soulConfig: SoulConfig = {
      ...DEFAULT_SOUL_CONFIG,
      ...(raw.soulConfig ?? {}),
    };

    return {
      ...DEFAULT_CONFIG,
      ...raw,
      sandboxId:
        typeof raw.sandboxId === "string"
          ? raw.sandboxId.trim()
          : DEFAULT_CONFIG.sandboxId,
      backendApiKey: apiKey,
      treasuryPolicy,
      modelStrategy,
      soulConfig,
      chainType: raw.chainType || "evm",
      agentTier: raw.agentTier || (process.env.AGENT_TIER as AutomatonConfig["agentTier"]) || undefined,
      departmentRole: raw.departmentRole || process.env.DEPARTMENT_ROLE || undefined,
      workerRole: raw.workerRole || process.env.WORKER_ROLE || undefined,
      planApprovalMode: raw.planApprovalMode || process.env.PLAN_APPROVAL_MODE || "auto",
      planApprovalAutoBudgetThresholdCents:
        raw.planApprovalAutoBudgetThresholdCents ??
        (process.env.PLAN_APPROVAL_AUTO_BUDGET_THRESHOLD_CENTS
          ? Number(process.env.PLAN_APPROVAL_AUTO_BUDGET_THRESHOLD_CENTS)
          : undefined),
      planApprovalConsensusCriticRole:
        raw.planApprovalConsensusCriticRole || process.env.PLAN_APPROVAL_CONSENSUS_CRITIC_ROLE || undefined,
      planApprovalReviewTimeoutMs:
        raw.planApprovalReviewTimeoutMs ??
        (process.env.PLAN_APPROVAL_REVIEW_TIMEOUT_MS ? Number(process.env.PLAN_APPROVAL_REVIEW_TIMEOUT_MS) : undefined),
    } as AutomatonConfig;
  } catch {
    return null;
  }
}

/**
 * Save the automaton config to disk.
 * Includes treasuryPolicy in the persisted config.
 */
export function saveConfig(config: AutomatonConfig): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  const toSave = {
    ...config,
    treasuryPolicy: config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    modelStrategy: config.modelStrategy ?? DEFAULT_MODEL_STRATEGY_CONFIG,
    soulConfig: config.soulConfig ?? DEFAULT_SOUL_CONFIG,
  };
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), {
    mode: 0o600,
  });
}

/**
 * Resolve ~ paths to absolute paths.
 */
export function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}

/**
 * Create a fresh config from setup wizard inputs.
 */
export function createConfig(params: {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: string;
  registeredWithBackend: boolean;
  sandboxId: string;
  walletAddress: string;
  apiKey: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  parentAddress?: string;
  treasuryPolicy?: TreasuryPolicy;
  chainType?: ChainType;
}): AutomatonConfig {
  const normalizedSandboxId = (params.sandboxId || "").trim();
  return {
    name: params.name,
    genesisPrompt: params.genesisPrompt,
    creatorMessage: params.creatorMessage,
    creatorAddress: params.creatorAddress,
    registeredWithBackend: params.registeredWithBackend,
    sandboxId: normalizedSandboxId,
    backendApiUrl:
      DEFAULT_CONFIG.backendApiUrl ||
      process.env.BACKEND_API_URL ||
      "http://127.0.0.1:8000",
    backendApiKey: params.apiKey,
    openaiApiKey: params.openaiApiKey,
    anthropicApiKey: params.anthropicApiKey,
    ollamaBaseUrl: params.ollamaBaseUrl,
    inferenceModel: DEFAULT_CONFIG.inferenceModel || "qwen3-4b",
    maxTokensPerTurn: DEFAULT_CONFIG.maxTokensPerTurn || 4096,
    heartbeatConfigPath:
      DEFAULT_CONFIG.heartbeatConfigPath || "~/.automaton/heartbeat.yml",
    dbPath: DEFAULT_CONFIG.dbPath || "~/.automaton/state.db",
    logLevel: (DEFAULT_CONFIG.logLevel as AutomatonConfig["logLevel"]) || "info",
    walletAddress: params.walletAddress,
    version: DEFAULT_CONFIG.version || "0.2.1",
    skillsDir: DEFAULT_CONFIG.skillsDir || "~/.automaton/skills",
    maxChildren: DEFAULT_CONFIG.maxChildren ?? -1,
    parentAddress: params.parentAddress,
    treasuryPolicy: params.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    chainType: params.chainType || "evm",
  };
}
