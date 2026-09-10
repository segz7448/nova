import { describe, expect, it } from "vitest";
import { LoopDetector } from "../../agent/loop-detector.js";

describe("agent/LoopDetector", () => {
  it("blocks identical calls on the configured repetition threshold", () => {
    const detector = new LoopDetector({ maxIdenticalCalls: 3 });
    expect(detector.recordToolCall("exec", '{"command":"echo hi"}').blocked).toBe(false);
    expect(detector.recordToolCall("exec", '{"command":"echo hi"}').blocked).toBe(false);
    const result = detector.recordToolCall("exec", '{"command":"echo hi"}');
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("identical arguments 3 times");
  });

  it("does not block the same tool when arguments change", () => {
    const detector = new LoopDetector({ maxIdenticalCalls: 3 });
    expect(detector.recordToolCall("exec", '{"command":"echo a"}').blocked).toBe(false);
    expect(detector.recordToolCall("exec", '{"command":"echo b"}').blocked).toBe(false);
    expect(detector.recordToolCall("exec", '{"command":"echo c"}').blocked).toBe(false);
  });

  it("warns on repeated turn patterns and blocks when ignored", () => {
    const detector = new LoopDetector();
    for (let i = 0; i < 2; i++) {
      detector.recordToolCall("exec", '{"command":"echo hi"}');
      expect(detector.endTurn().reason).toBe("");
    }

    detector.recordToolCall("exec", '{"command":"echo hi"}');
    const warning = detector.endTurn();
    expect(warning.blocked).toBe(false);
    expect(warning.reason).toContain("repeated the tool pattern");

    detector.recordToolCall("exec", '{"command":"echo hi"}');
    const blocked = detector.endTurn();
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("LOOP ENFORCEMENT");
  });

  it("flags idle-only streaks and reset clears state", () => {
    const detector = new LoopDetector({ maxIdleOnlyTurns: 3 });
    detector.recordToolCall("check_credits", '{}');
    expect(detector.endTurn().reason).toBe("");

    detector.recordToolCall("git_status", '{}');
    expect(detector.endTurn().reason).toBe("");

    detector.recordToolCall("list_models", '{}');
    const result = detector.endTurn();
    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("IDLE LOOP DETECTED");

    detector.reset();
    detector.recordToolCall("exec", '{"command":"echo ok"}');
    expect(detector.endTurn().reason).toBe("");
  });

  it("treats read_file as investigative work, not an idle-only turn", () => {
    const detector = new LoopDetector({ maxIdleOnlyTurns: 2 });

    detector.recordToolCall("read_file", '{"path":"README.md"}');
    expect(detector.endTurn().reason).toBe("");

    detector.recordToolCall("check_credits", '{}');
    expect(detector.endTurn().reason).toBe("");

    detector.recordToolCall("list_models", '{}');
    expect(detector.endTurn().reason).toContain("IDLE LOOP DETECTED");
  });
});
