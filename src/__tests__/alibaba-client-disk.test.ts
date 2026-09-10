import { test } from "node:test";
import assert from "node:assert/strict";
import { AlibabaClient, type AliyunRpcClient, type VmExecFn } from "../infra/alibaba-client.js";

const INSTANCE_ID = "i-bp1abcdefghijklmnop";

function fakeEcs(): AliyunRpcClient {
  return {
    async request(action: string) {
      if (action === "DescribeInstances") {
        return { Instances: { Instance: [{ InstanceType: "ecs.g6.large", ExpiredTime: "2026-12-01T00:00:00Z" }] } };
      }
      if (action === "DescribeDisks") {
        return { Disks: { Disk: [{ Size: 100 }] } };
      }
      throw new Error(`unexpected ecs action ${action}`);
    },
  };
}
const fakeBss: AliyunRpcClient = { async request() { return {}; } };

function fakeCms(byMetric: Record<string, any>): AliyunRpcClient {
  return {
    async request(action: string, params: Record<string, unknown>) {
      const metricName = params.MetricName as string;
      if (!(metricName in byMetric)) throw new Error(`unexpected metric ${metricName}`);
      return byMetric[metricName];
    },
  };
}

const okCpuMem = {
  cpu_total: { Datapoints: JSON.stringify([{ timestamp: 1, Average: 5 }]) },
  memory_usedutilization: { Datapoints: JSON.stringify([{ timestamp: 1, Average: 5 }]) },
};

test("diskUsedGb comes from CloudMonitor's disk_usedutilization when available", async () => {
  const cms = fakeCms({
    ...okCpuMem,
    disk_usedutilization: { Datapoints: JSON.stringify([{ timestamp: 1, Average: 42 }]) },
  });
  const client = new AlibabaClient(fakeEcs(), fakeBss, "cn-hangzhou", cms);
  const usage = await client.getVmUsage(INSTANCE_ID);
  assert.equal(usage.diskTotalGb, 100);
  assert.equal(usage.diskUsedGb, 42); // 100GB * 42%
});

test("diskUsedGb falls back to df over execFn when CloudMonitor has no disk datapoints", async () => {
  const cms = fakeCms({
    ...okCpuMem,
    disk_usedutilization: { Datapoints: JSON.stringify([]) }, // agent not installed
  });
  const execCalls: string[] = [];
  const execFn: VmExecFn = async (command) => {
    execCalls.push(command);
    return { stdout: `${30 * 1024 ** 3}\n`, stderr: "", exitCode: 0 }; // 30GB used
  };
  const client = new AlibabaClient(fakeEcs(), fakeBss, "cn-hangzhou", cms, execFn);
  const usage = await client.getVmUsage(INSTANCE_ID);
  assert.equal(usage.diskUsedGb, 30);
  assert.equal(execCalls.length, 1);
  assert.match(execCalls[0], /^df /);
});

test("diskUsedGb uses df directly when no CloudMonitor client is wired up at all", async () => {
  const execFn: VmExecFn = async () => ({ stdout: `${15 * 1024 ** 3}\n`, stderr: "", exitCode: 0 });
  const client = new AlibabaClient(fakeEcs(), fakeBss, "cn-hangzhou", undefined, execFn);
  const usage = await client.getVmUsage(INSTANCE_ID);
  assert.equal(usage.diskUsedGb, 15);
});

test("diskUsedGb degrades to 0 (not a throw) when neither CloudMonitor nor execFn is wired up", async () => {
  const client = new AlibabaClient(fakeEcs(), fakeBss, "cn-hangzhou");
  const usage = await client.getVmUsage(INSTANCE_ID);
  assert.equal(usage.diskUsedGb, 0);
  assert.equal(usage.diskTotalGb, 100);
});

test("diskUsedGb degrades to 0 when df fails (non-zero exit) rather than throwing", async () => {
  const execFn: VmExecFn = async () => ({ stdout: "", stderr: "df: command not found", exitCode: 127 });
  const client = new AlibabaClient(fakeEcs(), fakeBss, "cn-hangzhou", undefined, execFn);
  const usage = await client.getVmUsage(INSTANCE_ID);
  assert.equal(usage.diskUsedGb, 0);
});

test("diskUsedGb degrades to 0 when df throws rather than crashing getVmUsage", async () => {
  const execFn: VmExecFn = async () => {
    throw new Error("ssh connection refused");
  };
  const client = new AlibabaClient(fakeEcs(), fakeBss, "cn-hangzhou", undefined, execFn);
  const usage = await client.getVmUsage(INSTANCE_ID);
  assert.equal(usage.diskUsedGb, 0);
  assert.equal(usage.diskTotalGb, 100); // rest of the snapshot still resolves
});

test("diskUsedGb is 0 with no disks and never calls execFn", async () => {
  const ecsNoDisks: AliyunRpcClient = {
    async request(action: string) {
      if (action === "DescribeInstances") {
        return { Instances: { Instance: [{ InstanceType: "ecs.g6.large", ExpiredTime: "2026-12-01T00:00:00Z" }] } };
      }
      if (action === "DescribeDisks") return { Disks: { Disk: [] } };
      throw new Error("unexpected");
    },
  };
  let execCalled = false;
  const execFn: VmExecFn = async () => {
    execCalled = true;
    return { stdout: "0", stderr: "", exitCode: 0 };
  };
  const client = new AlibabaClient(ecsNoDisks, fakeBss, "cn-hangzhou", undefined, execFn);
  const usage = await client.getVmUsage(INSTANCE_ID);
  assert.equal(usage.diskUsedGb, 0);
  assert.equal(usage.diskTotalGb, 0);
  assert.equal(execCalled, false, "no point running df against a 0-capacity report");
});
