/**
 * Self-Hosted Backend Client
 *
 * Talks to YOUR automaton-stack server (running on your own Alibaba Cloud
 * VM) instead of api.conway.tech. Implements the same BackendClient
 * interface the rest of the agent code already depends on, so nothing
 * upstream (agent/tools.ts, replication/, etc.) needs to change shape —
 * only where the bytes go.
 *
 * Route map (see automaton-stack README):
 *   exec/file        -> POST /vm/exec, /vm/file/write, GET /vm/file/read
 *   wallet + lineage  -> POST /wallet/create|register, GET /wallet/:addr/balance|lineage
 *   payments (x402)   -> POST /wallet/:addr/pay, /facilitator/verify, /facilitator/settle
 *   inference         -> POST /inference/chat (see backend/inference.ts, separate interface)
 *
 * NOT YET implemented on automaton-stack (throws NotImplementedError,
 * agent gets a clear message instead of a crash or a silent no-op):
 *   - exposePort / removePort        (Phase: ports)
 *   - createSandbox / deleteSandbox / listSandboxes  (Phase: multi-sandbox)
 *   - searchDomains / registerDomain / DNS tools     (Phase: domains)
 *   - getCreditsPricing (no VM tier system on a single fixed VM)
 */

import type {
  BackendClient,
  ExecResult,
  PortInfo,
  CreateSandboxOptions,
  SandboxInfo,
  PricingTier,
  CreditTransferResult,
  DomainSearchResult,
  DomainRegistration,
  DnsRecord,
  ModelInfo,
  MarketplaceListing,
  MarketplaceListingStatus,
  MarketplaceListingVersion,
  MarketplaceListUrlParams,
  MarketplaceListZipParams,
  MarketplaceListResult,
  MarketplaceInvokeParams,
  MarketplaceInvokeResult,
  MarketplaceInvocation,
  DistributionChannel,
  DistributionPublishResult,
  EcosystemNode,
} from "../types.js";
import { ResilientHttpClient } from "./http-client.js";
import type { PrivateKeyAccount } from "viem";
import type { ChainType, ChainIdentity } from "../identity/chain.js";
import { isValidEvmAddress } from "../identity/chain.js";
import { signExactPaymentLeg } from "../chain-utils/x402.js";

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(
      `${feature} is not available on this self-hosted backend yet. ` +
        `This automaton runs on your own infrastructure, not Conway's — ` +
        `this capability hasn't been built out on your VM yet.`,
    );
    this.name = "NotImplementedError";
  }
}

interface BackendClientOptions {
  /** e.g. http://YOUR_VM_IP:8000 */
  apiUrl: string;
  /** Shared secret (BACKEND_API_KEY on the server), sent as x-backend-key. */
  apiKey: string;
  /** This agent's on-chain wallet address — identifies it to the backend. */
  agentAddress: string;
  /** Kept for interface compatibility; not yet meaningful (single shared VM). */
  sandboxId: string;
}

