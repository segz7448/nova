import { describe, expect, it } from "vitest";
import { validateVisualAction } from "../browser/safety.js";

const base = {
  action: "click" as const,
  x: 1040,
  y: 630,
  viewport: { width: 1280, height: 800 },
  perception: { target: "Download", confidence: 0.94, capturedAt: Date.now() },
};

describe("validateVisualAction", () => {
  it("permits a fresh, confident, in-bounds low-impact action", () => {
    expect(validateVisualAction(base)).toEqual({ allowed: true });
  });

  it("fails closed for a stale or low-confidence perception", () => {
    expect(validateVisualAction({ ...base, perception: { ...base.perception, capturedAt: Date.now() - 15_001 } }).allowed).toBe(false);
    expect(validateVisualAction({ ...base, perception: { ...base.perception, confidence: 0.79 } }).reason).toContain("confidence");
  });

  it("blocks unsafe targets and coordinates outside the current viewport", () => {
    expect(validateVisualAction({ ...base, perception: { ...base.perception, target: "Delete account" } }).reason).toContain("high-impact");
    expect(validateVisualAction({ ...base, x: 1280 }).reason).toContain("viewport");
  });
});
