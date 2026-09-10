/**
 * x402 Payment Protocol
 *
 * Enables the automaton to make USDC micropayments via HTTP 402.
 * Adapted from backend-mcp/src/x402/index.ts
 */

import {
  createPublicClient,
  http,
  parseUnits,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { ResilientHttpClient } from "./http-client.js";
import type { ChainType } from "../identity/chain.js";
import type { ChainIdentity } from "../identity/chain.js";
import { SolanaChainIdentity, isValidEvmAddress } from "../identity/chain.js";

const x402HttpClient = new ResilientHttpClient();

// USDC contract addresses
const USDC_ADDRESSES: Record<string, Address> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

const CHAINS: Record<string, any> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};
type NetworkId = keyof typeof USDC_ADDRESSES;

const BALANCE_OF_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface PaymentRequirement {
  scheme: string;
  network: NetworkId | `solana:${string}`;
  maxAmountRequired: string;
  payToAddress: Address;
  requiredDeadlineSeconds: number;
  usdcAddress: Address;
}

interface PaymentRequiredResponse {
  x402Version: number;
  accepts: PaymentRequirement[];
}

interface ParsedPaymentRequirement {
  x402Version: number;
  requirement: PaymentRequirement;
}

interface X402PaymentResult {
  success: boolean;
  response?: any;
  error?: string;
  status?: number;
}

export interface UsdcBalanceResult {
  balance: number;
  network: string;
  ok: boolean;
  error?: string;
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function normalizeNetwork(raw: unknown): (NetworkId | `solana:${string}`) | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "base") return "eip155:8453";
  if (normalized === "base-sepolia") return "eip155:84532";
  if (normalized === "eip155:8453" || normalized === "eip155:84532") {
    return normalized;
  }
  if (/^solana:[1-9a-hj-np-z]+$/i.test(normalized)) return normalized as `solana:${string}`;
  return null;
}

function normalizePaymentRequirement(raw: unknown): PaymentRequirement | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const network = normalizeNetwork(value.network);
  if (!network) return null;

  const scheme = typeof value.scheme === "string" ? value.scheme : null;
  const maxAmountRequired = typeof value.maxAmountRequired === "string"
    ? value.maxAmountRequired
    : typeof value.maxAmountRequired === "number" &&
        Number.isFinite(value.maxAmountRequired)
      ? String(value.maxAmountRequired)
      : null;
  const payToAddress = typeof value.payToAddress === "string"
    ? value.payToAddress
    : typeof value.payTo === "string"
      ? value.payTo
      : null;
  const usdcAddress = typeof value.usdcAddress === "string"
    ? value.usdcAddress
    : typeof value.asset === "string"
      ? value.asset
    : network.startsWith("solana:") ? SOLANA_USDC_MINT : USDC_ADDRESSES[network];
  const requiredDeadlineSeconds =
    parsePositiveInt(value.requiredDeadlineSeconds) ??
    parsePositiveInt(value.maxTimeoutSeconds) ??
    300;

  if (!scheme || !maxAmountRequired || !payToAddress || !usdcAddress) {
    return null;
  }

  return {
    scheme,
    network,
    maxAmountRequired,
    payToAddress: payToAddress as Address,
    requiredDeadlineSeconds,
    usdcAddress: usdcAddress as Address,
  };
}

function normalizePaymentRequired(raw: unknown): PaymentRequiredResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.accepts)) return null;

  const accepts = value.accepts
    .map(normalizePaymentRequirement)
    .filter((v): v is PaymentRequirement => v !== null);
  if (!accepts.length) return null;

  const x402Version = parsePositiveInt(value.x402Version) ?? 1;
  return { x402Version, accepts };
}

function parseMaxAmountRequired(maxAmountRequired: string, x402Version: number): bigint {
  const amount = maxAmountRequired.trim();
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`Invalid maxAmountRequired: ${maxAmountRequired}`);
  }

  if (amount.includes(".")) {
    return parseUnits(amount, 6);
  }
  if (x402Version >= 2 || amount.length > 6) {
    return BigInt(amount);
  }
  return parseUnits(amount, 6);
}

function selectRequirement(parsed: PaymentRequiredResponse): PaymentRequirement {
  const exactSupported = parsed.accepts.find(
    (r) => r.scheme === "exact" && (isSolanaRequirement(r) || !!CHAINS[r.network as NetworkId]),
  );
  if (exactSupported) return exactSupported;
  return parsed.accepts[0];
}

