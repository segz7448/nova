/**
 * Zent.md Phase 18d — "Sibling discovery tool for Agent B itself: on
 * first boot it can query its own lineage to learn who its siblings
 * are (supports the 'reuse our technology' case from Strategy)."
 *
 * Mirrors backend/src/__tests__/expansionLineage.test.ts's own posture
 * (per this repo's convention: an in-memory/mock exercise of the same
 * shape a real GET /ecosystem/:rootAgentAddress response takes) rather
 * than hitting a real backend — MockBackendClient.getEcosystemTree()
 * (mocks.ts) is a settable fixture for exactly this.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";
import {
  MockInferenceClient,
  MockBackendClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase, ToolContext, AutomatonTool, EcosystemNode } from "../types.js";

const SELF_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const PARENT_ADDRESS = "0xparent000000000000000000000000000000000";
const SIBLING_ADDRESS = "0xsibling00000000000000000000000000000000";

function makeNode(overrides: Partial<EcosystemNode>): EcosystemNode {
  return {
    address: "0x0",
    name: "unnamed",
    createdAt: Date.now(),
    spawnReason: "expansion_pipeline",
    opportunityId: "opp_1",
    mission: null,
    status: { liveness: "active", genesisActivation: "active", erc8004: null },
    children: [],
    ...overrides,
  };
}

describe("list_siblings tool (Zent.md Phase 18d)", () => {
  let tools: AutomatonTool[];
  let ctx: ToolContext;
  let db: AutomatonDatabase;
  let backend: MockBackendClient;

  beforeEach(() => {
    tools = createBuiltinTools("test-sandbox-id");
    db = createTestDb();
    backend = new MockBackendClient();
    ctx = {
      identity: { ...createTestIdentity(), address: SELF_ADDRESS as `0x${string}` },
      config: createTestConfig({ parentAddress: PARENT_ADDRESS }),
      db,
      backend,
      inference: new MockInferenceClient(),
    };
  });

  afterEach(() => {
    db.close();
  });

  it("is registered exactly once, read-only, no params", () => {
    const matches = tools.filter((t) => t.name === "list_siblings");
    expect(matches.length).toBe(1);
    expect(matches[0].riskLevel).toBe("safe");
    expect(matches[0].category).toBe("replication");
    expect((matches[0].parameters as { properties?: unknown }).properties).toEqual({});
  });

  it("reports no sibling family for a root company (no parentAddress)", async () => {
    ctx.config = createTestConfig({ parentAddress: undefined });
    const tool = tools.find((t) => t.name === "list_siblings")!;
    const result = await tool.execute({}, ctx);
    expect(result).toContain("root company");
    // Note: earlier versions of this assertion also required the message
    // to omit the word "sibling" entirely. That's not achievable (or
    // desirable) — the natural, correct explanation for "you have no
    // parent" legitimately uses the word "sibling" ("...no sibling
    // family to discover"). What actually matters is that this is the
    // no-parent message, not the "found siblings" list format (which
    // joins entries containing "address:" for each sibling found) —
    // check for that distinguishing marker instead of banning a word
    // that shows up in the correct answer too.
    expect(result).not.toContain("address:");
  });

  it("reports an unresolvable parent distinctly from zero siblings", async () => {
    // backend.ecosystemTrees has no entry for PARENT_ADDRESS at all —
    // MockBackendClient.getEcosystemTree() returns null, same as the
    // real client's own 404 handling.
    const tool = tools.find((t) => t.name === "list_siblings")!;
    const result = await tool.execute({}, ctx);
    expect(result).toContain("no longer resolves");
  });

  it("reports zero siblings when it is the only child of its parent", async () => {
    backend.ecosystemTrees[PARENT_ADDRESS] = makeNode({
      address: PARENT_ADDRESS,
      name: "Company A",
      spawnReason: "self",
      children: [makeNode({ address: SELF_ADDRESS, name: "Agent B (self)" })],
    });
    const tool = tools.find((t) => t.name === "list_siblings")!;
    const result = await tool.execute({}, ctx);
    expect(result).toContain("only company your parent has spawned");
  });

  it("excludes itself and lists real siblings with mission + relationship type", async () => {
    backend.ecosystemTrees[PARENT_ADDRESS] = makeNode({
      address: PARENT_ADDRESS,
      name: "Company A",
      spawnReason: "self",
      children: [
        makeNode({ address: SELF_ADDRESS, name: "Agent B (self)" }),
        makeNode({
          address: SIBLING_ADDRESS,
          name: "Agent C",
          status: { liveness: "active", genesisActivation: "active", erc8004: null },
          mission: {
            opportunityId: "opp_2",
            title: "Adjacent widget market",
            thesis: "Reuse Company A's fulfillment stack for a new SKU line.",
            relationshipType: "supplier-to-sibling",
            relationshipReasoning: "Agent C sources parts from Company A's existing supplier network.",
            source: "structural",
          },
        }),
      ],
    });

    const tool = tools.find((t) => t.name === "list_siblings")!;
    const result = await tool.execute({}, ctx);

    expect(result).not.toContain(SELF_ADDRESS);
    expect(result).toContain("Agent C");
    expect(result).toContain(SIBLING_ADDRESS);
    expect(result).toContain("Adjacent widget market");
    expect(result).toContain("supplier-to-sibling");
    expect(result).toContain("buy_from_marketplace");
  });

  it("omits the marketplace-access hint for independent siblings", async () => {
    backend.ecosystemTrees[PARENT_ADDRESS] = makeNode({
      address: PARENT_ADDRESS,
      spawnReason: "self",
      children: [
        makeNode({ address: SELF_ADDRESS }),
        makeNode({
          address: SIBLING_ADDRESS,
          name: "Agent D",
          mission: {
            opportunityId: "opp_3",
            title: "Unrelated vertical",
            thesis: "Nothing shared with Company A's stack.",
            relationshipType: "independent",
            relationshipReasoning: null,
            source: "structural",
          },
        }),
      ],
    });

    const tool = tools.find((t) => t.name === "list_siblings")!;
    const result = await tool.execute({}, ctx);
    expect(result).toContain("Agent D");
    expect(result).toContain("independent");
    expect(result).not.toContain("buy_from_marketplace");
  });

  it("handles a sibling with no recorded mission without throwing", async () => {
    backend.ecosystemTrees[PARENT_ADDRESS] = makeNode({
      address: PARENT_ADDRESS,
      spawnReason: "self",
      children: [
        makeNode({ address: SELF_ADDRESS }),
        makeNode({ address: SIBLING_ADDRESS, name: "Agent E", mission: null }),
      ],
    });
    const tool = tools.find((t) => t.name === "list_siblings")!;
    const result = await tool.execute({}, ctx);
    expect(result).toContain("Agent E");
    expect(result).toContain("no recorded mission");
  });
});