export function createBackendClient(options: BackendClientOptions): BackendClient {
  const { apiUrl, apiKey, agentAddress } = options;
  const httpClient = new ResilientHttpClient();

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const resp = await httpClient.request(`${apiUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-backend-key": apiKey,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();
      const err: any = new Error(
        `Backend error: ${method} ${path} -> ${resp.status}: ${text}`,
      );
      err.status = resp.status;
      err.responseText = text;
      throw err;
    }

    return resp.headers.get("content-type")?.includes("application/json")
      ? resp.json()
      : resp.text();
  }

  // ─── Command Execution ────────────────────────────────────────
  // automaton-stack's /vm/exec runs `[command, ...args]` directly (no
  // shell), so we route every call through `bash -c "<full command>"`.
  // Requires "bash" to be present in VM_ALLOWED_COMMANDS on the server.

  // Only isolated sandboxes created via createSandbox() (IDs look like
  // "sbx-xxxxxx", see automaton-stack's vmService.ts) get routed with an
  // explicit sandboxId. The default/home client (no such sandbox, or
  // scoped to whatever config.sandboxId was at genesis) transparently
  // uses the original always-on shared container for backward compat.
  const isIsolatedSandbox = options.sandboxId?.startsWith("sbx-") ?? false;

  const exec = async (command: string, _timeout?: number): Promise<ExecResult> => {
    const result = await request("POST", "/vm/exec", {
      agentAddress,
      command: "bash",
      args: ["-c", command],
      ...(isIsolatedSandbox ? { sandboxId: options.sandboxId } : {}),
    });
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.exitCode ?? -1,
    };
  };

  const writeFile = async (path: string, content: string): Promise<void> => {
    await request("POST", "/vm/file/write", {
      path,
      content,
      agentAddress,
      ...(isIsolatedSandbox ? { sandboxId: options.sandboxId } : {}),
    });
  };

  const readFile = async (path: string): Promise<string> => {
    const qs = new URLSearchParams({ path, agentAddress });
    if (isIsolatedSandbox) qs.set("sandboxId", options.sandboxId);
    const result = await request("GET", `/vm/file/read?${qs.toString()}`);
    return typeof result === "string" ? result : result.content || "";
  };

  // ─── Ports ───────────────────────────────────────────────────────
  // Only meaningful on an isolated sandbox — the shared container runs
  // with NetworkMode "none" by design and can't publish ports.

  const exposePort = async (port: number): Promise<PortInfo> => {
    if (!isIsolatedSandbox) {
      throw new NotImplementedError(
        "Exposing a port on the shared/default sandbox (it has no network by design — " +
          "create an isolated sandbox with createSandbox() and pass its ports up front)",
      );
    }
    const result = await request(
      "POST",
      `/vm/sandboxes/${options.sandboxId}/ports`,
      { agentAddress, containerPort: port },
    );
    return { port, publicUrl: result.url, sandboxId: options.sandboxId };
  };

  const removePort = async (port: number): Promise<void> => {
    if (!isIsolatedSandbox) return;
    await request(
      "DELETE",
      `/vm/sandboxes/${options.sandboxId}/ports/${port}`,
      { agentAddress },
    );
  };

  // ─── Multi-sandbox management ──────────────────────────────────────

  const createSandbox = async (o: CreateSandboxOptions): Promise<SandboxInfo> => {
    const result = await request("POST", "/vm/sandboxes", {
      agentAddress,
      vcpu: o.vcpu ?? 1,
      memoryMb: o.memoryMb ?? 512,
      diskGb: o.diskGb ?? 5,
      exposedPorts: o.exposedPorts ?? [],
    });
    return {
      id: result.id,
      status: result.status,
      region: result.region,
      vcpu: result.vcpu,
      memoryMb: result.memoryMb,
      diskGb: result.diskGb,
      createdAt: new Date().toISOString(),
    };
  };

  const deleteSandbox = async (id: string): Promise<void> => {
    await request("DELETE", `/vm/sandboxes/${id}`, { agentAddress });
  };

  const listSandboxes = async (): Promise<SandboxInfo[]> => {
    const results = await request(
      "GET",
      `/vm/sandboxes?agentAddress=${encodeURIComponent(agentAddress)}`,
    );
    return (results as any[]).map((r) => ({
      id: r.id,
      status: r.status,
      region: r.region,
      vcpu: r.vcpu,
      memoryMb: r.memoryMb,
      diskGb: r.diskGb,
      createdAt: new Date().toISOString(),
    }));
  };

  // ─── Wallet / "Credits" ─────────────────────────────────────────
  // There is no separate credits ledger here — the agent's real USDC
  // balance on Base IS its balance. We report it in "cents" (USD *100)
  // so callers built around Conway's credits abstraction keep working.

  const getCreditsBalance = async (): Promise<number> => {
    const result = await request("GET", `/wallet/${agentAddress}/balance`);
    const usdc = parseFloat(result.usdc || "0");
    return Math.round(usdc * 100);
  };

  const checkKillStatus = async (): Promise<{ shutdown: boolean; reason: string | null }> => {
    return request("GET", `/control/kill-status/${agentAddress}`);
  };

  const reportEvent = async (params: {
    eventType: string;
    message: string;
    role?: string;
    subRole?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> => {
    await request("POST", "/events/report", { agentAddress, ...params });
  };

  const getCreditsPricing = async (): Promise<PricingTier[]> => {
    // Single fixed VM, not tiered — return one synthetic tier describing it.
    return [
      {
        name: "self-hosted",
        vcpu: 0,
        memoryMb: 0,
        diskGb: 0,
        monthlyCents: 0,
      },
    ];
  };

  const transferCredits = async (
    toAddress: string,
    amountCents: number,
    _note?: string,
  ): Promise<CreditTransferResult> => {
    const amountUsdc = amountCents / 100;

    // 1. Ask the backend to sign a gasless USDC transfer authorization
    //    from this agent's wallet (only works for backend-custodied
    //    wallets created via /wallet/create — self-custody wallets
    //    should sign locally instead; see backend/inference.ts for
    //    the self-signing pattern).
    const signed = await request("POST", `/wallet/${agentAddress}/pay`, {
      to: toAddress,
      amountUsdc,
    });

    // 2. Settle it on-chain via the facilitator.
    const settled = await request("POST", "/facilitator/settle", {
      authorization: signed.payload.authorization,
      signature: signed.payload.signature,
      purpose: "transfer",
    });

    return {
      transferId: settled.id || settled.txHash || "",
      status: settled.success ? "settled" : "failed",
      toAddress,
      amountCents,
      balanceAfterCents: undefined,
    };
  };

  // ─── Identity Registration ───────────────────────────────────────
  // No ERC-8004 on-chain registry here (yet) — we register the address
  // for lineage tracking (/wallet/register), which is what actually
  // matters for replication to work end to end today.

  const registerAutomaton = async (params: {
    automatonId: string;
    automatonAddress: string;
    creatorAddress: string;
    name: string;
    bio?: string;
    genesisPromptHash?: `0x${string}`;
    account: PrivateKeyAccount;
    nonce?: string;
    chainType?: ChainType;
    chainIdentity?: ChainIdentity;
  }): Promise<{ automaton: Record<string, unknown> }> => {
    const result = await request("POST", "/wallet/register", {
      address: params.automatonAddress,
      name: params.name,
    });
    return { automaton: result };
  };

  // ─── Domains (not yet built) ─────────────────────────────────────

  const searchDomains = async (
    _query: string,
    _tlds?: string,
  ): Promise<DomainSearchResult[]> => {
    throw new NotImplementedError("Domain search");
  };
  const registerDomain = async (
    _domain: string,
    _years?: number,
  ): Promise<DomainRegistration> => {
    throw new NotImplementedError("Domain registration");
  };
  const listDnsRecords = async (_domain: string): Promise<DnsRecord[]> => {
    throw new NotImplementedError("DNS record listing");
  };
  const addDnsRecord = async (
    _domain: string,
    _type: string,
    _host: string,
    _value: string,
    _ttl?: number,
  ): Promise<DnsRecord> => {
    throw new NotImplementedError("DNS record creation");
  };
  const deleteDnsRecord = async (_domain: string, _recordId: string): Promise<void> => {
    throw new NotImplementedError("DNS record deletion");
  };

  // ─── Model Discovery ──────────────────────────────────────────────
  // Your backend serves a local llama.cpp model (Qwen3-4B) as
  // primary, falling back to OpenRouter only on failure — see
  // automaton-backend's LOCAL_MODEL_PATCH_NOTES.md. This list is
  // informational only (list_models tool); the backend's own allowlist
  // in inferenceGateway.ts is what actually decides what gets served,
  // regardless of what's returned here.

  const listModels = async (): Promise<ModelInfo[]> => {
    const models: ModelInfo[] = [
      {
        id: process.env.LOCAL_MODEL_NAME || "qwen3-4b",
        provider: "local",
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
      },
    ];
    if (process.env.OPENROUTER_API_KEY) {
      models.push({
        id: process.env.OPENROUTER_MODEL || "ox-alpha",
        provider: "openrouter",
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
      });
    }
    return models;
  };

  const createScopedClient = (targetSandboxId: string): BackendClient => {
    return createBackendClient({ ...options, sandboxId: targetSandboxId });
  };

  // ─── Marketplace ────────────────────────────────────────────────
  // Agent-to-agent tool marketplace: browse/list/buy/sell via the
  // backend's /marketplace routes, same x402 facilitator flow already
  // used by inference/chat. See backend/src/marketplace.ts.

  // `request()` throws on non-2xx, which is fine for every marketplace
  // call except marketplaceInvoke — that one's *expected* first response
  // is a 402 (payment required), so it needs the status code back
  // instead of an exception.
  async function requestRaw(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const resp = await httpClient.request(`${apiUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-backend-key": apiKey },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const contentType = resp.headers.get("content-type") || "";
    const parsed = contentType.includes("application/json")
      ? await resp.json().catch(() => ({}))
      : await resp.text();
    return { status: resp.status, body: parsed };
  }

  const marketplaceBrowse = async (params?: {
    category?: string;
    sellerAddress?: string;
    status?: MarketplaceListingStatus;
    q?: string;
  }): Promise<MarketplaceListing[]> => {
    const qs = new URLSearchParams();
    if (params?.category) qs.set("category", params.category);
    if (params?.sellerAddress) qs.set("sellerAddress", params.sellerAddress);
    if (params?.status) qs.set("status", params.status);
    if (params?.q) qs.set("q", params.q);
    const q = qs.toString();
    const result = await request("GET", `/marketplace/listings${q ? `?${q}` : ""}`);
    return result.listings;
  };

  const marketplaceGetListing = (listingId: string): Promise<MarketplaceListing> =>
    request("GET", `/marketplace/listings/${encodeURIComponent(listingId)}`);

  const marketplaceListUrl = (
    params: MarketplaceListUrlParams,
  ): Promise<MarketplaceListResult> => request("POST", "/marketplace/list", params);

  const marketplaceListZipFromOffice = (
    params: MarketplaceListZipParams,
  ): Promise<MarketplaceListResult> =>
    request("POST", "/marketplace/list/upload-from-office", params);

  const marketplaceDeactivate = (
    listingId: string,
    agentAddressParam: string,
  ): Promise<{ id: string; active: false; status: "archived" }> =>
    request("POST", `/marketplace/${encodeURIComponent(listingId)}/deactivate`, {
      agentAddress: agentAddressParam,
    });

  const marketplaceSetStatus = (
    listingId: string,
    agentAddressParam: string,
    status: MarketplaceListingStatus,
  ): Promise<{ id: string; status: MarketplaceListingStatus; active: boolean }> =>
    request("POST", `/marketplace/${encodeURIComponent(listingId)}/status`, {
      agentAddress: agentAddressParam,
      status,
    });

  const marketplaceGetListingVersions = async (
    listingId: string,
  ): Promise<MarketplaceListingVersion[]> => {
    const result = await request(
      "GET",
      `/marketplace/listings/${encodeURIComponent(listingId)}/versions`,
    );
    return result.versions;
  };

  // ─── Ecosystem (Zent.md Phase 18d) ────────────────────────────────
  // GET /ecosystem/:rootAgentAddress (Phase 18b, ecosystemRoutes.ts) —
  // behind the same shared x-backend-key request() already sends on
  // every call above, same as every other agent-facing route on this
  // backend. A 404 (unknown address) is this route's own documented
  // "no agent there" outcome, not a transport failure — caught here
  // and turned into null so list_siblings (agent/tools.ts) can treat
  // "parent record doesn't resolve" as a normal, reportable case
  // instead of an uncaught exception.
  const getEcosystemTree = async (rootAgentAddress: string): Promise<EcosystemNode | null> => {
    try {
      const result = await request(
        "GET",
        `/ecosystem/${encodeURIComponent(rootAgentAddress)}`,
      );
      return result.root as EcosystemNode;
    } catch (err: any) {
      if (err?.status === 404) return null;
      throw err;
    }
  };

  const marketplaceGetCategories = async (): Promise<string[]> => {
    const result = await request("GET", "/marketplace/categories");
    return result.categories;
  };

  const marketplaceGetInvocation = (invocationId: string): Promise<MarketplaceInvocation> =>
    request("GET", `/marketplace/invocations/${encodeURIComponent(invocationId)}`);

  const marketplaceFlagInvocation = (params: {
    invocationId: string;
    buyerAddress: string;
    reason: "garbage" | "off_spec" | "incomplete" | "other";
    detail?: string;
  }): Promise<{ id: string; invocationId: string; updated: boolean }> =>
    request("POST", `/marketplace/invocations/${encodeURIComponent(params.invocationId)}/flag`, {
      buyerAddress: params.buyerAddress,
      reason: params.reason,
      detail: params.detail,
    });

  // The one with real logic: probe -> parse 402 -> sign leg(s) with
  // signExactPaymentLeg -> retry. Handles both delivery modes (url-mode
  // returns `result`; zip-mode returns `downloadUrl`) and both
  // fee-split branches (plain single seller leg vs. founder-fee
  // seller+founder legs) — see backend/src/marketplace.ts's
  // POST /:id/invoke for the exact response shapes this mirrors.
  const marketplaceInvoke = async (
    params: MarketplaceInvokeParams,
  ): Promise<MarketplaceInvokeResult> => {
    const { listingId, buyerAddress, account, input } = params;

    // Fail fast, before any network round-trip: signExactPaymentLeg
    // below guards this too, but checking here (a) skips a useless
    // probe request when we already know payment can't be signed, and
    // (b) avoids kicking off two doomed Promise.all signing attempts
    // in the requireAll (founder-fee) branch. tools.ts's
    // buy_from_marketplace already blocks Solana automatons before
    // ever building these params, but that's one call site among
    // potentially several (any future caller of ctx.backend.
    // marketplaceInvoke, tests, etc.) — this is the backstop that
    // holds regardless of what called us or whether it remembered to
    // check chainType itself.
    if (!isValidEvmAddress(account.address)) {
      throw new Error(
        `Marketplace invoke requires an EVM payment account (0x-prefixed address); got "${account.address}". ` +
          `Solana identities cannot sign x402 EIP-712 payment authorizations — marketplace purchases are EVM-only for now.`,
      );
    }

    const path = `/marketplace/${encodeURIComponent(listingId)}/invoke`;

    const probe = await requestRaw("POST", path, { buyerAddress, input });
    if (probe.status !== 402) {
      if (probe.status >= 300) {
        throw new Error(`Marketplace invoke failed: ${probe.status}: ${JSON.stringify(probe.body)}`);
      }
      return probe.body as MarketplaceInvokeResult;
    }

    const body = probe.body as {
      requireAll?: boolean;
      accepts: Array<{
        scheme: string;
        network: string;
        maxAmountRequired: string;
        payToAddress: string;
        requiredDeadlineSeconds: number;
        leg?: "seller" | "founder";
      }>;
    };
    if (!body.accepts?.length) {
      throw new Error("Marketplace invoke: 402 response had no accepts entries");
    }

    let paid: { status: number; body: any };
    if (body.requireAll) {
      const sellerReq = body.accepts.find((a) => a.leg === "seller");
      const founderReq = body.accepts.find((a) => a.leg === "founder");
      if (!sellerReq || !founderReq) {
        throw new Error("Marketplace invoke: founder-fee 402 missing seller/founder leg");
      }
      const [sellerLeg, founderLeg] = await Promise.all([
        signExactPaymentLeg(account, sellerReq),
        signExactPaymentLeg(account, founderReq),
      ]);
      paid = await requestRaw("POST", path, {
        buyerAddress,
        input,
        xPayments: { seller: sellerLeg, founder: founderLeg },
      });
    } else {
      const leg = await signExactPaymentLeg(account, body.accepts[0]);
      paid = await requestRaw("POST", path, { buyerAddress, input, xPayment: leg });
    }

    if (paid.status >= 300) {
      throw new Error(`Marketplace invoke settlement failed: ${paid.status}: ${JSON.stringify(paid.body)}`);
    }
    return paid.body as MarketplaceInvokeResult;
  };

  // ─── Distribution (human-facing publish) ───────────────────────────

  const distributionListChannels = async (): Promise<DistributionChannel[]> => {
    const result = await request("GET", "/distribution/channels");
    return result.channels;
  };

  const distributionPublish = (params: {
    agentAddress: string;
    listingId: string;
    channelKey: string;
    title: string;
    summary: string;
  }): Promise<DistributionPublishResult> => request("POST", "/distribution/publish", params);

  return {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort,
    createSandbox,
    deleteSandbox,
    listSandboxes,
    getCreditsBalance,
    getCreditsPricing,
    checkKillStatus,
    reportEvent,
    transferCredits,
    registerAutomaton,
    searchDomains,
    registerDomain,
    listDnsRecords,
    addDnsRecord,
    deleteDnsRecord,
    listModels,
    createScopedClient,
    marketplaceBrowse,
    marketplaceGetListing,
    marketplaceListUrl,
    marketplaceListZipFromOffice,
    marketplaceDeactivate,
    marketplaceSetStatus,
    marketplaceGetListingVersions,
    marketplaceGetCategories,
    marketplaceInvoke,
    marketplaceGetInvocation,
    marketplaceFlagInvocation,
    distributionListChannels,
    distributionPublish,
    getEcosystemTree,
  };
}
