/**
 * Coverage for AlibabaClient.getVmUsage()'s CloudMonitor wiring
 * (alibaba-client.ts's own doc comment on getLatestMetric()) — this
 * repo's `node --test` convention, a fake AliyunRpcClient rather than
 * a real Alibaba SDK/network call, same shape every other infra test
 * in this directory already uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AlibabaClient, type AliyunRpcClient } from "../infra/alibaba-client.js";

const INSTANCE_ID = "i-bp1abcdefghijklmnop";

function fakeEcs(instanceType = "ecs.g6.large", expiredTime = "2026-12-01T00:00:00Z"): AliyunRpcClient {
  return {
    async request(action: string) {
      if (action === "DescribeInstances") {
        return { Instances: { Instance: [{ InstanceType: instanceType, ExpiredTime: expiredTime }] } };
      }
      if (action === "DescribeDisks") {
        return { Disks: { Disk: [{ Size: 40 }, { Size: 20 }] } };
      }
      throw new Error(`unexpected ecs action ${action}`);
    },
  };
}

const fakeBss: AliyunRpcClient = { async request() { return {}; } };

function fakeCms(byMetric: Record<string, any>): AliyunRpcClient {
  return {
    async request(action: string, params: Record<string, unknown>) {
      assert.equal(action, "DescribeMetricLast");
      const metricName = params.MetricName as string;
      if (!(metricName in byMetric)) throw new Error(`unexpected metric ${metricName}`);
      return byMetric[metricName];
    },
  };
}

test("getVmUsage reads cpuPercent/memPercent from CloudMonitor's most recent datapoint", async () => {
  const cms = fakeCms({
    cpu_total: { Datapoints: JSON.stringify([{ timestamp: 100, Average: 12.5 }, { timestamp: 200, Average: 41.2 }]) },
    memory_usedutilization: { Datapoints: JSON.stringify([{ timestamp: 200, Average: 63.4 }, { timestamp: 100, Average: 10 }]) },
  });
  const client = new AlibabaClient(fakeEcs(), fakeBss, "cn-hangzhou", cms);
  const usage = await client.getVmUsage(INSTANCE_ID);
  assert.equal(usage.cpuPercent, 41.2, "picks the datapoint with the latest timestamp, not array index 0");
  assert.equal(usage.memPercent, 63.4);
  assert.equal(usage.diskTotalGb, 60);
});

test("getVmUsage degrades to 0 (not a throw) when no CloudMonitor client is wired up", async () => {
  const client = new AlibabaClient(fakeEcs(), fakeBss, "cn-hangzhou" /* no cms */);
  const usage = await client.getVmUsage(INSTANCE_ID);
  assert.equal(usage.cpuPercent, 0);
  assert.equal(usage.memPercent, 0);
});

test("getVmUsage degrades to 0 when CloudMonitor returns no datapoints yet", async () => {
  const cms = fakeCms({
    cpu_total: { Datapoints: JSON.stringify([]) },
    memory_usedutilization: { Datapoints: JSON.stringify([]) },
  });
  const client = new AlibabaClient(fakeEcs(), fakeBss, "cn-hangzhou", cms);
  const usage = await client.getVmUsage(INSTANCE_ID);
  assert.equal(usage.cpuPercent, 0);
  assert.equal(usage.memPercent, 0);
});

test("getVmUsage degrades to 0 (not a throw) when CloudMonitor's call itself fails", async () => {
  const cms: AliyunRpcClient = {
    async request() {
      throw new Error("throttled");
    },
  };
  const client = new AlibabaClient(fakeEcs(), fakeBss, "cn-hangzhou", cms);
  const usage = await client.getVmUsage(INSTANCE_ID);
  assert.equal(usage.cpuPercent, 0);
  assert.equal(usage.memPercent, 0);
  // disk/instance fields (a separate ECS call) still resolve normally —
  // a CloudMonitor failure must not take down the rest of the snapshot.
  assert.equal(usage.diskTotalGb, 60);
  assert.equal(usage.gpuAttached, false);
});

test("getVmUsage still detects GPU instance types and passes through ExpiredTime", async () => {
  const cms = fakeCms({
    cpu_total: { Datapoints: JSON.stringify([{ timestamp: 1, Average: 5 }]) },
    memory_usedutilization: { Datapoints: JSON.stringify([{ timestamp: 1, Average: 5 }]) },
  });
  const client = new AlibabaClient(fakeEcs("ecs.gn7i-c8g1.2xlarge", "2027-01-01T00:00:00Z"), fakeBss, "cn-hangzhou", cms);
  const usage = await client.getVmUsage(INSTANCE_ID);
  assert.equal(usage.gpuAttached, true);
  assert.equal(usage.renewalDueAt, "2027-01-01T00:00:00Z");
});
