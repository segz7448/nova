import { describe, expect, it } from "vitest";
import { assertSafeRemoteUrl } from "../security/safe-remote-url.js";

describe("assertSafeRemoteUrl", () => {
  it("rejects loopback and link-local targets before making a request", async () => {
    await expect(assertSafeRemoteUrl("http://127.0.0.1/skill.md")).rejects.toThrow("private or loopback");
    await expect(assertSafeRemoteUrl("http://169.254.169.254/latest")).rejects.toThrow("private or loopback");
  });
});
