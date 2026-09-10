/**
 * Chain Abstraction Layer
 *
 * Chain-at-genesis selection: an automaton picks `evm` or `solana` at setup
 * time and keeps that identity forever. The wallet IS the sovereign identity.
 *
 * Ported from aiws control-plane wallet.ts + siws.ts utilities.
 */

import type { PrivateKeyAccount } from "viem";
import nacl from "tweetnacl";
import bs58 from "bs58";

// ─── Chain Type ──────────────────────────────────────────────

export type ChainType = "evm" | "solana";

// ─── Address Validation ──────────────────────────────────────

export function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function isValidSolanaAddress(address: string): boolean {
  try {
    return bs58.decode(address).length === 32;
  } catch {
    return false;
  }
}

export function isValidAddress(address: string, chainType?: ChainType): boolean {
  if (chainType === "evm") return isValidEvmAddress(address);
  if (chainType === "solana") return isValidSolanaAddress(address);
  return isValidEvmAddress(address) || isValidSolanaAddress(address);
}

export function detectChainType(address: string): ChainType | null {
  if (isValidEvmAddress(address)) return "evm";
  if (isValidSolanaAddress(address)) return "solana";
  return null;
}

export function normalizeAddress(address: string, chain: ChainType): string {
  return chain === "evm" ? address.toLowerCase() : address;
}

// ─── Chain Identity Interface ────────────────────────────────

/**
 * Chain-agnostic identity interface.
 * Wraps either a viem PrivateKeyAccount (EVM) or an Ed25519 keypair (Solana).
 */
export interface ChainIdentity {
  readonly chainType: ChainType;
  readonly address: string;
  signMessage(message: string): Promise<string>;
}

/**
 * EVM chain identity wrapping a viem PrivateKeyAccount.
 */
export class EvmChainIdentity implements ChainIdentity {
  readonly chainType: ChainType = "evm";
  readonly address: string;
  readonly account: PrivateKeyAccount;

  constructor(account: PrivateKeyAccount) {
    this.account = account;
    this.address = account.address;
  }

  async signMessage(message: string): Promise<string> {
    return this.account.signMessage({ message });
  }
}

/**
 * Solana chain identity wrapping a tweetnacl Ed25519 keypair.
 */
export class SolanaChainIdentity implements ChainIdentity {
  readonly chainType: ChainType = "solana";
  readonly address: string;
  private readonly keypair: nacl.SignKeyPair;

  constructor(secretKey: Uint8Array) {
    this.keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    this.address = bs58.encode(this.keypair.publicKey);
  }

  async signMessage(message: string): Promise<string> {
    const messageBytes = new TextEncoder().encode(message);
    const signature = nacl.sign.detached(messageBytes, this.keypair.secretKey);
    return bs58.encode(signature);
  }

  /** Get the raw 64-byte secret key for serialization. */
  getSecretKey(): Uint8Array {
    return this.keypair.secretKey;
  }

  /** Get the raw 32-byte public key. */
  getPublicKey(): Uint8Array {
    return this.keypair.publicKey;
  }
}