/** Solana USDC mint address (mainnet). */
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Get the USDC balance for the automaton's wallet on a given network.
 * Supports both EVM (Base) and Solana networks.
 */
export async function getUsdcBalance(
  address: string,
  network: string = "eip155:8453",
  chainType?: ChainType,
): Promise<number> {
  if (chainType === "solana" || network === "solana:mainnet") {
    return getSolanaUsdcBalance(address);
  }
  const result = await getUsdcBalanceDetailed(address as Address, network);
  return result.balance;
}

/**
 * Get the USDC balance on Solana using @solana/web3.js.
 */
async function getSolanaUsdcBalance(address: string): Promise<number> {
  try {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");
    const ownerPubkey = new PublicKey(address);
    const mintPubkey = new PublicKey(SOLANA_USDC_MINT);

    // Find associated token account for USDC
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      ownerPubkey,
      { mint: mintPubkey },
    );

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    // Sum all USDC token accounts (usually just one)
    let totalBalance = 0;
    for (const account of tokenAccounts.value) {
      const parsed = account.account.data.parsed;
      if (parsed?.info?.tokenAmount?.uiAmount != null) {
        totalBalance += parsed.info.tokenAmount.uiAmount;
      }
    }

    return totalBalance;
  } catch (err: any) {
    throw new Error(`Solana USDC balance check failed: ${err?.message || String(err)}`);
  }
}

/**
 * Get the USDC balance and read status details for diagnostics.
 */
