import { describe, expect, it, vi } from "vitest";
import { createWorkerInferenceBridge } from "../../agent/worker-inference-bridge.js";

describe("agent/worker-inference-bridge", () => {
  it("forwards tier, responseFormat, tools, and token settings to unified inference", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: '{"analysis":"ok"}',
      toolCalls: [
        {
          id: "tool-1",
          type: "function",
          function: { name: "delegate_task", arguments: "{}" },
        },
      ],
    });

    const bridge = createWorkerInferenceBridge({ chat } as any);
    const result = await bridge.chat({
      tier: "reasoning",
      messages: [{ role: "system", content: "# Planner Agent" }],
      tools: [{ type: "function", function: { name: "delegate_task", description: "delegate", parameters: { type: "object", properties: {} } } }],
      maxTokens: 123,
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    });

    expect(chat).toHaveBeenCalledWith({
      tier: "reasoning",
      messages: [{ role: "system", content: "# Planner Agent" }],
      tools: [{ type: "function", function: { name: "delegate_task", description: "delegate", parameters: { type: "object", properties: {} } } }],
      maxTokens: 123,
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    });
    expect(result.content).toBe('{"analysis":"ok"}');
    expect(result.toolCalls?.[0].function.name).toBe("delegate_task");
  });

  it("defaults tier to fast when omitted", async () => {
    const chat = vi.fn().mockResolvedValue({ content: "ok", toolCalls: [] });
    const bridge = createWorkerInferenceBridge({ chat } as any);

    await bridge.chat({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(chat).toHaveBeenCalledWith({
      tier: "fast",
      messages: [{ role: "user", content: "hello" }],
      tools: undefined,
      maxTokens: undefined,
      temperature: undefined,
      responseFormat: undefined,
    });
  });
});
