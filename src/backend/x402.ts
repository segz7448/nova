/**
 * x402 Payment Protocol
 *
 * Enables the automaton to make USDC micropayments via HTTP 402
 * against our own self-hosted backend (not Conway's).
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
import { isValidEvmAddress } from "../identity/chain.js";

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

export interface PaymentRequirement {
  scheme: string;
  network: NetworkId;
  maxAmountRequired: string;
  payToAddress: Address;
  requiredDeadlineSeconds: number;
  usdcAddress: Address;
}

export interface PaymentRequiredResponse {
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

function normalizeNetwork(raw: unknown): NetworkId | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "base") return "eip155:8453";
  if (normalized === "base-sepolia") return "eip155:84532";
  if (normalized === "eip155:8453" || normalized === "eip155:84532") {
    return normalized;
  }
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
      : USDC_ADDRESSES[network];
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

export function normalizePaymentRequired(raw: unknown): PaymentRequiredResponse | null {
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

export function selectRequirement(parsed: PaymentRequiredResponse): PaymentRequirement {
  const exactSupported = parsed.accepts.find(
    (r) => r.scheme === "exact" && !!CHAINS[r.network],
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
  account: PrivateKeyAccount,
  method: string = "GET",
  body?: string,
  headers?: Record<string, string>,
  maxPaymentCents?: number,
  chainType?: ChainType,
): Promise<X402PaymentResult> {
  // Solana wallets cannot sign EVM x402 payments
  if (chainType === "solana") {
    return {
      success: false,
      error: "x402 payment requires an EVM wallet. Solana automatons should use the backend credits API instead.",
    };
  }

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
      payment = await signPayment(
        account,
        parsed.requirement,
        parsed.x402Version,
      );
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

export async function signPayment(
  account: PrivateKeyAccount,
  requirement: PaymentRequirement,
  x402Version: number,
): Promise<any> {
  // This module (backend/x402.ts) is a separate, older copy of the x402
  // client that predates Solana support — unlike chain-utils/x402.ts,
  // nothing here (normalizeNetwork, selectRequirement) even recognizes
  // a "solana:..." network, and this signPayment() has always gone
  // straight to account.signTypedData(). It's the one backend/inference.ts
  // actually imports for self-hosted inference payments (the most
  // frequently exercised x402 path in the whole system), so a Solana
  // automaton's compatibility-stub account reaching here would hit the
  // stub's own throw deep inside signTypedData with no upfront guard.
  // Same fix as chain-utils/x402.ts's signExactPaymentLeg: check the
  // account's own address shape (base58 vs 0x-prefixed) rather than
  // trust a caller-supplied flag, so this is safe regardless of caller.
  if (!isValidEvmAddress(account.address)) {
    throw new Error(
      `signPayment requires an EVM payment account (0x-prefixed address); got "${account.address}". ` +
        `Solana identities cannot sign EIP-712 payment authorizations.`,
    );
  }
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

// ─── Marketplace purchases ───────────────────────────────────
//
// Distinct from x402Fetch above on purpose: this backend's marketplace
// (and /facilitator/*) routes read a flat `{ authorization, signature }`
// from the JSON *body*, not the `X-Payment` header + `payload` envelope
// x402Fetch/signPayment produce for the generic case. When a founder
// fee is configured on the marketplace, /:id/invoke's 402 response
// also carries `requireAll: true` with two `accepts` entries (one
// leg payable to the seller, one to the founder wallet) that must
// both be signed and submitted together as `xPayments: { seller,
// founder }` — a buyer can't satisfy just one leg and get the other
// for free.

interface MarketplaceInvokeResult {
  success: boolean;
  status?: number;
  response?: any;
  error?: string;
}

/** Sign one payment leg, in the flat shape this backend's facilitator expects. */
async function signLegFlat(
  account: PrivateKeyAccount,
  requirement: PaymentRequirement,
  x402Version: number,
): Promise<{ authorization: Record<string, string>; signature: `0x${string}` }> {
  const signed = await signPayment(account, requirement, x402Version);
  return signed.payload;
}

/**
 * Buy a marketplace listing, paying whatever split of legs the seller
 * (and, if configured, the founder fee) requires — one signed payment
 * if no founder fee is active, two if there is one. Handles both
 * transparently; callers don't need to know which applies to a given
 * listing ahead of time.
 */
export async function purchaseListing(
  backendUrl: string,
  listingId: string,
  account: PrivateKeyAccount,
  buyerAddress: string,
  input?: unknown,
): Promise<MarketplaceInvokeResult> {
  const url = `${backendUrl.replace(/\/$/, "")}/marketplace/${listingId}/invoke`;

  const probe = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ buyerAddress, input }),
  });

  if (probe.status !== 402) {
    const data = await probe.json().catch(() => probe.text());
    return { success: probe.ok, status: probe.status, response: data };
  }

  const challenge = (await probe.json()) as {
    x402Version: number;
    requireAll?: boolean;
    accepts: (PaymentRequirement & { leg?: "seller" | "founder" })[];
  };

  if (!challenge.accepts?.length) {
    return { success: false, error: "Marketplace returned 402 with no payment requirements" };
  }

  let bodyPayload: Record<string, unknown>;
  if (challenge.requireAll) {
    const sellerReq = challenge.accepts.find((r) => r.leg === "seller");
    const founderReq = challenge.accepts.find((r) => r.leg === "founder");
    if (!sellerReq || !founderReq) {
      return { success: false, error: "Founder-fee challenge missing seller or founder leg" };
    }
    const [seller, founder] = await Promise.all([
      signLegFlat(account, sellerReq, challenge.x402Version),
      signLegFlat(account, founderReq, challenge.x402Version),
    ]);
    bodyPayload = { buyerAddress, input, xPayments: { seller, founder } };
  } else {
    const req0 = selectRequirement({ x402Version: challenge.x402Version, accepts: challenge.accepts });
    const leg = await signLegFlat(account, req0, challenge.x402Version);
    bodyPayload = { buyerAddress, input, xPayment: leg };
  }

  const paidResp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyPayload),
  });
  const data = await paidResp.json().catch(() => paidResp.text());
  return { success: paidResp.ok, status: paidResp.status, response: data };
}
