#!/usr/bin/env node
/**
 * Automaton Runtime
 *
 * The entry point for the sovereign AI agent.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import fs from "fs";
import path from "path";
import { getWallet, getAutomatonDir } from "./identity/wallet.js";
import { provision, loadApiKeyFromConfig } from "./identity/provision.js";
import { loadConfig, resolvePath } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createBackendClient } from "./backend/client.js";
import { createBackendInferenceClient } from "./backend/inference.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import {
  loadHeartbeatConfig,
  syncHeartbeatToDb,
} from "./heartbeat/config.js";
import { consumeNextWakeEvent, insertWakeEvent, upsertHeartbeatSchedule } from "./state/database.js";
import { BUILTIN_TASKS } from "./heartbeat/tasks.js";
import { initInfraSchema } from "./infra/database.js";
import { createInfraTasks, INFRA_TASK_INTERVALS_MS } from "./heartbeat/infra-tasks.js";
import { DEFAULT_INFRA_POLICY } from "./infra/types.js";
import { runAgentLoop } from "./agent/loop.js";
import { ModelRegistry } from "./inference/registry.js";
import { loadSkills } from "./skills/loader.js";
import { initStateRepo } from "./git/state-versioning.js";
import { createSocialClient } from "./social/client.js";
import { createSocialGroupClient } from "./social/groupClient.js";
import { PolicyEngine } from "./agent/policy-engine.js";
import { SpendTracker } from "./agent/spend-tracker.js";
import { createDefaultRules } from "./agent/policy-rules/index.js";
import type { AutomatonIdentity, AgentState, Skill, SocialClientInterface, SocialGroupClientInterface } from "./types.js";
import { DEFAULT_TREASURY_POLICY } from "./types.js";
import { createLogger, setGlobalLogLevel, StructuredLogger } from "./observability/logger.js";
import { prettySink } from "./observability/pretty-sink.js";
import { randomUUID } from "crypto";
import { keccak256, toHex } from "viem";

const logger = createLogger("main");
const VERSION = "0.2.1";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── CLI Commands ────────────────────────────────────────────

  if (args.includes("--version") || args.includes("-v")) {
    logger.info(`Automaton v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    logger.info(`
Automaton v${VERSION}
Sovereign AI Agent Runtime

Usage:
  automaton --run          Start the automaton (first run triggers setup wizard)
  automaton --setup        Re-run the interactive setup wizard
  automaton --configure    Edit configuration (providers, model, treasury, general)
  automaton --pick-model   Interactively pick the active inference model
  automaton --init         Initialize wallet and config directory
  automaton --provision    Provision a backend API key via SIWE
  automaton --status       Show current automaton status
  automaton --tick-once    Run exactly one agent-loop tick against this
                           config dir and exit (ops/test harness — same
                           bootstrap and loop code --run uses)
  automaton --version      Show version
  automaton --help         Show this help

Environment:
  BACKEND_API_URL          Your self-hosted backend URL, e.g. http://YOUR_ALIBABA_VM_IP:8000
  BACKEND_API_KEY          Your self-hosted backend's shared secret (overrides config)
  OLLAMA_BASE_URL          Ollama base URL (overrides config, e.g. http://localhost:11434)
`);
    process.exit(0);
  }

  if (args.includes("--init")) {
    // Read chain type from genesis.json if written by parent during spawn
    let initChainType: import("./identity/chain.js").ChainType | undefined;
    try {
      const genesisPath = path.join(getAutomatonDir(), "genesis.json");
      if (fs.existsSync(genesisPath)) {
        const genesis = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));
        initChainType = genesis.chainType;
      }
    } catch {}
    const { chainIdentity, isNew } = await getWallet(initChainType);
    logger.info(
      JSON.stringify({
        address: chainIdentity.address,
        isNew,
        configDir: getAutomatonDir(),
      }),
    );
    process.exit(0);
  }

  if (args.includes("--provision")) {
    try {
      const result = await provision();
      logger.info(JSON.stringify(result));
    } catch (err: any) {
      logger.error(`Provision failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--pick-model")) {
    const { runModelPicker } = await import("./setup/model-picker.js");
    await runModelPicker();
    process.exit(0);
  }

  if (args.includes("--configure")) {
    const { runConfigure } = await import("./setup/configure.js");
    await runConfigure();
    process.exit(0);
  }

  if (args.includes("--run")) {
    StructuredLogger.setSink(prettySink);
    await run();
    return;
  }

  // Zent.md Phase 17e-i — ops/test entry point. Deliberately a plain
  // CLI flag on the same binary run() uses, not a separate script that
  // reimplements process/env/config loading: genesis.ts (backend) or a
  // test harness invokes this by shelling out to
  // `automaton --tick-once` against Agent B's own config dir, the same
  // way a human operator would invoke `--run` for any other agent — so
  // there is no genesis-specific code path here for a future audit to
  // find, only this one added branch that calls runSingleTick() once
  // and exits instead of looping.
  if (args.includes("--tick-once")) {
    StructuredLogger.setSink(prettySink);
    try {
      await runSingleTick();
      process.exit(0);
    } catch (err: any) {
      logger.error(`[tick-once] Tick failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  }

  // Default: show help
  logger.info('Run "automaton --help" for usage information.');
  logger.info('Run "automaton --run" to start the automaton.');
}

// ─── Status Command ────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    logger.info("Automaton is not configured. Run the setup script first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state = db.getAgentState();
  const turnCount = db.getTurnCount();
  const tools = db.getInstalledTools();
  const heartbeats = db.getHeartbeatEntries();
  const skills = db.getSkills(true);
  const children = db.getChildren();
  const registry = db.getRegistryEntry();

  logger.info(`
=== AUTOMATON STATUS ===
Name:       ${config.name}
Address:    ${config.walletAddress}
Creator:    ${config.creatorAddress}
Sandbox:    ${config.sandboxId}
State:      ${state}
Turns:      ${turnCount}
Tools:      ${tools.length} installed
Skills:     ${skills.length} active
Heartbeats: ${heartbeats.filter((h) => h.enabled).length} active
Children:   ${children.filter((c) => c.status !== "dead").length} alive / ${children.length} total
Agent ID:   ${registry?.agentId || "not registered"}
Model:      ${config.inferenceModel}
Version:    ${config.version}
========================
`);

  db.close();
}

// ─── Main Run ──────────────────────────────────────────────────

/**
 * Zent.md Phase 17e-i: "Tick execution harness: wire a test/ops path
 * that invokes Agent B's standard agent-loop tick function directly
 * after genesis, using the same code path a scheduled tick would use —
 * no genesis-specific branching."
 *
 * This is the extraction that makes "no genesis-specific branching"
 * literally true rather than just a design intention: everything
 * run() used to build inline before entering its while(true) loop —
 * identity, db, backend client, inference client, social/groups
 * clients, PolicyEngine/SpendTracker, skills, heartbeat config — now
 * lives here, in one function, called by both run()'s own scheduled
 * loop and runSingleTick() below (the ops/test harness). A harness
 * that duplicated this setup by hand would drift from the real startup
 * path the first time either one changed; calling the same function
 * is what keeps that impossible by construction.
 *
 * Deliberately stops short of heartbeat-daemon creation, the Alibaba
 * infra-task wiring, and remote-memory-sync registration (still in
 * run(), below) — those are periodic background schedules, not
 * anything runAgentLoop() itself reads, so a single-tick harness has
 * no need of them and skipping them keeps this function's only job
 * "build what one call to runAgentLoop() needs."
 */
