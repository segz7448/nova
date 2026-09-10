/**
 * automaton-cli send <to-address> "message text"
 *
 * Send a message to an automaton or address via the social relay.
 *
 * Phase 3.2: CRITICAL FIX (S-P0-1) — All outbound messages are now signed
 * using the same canonical format as the runtime client.
 */

import { loadConfig } from "automaton-vm/config.js";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { keccak256, toBytes } from "viem";
import fs from "fs";
import path from "path";

const args = process.argv.slice(3);
const toAddress = args[0];
const messageText = args.slice(1).join(" ");

if (!toAddress || !messageText) {
  console.log("Usage: automaton-cli send <to-address> <message>");
  console.log("Examples:");
  console.log('  automaton-cli send 0xabc...def "Hello, fellow automaton!"');
  process.exit(1);
}

// Load wallet
const walletPath = path.join(
  process.env.HOME || "/root",
  ".automaton",
  "wallet.json",
);

if (!fs.existsSync(walletPath)) {
  console.log("No wallet found at ~/.automaton/wallet.json");
  console.log("Run: automaton --init");
  process.exit(1);
}

const walletData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
const account: PrivateKeyAccount = privateKeyToAccount(walletData.privateKey as `0x${string}`);

// Load config for relay URL. Resolution order: an explicit
// socialRelayUrl in the automaton config, then SOCIAL_RELAY_URL, then
// this operator's own backend's social relay (backendApiUrl + /social —
// see backend/src/socialRelay.ts). Deliberately no external fallback:
// this automaton runs on your own backend, not Conway's, so there is
// no default relay to fall back to if none of the above is set.
const config = loadConfig();
const relayUrl =
  config?.socialRelayUrl ||
  process.env.SOCIAL_RELAY_URL ||
  (config?.backendApiUrl ? `${config.backendApiUrl.replace(/\/$/, "")}/social` : undefined);

if (!relayUrl) {
  console.log("No social relay configured (socialRelayUrl / SOCIAL_RELAY_URL / backendApiUrl) in automaton config.");
  process.exit(1);
}

try {
  // Phase 3.2: Sign the message using the same canonical format as runtime
  // Canonical: Automaton:send:{to_lowercase}:{keccak256(toBytes(content))}:{signed_at_iso}
  const signedAt = new Date().toISOString();
  const contentHash = keccak256(toBytes(messageText));
  const canonical = `Automaton:send:${toAddress.toLowerCase()}:${contentHash}:${signedAt}`;
  const signature = await account.signMessage({ message: canonical });

  const resp = await fetch(`${relayUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: account.address.toLowerCase(),
      to: toAddress.toLowerCase(),
      content: messageText,
      signed_at: signedAt,
      signature,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Relay returned ${resp.status}: ${await resp.text()}`);
  }

  const result = (await resp.json()) as { id?: string };
  console.log(`Message sent (signed).`);
  console.log(`  ID:   ${result.id || "n/a"}`);
  console.log(`  From: ${account.address}`);
  console.log(`  To:   ${toAddress}`);
  console.log(`  Relay: ${relayUrl}`);
} catch (err: any) {
  console.error(`Failed to send message: ${err.message}`);
  process.exit(1);
}
