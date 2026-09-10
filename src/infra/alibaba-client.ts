/**
 * Alibaba Cloud Client
 *
 * Deliberately does NOT hand-roll Alibaba's request signing (ACS3-HMAC-SHA256).
 * Getting cloud-provider request signing subtly wrong is a common source of
 * silent auth failures, and Alibaba already publishes a correct client for
 * this. Instead, this wraps whatever RPC-style client you construct from
 * @alicloud/pop-core (or a generated per-product SDK like
 * @alicloud/ecs20140526 / @alicloud/bssopenapi20171214) — both expose the
 * same shape: `client.request(action: string, params: object): Promise<any>`.
 *
 *   npm install @alicloud/pop-core
 *
 *   import { RPCClient } from "@alicloud/pop-core";
 *   const ecsClient = new RPCClient({
 *     accessKeyId: process.env.ALIBABA_ACCESS_KEY_ID!,
 *     accessKeySecret: process.env.ALIBABA_ACCESS_KEY_SECRET!,
 *     endpoint: "https://ecs.aliyuncs.com",
 *     apiVersion: "2014-05-26",
 *   });
 *   const bssClient = new RPCClient({
 *     ...,
 *     endpoint: "https://business.aliyuncs.com",
 *     apiVersion: "2017-12-14",
 *   });
 *   const cmsClient = new RPCClient({
 *     ...,
 *     endpoint: "https://metrics.{regionId}.aliyuncs.com",
 *     apiVersion: "2019-01-01",
 *   });
 *   const client = new AlibabaClient(ecsClient, bssClient, regionId, cmsClient, execFn);
 *
 * The AccessKey used here should be a RAM sub-account scoped to exactly
 * the ECS/BSS actions below — never your root account key. This client
 * only ever reads usage/billing and calls the specific resize/renew
 * actions; it has no reason to hold broader permissions.
 */

import { createLogger } from "../observability/logger.js";
import type { VmUsageSnapshot } from "./types.js";

const logger = createLogger("infra.alibaba");

export interface AliyunRpcClient {
  request<T = any>(action: string, params: Record<string, unknown>, options?: Record<string, unknown>): Promise<T>;
}

/** Matches BackendClient's exec() shape (agent/src/backend/client.ts) —
 *  a caller wiring this up against its own automaton-stack VM can pass
 *  that exact function straight through. */