// No explicit return-type annotation: let TS infer the shape structurally
// from the `return { ... }` below, same as the rest of this file already
// does for loadConfig()/getWallet()/createDatabase() rather than hand-
// naming their internal types — avoids this function silently drifting
// out of sync with whatever those helpers actually return.
export async function bootstrapAgentRuntime() {
  logger.info(`[${new Date().toISOString()}] Automaton v${VERSION} starting...`);

  // Load config — first run triggers interactive setup wizard.
  //
  // PHASE-17D-IV: a missing/invalid automaton.json used to fall through
  // to runSetupWizard() unconditionally, including when this process
  // has no interactive stdin at all (e.g. spawned by orchestrator.ts's
  // spawnAgentProcess()/spawnAgentProcessTickOnce(), or run under
  // --tick-once for a genesis smoke test) — the wizard's stdin prompts
  // then never resolve, and the process just hangs until whatever
  // timeout is watching it (genesisSmokeTest.ts's
  // genesisTickSmokeTestTimeoutMs) eventually kills it. Fail fast and
  // legibly instead whenever this is known to be non-interactive.
  let config = loadConfig();
  if (!config) {
    const nonInteractive =
      process.env.AUTOMATON_NON_INTERACTIVE === "1" || !process.stdin.isTTY;
    if (nonInteractive) {
      throw new Error(
        `bootstrapAgentRuntime: no ${`automaton.json`} found at ${getAutomatonDir()} and ` +
          "running non-interactively (AUTOMATON_NON_INTERACTIVE=1 or no TTY) — refusing " +
          "to launch the interactive setup wizard. A caller expecting this process to " +
          "run unattended (orchestrator.ts, --tick-once) must provision a full config " +
          "(and wallet.json) at AUTOMATON_CONFIG_DIR before spawning it.",
      );
    }
    const { runSetupWizard } = await import("./setup/wizard.js");
    config = await runSetupWizard();
  }

  // Load wallet (chain-aware)
  const { account, chainIdentity, chainType: walletChainType } = await getWallet();

  // PHASE-17D-IV: orchestrator.ts's spawnAgentProcess() doc comment has
  // long claimed an AGENT_ADDRESS-driven "resume path" exists here —
  // it never did (nothing in this file read process.env.AGENT_ADDRESS
  // before this change). Now that a caller CAN hand this process a
  // specific identity via AUTOMATON_CONFIG_DIR, this is a cheap
  // resume-verification check: if the caller also told us which
  // address it expects (AGENT_ADDRESS), and the wallet that actually
  // loaded from AUTOMATON_CONFIG_DIR doesn't match, fail immediately
  // rather than let an agent silently run under the wrong identity —
  // e.g. a misconfigured/reused AUTOMATON_CONFIG_DIR pointing at a
  // different agent's files.
  if (
    process.env.AGENT_ADDRESS &&
    process.env.AGENT_ADDRESS.toLowerCase() !== chainIdentity.address.toLowerCase()
  ) {
    throw new Error(
      `bootstrapAgentRuntime: AGENT_ADDRESS=${process.env.AGENT_ADDRESS} but the wallet ` +
        `loaded from ${getAutomatonDir()} resolves to ${chainIdentity.address} — refusing ` +
        "to boot under a mismatched identity.",
    );
  }

  const resolvedChainType = config.chainType || walletChainType || "evm";
  const apiKey = config.backendApiKey || loadApiKeyFromConfig();
  if (!apiKey) {
    logger.error("No API key found. Run: automaton --provision");
    process.exit(1);
  }

  // Initialize database
  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  // Initialize infra-ops schema (idempotent — safe to call every startup)
  initInfraSchema(db.raw);

  // Persist createdAt: only set if not already stored (never overwrite)
  const existingCreatedAt = db.getIdentity("createdAt");
  const createdAt = existingCreatedAt || new Date().toISOString();
  if (!existingCreatedAt) {
    db.setIdentity("createdAt", createdAt);
  }

  // Build identity (chain-aware)
  const identity: AutomatonIdentity = {
    name: config.name,
    address: chainIdentity.address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: config.sandboxId,
    apiKey,
    createdAt,
    chainType: resolvedChainType,
    chainIdentity,
  };

  // Store identity in DB
  db.setIdentity("name", config.name);
  db.setIdentity("address", chainIdentity.address);
  db.setIdentity("creator", config.creatorAddress);
  db.setIdentity("chainType", resolvedChainType);
  db.setIdentity("sandbox", config.sandboxId);
  const storedAutomatonId = db.getIdentity("automatonId");
  const automatonId = storedAutomatonId || config.sandboxId || randomUUID();
  if (!storedAutomatonId) {
    db.setIdentity("automatonId", automatonId);
  }

  // Create self-hosted backend client (your automaton-stack, not Conway)
  const backend = createBackendClient({
    apiUrl: config.backendApiUrl,
    apiKey,
    agentAddress: chainIdentity.address,
    sandboxId: config.sandboxId,
  });

  // Register automaton identity (one-time, immutable)
  const registrationState = db.getIdentity("registrationStatus");
  if (registrationState !== "registered") {
    try {
      const genesisPromptHash = config.genesisPrompt
        ? keccak256(toHex(config.genesisPrompt))
        : undefined;
      await backend.registerAutomaton({
        automatonId,
        automatonAddress: chainIdentity.address,
        creatorAddress: config.creatorAddress,
        name: config.name,
        bio: config.creatorMessage || "",
        genesisPromptHash,
        account,
        chainType: resolvedChainType,
        chainIdentity,
      });
      db.setIdentity("registrationStatus", "registered");
      logger.info(`[${new Date().toISOString()}] Automaton identity registered.`);
    } catch (err: any) {
      const status = err?.status;
      if (status === 409) {
        db.setIdentity("registrationStatus", "conflict");
        logger.warn(`[${new Date().toISOString()}] Automaton identity conflict: ${err.message}`);
      } else {
        db.setIdentity("registrationStatus", "failed");
        logger.warn(`[${new Date().toISOString()}] Automaton identity registration failed: ${err.message}`);
      }
    }
  }

  // Resolve Ollama base URL: env var takes precedence over config
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl;

  // Create inference client — pass a live registry lookup so model names like
  // "gpt-oss:120b" route to Ollama based on their registered provider, not heuristics.
  const modelRegistry = new ModelRegistry(db.raw);
  modelRegistry.initialize();
  const inference = createBackendInferenceClient({
    apiUrl: config.backendApiUrl,
    apiKey,
    agentAddress: chainIdentity.address,
    account,
    chainType: resolvedChainType,
    defaultModel: config.inferenceModel,
    maxTokens: config.maxTokensPerTurn,
    maxPaymentUsdc: config.treasuryPolicy
      ? config.treasuryPolicy.maxX402PaymentCents / 100
      : undefined,
  });

  if (ollamaBaseUrl) {
    logger.info(`[${new Date().toISOString()}] Ollama backend: ${ollamaBaseUrl}`);
  }

  // Create social client (chain-aware: pass ChainIdentity for Solana signing)
  let social: SocialClientInterface | undefined;
  let groups: SocialGroupClientInterface | undefined;
  if (config.socialRelayUrl) {
    const signer = resolvedChainType === "solana" ? chainIdentity : account;
    social = createSocialClient(config.socialRelayUrl, signer);
    groups = createSocialGroupClient(config.socialRelayUrl, signer);
    logger.info(`[${new Date().toISOString()}] Social relay: ${config.socialRelayUrl}`);
  }

  // Initialize PolicyEngine + SpendTracker (Phase 1.4)
  const treasuryPolicy = config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY;
  const rules = createDefaultRules(treasuryPolicy);
  const policyEngine = new PolicyEngine(db.raw, rules);
  const spendTracker = new SpendTracker(db.raw);

  // Load and sync heartbeat config
  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  syncHeartbeatToDb(heartbeatConfig, db);

  // Load skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db);
    logger.info(`[${new Date().toISOString()}] Loaded ${skills.length} skills.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Skills loading failed: ${err.message}`);
  }

  // Initialize state repo (git)
  try {
    await initStateRepo(backend);
    logger.info(`[${new Date().toISOString()}] State repo initialized.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] State repo init failed: ${err.message}`);
  }

  // No credits topup on this backend — your USDC balance IS your balance,
  // there's no conversion step. Just log it so startup output still shows
  // whether the agent has funds to work with.
  try {
    const creditsCents = await backend.getCreditsBalance().catch(() => 0);
    logger.info(
      `[${new Date().toISOString()}] Wallet balance: $${(creditsCents / 100).toFixed(2)} USDC`,
    );
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Balance check failed: ${err.message}`);
  }

  return {
    identity,
    config,
    db,
    backend,
    inference,
    social,
    groups,
    skills,
    skillsDir,
    policyEngine,
    spendTracker,
    ollamaBaseUrl,
    heartbeatConfig,
    account,
    chainIdentity,
    resolvedChainType,
  };
}

/**
 * Zent.md Phase 17e-i, the harness itself. Ops/test entry point
 * (wired to `--tick-once` below) that runs bootstrapAgentRuntime()
 * then calls runAgentLoop() exactly once — the identical function
 * run()'s while(true) loop calls on every scheduled iteration — and
 * returns instead of looping. No branch anywhere in runAgentLoop()
 * itself, or in bootstrapAgentRuntime(), knows this call came from a
 * genesis smoke check rather than a normal scheduled wake; the only
 * thing that differs is that this function calls it once and stops.
 *
 * Does not touch agent state, mark anything "active", or interpret the
 * tick's outcome — that's 17e-ii (assert no unhandled error/timeout/
 * crash) and 17e-iii (constitution/guard compliance check) and
 * 17e-iv (active-status transition), still to be built on top of this.
 * This function's only contract: if the tick throws, this function
 * throws — nothing here catches it — so a caller (a test, or an ops
 * script invoked right after genesis.ts's genesisCompany() returns)
 * can tell a clean tick from a crashed one from its own try/catch.
 */
export async function runSingleTick(): Promise<void> {
  const boot = await bootstrapAgentRuntime();
  let turnCount = 0;
  await runAgentLoop({
    identity: boot.identity,
    config: boot.config,
    db: boot.db,
    backend: boot.backend,
    inference: boot.inference,
    social: boot.social,
    groups: boot.groups,
    skills: boot.skills,
    policyEngine: boot.policyEngine,
    spendTracker: boot.spendTracker,
    ollamaBaseUrl: boot.ollamaBaseUrl,
    onStateChange: (state: AgentState) => {
      logger.info(`[${new Date().toISOString()}] [tick-once] State: ${state}`);
    },
    onTurnComplete: (turn) => {
      turnCount += 1;
      logger.info(
        `[${new Date().toISOString()}] [tick-once] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
      );
    },
  });
  logger.info(
    `[${new Date().toISOString()}] [tick-once] Completed: ${turnCount} turn(s), state=${boot.db.getAgentState()}`,
  );
  boot.db.close();
}