export async function getUsdcBalanceDetailed(
  address: Address,
  network: string = "eip155:8453",
): Promise<UsdcBalanceResult> {
  const chain = CHAINS[network];
  const usdcAddress = USDC_ADDRESSES[network];
  if (!chain || !usdcAddress) {
    return {
      balance: 0,
      network,
      ok: false,
      error: `Unsupported USDC network: ${network}`,
    };
  }

  try {
    const rpcUrl = process.env.AUTOMATON_RPC_URL || undefined;
    const client = createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout: 10_000 }),
    });

    const balance = await client.readContract({
      address: usdcAddress,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address],
    });

    // USDC has 6 decimals
    return {
      balance: Number(balance) / 1_000_000,
      network,
      ok: true,
    };
  } catch (err: any) {
    return {
      balance: 0,
      network,
      ok: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Check if a URL requires x402 payment.
 */
export async function checkX402(
  url: string,
): Promise<PaymentRequirement | null> {
  try {
    const resp = await x402HttpClient.request(url, { method: "HEAD" });
    if (resp.status !== 402) {
      return null;
    }
    const parsed = await parsePaymentRequired(resp);
    return parsed?.requirement ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL with automatic x402 payment.
 * If the endpoint returns 402, sign and pay, then retry.
 */
export async function x402Fetch(
  url: string,
  signer: PrivateKeyAccount | ChainIdentity,
  method: string = "GET",
  body?: string,
  headers?: Record<string, string>,
  maxPaymentCents?: number,
): Promise<X402PaymentResult> {
  try {
    // Initial request (non-mutating probe, uses resilient client)
    const initialResp = await x402HttpClient.request(url, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });

    if (initialResp.status !== 402) {
      const data = await initialResp
        .json()
        .catch(() => initialResp.text());
      return { success: initialResp.ok, response: data, status: initialResp.status };
    }

    // Parse payment requirements
    const parsed = await parsePaymentRequired(initialResp);
    if (!parsed) {
      return {
        success: false,
        error: "Could not parse payment requirements",
        status: initialResp.status,
      };
    }

    // Check amount against maxPaymentCents BEFORE signing
    if (maxPaymentCents !== undefined) {
      const amountAtomic = parseMaxAmountRequired(
        parsed.requirement.maxAmountRequired,
        parsed.x402Version,
      );
      // Convert atomic units (6 decimals) to cents (2 decimals)
      const amountCents = Number(amountAtomic) / 10_000;
      if (amountCents > maxPaymentCents) {
        return {
          success: false,
          error: `Payment of ${amountCents.toFixed(2)} cents exceeds max allowed ${maxPaymentCents} cents`,
          status: 402,
        };
      }
    }

    // Sign payment
    let payment: any;
    try {
      payment = isSolanaRequirement(parsed.requirement)
        ? await signSolanaPayment(signer, parsed.requirement, parsed.x402Version)
        : await signPayment(requireEvmAccount(signer), parsed.requirement, parsed.x402Version);
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to sign payment: ${err?.message || String(err)}`,
        status: initialResp.status,
      };
    }

    // Retry with payment
    const paymentHeader = Buffer.from(
      JSON.stringify(payment),
    ).toString("base64");

    const paidResp = await x402HttpClient.request(url, {
      method,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "X-Payment": paymentHeader,
      },
      body,
      retries: 0, // Paid request: do not auto-retry (payment already signed)
    });

    const data = await paidResp.json().catch(() => paidResp.text());
    return { success: paidResp.ok, response: data, status: paidResp.status };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export function isSolanaRequirement(requirement: PaymentRequirement): boolean {
  return requirement.network.startsWith("solana:");
}

function requireEvmAccount(signer: PrivateKeyAccount | ChainIdentity): PrivateKeyAccount {
  if ("chainType" in signer) {
    if (signer.chainType !== "evm" || !("account" in signer)) throw new Error("The payment requirement needs an EVM identity.");
    return signer.account as PrivateKeyAccount;
  }
  return signer;
}

async function signSolanaPayment(
  signer: PrivateKeyAccount | ChainIdentity,
  requirement: PaymentRequirement,
  x402Version: number,
): Promise<any> {
  if (!(signer instanceof SolanaChainIdentity)) throw new Error("The payment requirement needs a Solana identity.");
  const { Connection, Keypair, PublicKey, Transaction } = await import("@solana/web3.js");
  const payer = Keypair.fromSecretKey(signer.getSecretKey());
  const mint = new PublicKey(requirement.usdcAddress || SOLANA_USDC_MINT);
  const recipient = new PublicKey(requirement.payToAddress);
  const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const associatedProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const source = PublicKey.findProgramAddressSync([payer.publicKey.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], associatedProgram)[0];
  const destination = PublicKey.findProgramAddressSync([recipient.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], associatedProgram)[0];
  const amount = BigInt(parseMaxAmountRequired(requirement.maxAmountRequired, x402Version));
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = 6;
  const instruction = { programId: tokenProgram, keys: [
    { pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: destination, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: false },
  ], data };
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const { blockhash } = await new Connection(rpc, "confirmed").getLatestBlockhash("finalized");
  const transaction = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(instruction);
  transaction.sign(payer);
  return { x402Version, scheme: requirement.scheme, network: requirement.network, payload: { transaction: transaction.serialize().toString("base64") } };
}

/**
 * Sign one exact-scheme USDC payment leg against a raw requirement
 * object shaped like a single entry in an x402 402 response's
 * `accepts` array (scheme/network/maxAmountRequired/payToAddress/
 * requiredDeadlineSeconds — `network` may be either a NetworkId like
 * "eip155:8453" or a human label like "base"/"base-sepolia", both
 * normalized the same way parsePaymentRequired() above already does
 * for a full response body).
 *
 * Deliberately NOT built on top of signPayment()/parseMaxAmountRequired()
 * above: those treat a short (<=6 digit), no-decimal-point
 * maxAmountRequired as a *decimal dollar* string under x402Version 1
 * (`parseUnits(amount, 6)`) — correct for inferenceGateway.ts's own 402
 * responses, whose `estimatedCost` is always `.toFixed(6)`'d and so
 * always contains a ".". marketplace.ts's maxAmountRequired is never
 * that: per that file's own "Founder fee" comment, `price_usdc` (and
 * every value derived from it — computeFeeSplit's sellerAmount/
 * founderAmount) is always an already-atomic integer string with no
 * decimal point, and a sub-$1 listing (any price under 1,000,000 atomic
 * units) is exactly the case the shared parser gets wrong — it would
 * multiply an already-atomic amount by 1e6 a second time. This function
 * treats maxAmountRequired as atomic unconditionally, which is correct
 * for every caller (marketplace.ts's /:id/invoke) that has a reason to
 * use this function rather than plain x402Fetch.
 *
 * Returns just the `{signature, authorization}` pair — the same shape
 * every x402-authenticated backend route in this stack expects for one
 * payment leg (see marketplace.ts's XPaymentLeg) — rather than the
 * full `{x402Version, scheme, network, payload}` envelope signPayment()
 * builds, since callers that submit MULTIPLE legs in one request body
 * (marketplace.ts's founder-fee split) key each leg by name, not by
 * re-wrapping a whole envelope per leg.
 *
 * EVM-only, unconditionally: this leg is always an EIP-712
 * TransferWithAuthorization signature (`account.signTypedData`), which
 * only a real viem PrivateKeyAccount can produce. A Solana automaton's
 * AutomatonIdentity.account is never a real signer — wallet.ts's
 * createSolanaCompatibilityAccount() fills that field with a stub whose
 * signTypedData/sign/etc. all throw, purely so callers that still
 * expect the legacy `account: PrivateKeyAccount` shape don't crash on a
 * missing property. That stub is structurally a PrivateKeyAccount (same
 * call signature), so nothing at the type level stops it from reaching
 * here — the only real tell is its `address`, which is base58 (no `0x`
 * prefix) rather than a real EVM address. Guarded on that, immediately
 * and unconditionally, so any current or future caller (not just
 * marketplaceInvoke's one tool-level chainType check today) fails fast
 * here with a clear message instead of hitting the stub's opaque
 * "Solana signing requires chainIdentity." deep inside signTypedData —
 * or, worse, silently signing with the wrong key if some future stub
 * implementation is less careful about throwing.
 */
export async function signExactPaymentLeg(
  account: PrivateKeyAccount,
  requirement: {
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payToAddress: string;
    requiredDeadlineSeconds?: number;
  },
): Promise<{ signature: `0x${string}`; authorization: Record<string, string> }> {
  if (!isValidEvmAddress(account.address)) {
    throw new Error(
      `signExactPaymentLeg requires an EVM payment account (0x-prefixed address); got "${account.address}". ` +
        `Solana identities cannot sign EIP-712 payment authorizations — marketplace/x402 purchases ` +
        `are EVM-only for now.`,
    );
  }
  const network = normalizeNetwork(requirement.network);
  if (!network) {
    throw new Error(`Unsupported/unrecognized network in payment requirement: ${requirement.network}`);
  }
  const chain = CHAINS[network];
  const usdcAddress = USDC_ADDRESSES[network];
  if (!chain || !usdcAddress) {
    throw new Error(`No chain/USDC config for network: ${network}`);
  }
  if (!/^\d+$/.test(requirement.maxAmountRequired.trim())) {
    throw new Error(
      `Expected an atomic-unit integer string for maxAmountRequired, got: ${requirement.maxAmountRequired}`,
    );
  }
  const amount = BigInt(requirement.maxAmountRequired.trim());

  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const validBefore = now + (requirement.requiredDeadlineSeconds ?? 300);

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: chain.id,
    verifyingContract: usdcAddress,
  } as const;
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;
  const message = {
    from: account.address,
    to: requirement.payToAddress as Address,
    value: amount,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce as `0x${string}`,
  };

  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
  });

  return {
    signature,
    authorization: {
      from: account.address,
      to: requirement.payToAddress,
      value: amount.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  };
}

async function parsePaymentRequired(
  resp: Response,
): Promise<ParsedPaymentRequirement | null> {
  const header = resp.headers.get("X-Payment-Required");
  if (header) {
    const rawHeader = safeJsonParse(header);
    const normalizedRaw = normalizePaymentRequired(rawHeader);
    if (normalizedRaw) {
      return {
        x402Version: normalizedRaw.x402Version,
        requirement: selectRequirement(normalizedRaw),
      };
    }

    try {
      const decoded = Buffer.from(header, "base64").toString("utf-8");
      const parsedDecoded = normalizePaymentRequired(safeJsonParse(decoded));
      if (parsedDecoded) {
        return {
          x402Version: parsedDecoded.x402Version,
          requirement: selectRequirement(parsedDecoded),
        };
      }
    } catch {
      // Ignore header decode errors and continue with body parsing.
    }
  }

  try {
    const body = await resp.json();
    const parsedBody = normalizePaymentRequired(body);
    if (!parsedBody) return null;
    return {
      x402Version: parsedBody.x402Version,
      requirement: selectRequirement(parsedBody),
    };
  } catch {
    return null;
  }
}

async function signPayment(
  account: PrivateKeyAccount,
  requirement: PaymentRequirement,
  x402Version: number,
): Promise<any> {
  const chain = CHAINS[requirement.network];
  if (!chain) {
    throw new Error(`Unsupported network: ${requirement.network}`);
  }

  const nonce = `0x${Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("hex")}`;

  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const validBefore = now + requirement.requiredDeadlineSeconds;
  const amount = parseMaxAmountRequired(
    requirement.maxAmountRequired,
    x402Version,
  );

  // EIP-712 typed data for TransferWithAuthorization
  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: chain.id,
    verifyingContract: requirement.usdcAddress,
  } as const;

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;

  const message = {
    from: account.address,
    to: requirement.payToAddress,
    value: amount,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce as `0x${string}`,
  };

  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
  });

  return {
    x402Version,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: requirement.payToAddress,
        value: amount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
}
