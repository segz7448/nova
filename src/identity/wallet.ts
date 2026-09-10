/**
 * Automaton Wallet Management
 *
 * Creates and manages wallets for the automaton's identity and payments.
 * Supports both EVM (secp256k1/viem) and Solana (Ed25519/tweetnacl) wallets.
 * The private key is the automaton's sovereign identity.
 * Chain type is chosen at genesis and never changes.
 */

import type { PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import nacl from "tweetnacl";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import type { WalletData } from "../types.js";
import type { ChainType } from "./chain.js";
import { EvmChainIdentity, SolanaChainIdentity } from "./chain.js";
import type { ChainIdentity } from "./chain.js";

/** Compatibility metadata for legacy consumers; never use it for signing. */
function createSolanaCompatibilityAccount(address: string): PrivateKeyAccount {
  const fail = () => { throw new Error("Solana signing requires chainIdentity."); };
  return {
    address: address as any,
    publicKey: "0x" as any,
    source: "custom",
    type: "local",
    sign: fail as any,
    signMessage: fail as any,
    signTypedData: fail as any,
    signTransaction: fail as any,
    // Required by viem's LocalAccount as of the EIP-7702 signAuthorization
    // addition; this stub account never signs anything for real (see the
    // other methods above), so it throws the same way they do.
    signAuthorization: fail as any,
    // This is a type-shape compatibility shim for a Solana-backed identity,
    // not an actual viem private-key account, so `source` is honestly
    // "custom" rather than "privateKey" — the two types don't really
    // overlap. Route through `unknown` (as TS's own diagnostic suggests)
    // instead of pretending they do.
  } as unknown as PrivateKeyAccount;
}

// PHASE-17D-IV: previously hardcoded to `${HOME}/.automaton` with no
// override point anywhere in this codebase. That's fine for a single
// human-operated automaton on its own machine, but breaks for a
// pipeline-spawned company (genesis.ts's genesisCompany()) and for any
// host that runs more than one agent process at once — every such
// process would resolve the exact same directory and stomp on each
// other's wallet.json/automaton.json. AUTOMATON_CONFIG_DIR lets a
// caller (orchestrator.ts's spawnAgentProcess()/
// spawnAgentProcessTickOnce(), or genesis.ts's own provisioning step)
// give each agent process its own home explicitly; falls back to the
// original $HOME-based default when unset, so a normal, single-agent,
// human-operated `automaton --run` is unaffected.
const AUTOMATON_DIR = process.env.AUTOMATON_CONFIG_DIR
  ? path.resolve(process.env.AUTOMATON_CONFIG_DIR)
  : path.join(process.env.HOME || "/root", ".automaton");
const WALLET_FILE = path.join(AUTOMATON_DIR, "wallet.json");

export function getAutomatonDir(): string {
  return AUTOMATON_DIR;
}

export function getWalletPath(): string {
  return WALLET_FILE;
}

/**
 * Generate a Solana Ed25519 keypair.
 * Returns the 64-byte secret key (first 32 = private, last 32 = public).
 */
export function generateSolanaKeypair(): { secretKey: Uint8Array; publicKey: Uint8Array; address: string } {
  const keypair = nacl.sign.keyPair();
  return {
    secretKey: keypair.secretKey,
    publicKey: keypair.publicKey,
    address: bs58.encode(keypair.publicKey),
  };
}

/**
 * Get or create the automaton's wallet.
 * The private key IS the automaton's identity -- protect it.
 *
 * @param chainType - If creating a new wallet, which chain to use. Defaults to "evm".
 */
export async function getWallet(chainType?: ChainType): Promise<{
  account: PrivateKeyAccount;
  chainIdentity: ChainIdentity;
  chainType: ChainType;
  isNew: boolean;
}> {
  if (!fs.existsSync(AUTOMATON_DIR)) {
    fs.mkdirSync(AUTOMATON_DIR, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(WALLET_FILE)) {
    const walletData: WalletData = JSON.parse(
      fs.readFileSync(WALLET_FILE, "utf-8"),
    );
    const resolvedChainType = walletData.chainType || "evm";

    if (resolvedChainType === "solana" && walletData.secretKey) {
      const secretKey = bs58.decode(walletData.secretKey);
      const solanaIdentity = new SolanaChainIdentity(secretKey);
      return { account: createSolanaCompatibilityAccount(solanaIdentity.address), chainIdentity: solanaIdentity, chainType: "solana", isNew: false };
    }

    // EVM path (default)
    const account = privateKeyToAccount(walletData.privateKey!);
    return { account, chainIdentity: new EvmChainIdentity(account), chainType: "evm", isNew: false };
  }

  // Create new wallet
  const resolvedChain = chainType || "evm";

  if (resolvedChain === "solana") {
    const { secretKey, address } = generateSolanaKeypair();
    const solanaIdentity = new SolanaChainIdentity(secretKey);

    const walletData: WalletData = {
      chainType: "solana",
      secretKey: bs58.encode(secretKey),
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), {
      mode: 0o600,
    });

    return { account: createSolanaCompatibilityAccount(address), chainIdentity: solanaIdentity, chainType: "solana", isNew: true };
  }

  // EVM wallet
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const walletData: WalletData = {
    chainType: "evm",
    privateKey,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), {
    mode: 0o600,
  });

  return { account, chainIdentity: new EvmChainIdentity(account), chainType: "evm", isNew: true };
}

/**
 * Get the wallet address without loading the full account.
 */
export function getWalletAddress(): string | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const walletData: WalletData = JSON.parse(
    fs.readFileSync(WALLET_FILE, "utf-8"),
  );

  if (walletData.chainType === "solana" && walletData.secretKey) {
    const secretKey = bs58.decode(walletData.secretKey);
    const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    return bs58.encode(keypair.publicKey);
  }

  const account = privateKeyToAccount(walletData.privateKey!);
  return account.address;
}

/**
 * Load the full wallet account (needed for signing).
 * For Solana wallets, returns a proxy account.
 */
export function loadWalletAccount(): PrivateKeyAccount | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const walletData: WalletData = JSON.parse(
    fs.readFileSync(WALLET_FILE, "utf-8"),
  );

  if (walletData.chainType === "solana") {
    // Solana wallets don't have a PrivateKeyAccount; callers should use getWallet() instead
    return null;
  }

  return privateKeyToAccount(walletData.privateKey!);
}

/**
 * Get the chain type from the wallet file.
 */
export function getWalletChainType(): ChainType {
  if (!fs.existsSync(WALLET_FILE)) {
    return "evm";
  }
  try {
    const walletData: WalletData = JSON.parse(
      fs.readFileSync(WALLET_FILE, "utf-8"),
    );
    return walletData.chainType || "evm";
  } catch {
    return "evm";
  }
}

export function walletExists(): boolean {
  return fs.existsSync(WALLET_FILE);
}
