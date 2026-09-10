# Phase 4 + Phase 2: Multi-Sandbox & Ports

## What was built

**automaton-stack (your backend):**
- `db.ts` — new `sandboxes` and `exposed_ports` tables.
- `docker.ts` — generalized: the original shared `automaton-sandbox`
  container is untouched and still works exactly as before (backward
  compatible). Added `createNamedSandbox`, `deleteNamedSandbox`,
  `execInNamedSandbox`, `getPublishedHostPort` for isolated, per-agent
  containers with the same hardening profile (no-new-privileges,
  dropped caps, read-only rootfs, cgroup limits) plus optional bridge
  networking with published ports when the caller asks for them.
- `portProxy.ts` — new. A public `/app/{token}/*` reverse proxy built
  entirely on Node's built-in `http` module (no new dependency to
  audit). No wildcard domain needed — it proxies by path token, not
  subdomain. Mounted *before* the shared-secret auth check in
  `index.ts` since these links are meant to be shareable, the same
  trust model as a Conway `life.conway.tech` URL.
- `vmService.ts` — new routes:
  - `POST /vm/sandboxes` — create an isolated sandbox (vcpu/memory/disk
    caps enforced from config, `MAX_SANDBOXES_PER_AGENT` enforced)
  - `GET /vm/sandboxes?agentAddress=` — list
  - `DELETE /vm/sandboxes/:id` — stop + remove the container
  - `POST /vm/sandboxes/:id/ports` — expose a container port, returns
    a public URL
  - `DELETE /vm/sandboxes/:id/ports/:containerPort` — unexpose
  - `GET /vm/ports?agentAddress=` — list an agent's exposed ports
  - `/vm/exec`, `/vm/file/write`, `/vm/file/read` now accept an
    optional `sandboxId` — omit it and behavior is identical to
    before (targets the shared container); pass it and the call is
    ownership-checked and routed to that isolated sandbox instead.
- `config.ts` — new env vars: `MAX_SANDBOXES_PER_AGENT`,
  `MAX_SANDBOX_VCPU`, `MAX_SANDBOX_MEMORY_MB`, `MIN_SANDBOX_MEMORY_MB`,
  `MAX_SANDBOX_DISK_GB`, `PUBLIC_BASE_URL`,
  `MAX_EXPOSED_PORTS_PER_SANDBOX`. Add these to your `.env`.

**automaton-custom (your agent):**
- `backend/client.ts` — `createSandbox`, `deleteSandbox`,
  `listSandboxes`, `exposePort`, `removePort` now actually call the
  routes above instead of throwing. Verified this lines up end-to-end
  with `replication/spawn.ts`'s existing flow (`createSandbox()` →
  `createScopedClient(sandbox.id)` → scoped `exec`/`writeFile` on the
  child) without needing to touch the replication module at all — it
  was already written against this exact interface shape.
- `types.ts` — added an optional `exposedPorts?: number[]` to
  `CreateSandboxOptions` (backward compatible), since Docker can't add
  published ports to a running container — they must be declared when
  the sandbox is created.

## Architectural choice worth knowing about

A container only gets network access (`NetworkMode: bridge`) if you
pass `exposedPorts` when calling `createSandbox`. Otherwise it's
`NetworkMode: none`, same as the original shared sandbox — no network
at all, by design. So: if the agent wants to expose a port on a
sandbox it already created without declaring ports up front, that
sandbox needs to be deleted and recreated with `exposedPorts` set.
This mirrors Docker's real constraint (you can't dynamically publish a
port on a running container) rather than hiding it.

## Before you run this

1. Add the new env vars above to automaton-stack's `.env` — at minimum
   set `PUBLIC_BASE_URL` to `http://YOUR_ALIBABA_VM_IP:8080` (or your
   domain if you put one in front later).
2. Rebuild the sandbox Docker image if you haven't (`sandbox/Dockerfile`
   — unchanged by this work, still applies to both shared and isolated
   containers).
3. Same caveat as before: no live `tsc`/`npm install` was run in this
   session (no network access here). Build on your VM and fix any
   small type nits that surface.
4. Exposed-port URLs currently carry no HTTPS/TLS — they're plain HTTP
   on your VM's IP. Fine for testing; put a real reverse proxy (Caddy
   with automatic HTTPS is the easy option) in front of the whole
   backend later if you want TLS on these links.

## Still open

- **Domains** (real registrar integration) — deliberately last, since
  it's the one piece involving a funded third-party account.
- **tsc build verification** — do this before trusting either change
  set in production.
