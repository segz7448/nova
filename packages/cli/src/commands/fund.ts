/**
 * automaton-cli fund <amount> --to 0x...
 *
 * Transfer USDC from this automaton's own wallet to another address,
 * using this backend's own /wallet/:address/pay + /facilitator/settle
 * flow (a gasless EIP-3009 `transferWithAuthorization` on the
 * configured chain). Runs entirely against your own self-hosted
 * backend (`config.backendApiUrl` / `config.backendApiKey`) — no
 * Conway dependency, no Conway credits ledger. If the backend requires
 * an active payment channel between these two addresses
 * (`paymentChannelRequired()` in `wallet.ts`), the sign step will fail
 * with a 403 until one is opened.
 */

import { loadConfig } from "automaton-vm/config.js";

const args = process.argv.slice(3);
const amount = args[0];
const toIndex = args.indexOf("--to");
const toAddress = toIndex >= 0 ? args[toIndex + 1] : undefined;

if (!amount || !toAddress) {
  console.log("Usage: automaton-cli fund <amount> --to 0x...");
  console.log("Examples:");
  console.log("  automaton-cli fund 5.00 --to 0xabc...");
  console.log("  automaton-cli fund 500 --to 0xabc...   (interpreted as $500.00 USDC)");
  process.exit(1);
}

const config = loadConfig();
if (!config) {
  console.log("No automaton configuration found.");
  process.exit(1);
}

if (!config.backendApiUrl || !config.backendApiKey) {
  console.log("No backend configured (backendApiUrl/backendApiKey missing from automaton config).");
  process.exit(1);
}

if (!config.walletAddress) {
  console.log("No wallet address found in automaton config.");
  process.exit(1);
}

const amountUsdc = parseAmountToUsdc(amount);
if (amountUsdc <= 0) {
  console.log(`Invalid amount: ${amount}`);
  process.exit(1);
}

const apiUrl = config.backendApiUrl.replace(/\/$/, "");
const headers = {
  "Content-Type": "application/json",
  "x-backend-key": config.backendApiKey,
};

// Step 1: ask the backend to sign a gasless USDC transfer authorization
// FROM this agent's own wallet TO the destination address. The backend
// only signs here — no funds move yet.
const payRes = await fetch(`${apiUrl}/wallet/${config.walletAddress}/pay`, {
  method: "POST",
  headers,
  body: JSON.stringify({ to: toAddress, amountUsdc: amountUsdc.toFixed(6) }),
});

if (!payRes.ok) {
  console.log(`Transfer failed (sign step): ${payRes.status}: ${await payRes.text()}`);
  process.exit(1);
}

const signed = (await payRes.json().catch(() => ({}))) as {
  payload?: { signature: `0x${string}`; authorization: Record<string, unknown> };
};

if (!signed.payload) {
  console.log("Transfer failed: backend did not return a signed payload.");
  process.exit(1);
}

// Step 2: settle the signed authorization — this is the call that
// actually moves USDC on-chain.
const settleRes = await fetch(`${apiUrl}/facilitator/settle`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    authorization: signed.payload.authorization,
    signature: signed.payload.signature,
    purpose: `fund via automaton-cli (${config.name})`,
  }),
});

const settlement = (await settleRes.json().catch(() => ({}))) as {
  success?: boolean;
  txHash?: string;
  error?: string;
};

if (!settleRes.ok || !settlement.success) {
  console.log(`Transfer failed (settle step): ${settleRes.status}: ${JSON.stringify(settlement)}`);
  process.exit(1);
}

console.log(`
Transfer settled.
From:      ${config.walletAddress}
To:        ${toAddress}
Amount:    $${amountUsdc.toFixed(2)} USDC
Tx hash:   ${settlement.txHash}
Backend:   ${apiUrl}
`);

function parseAmountToUsdc(raw: string): number {
  const trimmed = raw.trim();
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars)) return 0;
  return dollars;
}
