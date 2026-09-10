import { describe, expect, it } from "vitest";
import { isSolanaRequirement } from "../chain-utils/x402.js";

describe("x402 Solana selection", () => {
  it("selects SVM payment handling only for Solana requirements", () => {
    expect(isSolanaRequirement({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" } as any)).toBe(true);
    expect(isSolanaRequirement({ network: "eip155:8453" } as any)).toBe(false);
  });
});
