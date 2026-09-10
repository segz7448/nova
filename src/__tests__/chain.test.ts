/**
 * Tests for Chain Abstraction Layer
 */

import { describe, it, expect } from "vitest";
import {
  detectChainType,
  isValidEvmAddress,
  isValidSolanaAddress,
  isValidAddress,
  normalizeAddress,
  EvmChainIdentity,
  SolanaChainIdentity,
} from "../identity/chain.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

describe("Chain Abstraction", () => {
  describe("isValidEvmAddress", () => {
    it("accepts valid EVM addresses", () => {
      expect(isValidEvmAddress("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28")).toBe(true);
      expect(isValidEvmAddress("0x0000000000000000000000000000000000000001")).toBe(true);
    });

    it("rejects invalid EVM addresses", () => {
      expect(isValidEvmAddress("0x742d35")).toBe(false);
      expect(isValidEvmAddress("not-an-address")).toBe(false);
      expect(isValidEvmAddress("")).toBe(false);
    });
  });

  describe("isValidSolanaAddress", () => {
    it("accepts valid Solana addresses", () => {
      const keypair = nacl.sign.keyPair();
      const address = bs58.encode(keypair.publicKey);
      expect(isValidSolanaAddress(address)).toBe(true);
    });

    it("rejects invalid Solana addresses", () => {
      expect(isValidSolanaAddress("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28")).toBe(false);
      expect(isValidSolanaAddress("")).toBe(false);
      expect(isValidSolanaAddress("short")).toBe(false);
    });
  });

  describe("isValidAddress", () => {
    it("validates by chain type", () => {
      expect(isValidAddress("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28", "evm")).toBe(true);
      expect(isValidAddress("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28", "solana")).toBe(false);

      const keypair = nacl.sign.keyPair();
      const solAddress = bs58.encode(keypair.publicKey);
      expect(isValidAddress(solAddress, "solana")).toBe(true);
      expect(isValidAddress(solAddress, "evm")).toBe(false);
    });

    it("auto-detects without chain type", () => {
      expect(isValidAddress("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28")).toBe(true);
      const keypair = nacl.sign.keyPair();
      const solAddress = bs58.encode(keypair.publicKey);
      expect(isValidAddress(solAddress)).toBe(true);
    });
  });

  describe("detectChainType", () => {
    it("detects EVM addresses", () => {
      expect(detectChainType("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28")).toBe("evm");
    });

    it("detects Solana addresses", () => {
      const keypair = nacl.sign.keyPair();
      const address = bs58.encode(keypair.publicKey);
      expect(detectChainType(address)).toBe("solana");
    });

    it("returns null for invalid addresses", () => {
      expect(detectChainType("invalid")).toBe(null);
      expect(detectChainType("")).toBe(null);
    });
  });

  describe("normalizeAddress", () => {
    it("lowercases EVM addresses", () => {
      expect(normalizeAddress("0xABCD1234567890abcdef1234567890ABCDEF1234", "evm"))
        .toBe("0xabcd1234567890abcdef1234567890abcdef1234");
    });

    it("preserves Solana addresses", () => {
      const addr = "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy";
      expect(normalizeAddress(addr, "solana")).toBe(addr);
    });
  });

  describe("EvmChainIdentity", () => {
    it("wraps a viem account", async () => {
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      const identity = new EvmChainIdentity(account);

      expect(identity.chainType).toBe("evm");
      expect(identity.address).toBe(account.address);

      const sig = await identity.signMessage("test");
      expect(sig).toMatch(/^0x/);
    });
  });

  describe("SolanaChainIdentity", () => {
    it("wraps a tweetnacl keypair", async () => {
      const keypair = nacl.sign.keyPair();
      const identity = new SolanaChainIdentity(keypair.secretKey);

      expect(identity.chainType).toBe("solana");
      expect(identity.address).toBe(bs58.encode(keypair.publicKey));

      const sig = await identity.signMessage("test");
      // Verify the signature is valid base58
      const sigBytes = bs58.decode(sig);
      expect(sigBytes.length).toBe(64);

      // Verify the signature
      const msgBytes = new TextEncoder().encode("test");
      const valid = nacl.sign.detached.verify(msgBytes, sigBytes, keypair.publicKey);
      expect(valid).toBe(true);
    });
  });
});