export type VmExecFn = (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface PurchaseResult {
  success: boolean;
  orderId?: string;
  actualCostUsd?: number;
  error?: string;
}

export class AlibabaClient {
  constructor(
    private ecs: AliyunRpcClient,
    private bss: AliyunRpcClient,
    private regionId: string,
    // Optional, unlike ecs/bss: CloudMonitor ("cms") is a separate
    // Alibaba product (endpoint metrics.{region}.aliyuncs.com,
    // apiVersion 2019-01-01 — same RPCClient shape as ecs/bss, per this
    // file's own header). Optional rather than required so an existing
    // caller that only ever wired up ecs/bss (there are none in this
    // repo today, but the constructor shouldn't force a breaking change
    // on whoever wires this up next) keeps working — getVmUsage just
    // degrades cpuPercent/memPercent to 0 (see below) exactly as it did
    // before this metric was wired in, instead of throwing.
    private cms?: AliyunRpcClient,
    // Optional `df`-over-exec fallback for disk usage (see getDiskUsedGb
    // below) — VmExecFn's shape matches BackendClient.exec() exactly, so
    // a caller already talking to its own VM via automaton-stack's
    // /vm/exec can pass that function straight through with no
    // adapter. Optional for the same backward-compatibility reason `cms`
    // is: a caller with neither cms nor execFn wired up still gets a
    // working client, just with diskUsedGb degrading to 0.
    private execFn?: VmExecFn,
  ) {}

  /**
   * Current usage snapshot for one instance. CPU/mem come from
   * CloudMonitor's DescribeMetricLast (metrics cpu_total,
   * memory_usedutilization, namespace acs_ecs_dashboard — the standard
   * ECS-dashboard metric set every instance reports without needing a
   * separately-installed monitoring agent); disk *capacity* and renewal
   * date come directly from ECS's own DescribeInstances/DescribeDisks;
   * disk *used* bytes come from getDiskUsedGb() below (CloudMonitor's
   * disk_usedutilization metric, falling back to a `df` call over
   * execFn — see that method's own doc comment for why two paths).
   */
  async getVmUsage(instanceId: string): Promise<VmUsageSnapshot> {
    const [instanceResp, disksResp, cpuPercent, memPercent] = await Promise.all([
      this.ecs.request("DescribeInstances", {
        RegionId: this.regionId,
        InstanceIds: JSON.stringify([instanceId]),
      }),
      this.ecs.request("DescribeDisks", {
        RegionId: this.regionId,
        InstanceId: instanceId,
      }),
      this.getLatestMetric(instanceId, "cpu_total"),
      this.getLatestMetric(instanceId, "memory_usedutilization"),
    ]);

    const instance = instanceResp?.Instances?.Instance?.[0];
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found in DescribeInstances response`);
    }

    const disks = disksResp?.Disks?.Disk ?? [];
    const diskTotalGb = disks.reduce((sum: number, d: any) => sum + (d.Size ?? 0), 0);
    const diskUsedGb = await this.getDiskUsedGb(instanceId, diskTotalGb);

    return {
      instanceId,
      cpuPercent,
      memPercent,
      diskUsedGb,
      diskTotalGb,
      gpuAttached: /gn|ga|gu/i.test(instance.InstanceType ?? ""), // Alibaba GPU family prefixes
      renewalDueAt: instance.ExpiredTime, // ISO8601 already, per ECS API
    };
  }

  /**
   * Real disk-used-bytes, in GB. Neither DescribeInstances nor
   * DescribeDisks exposes this (they only know provisioned capacity) —
   * this tries two sources in order, same "degrade, don't throw"
   * posture as getLatestMetric() below:
   *
   *   1. CloudMonitor's `disk_usedutilization` metric (percent used,
   *      same DescribeMetricLast call cpu/mem already use) — requires
   *      the Cloud Monitor agent to be installed on the instance, unlike
   *      cpu_total/memory_usedutilization which every instance reports
   *      by default. Uses getLatestMetricRaw() (not getLatestMetric())
   *      specifically so "no datapoints yet" (agent not installed, or
   *      installed too recently) is distinguishable from "genuinely 0%
   *      used" — the former should fall through to step 2, the latter
   *      is a real answer worth returning as-is.
   *   2. A `df` call through execFn (see this file's own header + the
   *      VmExecFn doc comment) against the root filesystem. Only covers
   *      "/" — an instance with data on a second mounted disk that
   *      DescribeDisks reports as separate capacity won't have that
   *      second disk's usage counted. Narrow on purpose: matching
   *      capacity across multiple disks/mounts to their actual mount
   *      points is a real feature, not a one-line fallback, and out of
   *      scope for what's otherwise a "make the trigger not always read
   *      0" fix.
   *
   * Returns 0, logged, if neither source is wired up or both fail —
   * the same "capacity trigger degrades to never fires rather than
   * firing on garbage data" posture this returned unconditionally
   * before either path existed.
   */
  private async getDiskUsedGb(instanceId: string, diskTotalGb: number): Promise<number> {
    if (diskTotalGb <= 0) return 0;

    if (this.cms) {
      const pct = await this.getLatestMetricRaw(instanceId, "disk_usedutilization");
      if (pct !== null) {
        return Math.round(diskTotalGb * (pct / 100) * 100) / 100;
      }
      logger.warn(
        `getDiskUsedGb: no disk_usedutilization datapoints for ${instanceId} yet (Cloud Monitor agent not installed, or too recently) — falling back to df`,
      );
    }

    if (this.execFn) {
      try {
        const result = await this.execFn("df -B1 --output=used / | tail -1");
        const usedBytes = Number(result.stdout.trim());
        if (result.exitCode === 0 && Number.isFinite(usedBytes)) {
          return Math.round((usedBytes / 1024 ** 3) * 100) / 100;
        }
        logger.warn(`getDiskUsedGb: df fallback for ${instanceId} returned unparseable output: ${JSON.stringify(result)}`);
      } catch (err: any) {
        logger.error(`getDiskUsedGb: df fallback failed for ${instanceId}: ${err.message}`);
      }
    }

    if (!this.cms && !this.execFn) {
      logger.warn(`getDiskUsedGb: no CloudMonitor client or execFn wired up for ${instanceId} — diskUsedGb degrading to 0`);
    }
    return 0;
  }

  /**
   * Latest single-instance reading for one CloudMonitor ECS-dashboard
   * metric, as a percent (0-100). Returns 0 — the "degrades to never
   * fires" posture getDiskUsedGb() above also follows — on any of three
   * non-fatal conditions, each logged distinctly so a caller debugging a
   * stuck-at-0 capacity trigger can tell which one hit:
   *   1. no `cms` client was ever wired up (constructor's `cms` is
   *      optional — see its own doc comment),
   *   2. the API call itself fails (network, auth, throttling — a
   *      transient CloudMonitor outage should never crash a capacity
   *      check, it should just skip triggering until the next poll),
   *   3. the call succeeds but returns no datapoints yet (freshly
   *      launched instance — CloudMonitor's first datapoint typically
   *      lags actual boot by up to a few minutes).
   * Thin wrapper over getLatestMetricRaw() below, collapsing its `null`
   * ("no data") case to 0 — the right behavior for cpu/mem, which have
   * no second data source to fall back to. getDiskUsedGb() calls the
   * raw form directly instead, since it needs to tell "no data" apart
   * from "genuinely 0%" to decide whether to fall back to df.
   */
  private async getLatestMetric(instanceId: string, metricName: string): Promise<number> {
    const value = await this.getLatestMetricRaw(instanceId, metricName);
    return value ?? 0;
  }

  /** Same call as getLatestMetric() above, but returns `null` (rather
   *  than degrading to 0) when the client isn't wired up, the call
   *  fails, or there are no datapoints yet — see getLatestMetric()'s own
   *  doc comment for why that distinction matters to getDiskUsedGb(). */
  private async getLatestMetricRaw(instanceId: string, metricName: string): Promise<number | null> {
    if (!this.cms) {
      logger.warn(`getLatestMetric(${metricName}) skipped for ${instanceId}: no CloudMonitor client wired up`);
      return null;
    }
    try {
      const resp = await this.cms.request("DescribeMetricLast", {
        Namespace: "acs_ecs_dashboard",
        MetricName: metricName,
        Dimensions: JSON.stringify([{ instanceId }]),
      });
      const raw = resp?.Datapoints;
      const datapoints: any[] = typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
      if (datapoints.length === 0) {
        logger.warn(`getLatestMetric(${metricName}) for ${instanceId}: no datapoints yet`);
        return null;
      }
      // DescribeMetricLast is documented to return the single most
      // recent datapoint, but doesn't guarantee array order across all
      // metrics/regions — sort defensively rather than trust index 0.
      const latest = datapoints.reduce((a, b) => ((a.timestamp ?? 0) >= (b.timestamp ?? 0) ? a : b));
      const value = Number(latest.Average ?? latest.Value ?? NaN);
      return Number.isFinite(value) ? value : null;
    } catch (err: any) {
      logger.error(`getLatestMetric(${metricName}) failed for ${instanceId}: ${err.message}`);
      return null;
    }
  }

  /** Alibaba-side account balance in USD-equivalent, post-settlement. */
  async getAccountBalance(): Promise<number> {
    const resp = await this.bss.request("QueryAccountBalance", {});
    // AvailableAmount is a formatted string like "60.00" per BSS API docs.
    const amount = parseFloat(resp?.Data?.AvailableAmount ?? "0");
    return Number.isFinite(amount) ? amount : 0;
  }

  /** Quoted renewal price without committing to it. */
  async getRenewalPriceUsd(instanceId: string, periodMonths: number): Promise<number> {
    const resp = await this.ecs.request("DescribeRenewalPrice", {
      InstanceId: instanceId,
      PriceUnit: "Month",
    });
    return parseFloat(resp?.OrderPriceInfo?.Price?.TradePrice ?? "0");
  }

  async renewInstance(instanceId: string, periodMonths: number): Promise<PurchaseResult> {
    try {
      const resp = await this.ecs.request("RenewInstance", {
        InstanceId: instanceId,
        Period: periodMonths,
        PeriodUnit: "Month",
      });
      logger.info(`Renewed ${instanceId} for ${periodMonths} month(s)`);
      return { success: true, orderId: resp?.OrderId };
    } catch (err: any) {
      logger.error(`RenewInstance failed for ${instanceId}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async getDiskResizePriceUsd(diskId: string, newSizeGb: number): Promise<number> {
    const resp = await this.ecs.request("DescribeDiskResizeOrder", {
      DiskId: diskId,
      NewSize: newSizeGb,
    });
    return parseFloat(resp?.OrderPriceInfo?.Price?.TradePrice ?? "0");
  }

  async resizeDisk(diskId: string, newSizeGb: number): Promise<PurchaseResult> {
    try {
      const resp = await this.ecs.request("ResizeDisk", {
        DiskId: diskId,
        NewSize: newSizeGb,
        Type: "online", // avoids a reboot where the instance supports it
      });
      logger.info(`Resized disk ${diskId} to ${newSizeGb}GB`);
      return { success: true, orderId: resp?.RequestId };
    } catch (err: any) {
      logger.error(`ResizeDisk failed for ${diskId}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /** RAM/vCPU upgrade — requires the instance to be Stopped first per
   *  Alibaba's own API constraints (see ModifyInstanceSpec docs). */
  async resizeInstanceSpec(instanceId: string, newInstanceType: string): Promise<PurchaseResult> {
    try {
      const resp = await this.ecs.request("ModifyInstanceSpec", {
        InstanceId: instanceId,
        InstanceType: newInstanceType,
      });
      logger.info(`Resized ${instanceId} to ${newInstanceType}`);
      return { success: true, orderId: resp?.RequestId };
    } catch (err: any) {
      logger.error(`ModifyInstanceSpec failed for ${instanceId}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * GPU migration is the same ModifyInstanceSpec call with a GPU-family
   * instance type (e.g. ecs.gn7i-c8g1.2xlarge) — kept as a separate
   * method because callers (ops.ts) apply a different, stricter policy
   * gate to it than a routine RAM bump.
   */
  async migrateToGpu(instanceId: string, gpuInstanceType: string): Promise<PurchaseResult> {
    return this.resizeInstanceSpec(instanceId, gpuInstanceType);
  }
}
