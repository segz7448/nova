import { describe, it, expect, vi } from "vitest";
import {
  canRunInference,
  getModelForTier,
  applyTierRestrictions,
} from "../survival/low-compute.js";
import { createBackendInferenceClient } from "../backend/inference.js";
import { privateKeyToAccount } from "viem/accounts";
import type { SurvivalTier } from "../types.js";

describe("canRunInference", () => {
  it("allows inference for 'high' tier", () => {
    expect(canRunInference("high")).toBe(true);
  });

  it("allows inference for 'normal' tier", () => {
    expect(canRunInference("normal")).toBe(true);
  });

  it("allows inference for 'low_compute' tier", () => {
    expect(canRunInference("low_compute")).toBe(true);
  });

  it("allows inference for 'critical' tier", () => {
    expect(canRunInference("critical")).toBe(true);
  });

  it("denies inference for 'dead' tier", () => {
    expect(canRunInference("dead")).toBe(false);
  });
});

describe("getModelForTier", () => {
  const defaultModel = "gpt-5.2";

  it("returns default model for 'high' tier", () => {
    expect(getModelForTier("high", defaultModel)).toBe(defaultModel);
  });

  it("returns default model for 'normal' tier", () => {
    expect(getModelForTier("normal", defaultModel)).toBe(defaultModel);
  });

  it("returns the default model for 'low_compute' tier", () => {
    // On this local-model setup there's no separate cheap model to drop
    // to — Qwen3-4B is the only model the VM serves — so every tier
    // resolves to defaultModel (see getModelForTier's doc comment in
    // survival/low-compute.ts). These tests previously expected a
    // "gpt-5-mini" cheap-tier fallback that doesn't exist in this setup.
    expect(getModelForTier("low_compute", defaultModel)).toBe(defaultModel);
  });

  it("returns the default model for 'critical' tier", () => {
    expect(getModelForTier("critical", defaultModel)).toBe(defaultModel);
  });

  it("returns the default model for 'dead' tier", () => {
    expect(getModelForTier("dead", defaultModel)).toBe(defaultModel);
  });

  it("returns the default model for 'normal' tier with custom default", () => {
    expect(getModelForTier("normal", "gpt-5.2")).toBe("gpt-5.2");
  });

  it("returns a value for every tier", () => {
    const tiers: SurvivalTier[] = ["high", "normal", "low_compute", "critical", "dead"];
    for (const tier of tiers) {
      const model = getModelForTier(tier, defaultModel);
      expect(model).toBeTruthy();
    }
  });
});

describe("applyTierRestrictions", () => {
  function makeMocks() {
    return {
      inference: { setLowComputeMode: vi.fn() },
      db: {
        setKV: vi.fn(),
        getKV: vi.fn(),
        raw: {} as any,
        insertTurn: vi.fn(),
        updateTurn: vi.fn(),
        getTurnsBySession: vi.fn(),
        insertToolCall: vi.fn(),
        getToolCallsByTurn: vi.fn(),
        getChildById: vi.fn(),
        getChildren: vi.fn(),
        insertChild: vi.fn(),
        updateChild: vi.fn(),
        deleteChild: vi.fn(),
        close: vi.fn(),
      },
    };
  }

  it("sets low compute mode off for 'high' tier", () => {
    const { inference, db } = makeMocks();
    applyTierRestrictions("high", inference as any, db as any);
    expect(inference.setLowComputeMode).toHaveBeenCalledWith(false);
    expect(db.setKV).toHaveBeenCalledWith("current_tier", "high");
  });

  it("sets low compute mode off for 'normal' tier", () => {
    const { inference, db } = makeMocks();
    applyTierRestrictions("normal", inference as any, db as any);
    expect(inference.setLowComputeMode).toHaveBeenCalledWith(false);
  });

  it("sets low compute mode on for 'low_compute' tier", () => {
    const { inference, db } = makeMocks();
    applyTierRestrictions("low_compute", inference as any, db as any);
    expect(inference.setLowComputeMode).toHaveBeenCalledWith(true);
  });

  it("sets low compute mode on for 'critical' tier", () => {
    const { inference, db } = makeMocks();
    applyTierRestrictions("critical", inference as any, db as any);
    expect(inference.setLowComputeMode).toHaveBeenCalledWith(true);
  });

  it("sets low compute mode on for 'dead' tier", () => {
    const { inference, db } = makeMocks();
    applyTierRestrictions("dead", inference as any, db as any);
    expect(inference.setLowComputeMode).toHaveBeenCalledWith(true);
  });
});

describe("createBackendInferenceClient setLowComputeMode", () => {
  // Migrated from the old backend/inference.ts createInferenceClient
  // coverage (error-fix.md Phase 11) — backend/inference.ts was dead
  // code (superseded by backend/inference.ts, never imported outside
  // this test) and has been deleted. This also now exercises the
  // Phase 11 fix: setLowComputeMode/getDefaultModel were previously a
  // no-op on the backend client (see backend/inference.ts's own note),
  // so this coverage is not just relocated, it's newly meaningful.
  const account = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const baseOptions = {
    apiUrl: "http://localhost:8000",
    apiKey: "test-key",
    agentAddress: account.address,
    account,
    defaultModel: "gpt-5.2",
    maxTokens: 4096,
  };

  it("uses lowComputeModel when provided", () => {
    const client = createBackendInferenceClient({
      ...baseOptions,
      lowComputeModel: "gpt-5-mini",
    });
    client.setLowComputeMode(true);
    expect(client.getDefaultModel()).toBe("gpt-5-mini");
  });

  it("falls back to the local low-compute model when no lowComputeModel is provided", () => {
    // backend/inference.ts's actual fallback is "qwen3-4b" (the local
    // model this backend serves by default when no explicit
    // lowComputeModel is configured — see its own doc comment), not
    // "gpt-5-mini". That expectation was stale from before this repo
    // moved to a Qwen-based local setup.
    const client = createBackendInferenceClient(baseOptions);
    client.setLowComputeMode(true);
    expect(client.getDefaultModel()).toBe("qwen3-4b");
  });

  it("restores defaultModel when low compute mode is disabled", () => {
    const client = createBackendInferenceClient({
      ...baseOptions,
      lowComputeModel: "gpt-5-mini",
    });
    client.setLowComputeMode(true);
    expect(client.getDefaultModel()).toBe("gpt-5-mini");
    client.setLowComputeMode(false);
    expect(client.getDefaultModel()).toBe("gpt-5.2");
  });
});