async function run(): Promise<void> {
  const {
    config,
    account,
    chainIdentity,
    resolvedChainType,
    db,
    identity,
    backend,
    inference,
    ollamaBaseUrl,
    social,
    groups,
    policyEngine,
    spendTracker,
    heartbeatConfig,
    skillsDir,
    skills: initialSkills,
  } = await bootstrapAgentRuntime();
  let skills = initialSkills;

  // ─── Infra-Ops Tasks ───────────────────────────────────────
  // Wire Alibaba Cloud VM-management tasks when the required env vars are set.
  // Object.assign(BUILTIN_TASKS, ...) must happen BEFORE createHeartbeatDaemon()
  // so the daemon's taskMap includes them when it copies BUILTIN_TASKS.
  if (
    process.env.ALIBABA_ACCESS_KEY_ID &&
    process.env.ALIBABA_ACCESS_KEY_SECRET &&
    process.env.ALIBABA_REGION_ID &&
    process.env.ALIBABA_INSTANCE_ID &&
    process.env.ALIBABA_WALLET_ADDRESS
  ) {
    try {
      const { RPCClient } = await import("@alicloud/pop-core" as any);
      const { AlibabaClient } = await import("./infra/alibaba-client.js");

      const ecsClient = new RPCClient({
        accessKeyId: process.env.ALIBABA_ACCESS_KEY_ID,
        accessKeySecret: process.env.ALIBABA_ACCESS_KEY_SECRET,
        endpoint: "https://ecs.aliyuncs.com",
        apiVersion: "2014-05-26",
      });
      const bssClient = new RPCClient({
        accessKeyId: process.env.ALIBABA_ACCESS_KEY_ID,
        accessKeySecret: process.env.ALIBABA_ACCESS_KEY_SECRET,
        endpoint: "https://business.aliyuncs.com",
        apiVersion: "2017-12-14",
      });
      const cmsClient = new RPCClient({
        accessKeyId: process.env.ALIBABA_ACCESS_KEY_ID,
        accessKeySecret: process.env.ALIBABA_ACCESS_KEY_SECRET,
        endpoint: `https://metrics.${process.env.ALIBABA_REGION_ID}.aliyuncs.com`,
        apiVersion: "2019-01-01",
      });

      const infraDeps = {
        db: db.raw,
        account,
        alibaba: new AlibabaClient(
          ecsClient,
          bssClient,
          process.env.ALIBABA_REGION_ID,
          cmsClient,
          // Reuse backend's exec so the df-fallback for disk usage
          // speaks to the same VM the agent already talks to.
          (cmd: string) => backend.exec(cmd),
        ),
        policy: DEFAULT_INFRA_POLICY,
        wallet: {
          alibabaWalletAddress: process.env.ALIBABA_WALLET_ADDRESS,
          network: (process.env.ALIBABA_USDC_NETWORK ?? "base") as "base" | "base-sepolia",
        },
      };

      const infraTasks = createInfraTasks(
        infraDeps,
        process.env.ALIBABA_INSTANCE_ID,
        process.env.ALIBABA_DISK_ID ?? "",
      );

      // Merge into BUILTIN_TASKS before the daemon copies them into its taskMap
      Object.assign(BUILTIN_TASKS, infraTasks);

      // Register infra task schedules in the DB (intervalMs-based, not cron).
      // tierMinimum: "normal" — don't run renewals/capacity checks when the
      // agent is in low_compute or critical state; they'd likely fail anyway
      // and the agent has bigger problems to fix first.
      for (const [taskName, intervalMs] of Object.entries(INFRA_TASK_INTERVALS_MS)) {
        upsertHeartbeatSchedule(db.raw, {
          taskName,
          cronExpression: null,
          intervalMs,
          enabled: 1,
          priority: 0,
          timeoutMs: 120_000, // infra tasks make external API calls
          maxRetries: 1,
          tierMinimum: "normal",
          lastRunAt: null,
          nextRunAt: null,
          lastResult: null,
          lastError: null,
          runCount: 0,
          failCount: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
        });
      }

      logger.info(
        `[${new Date().toISOString()}] Infra tasks registered (instance: ${process.env.ALIBABA_INSTANCE_ID}).`,
      );
    } catch (err: any) {
      // @alicloud/pop-core is an optional dependency — absence is not fatal.
      logger.warn(
        `[${new Date().toISOString()}] Infra tasks not loaded: ${err.message}. ` +
        `Install @alicloud/pop-core if you need Alibaba Cloud VM management.`,
      );
    }
  }

  // ─── Remote Memory Sync (opt-in) ────────────────────────────
  // Wires ./memory/backend-sync/remote-compaction.ts +
  // remote-memory-client.ts in as a heartbeat task — see MERGE-NOTES.md
  // item 1. Off by default: local SQLite (episodic.ts/semantic.ts/etc.)
  // remains the automaton's primary memory store either way. Same
  // "Object.assign(BUILTIN_TASKS, ...) before createHeartbeatDaemon()"
  // requirement as the Alibaba infra tasks above.
  if (process.env.REMOTE_MEMORY_SYNC_ENABLED === "true") {
    try {
      const { createRemoteMemorySyncTasks, REMOTE_MEMORY_TASK_INTERVALS_MS } = await import(
        "./memory/backend-sync/heartbeat-task.js"
      );

      const remoteMemoryTasks = createRemoteMemorySyncTasks({
        inference,
        agentAddress: identity.address,
      });

      Object.assign(BUILTIN_TASKS, remoteMemoryTasks);

      for (const [taskName, intervalMs] of Object.entries(REMOTE_MEMORY_TASK_INTERVALS_MS)) {
        upsertHeartbeatSchedule(db.raw, {
          taskName,
          cronExpression: null,
          intervalMs,
          enabled: 1,
          priority: 5,
          timeoutMs: 60_000, // makes a real inference call + a backend HTTP call
          maxRetries: 1,
          tierMinimum: "normal",
          lastRunAt: null,
          nextRunAt: null,
          lastResult: null,
          lastError: null,
          runCount: 0,
          failCount: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
        });
      }

      logger.info(`[${new Date().toISOString()}] Remote memory sync task registered.`);
    } catch (err: any) {
      logger.warn(
        `[${new Date().toISOString()}] Remote memory sync not loaded: ${err.message}.`,
      );
    }
  }

  // Start heartbeat daemon (Phase 1.1: DurableScheduler)
  const heartbeat = createHeartbeatDaemon({
    identity,
    config,
    heartbeatConfig,
    db,
    rawDb: db.raw,
    backend,
    social,
    groups,
    onWakeRequest: (reason) => {
      logger.info(`[HEARTBEAT] Wake request: ${reason}`);
      // Phase 1.1: Use wake_events table instead of KV wake_request
      insertWakeEvent(db.raw, 'heartbeat', reason);
    },
  });

  heartbeat.start();
  logger.info(`[${new Date().toISOString()}] Heartbeat daemon started.`);

  // Handle graceful shutdown
  const shutdown = () => {
    logger.info(`[${new Date().toISOString()}] Shutting down...`);
    heartbeat.stop();
    db.setAgentState("sleeping");
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ─── Main Run Loop ──────────────────────────────────────────
  // The automaton alternates between running and sleeping.
  // The heartbeat can wake it up.

  while (true) {
    try {
      // Reload skills (may have changed since last loop)
      try {
        skills = loadSkills(skillsDir, db);
      } catch (error) {
        logger.error("Skills reload failed", error instanceof Error ? error : undefined);
      }

      // Run the agent loop
      await runAgentLoop({
        identity,
        config,
        db,
        backend,
        inference,
        social,
        groups,
        skills,
        policyEngine,
        spendTracker,
        ollamaBaseUrl,
        onStateChange: (state: AgentState) => {
          logger.info(`[${new Date().toISOString()}] State: ${state}`);
        },
        onTurnComplete: (turn) => {
          logger.info(
            `[${new Date().toISOString()}] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
          );
        },
      });

      // Agent loop exited (sleeping or dead)
      const state = db.getAgentState();

      if (state === "dead") {
        logger.info(`[${new Date().toISOString()}] Automaton is dead. Heartbeat will continue.`);
        // In dead state, we just wait for funding
        // The heartbeat will keep checking and broadcasting distress
        await sleep(300_000); // Check every 5 minutes
        continue;
      }

      if (state === "sleeping") {
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = sleepUntilStr
          ? new Date(sleepUntilStr).getTime()
          : Date.now() + 60_000;
        const sleepMs = Math.max(sleepUntil - Date.now(), 10_000);
        logger.info(
          `[${new Date().toISOString()}] Sleeping for ${Math.round(sleepMs / 1000)}s`,
        );

        // Sleep, but check for wake requests periodically
        const checkInterval = Math.min(sleepMs, 30_000);
        let slept = 0;
        while (slept < sleepMs) {
          await sleep(checkInterval);
          slept += checkInterval;

          // Phase 1.1: Check for wake events from wake_events table (atomic consume)
          const wakeEvent = consumeNextWakeEvent(db.raw);
          if (wakeEvent) {
            logger.info(
              `[${new Date().toISOString()}] Woken by ${wakeEvent.source}: ${wakeEvent.reason}`,
            );
            db.deleteKV("sleep_until");
            break;
          }
        }

        // Clear sleep state
        db.deleteKV("sleep_until");
        continue;
      }
    } catch (err: any) {
      logger.error(
        `[${new Date().toISOString()}] Fatal error in run loop: ${err.message}`,
      );
      // Wait before retrying
      await sleep(30_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry Point ───────────────────────────────────────────────

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
