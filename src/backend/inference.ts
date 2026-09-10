/**
 * Self-Hosted Inference Client
 *
 * Talks to YOUR automaton-stack's POST /inference/chat instead of
 * a hosted inference endpoint. That route is x402-gated per request
 * (unlike a credits-based provider, which billed against a pre-funded balance),
 * so this client self-signs each payment with the agent's own wallet —
 * the backend never custodies this agent's key.
 *
 * Flow:
 *   1. POST without xPayment -> 402 with price (accepts[0])
 *   2. Sign a USDC transferWithAuthorization locally (EIP-3009, gasless)
 *   3. POST again with xPayment = { signature, authorization }
 */

import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
} from "../types.js";
import { ResilientHttpClient } from "./http-client.js";
import { signPayment, normalizePaymentRequired, selectRequirement } from "./x402.js";
import type { PrivateKeyAccount } from "viem";
import type { ChainType } from "../identity/chain.js";

const INFERENCE_TIMEOUT_MS = 60_000;

interface BackendInferenceOptions {
  /** e.g. http://YOUR_VM_IP:8000 */
  apiUrl: string;
  apiKey: string;
  agentAddress: string;
  account: PrivateKeyAccount;
  /**
   * The automaton's chain type. Self-hosted inference payments are
   * EVM-only for now (see the chainType === "solana" guard in chat()
   * below) — this is threaded through explicitly, the same way
   * index.ts already threads resolvedChainType into the social client
   * and tools.ts checks it before every EVM-only tool, rather than
   * relying solely on sniffing `account.address`'s shape. Missing =
   * "evm" for backward compat with any existing caller that predates
   * this field.
   */
  chainType?: ChainType;
  defaultModel: string;
  maxTokens: number;
  /** Refuse to pay more than this per request, as a safety ceiling. */
  maxPaymentUsdc?: number;
  /**
   * Model requested from the backend while `setLowComputeMode(true)` is
   * active. Falls back to "qwen3-4b" (the local model — the backend's
   * own allowlist in `inferenceGateway.ts` decides what actually gets
   * served regardless of this label; there's no separate cheaper local
   * model to switch to, unlike a hosted-model setup) when omitted.
   */
  lowComputeModel?: string;
}

function formatMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.name) out.name = m.name;
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

export function createBackendInferenceClient(
  options: BackendInferenceOptions,
): InferenceClient {
  const { apiUrl, apiKey, agentAddress, account, maxPaymentUsdc } = options;
  const httpClient = new ResilientHttpClient({ baseTimeout: INFERENCE_TIMEOUT_MS });
  let currentModel = options.defaultModel;

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    const maxTokens = opts?.maxTokens || options.maxTokens;
    // `opts?.model` (set per-request by InferenceRouter's tier/task-based
    // selection, see inference/router.ts) takes priority; otherwise fall
    // back to whatever setLowComputeMode() last put in currentModel. Both
    // were previously dropped on the floor here — the backend only ever
    // received agentAddress/messages/maxTokens, so every request was
    // silently served on config.openrouterModel regardless of what the
    // router or low-compute mode selected. See error-fix.md Phase 11.
    const model = opts?.model || currentModel;
    const body = {
      agentAddress,
      model,
      messages: messages.map(formatMessage),
      maxTokens,
    };

    // First attempt: no payment attached.
    let resp = await httpClient.request(`${apiUrl}/inference/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-backend-key": apiKey },
      body: JSON.stringify(body),
    });

    if (resp.status === 402) {
      // Explicit upfront guard, same pattern as tools.ts's chainType
      // checks (e.g. buy_from_marketplace, register_on_erc8004): fail
      // here with a clear message instead of letting this fall through
      // to signPayment()'s own account.signTypedData() call, which for
      // a Solana automaton is always the compatibility stub and throws
      // an opaque low-level error. Inference is the most frequently
      // exercised x402 payment path in the system, so a silent/late
      // failure here would be hit constantly by a Solana automaton the
      // moment any paid model is used.
      const chainType = options.chainType || "evm";
      if (chainType === "solana") {
        throw new Error(
          "inference_solana_unsupported: this backend's paid inference route requires an EVM wallet. " +
            "Solana automatons cannot sign x402 EIP-712 payment authorizations for inference " +
            "(unpaid/free models, if any are configured on this backend, are unaffected).",
        );
      }

      const rawBody = await resp.json();
      const parsed = normalizePaymentRequired(rawBody);
      if (!parsed) {
        throw new Error("inference_402_missing_price: backend returned no price quote");
      }
      const requirement = selectRequirement(parsed);

      if (maxPaymentUsdc !== undefined) {
        // maxAmountRequired may arrive as a decimal USDC string ("0.0005")
        // or an atomic integer (500) depending on the resource — decimal
        // strings (containing ".") are already in USDC, not base units.
        const raw = requirement.maxAmountRequired;
        const amountUsdc = raw.includes(".") ? Number(raw) : Number(raw) / 1_000_000;
        if (amountUsdc > maxPaymentUsdc) {
          throw new Error(
            `inference_price_exceeds_limit: quoted $${amountUsdc.toFixed(4)}, max allowed $${maxPaymentUsdc}`,
          );
        }
      }

      const signed = await signPayment(account, requirement, parsed.x402Version);

      resp = await httpClient.request(`${apiUrl}/inference/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-backend-key": apiKey },
        body: JSON.stringify({
          ...body,
          xPayment: {
            ...signed.payload,
            network: requirement.network,
            resource: "/inference/chat",
            maxTokens,
          },
        }),
        retries: 0,
      });
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`inference_error: ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as {
      completion: {
        id: string;
        model: string;
        choices: Array<{
          message: { role: string; content: string; tool_calls?: InferenceToolCall[] };
          finish_reason: string;
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      usedTokens: number;
      chargedUsdc: string;
    };

    const choice = data.completion.choices[0];
    const usage: TokenUsage = {
      promptTokens: data.completion.usage?.prompt_tokens ?? 0,
      completionTokens: data.completion.usage?.completion_tokens ?? 0,
      totalTokens: data.completion.usage?.total_tokens ?? data.usedTokens ?? 0,
    };

    return {
      id: data.completion.id,
      model: data.completion.model,
      message: {
        role: "assistant",
        content: choice.message.content ?? "",
        tool_calls: choice.message.tool_calls,
      },
      toolCalls: choice.message.tool_calls,
      usage,
      finishReason: choice.finish_reason,
    };
  };

  return {
    chat,
    setLowComputeMode: (enabled: boolean) => {
      currentModel = enabled ? options.lowComputeModel || "qwen3-4b" : options.defaultModel;
    },
    getDefaultModel: () => currentModel,
  };
}
