/**
 * Social Signing Module
 *
 * THE SINGLE canonical signing implementation for both runtime + CLI.
 * Supports both EVM (ECDSA secp256k1 via viem) and Solana (Ed25519 via tweetnacl).
 *
 * Phase 3.2: Social & Registry Hardening (S-P0-1)
 */

import {
  type PrivateKeyAccount,
  keccak256,
  toBytes,
} from "viem";
import type { SignedMessagePayload } from "../types.js";
import type { ChainIdentity } from "../identity/chain.js";

export const MESSAGE_LIMITS = {
  maxContentLength: 64_000, // 64KB
  maxTotalSize: 128_000, // 128KB
  replayWindowMs: 300_000, // 5 minutes
  maxOutboundPerHour: 100,
} as const;

/**
 * Sign a send message payload.
 *
 * Canonical format: Automaton:send:{to_lowercase}:{keccak256(toBytes(content))}:{signed_at_iso}
 *
 * Accepts either a PrivateKeyAccount (EVM backward compat) or a ChainIdentity (both chains).
 */
export async function signSendPayload(
  signer: PrivateKeyAccount | ChainIdentity,
  to: string,
  content: string,
  replyTo?: string,
): Promise<SignedMessagePayload> {
  if (content.length > MESSAGE_LIMITS.maxContentLength) {
    throw new Error(
      `Message content too long: ${content.length} bytes (max ${MESSAGE_LIMITS.maxContentLength})`,
    );
  }

  const signedAt = new Date().toISOString();
  const contentHash = keccak256(toBytes(content));

  // Solana addresses are case-sensitive (base58); only lowercase EVM addresses
  // Solana addresses are case-sensitive (base58); only lowercase EVM addresses
  const isSolana = "signMessage" in signer && "chainType" in signer
    && (signer as ChainIdentity).chainType === "solana";
  const { detectChainType } = await import("../identity/chain.js");
  const recipientChainType = detectChainType(to);
  const normalizedTo = recipientChainType === "solana" ? to : to.toLowerCase();
  const canonical = `Automaton:send:${normalizedTo}:${contentHash}:${signedAt}`;

  let signature: string;
  let fromAddress: string;

  if ("signMessage" in signer && "chainType" in signer) {
    // ChainIdentity path (both EVM and Solana)
    const identity = signer as ChainIdentity;
    signature = await identity.signMessage(canonical);
    fromAddress = identity.chainType === "solana" ? identity.address : identity.address.toLowerCase();
  } else {
    // PrivateKeyAccount path (EVM backward compat)
    const account = signer as PrivateKeyAccount;
    signature = await account.signMessage({ message: canonical });
    fromAddress = account.address.toLowerCase();
  }

  return {
    from: fromAddress,
    to: normalizedTo,
    content,
    signed_at: signedAt,
    signature,
    reply_to: replyTo,
  };
}

/**
 * Sign a poll payload.
 *
 * Canonical format: Automaton:poll:{address_lowercase}:{timestamp_iso}
 *
 * Accepts either a PrivateKeyAccount (EVM backward compat) or a ChainIdentity (both chains).
 */
export async function signPollPayload(
  signer: PrivateKeyAccount | ChainIdentity,
): Promise<{ address: string; signature: string; timestamp: string }> {
  const timestamp = new Date().toISOString();

  let signature: string;
  let address: string;

  if ("signMessage" in signer && "chainType" in signer) {
    // ChainIdentity path
    const identity = signer as ChainIdentity;
    address = identity.chainType === "solana" ? identity.address : identity.address.toLowerCase();
    const canonical = `Automaton:poll:${address}:${timestamp}`;
    signature = await identity.signMessage(canonical);
  } else {
    // PrivateKeyAccount path (EVM backward compat)
    const account = signer as PrivateKeyAccount;
    address = account.address.toLowerCase();
    const canonical = `Automaton:poll:${address}:${timestamp}`;
    signature = await account.signMessage({ message: canonical });
  }

  return {
    address,
    signature,
    timestamp,
  };
}

// ─── Groups ("meeting rooms") ────────────────────────────────────────
// Same signer shapes as above, mirroring backend/src/socialCrypto.ts's
// canonical* builders byte-for-byte. Every group action gets its own
// namespaced canonical string (Automaton:group:<action>:...) so a
// signature collected for one purpose can never be replayed for
// another — same reasoning the personal-relay canonicals above follow.

async function signWith(
  signer: PrivateKeyAccount | ChainIdentity,
  canonical: string,
): Promise<{ address: string; signature: string }> {
  if ("signMessage" in signer && "chainType" in signer) {
    const identity = signer as ChainIdentity;
    const address = identity.chainType === "solana" ? identity.address : identity.address.toLowerCase();
    const signature = await identity.signMessage(canonical);
    return { address, signature };
  }
  const account = signer as PrivateKeyAccount;
  const signature = await account.signMessage({ message: canonical });
  return { address: account.address.toLowerCase(), signature };
}

