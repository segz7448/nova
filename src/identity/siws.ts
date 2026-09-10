/**
 * Sign-In With Solana (SIWS)
 *
 * Builds and signs SIWS messages for Solana automaton provisioning.
 * Ported from aiws control-plane siws.ts.
 */

import nacl from "tweetnacl";
import bs58 from "bs58";
import type { ChainIdentity } from "./chain.js";

export interface SiwsMessage {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  nonce: string;
  issuedAt: string;
  chainId: string;
}

export function buildSiwsMessage(params: SiwsMessage): string {
  return `${params.domain} wants you to sign in with your Solana account:
${params.address}

${params.statement}

URI: ${params.uri}
Nonce: ${params.nonce}
Issued At: ${params.issuedAt}
Chain ID: ${params.chainId}`;
}

/**
 * Sign a SIWS message using a ChainIdentity (must be Solana).
 * Returns the base58-encoded detached signature.
 */
export async function signSiwsMessage(
  message: string,
  identity: ChainIdentity,
): Promise<string> {
  return identity.signMessage(message);
}

/**
 * Verify a SIWS signature.
 */
export function verifySiwsSignature(
  message: string,
  signatureBase58: string,
  addressBase58: string,
): boolean {
  try {
    const signatureBytes = bs58.decode(signatureBase58);
    const publicKeyBytes = bs58.decode(addressBase58);

    if (signatureBytes.length !== 64 || publicKeyBytes.length !== 32) {
      return false;
    }

    const messageBytes = new TextEncoder().encode(message);

    return nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKeyBytes,
    );
  } catch {
    return false;
  }
}
