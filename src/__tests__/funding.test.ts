/**
 * Funding Strategy Tests
 *
 * Tests for executeFundingStrategies, especially per-tier cooldown isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeFundingStrategies } from "../survival/funding.js";
import {
  MockBackendClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

describe("executeFundingStrategies", () => {
  let db: AutomatonDatabase;
  let backend: MockBackendClient;

  beforeEach(() => {
    db = createTestDb();
    backend = new MockBackendClient();
    backend.creditsCents = 5; // low balance
  });

  afterEach(() => {
    db.close();
  });

  it("dead-tier cooldown does not suppress low_compute notification", async () => {
    const identity = createTestIdentity();
    const config = createTestConfig();

    // First: trigger dead-tier plea
    const deadAttempts = await executeFundingStrategies(
      "dead",
      identity,
      config,
      db,
      backend,
    );
    expect(deadAttempts.length).toBe(1);
    expect(deadAttempts[0].strategy).toBe("desperate_plea");

    // Now: agent recovers to low_compute. With the fix, the low_compute
    // notification should fire because it has its own cooldown key.
    const lowAttempts = await executeFundingStrategies(
      "low_compute",
      identity,
      config,
      db,
      backend,
    );
    expect(lowAttempts.length).toBe(1);
    expect(lowAttempts[0].strategy).toBe("polite_creator_notification");
  });

  it("critical-tier cooldown does not suppress low_compute notification", async () => {
    const identity = createTestIdentity();
    const config = createTestConfig();

    // Trigger critical-tier notice
    const criticalAttempts = await executeFundingStrategies(
      "critical",
      identity,
      config,
      db,
      backend,
    );
    expect(criticalAttempts.length).toBe(1);
    expect(criticalAttempts[0].strategy).toBe("urgent_local_notice");

    // low_compute should still fire independently
    const lowAttempts = await executeFundingStrategies(
      "low_compute",
      identity,
      config,
      db,
      backend,
    );
    expect(lowAttempts.length).toBe(1);
    expect(lowAttempts[0].strategy).toBe("polite_creator_notification");
  });

  it("respects per-tier cooldown on repeated calls", async () => {
    const identity = createTestIdentity();
    const config = createTestConfig();

    // First dead-tier call fires
    const first = await executeFundingStrategies("dead", identity, config, db, backend);
    expect(first.length).toBe(1);

    // Immediate second dead-tier call should be suppressed (2h cooldown)
    const second = await executeFundingStrategies("dead", identity, config, db, backend);
    expect(second.length).toBe(0);
  });
});
