/**
 * Self-Hosted Backend Provisioning
 *
 * Replaces Conway's SIWE-based per-automaton API key issuance. Your
 * backend (automaton-stack) authenticates with a single static shared
 * secret (BACKEND_API_KEY) that you, the operator, generate once and
 * put in .env — there is no per-agent key provisioning step, so this
 * module's job shrinks to: register this agent's wallet address with
 * the backend for lineage tracking, and save the local config.
 */

import fs from "fs";
import path from "path";
import { getWallet, getAutomatonDir } from "./wallet.js";
import type { ProvisionResult } from "../types.js";
import { ResilientHttpClient } from "../backend/http-client.js";
import type { ChainIdentity } from "./chain.js";

const httpClient = new ResilientHttpClient();

const DEFAULT_BACKEND_URL = process.env.BACKEND_API_URL || "http://127.0.0.1:8000";

/**
 * Load the shared backend key. Unlike Conway's per-automaton keys, this
 * is the same static secret for every agent on your infrastructure —
 * it comes from your own env, not a provisioning handshake.
 */
export function loadApiKeyFromConfig(): string | null {
  if (process.env.BACKEND_API_KEY) return process.env.BACKEND_API_KEY;
  const configPath = path.join(getAutomatonDir(), "config.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.apiKey || null;
  } catch {
    return null;
  }
}

function saveConfig(apiKey: string, walletAddress: string): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const configPath = path.join(dir, "config.json");
  const config = {
    apiKey,
    walletAddress,
    provisionedAt: new Date().toISOString(),
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

/**
 * Register this agent's wallet with the backend (POST /wallet/register)
 * so lineage (parent/child) tracking works, then persist local config.
 * No SIWE handshake, no JWT, no per-agent key creation — the backend
 * key is supplied out of band via BACKEND_API_KEY.
 */
export async function provision(
  apiUrl?: string,
  _solanaIdentity?: ChainIdentity,
): Promise<ProvisionResult> {
  const url = apiUrl || DEFAULT_BACKEND_URL;
  const apiKey = loadApiKeyFromConfig();
  if (!apiKey) {
    throw new Error(
      "BACKEND_API_KEY is not set. Generate one on your VM with " +
        "`openssl rand -hex 32`, put it in automaton-stack's .env, and " +
        "export the same value as BACKEND_API_KEY for this agent.",
    );
  }

  const { chainIdentity } = await getWallet();
  const address = chainIdentity.address;

  const resp = await httpClient.request(`${url}/wallet/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-backend-key": apiKey,
    },
    body: JSON.stringify({ address, name: process.env.AUTOMATON_NAME || address }),
  });

  if (!resp.ok) {
    throw new Error(
      `Failed to register wallet with backend: ${resp.status} ${await resp.text()}`,
    );
  }

  saveConfig(apiKey, address);

  return { apiKey, walletAddress: address, keyPrefix: apiKey.slice(0, 8) };
}

/**
 * Register the automaton's creator as its parent for lineage purposes.
 * Maps to the same /wallet/register call — automaton-stack tracks
 * parent/child relationships via the `parentAddress` field rather than
 * a separate "register-parent" endpoint.
 */
export async function registerParent(
  creatorAddress: string,
  apiUrl?: string,
): Promise<void> {
  const url = apiUrl || DEFAULT_BACKEND_URL;
  const apiKey = loadApiKeyFromConfig();
  if (!apiKey) {
    throw new Error("Must provision (register wallet) before registering a parent");
  }

  const { chainIdentity } = await getWallet();

  const resp = await httpClient.request(`${url}/wallet/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-backend-key": apiKey,
    },
    body: JSON.stringify({
      address: chainIdentity.address,
      name: process.env.AUTOMATON_NAME || chainIdentity.address,
      parentAddress: creatorAddress,
    }),
  });

  if (!resp.ok && resp.status !== 404) {
    throw new Error(
      `Failed to register parent: ${resp.status} ${await resp.text()}`,
    );
  }
}
