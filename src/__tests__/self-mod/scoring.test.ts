import { describe, it, expect } from "vitest";
import { getScore, recordOutcome, localSelfModShouldWin, shouldAutoRevert, resetScore, getRecentFailureReasons } from "../../self-mod/scoring.js";
import type { AutomatonDatabase } from "../../types.js";

function makeKvDatabase(): AutomatonDatabase {
  const store = new Map<string, string>();
  return {
    getKV: (key: string) => store.get(key),
    setKV: (key: string, value: string) => {
      store.set(key, value);
    },
    deleteKV: (key: string) => {
      store.delete(key);
    },
  } as unknown as AutomatonDatabase; // only KV is exercised by scoring.ts
}

describe("recordOutcome / getScore", () => {
  it("starts at zero for a file with no recorded outcomes", () => {
    const db = makeKvDatabase();
    expect(getScore(db, "skills/distribution-agent/negotiate.ts")).toEqual({ success: 0, failure: 0 });
  });

  it("increments success and failure counts independently", () => {
    const db = makeKvDatabase();
    const file = "skills/distribution-agent/negotiate.ts";
    recordOutcome(db, file, true);
    recordOutcome(db, file, true);
    recordOutcome(db, file, false);
    expect(getScore(db, file)).toEqual({ success: 2, failure: 1 });
  });

  it("tracks separate files independently", () => {
    const db = makeKvDatabase();
    recordOutcome(db, "skills/distribution-agent/negotiate.ts", true);
    recordOutcome(db, "skills/distribution-agent/pricing.ts", false);
    expect(getScore(db, "skills/distribution-agent/negotiate.ts")).toEqual({ success: 1, failure: 0 });
    expect(getScore(db, "skills/distribution-agent/pricing.ts")).toEqual({ success: 0, failure: 1 });
  });
});

describe("localSelfModShouldWin", () => {
  it("never wins with zero recorded successes, no matter how few failures", () => {
    expect(localSelfModShouldWin({ success: 0, failure: 0 })).toBe(false);
  });

  it("does not win below the minimum success count even at 100% success rate", () => {
    expect(localSelfModShouldWin({ success: 2, failure: 0 })).toBe(false);
  });

  it("wins with enough successes at a high success ratio", () => {
    expect(localSelfModShouldWin({ success: 5, failure: 0 })).toBe(true);
    expect(localSelfModShouldWin({ success: 3, failure: 1 })).toBe(true); // 75% exactly, at the threshold
  });

  it("does not win with enough successes but too many failures dragging the ratio down", () => {
    expect(localSelfModShouldWin({ success: 4, failure: 4 })).toBe(false); // 50%
  });

  it("absence of evidence (never exercised) is never treated as evidence of quality", () => {
    // A file that was self-modified but never actually run/tested has
    // zero of both — must not win just because it also has zero
    // failures.
    expect(localSelfModShouldWin({ success: 0, failure: 0 })).toBe(false);
  });
});

describe("shouldAutoRevert", () => {
  it("never reverts with fewer than the minimum recorded failures, even at 0% success", () => {
    expect(shouldAutoRevert({ success: 0, failure: 1 })).toBe(false);
    expect(shouldAutoRevert({ success: 0, failure: 2 })).toBe(false);
  });

  it("reverts once there are enough failures and a clearly bad success ratio", () => {
    expect(shouldAutoRevert({ success: 0, failure: 3 })).toBe(true);
    expect(shouldAutoRevert({ success: 1, failure: 3 })).toBe(true); // 25% exactly, at the threshold
  });

  it("does not revert with enough failures but a middling (not clearly bad) success ratio", () => {
    expect(shouldAutoRevert({ success: 4, failure: 4 })).toBe(false); // 50%
  });

  it("does not revert a file with many successes and only a few recent failures", () => {
    expect(shouldAutoRevert({ success: 20, failure: 3 })).toBe(false);
  });

  it("a single bad run right after a self-mod is not yet a pattern", () => {
    expect(shouldAutoRevert({ success: 0, failure: 1 })).toBe(false);
  });
});

