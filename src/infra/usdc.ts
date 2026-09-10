/**
 * USDC Transfer + Settlement Polling
 *
 * This is deliberately NOT x402 (backend/x402.ts, backend/topup.ts).
 * x402 is a pay-per-request HTTP protocol where the payment and the
 * resource are exchanged in one round trip. Paying Alibaba's wallet is
 * a plain ERC-20 transfer to a fixed address, followed by an
 * out-of-band settlement (their side converts/credits your account)
 * that this code has no way to trigger or speed up — only poll for.
 *
 * Two functions:
 *   sendUsdc()        - broadcasts the transfer, returns once mined
 *   waitForSettlement() - polls a caller-supplied check function until
 *                         it reports funds available, or times out
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Address,
  type PrivateKeyAccount,
  type Hash,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("infra.usdc");

const USDC_ADDRESSES: Record<"base" | "base-sepolia", Address> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const CHAINS = {
  base,
  "base-sepolia": baseSepolia,
} as const;

const ERC20_TRANSFER_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface SendUsdcResult {
  success: boolean;
  txHash?: Hash;
  amountUsdc: number;
  error?: string;
}

/**
 * Send a plain USDC transfer to `toAddress`. Waits for one confirmation
 * before returning — this is "sent", not "settled"; settlement on
 * Alibaba's side is a separate, much slower step (see waitForSettlement).
 */
export async function sendUsdc(params: {
  account: PrivateKeyAccount;
  toAddress: Address;
  amountUsdc: number;
  network: "base" | "base-sepolia";
}): Promise<SendUsdcResult> {
  const { account, toAddress, amountUsdc, network } = params;
  const chain = CHAINS[network];
  const usdcAddress = USDC_ADDRESSES[network];

  try {
    const walletClient = createWalletClient({ account, chain, transport: http() });
    const publicClient = createPublicClient({ chain, transport: http() });

    const amountUnits = parseUnits(amountUsdc.toFixed(6), 6); // USDC = 6 decimals

    logger.info(`Sending ${amountUsdc} USDC to ${toAddress} on ${network}`);

    const hash = await walletClient.writeContract({
      address: usdcAddress,
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [toAddress, amountUnits],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status !== "success") {
      return { success: false, amountUsdc, txHash: hash, error: `Transaction reverted: ${hash}` };
    }

    logger.info(`USDC transfer confirmed: ${hash}`);
    return { success: true, txHash: hash, amountUsdc };
  } catch (err: any) {
    logger.error(`USDC transfer failed: ${err.message}`);
    return { success: false, amountUsdc, error: err.message };
  }
}

export async function getUsdcBalance(params: {
  address: Address;
  network: "base" | "base-sepolia";
}): Promise<number> {
  const { address, network } = params;
  const chain = CHAINS[network];
  const usdcAddress = USDC_ADDRESSES[network];
  const publicClient = createPublicClient({ chain, transport: http() });

  const balance = await publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_TRANSFER_ABI,
    functionName: "balanceOf",
    args: [address],
  });

  return Number(balance) / 1_000_000;
}

export interface SettlementCheckResult {
  settled: boolean;
  /** Whatever balance/credit figure the check function found, for logging. */
  observedValue?: number;
}

/**
 * Poll `checkFn` until it reports settled=true or `timeoutMs` elapses.
 * `checkFn` is caller-supplied on purpose — settlement might mean
 * "Alibaba's account balance API shows the credit" (preferred) or, if
 * that's not queryable in time, "our own wallet balance dropped by the
 * expected amount and enough wall-clock time has passed" as a fallback.
 * See ops.ts for which one is actually wired in.
 */
export async function waitForSettlement(params: {
  checkFn: () => Promise<SettlementCheckResult>;
  timeoutMs: number;
  pollIntervalMs: number;
  onPoll?: (elapsedMs: number, result: SettlementCheckResult) => void;
}): Promise<{ settled: boolean; elapsedMs: number }> {
  const { checkFn, timeoutMs, pollIntervalMs, onPoll } = params;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const result = await checkFn();
    onPoll?.(Date.now() - start, result);
    if (result.settled) {
      return { settled: true, elapsedMs: Date.now() - start };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { settled: false, elapsedMs: Date.now() - start };
}
