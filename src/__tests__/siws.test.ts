/**
 * Tests for SIWS (Sign-In With Solana)
 */

import { describe, it, expect } from "vitest";
import { buildSiwsMessage, signSiwsMessage, verifySiwsSignature } from "../identity/siws.js";
import { SolanaChainIdentity } from "../identity/chain.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

describe("SIWS", () => {
  describe("buildSiwsMessage", () => {
    it("builds a valid SIWS message", () => {
      const msg = buildSiwsMessage({
        domain: "example.com",
        address: "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy",
        statement: "Sign in as an Automaton.",
        uri: "https://api.example.com/v1/auth/verify",
        nonce: "abc123",
        issuedAt: "2025-01-01T00:00:00.000Z",
        chainId: "mainnet",
      });

      expect(msg).toContain("example.com wants you to sign in with your Solana account:");
      expect(msg).toContain("DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy");
      expect(msg).toContain("Sign in as an Automaton.");
      expect(msg).toContain("URI: https://api.example.com/v1/auth/verify");
      expect(msg).toContain("Nonce: abc123");
      expect(msg).toContain("Issued At: 2025-01-01T00:00:00.000Z");
      expect(msg).toContain("Chain ID: mainnet");
    });
  });

  describe("signSiwsMessage + verifySiwsSignature", () => {
    it("signs and verifies a SIWS message", async () => {
      const keypair = nacl.sign.keyPair();
      const address = bs58.encode(keypair.publicKey);
      const identity = new SolanaChainIdentity(keypair.secretKey);

      const message = buildSiwsMessage({
        domain: "example.com",
        address,
        statement: "Test sign in",
        uri: "https://api.example.com/v1/auth/verify",
        nonce: "test-nonce",
        issuedAt: new Date().toISOString(),
        chainId: "mainnet",
      });

      const signature = await signSiwsMessage(message, identity);

      // Verify the signature
      const valid = verifySiwsSignature(message, signature, address);
      expect(valid).toBe(true);

      // Verify with wrong address fails
      const otherKeypair = nacl.sign.keyPair();
      const otherAddress = bs58.encode(otherKeypair.publicKey);
      expect(verifySiwsSignature(message, signature, otherAddress)).toBe(false);

      // Verify with tampered message fails
      expect(verifySiwsSignature(message + "tampered", signature, address)).toBe(false);
    });
  });

  describe("verifySiwsSignature edge cases", () => {
    it("returns false for invalid signature length", () => {
      expect(verifySiwsSignature("msg", "short", "addr")).toBe(false);
    });

    it("returns false for invalid base58", () => {
      expect(verifySiwsSignature("msg", "0000", "0000")).toBe(false);
    });
  });
});
