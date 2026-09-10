# Infra-Ops: Alibaba Cloud USDC payment pipeline

Lets an automaton keep its own Alibaba Cloud VM alive and sized
correctly by watching usage, sending USDC to your Alibaba-side wallet
ahead of need, waiting out Alibaba's ~30-40 min settlement window, then
calling the actual resize/renew API.

## Files

| File | Role |
|---|---|
| `types.ts` | State machine states, `InfraPolicy`, `InfraWalletConfig` |
| `database.ts` | `infra_ops` / `infra_ops_events` / `infra_locks` tables |
| `usdc.ts` | Plain ERC-20 USDC transfer + settlement polling |
| `alibaba-client.ts` | Thin wrapper over an injected `@alicloud/pop-core` client |
| `triggers.ts` | Pure "should this fire, and for how much" decisions |
| `ops.ts` | The state machine: cost_detected → ... → confirmed |
| `../heartbeat/infra-tasks.ts` | Heartbeat tasks calling triggers → ops |
| `../agent/policy-rules/infra-financial.ts` | Spend caps + wallet allowlist |

## 1. Install the Alibaba SDK

```bash
cd agent && npm install @alicloud/pop-core
```

## 2. Env vars (`agent/.env`)

```
ALIBABA_ACCESS_KEY_ID=...       # a RAM sub-account, NOT your root key
ALIBABA_ACCESS_KEY_SECRET=...
ALIBABA_REGION_ID=cn-hangzhou   # or wherever your VM actually is
ALIBABA_WALLET_ADDRESS=0x...    # the wallet you (the human) control that
                                 # Alibaba credits after you convert/deposit
ALIBABA_INSTANCE_ID=i-xxxxxxxx
ALIBABA_DISK_ID=d-xxxxxxxx
```

Get the RAM sub-account key from the Alibaba Cloud console (RAM →
Users → Create), and attach a custom policy scoped to exactly:
`ecs:DescribeInstances`, `ecs:DescribeDisks`, `ecs:DescribeRenewalPrice`,
`ecs:RenewInstance`, `ecs:DescribeDiskResizeOrder`, `ecs:ResizeDisk`,
`ecs:ModifyInstanceSpec`, `bssapi:QueryAccountBalance`. Not
`AdministratorAccess` — this key lives in your agent's `.env`.

## 3. Migration

Call `initInfraSchema(db)` once at startup, right next to wherever
`agent/src/state/database.ts` runs its own schema setup (`index.ts`,
before the heartbeat starts).

## 4. Wire the heartbeat tasks

```ts
// agent/src/index.ts, near where BUILTIN_TASKS is assembled
import { RPCClient } from "@alicloud/pop-core";
import { AlibabaClient } from "./infra/alibaba-client.js";
import { initInfraSchema } from "./infra/database.js";
import { createInfraTasks, INFRA_TASK_INTERVALS_MS } from "./heartbeat/infra-tasks.js";
import { DEFAULT_INFRA_POLICY } from "./infra/types.js";

initInfraSchema(db);

const ecsClient = new RPCClient({
  accessKeyId: process.env.ALIBABA_ACCESS_KEY_ID!,
  accessKeySecret: process.env.ALIBABA_ACCESS_KEY_SECRET!,
  endpoint: "https://ecs.aliyuncs.com",
  apiVersion: "2014-05-26",
});
const bssClient = new RPCClient({
  accessKeyId: process.env.ALIBABA_ACCESS_KEY_ID!,
  accessKeySecret: process.env.ALIBABA_ACCESS_KEY_SECRET!,
  endpoint: "https://business.aliyuncs.com",
  apiVersion: "2017-12-14",
});
// Optional but recommended: without this, cpuPercent/memPercent/diskUsedGb
// all read 0 forever and the RAM/storage triggers below never fire.
const cmsClient = new RPCClient({
  accessKeyId: process.env.ALIBABA_ACCESS_KEY_ID!,
  accessKeySecret: process.env.ALIBABA_ACCESS_KEY_SECRET!,
  endpoint: `https://metrics.${process.env.ALIBABA_REGION_ID}.aliyuncs.com`,
  apiVersion: "2019-01-01",
});

const infraDeps = {
  db,
  account,                    // the automaton's own PrivateKeyAccount, already created elsewhere in index.ts
  // Third optional arg (execFn) is only needed as a diskUsedGb fallback
  // for VMs that don't have the Cloud Monitor agent installed — reuse
  // this automaton's own backend client's exec() if it already talks to
  // this VM (backend/client.ts), or omit it and rely on cmsClient's
  // disk_usedutilization metric once the agent is installed.
  alibaba: new AlibabaClient(ecsClient, bssClient, process.env.ALIBABA_REGION_ID!, cmsClient, backendClient.exec),
  policy: DEFAULT_INFRA_POLICY,
  wallet: {
    alibabaWalletAddress: process.env.ALIBABA_WALLET_ADDRESS!,
    network: "base" as const,
  },
};

const infraTasks = createInfraTasks(infraDeps, process.env.ALIBABA_INSTANCE_ID!, process.env.ALIBABA_DISK_ID!);

// Merge into the existing scheduler however heartbeat/index.ts (or
// wherever BUILTIN_TASKS + COLONY_TASK_INTERVALS_MS get registered)
// does it for the built-in tasks — same map, same registration call.
Object.assign(BUILTIN_TASKS, infraTasks);
Object.assign(COLONY_TASK_INTERVALS_MS, INFRA_TASK_INTERVALS_MS);
```

## 5. Wire the policy rules

```ts
// wherever createDefaultRules() assembles policy-rules/index.ts's list
import { createInfraFinancialRules } from "./agent/policy-rules/infra-financial.js";

rules.push(...createInfraFinancialRules(DEFAULT_INFRA_POLICY, process.env.ALIBABA_WALLET_ADDRESS!));
```

## 6. Multi-agent / shared-wallet setups

If more than one automaton watches VMs funded from the *same* Alibaba
wallet, they all need the same `infra_locks` table — meaning the same
SQLite file, or (better, per your earlier architecture notes) route
infra-ops through one designated "infra-ops" automaton and have the
others request top-ups via the inbox relay (`social/`) instead of
calling `runInfraPurchase` directly. The lock in `database.ts` only
protects agents sharing one DB; it does nothing across separate
sandboxes with separate SQLite files.

## 7. What's a stub, deliberately

- **CPU/mem usage** (`alibaba-client.ts`'s `getVmUsage`) returns 0 —
  real numbers need either CloudMonitor's `DescribeMetricLast` or a
  `df`/`free` call through your own backend's exec endpoint. Capacity
  triggers degrade to "never fires" until this is wired in, not to
  "fires constantly on garbage data."
- **Target instance type for RAM/GPU bumps** — `infra-tasks.ts` surfaces
  a wake-up with the reason instead of guessing a spec, since that's a
  workload judgment call, not a mechanical trigger.
- **`resumeAndPurchase` / `resumeStaleOp`** — only meant to be called
  from an operator CLI command (mirroring `automaton-cli constitution
  clear`), never from an agent tool. This repo doesn't have that CLI
  command yet; add one under `agent/packages/cli/src/commands/` if you
  want the agent-facing escape hatch instead of calling these
  functions directly from a script.

## 8. Before real money

Test the whole pipeline against `base-sepolia` + a sandbox/test
Alibaba account first, same as the rest of this repo's `.env.example`
already tells you to do for everything else financial. Specifically
verify: the settlement-timeout path actually reaches `stale` (don't
just assume — kill the poll early once and watch it), and that
`infra_locks` actually blocks a second concurrent call before you ever
run two automatons against one wallet for real.
