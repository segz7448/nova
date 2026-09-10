# Migration: Conway → Your Self-Hosted Backend

This is `automaton-main` retargeted to run entirely against your own
`automaton-stack` backend (Alibaba Cloud VM) and OpenRouter (`ox-alpha`),
with no calls to Conway's real infrastructure. Built following Conway's
public docs (tool shapes, x402 flow) as a design reference only —
nothing here talks to `api.conway.tech`, `life.conway.tech`,
`inference.conway.tech`, or `social.conway.tech`.

## What changed

**Config (`src/types.ts`, `src/config.ts`)**
- `conwayApiUrl`/`conwayApiKey`/`registeredWithConway` renamed to
  `backendApiUrl`/`backendApiKey`/`registeredWithBackend` everywhere
  they're used (8 files, no leftovers).
- Default backend URL now reads `process.env.BACKEND_API_URL`, falling
  back to a placeholder you need to fill in with your VM's IP:port.
- `x402AllowedDomains` was hardcoded to `['conway.tech']` — payments to
  your own backend would have been silently refused by this policy
  check. Now reads `BACKEND_HOST` from env.
- `socialRelayUrl` (agent-to-agent chat, a separate Conway product) was
  hardcoded to `social.conway.tech`. Disabled by default (empty string)
  since there's no self-hosted equivalent yet — build one later if you
  want this capability.

**New `src/backend/` module** (replaces `src/conway/client.ts` + `conway/inference.ts`)
- `client.ts` — implements the same tool interface, wired to your real
  routes: `exec` → `POST /vm/exec` (wrapped in `bash -c "..."` so shell
  syntax like pipes and `&&` still works — **you must add `bash` to
  `VM_ALLOWED_COMMANDS`** in automaton-stack's `.env`), file read/write,
  wallet balance (`getCreditsBalance` returns USDC×100 as a "cents"
  shim so downstream survival-tier code keeps working unmodified),
  and a real working `transferCredits` (signs + settles an actual
  on-chain USDC transfer — this is what funds a clone).
  `exposePort`, `removePort`, `createSandbox`, `deleteSandbox`,
  `listSandboxes`, `searchDomains`, `registerDomain`, and the DNS tools
  throw a clear `NotImplementedError` instead of crashing or silently
  hitting Conway — the agent gets a readable explanation and moves on
  (verified this is caught safely by the existing try/catch around
  every tool call in `agent/tools.ts`).
- `inference.ts` — calls `POST /inference/chat`, which is x402-gated
  per-request on your backend (unlike Conway's credit-balance model).
  Self-signs each payment with the agent's own wallet key — your
  backend never custodies it. Respects a spend ceiling derived from
  `treasuryPolicy.maxX402PaymentCents`.
- `x402.ts` — your existing generic EIP-3009 signing code, copied over
  and exported for reuse. Confirmed its output shape matches your
  `wallet.ts`'s `/pay` route and `facilitator.ts`'s `/verify` + `/settle`
  routes exactly, byte for byte.

**`src/identity/provision.ts`** — fully rewritten. Conway's flow was
SIWE → JWT → per-agent API key issuance. Your backend uses one static
shared secret (`BACKEND_API_KEY`, set once in `.env`), so this file's
job shrank to: register the agent's wallet address with your backend
(`POST /wallet/register`) for lineage tracking, and save local config.

**`src/agent/system-prompt.ts`** — every place the model's own context
described Conway (identity, environment tool list, credits/survival
language, heartbeat status line) rewritten to describe your actual
infrastructure and its actual constraints (single fixed VM, no
port exposure yet, no domains yet, x402-per-call inference pricing).
This matters as much as the code changes — the model conditions its
tool-use decisions on what this text tells it exists.

**`src/agent/tools.ts`** — `topup_credits` tool rewritten from "buy
Conway credits via x402" (meaningless here — there's no separate
credits ledger) into an honest no-op that explains the USDC balance
check happens directly, per request.

**`src/index.ts`** — bootstrap "buy $5 of credits on startup" logic
replaced with a plain balance log; client/inference construction
retargeted to the new `backend/` module; stray Conway URLs in `--help`
text fixed.

## Known remaining gaps (safe, but incomplete)

1. **`src/conway/topup.ts` (now `src/chain-utils/topup.ts`) is still
   referenced** by 4 dynamic-import call sites in `agent/loop.ts`,
   `agent/tools.ts`, and `heartbeat/tasks.ts` (auto-topup-when-low-balance
   logic). These call a `GET /pay/{amount}/{address}` endpoint that
   doesn't exist on your backend — they'll fail and get caught by
   existing error handling (no crash), but it's dead weight worth
   removing in a follow-up pass. (Unchanged by the Phase 11 cleanup
   below — `topup.ts` is functionally generic on-chain code, not a
   Conway dependency itself; only its directory moved.)
2. ~~**`src/conway/client.ts` and `src/conway/inference.ts`** are now
   unused (superseded by `src/backend/`) but left in place rather than
   deleted, to keep this diff reviewable. Safe to delete once you've
   confirmed the new modules work.~~ **Done (error-fix.md Phase 11):**
   both files deleted, their one remaining test (`low-compute.test.ts`)
   migrated onto `src/backend/inference.ts`, `src/conway/` renamed to
   `src/chain-utils/` for the four files that were actually still
   live (`credits.ts`, `http-client.ts`, `topup.ts`, `x402.ts`), and
   the `ConwayClient` type renamed to `BackendClient` throughout. See
   `error-fix.md` for the full account, including two bugs this cleanup
   surfaced: `setLowComputeMode()`/model selection wasn't actually wired
   to the backend request, and `/inference/chat`'s async settlement had
   a payment race + budget-accounting gap — both now fixed too.
3. **The OpenAI-SDK fallback path** in `agent/loop.ts` (sets
   `OPENAI_API_KEY = backendApiKey` when no direct OpenAI key exists)
   has no matching `OPENAI_BASE_URL` override anywhere — this was
   already incomplete in the original Conway codebase, not something
   this migration introduced. Low priority: it's a secondary fallback.
4. **No `tsc` build was run** — this sandbox has no network access to
   `npm install`. Run `npm install && npm run build` on your VM (or
   locally) before deploying; I did a manual, careful review of every
   import and interface shape but a real compiler pass is still worth
   doing.

## Still to build (from our earlier gap analysis)

- **Ports** — public URLs for anything the agent deploys (needs your
  own domain + Nginx/Caddy reverse proxy on the VM).
- **Domains** — real registrar API integration (Namecheap/Porkbun/
  Cloudflare Registrar).
- **Multi-sandbox / per-agent isolation** — currently one shared
  Docker container for all agents; replication needs isolated child
  environments.

## Before you run this

1. Set `BACKEND_API_URL`, `BACKEND_API_KEY`, `BACKEND_HOST` in your
   agent's environment, matching the values in automaton-stack's `.env`
   on your VM.
2. Add `bash` to `VM_ALLOWED_COMMANDS` in automaton-stack's `.env` —
   required for the new `exec()` to run arbitrary shell commands.
3. `npm install && npm run build` here, fix any compiler errors that
   surface (I did this migration by careful manual review, not a live
   compile — expect maybe a handful of small type nits, not structural
   issues).
