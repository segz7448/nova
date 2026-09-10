export interface VisualActionRequest {
  action: "click" | "type";
  x: number;
  y: number;
  viewport: { width: number; height: number };
  perception: { target: string; confidence: number; capturedAt: number };
}

export interface VisualActionDecision {
  allowed: boolean;
  reason?: string;
}

const MAX_PERCEPTION_AGE_MS = 15_000;
const MIN_CONFIDENCE = 0.8;
const HIGH_IMPACT_TARGET = /\b(delete|remove|terminate|transfer|withdraw|pay|purchase|publish|submit|send|sign|authorize)\b/i;

/**
 * Deterministic gate between visual perception and browser input.
 * It deliberately fails closed: model prose never directly executes input.
 */
export function validateVisualAction(request: VisualActionRequest): VisualActionDecision {
  const { x, y, viewport, perception } = request;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
    return { allowed: false, reason: "target is outside the current viewport" };
  }
  if (!Number.isFinite(perception.capturedAt) || Date.now() - perception.capturedAt > MAX_PERCEPTION_AGE_MS) {
    return { allowed: false, reason: "perception is stale; capture a new screenshot" };
  }
  if (!Number.isFinite(perception.confidence) || perception.confidence < MIN_CONFIDENCE) {
    return { allowed: false, reason: "perception confidence is below the safety threshold" };
  }
  if (!perception.target.trim() || HIGH_IMPACT_TARGET.test(perception.target)) {
    return { allowed: false, reason: "high-impact target requires a dedicated policy path" };
  }
  return { allowed: true };
}