export async function signGroupCreatePayload(
  signer: PrivateKeyAccount | ChainIdentity,
  name: string,
  description?: string,
): Promise<{ name: string; description?: string; signed_at: string; signature: string; from: string }> {
  const signedAt = new Date().toISOString();
  const canonical = `Automaton:group:create:${keccak256(toBytes(name))}:${signedAt}`;
  const { address, signature } = await signWith(signer, canonical);
  return { name, description, signed_at: signedAt, signature, from: address };
}

async function normalizeCounterparty(address: string): Promise<string> {
  const { detectChainType } = await import("../identity/chain.js");
  return detectChainType(address) === "solana" ? address : address.toLowerCase();
}

export async function signGroupAddMemberPayload(
  signer: PrivateKeyAccount | ChainIdentity,
  groupId: string,
  memberAddress: string,
): Promise<{ member_address: string; signed_at: string; signature: string; from: string }> {
  const signedAt = new Date().toISOString();
  const normalizedMember = await normalizeCounterparty(memberAddress);
  const canonical = `Automaton:group:add_member:${groupId}:${normalizedMember}:${signedAt}`;
  const { address, signature } = await signWith(signer, canonical);
  return { member_address: normalizedMember, signed_at: signedAt, signature, from: address };
}

export async function signGroupRemoveMemberAuth(
  signer: PrivateKeyAccount | ChainIdentity,
  groupId: string,
  memberAddress: string,
): Promise<{ address: string; signature: string; timestamp: string }> {
  const timestamp = new Date().toISOString();
  const normalizedMember = await normalizeCounterparty(memberAddress);
  const canonical = `Automaton:group:remove_member:${groupId}:${normalizedMember}:${timestamp}`;
  const { address, signature } = await signWith(signer, canonical);
  return { address, signature, timestamp };
}

export async function signGroupSendPayload(
  signer: PrivateKeyAccount | ChainIdentity,
  groupId: string,
  content: string,
  replyTo?: string,
): Promise<{ content: string; reply_to?: string; signed_at: string; signature: string; from: string }> {
  if (content.length > MESSAGE_LIMITS.maxContentLength) {
    throw new Error(`Message content too long: ${content.length} bytes (max ${MESSAGE_LIMITS.maxContentLength})`);
  }
  const signedAt = new Date().toISOString();
  const canonical = `Automaton:group:send:${groupId}:${keccak256(toBytes(content))}:${signedAt}`;
  const { address, signature } = await signWith(signer, canonical);
  return { content, reply_to: replyTo, signed_at: signedAt, signature, from: address };
}

function deriveAddress(signer: PrivateKeyAccount | ChainIdentity): string {
  if ("signMessage" in signer && "chainType" in signer) {
    const identity = signer as ChainIdentity;
    return identity.chainType === "solana" ? identity.address : identity.address.toLowerCase();
  }
  return (signer as PrivateKeyAccount).address.toLowerCase();
}

export async function signGroupPollAuth(
  signer: PrivateKeyAccount | ChainIdentity,
  groupId: string,
): Promise<{ address: string; signature: string; timestamp: string }> {
  const timestamp = new Date().toISOString();
  const address = deriveAddress(signer);
  const canonical = `Automaton:group:poll:${groupId}:${address}:${timestamp}`;
  const { signature } = await signWith(signer, canonical);
  return { address, signature, timestamp };
}

export async function signIdentityAuth(
  signer: PrivateKeyAccount | ChainIdentity,
): Promise<{ address: string; signature: string; timestamp: string }> {
  const timestamp = new Date().toISOString();
  const address = deriveAddress(signer);
  const canonical = `Automaton:identity:${address}:${timestamp}`;
  const { signature } = await signWith(signer, canonical);
  return { address, signature, timestamp };
}

/** Self- or parent-attested death report. `targetAddress` defaults to the signer's own address. */
export async function signAgentDeathPayload(
  signer: PrivateKeyAccount | ChainIdentity,
  targetAddress?: string,
): Promise<{ target: string; signed_at: string; signature: string; from: string }> {
  const signedAt = new Date().toISOString();
  const selfAddress = deriveAddress(signer);
  const target = (targetAddress ?? selfAddress).toLowerCase();
  const canonical = `Automaton:agent:death:${target}:${signedAt}`;
  const { signature } = await signWith(signer, canonical);
  return { target, signed_at: signedAt, signature, from: selfAddress };
}