describe("recordOutcome with failure reasons", () => {
  it("stores the failure reason alongside the count", () => {
    const db = makeKvDatabase();
    const file = "skills/distribution-agent/negotiate.ts";
    recordOutcome(db, file, false, "Client rejected the counter-offer as too aggressive");
    expect(getRecentFailureReasons(db, file)).toEqual(["Client rejected the counter-offer as too aggressive"]);
  });

  it("ignores the reason on a success (nothing to explain)", () => {
    const db = makeKvDatabase();
    const file = "skills/distribution-agent/negotiate.ts";
    recordOutcome(db, file, true, "this should never be stored");
    expect(getRecentFailureReasons(db, file)).toEqual([]);
  });

  it("accumulates multiple reasons in order", () => {
    const db = makeKvDatabase();
    const file = "skills/distribution-agent/negotiate.ts";
    recordOutcome(db, file, false, "reason one");
    recordOutcome(db, file, false, "reason two");
    recordOutcome(db, file, false, "reason three");
    expect(getRecentFailureReasons(db, file)).toEqual(["reason one", "reason two", "reason three"]);
  });

  it("caps the stored reasons at the most recent 5, dropping the oldest first", () => {
    const db = makeKvDatabase();
    const file = "skills/distribution-agent/negotiate.ts";
    for (let i = 1; i <= 7; i++) {
      recordOutcome(db, file, false, `reason ${i}`);
    }
    expect(getRecentFailureReasons(db, file)).toEqual(["reason 3", "reason 4", "reason 5", "reason 6", "reason 7"]);
  });

  it("truncates an overly long reason rather than storing it in full", () => {
    const db = makeKvDatabase();
    const file = "skills/distribution-agent/negotiate.ts";
    const longReason = "x".repeat(500);
    recordOutcome(db, file, false, longReason);
    const [stored] = getRecentFailureReasons(db, file);
    expect(stored.length).toBeLessThan(500);
    expect(stored.endsWith("…")).toBe(true);
  });

  it("collapses embedded newlines/whitespace into a single line", () => {
    const db = makeKvDatabase();
    const file = "skills/distribution-agent/negotiate.ts";
    recordOutcome(db, file, false, "line one\nline two\n\n   line three");
    expect(getRecentFailureReasons(db, file)).toEqual(["line one line two line three"]);
  });

  it("recording a failure with no reason at all still increments the count without adding an entry", () => {
    const db = makeKvDatabase();
    const file = "skills/distribution-agent/negotiate.ts";
    recordOutcome(db, file, false);
    expect(getScore(db, file)).toEqual({ success: 0, failure: 1 });
    expect(getRecentFailureReasons(db, file)).toEqual([]);
  });

  it("tracks reasons independently per file", () => {
    const db = makeKvDatabase();
    recordOutcome(db, "skills/distribution-agent/negotiate.ts", false, "negotiate failure");
    recordOutcome(db, "skills/distribution-agent/pricing.ts", false, "pricing failure");
    expect(getRecentFailureReasons(db, "skills/distribution-agent/negotiate.ts")).toEqual(["negotiate failure"]);
    expect(getRecentFailureReasons(db, "skills/distribution-agent/pricing.ts")).toEqual(["pricing failure"]);
  });
});

describe("resetScore", () => {
  it("clears both counters back to zero", () => {
    const db = makeKvDatabase();
    const file = "skills/distribution-agent/negotiate.ts";
    recordOutcome(db, file, false);
    recordOutcome(db, file, false);
    recordOutcome(db, file, false);
    expect(getScore(db, file)).toEqual({ success: 0, failure: 3 });

    resetScore(db, file);

    expect(getScore(db, file)).toEqual({ success: 0, failure: 0 });
  });

  it("does not affect other files' scores", () => {
    const db = makeKvDatabase();
    recordOutcome(db, "skills/distribution-agent/negotiate.ts", true);
    recordOutcome(db, "skills/distribution-agent/pricing.ts", false);

    resetScore(db, "skills/distribution-agent/negotiate.ts");

    expect(getScore(db, "skills/distribution-agent/negotiate.ts")).toEqual({ success: 0, failure: 0 });
    expect(getScore(db, "skills/distribution-agent/pricing.ts")).toEqual({ success: 0, failure: 1 });
  });

  it("also clears the stored failure reasons, not just the counts", () => {
    const db = makeKvDatabase();
    const file = "skills/distribution-agent/negotiate.ts";
    recordOutcome(db, file, false, "a specific reason that should not survive the reset");

    resetScore(db, file);

    expect(getRecentFailureReasons(db, file)).toEqual([]);
  });
});
