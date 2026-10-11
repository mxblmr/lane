import { describe, expect, it } from "vitest";
import * as schema from "@lane/core/schema";
import * as agents from "@lane/core/schema/agents";
import * as packs from "@lane/core/packs";
import * as shipWeek from "@lane/core/packs/ship-week";
import * as customers from "@lane/core/packs/customers";
import * as buildInPublic from "@lane/core/packs/build-in-public";
import * as interfaces from "@lane/core/interfaces";
import * as config from "@lane/core/config";
import * as clock from "@lane/core/clock";
import * as days from "@lane/core/days";
import * as ledger from "@lane/core/ledger";
import * as jobs from "@lane/core/jobs";
import * as events from "@lane/core/events";
import * as testingMongo from "@lane/core/testing/mongo";

/** Every Wave 2 unit imports through these subpath exports. */
describe("subpath exports", () => {
  it("resolves every U3 subpath through the package name", () => {
    expect(schema.ProofSchema).toBeDefined();
    expect(schema.ensureIndexes).toBeTypeOf("function");
    expect(schema.collections).toBeTypeOf("function");
    expect(agents.INTERNAL_API.ping.path).toBe("/api/internal/ping");
    expect(packs.getPack("ship_week")).toBe(shipWeek.shipWeekPack);
    expect(packs.getPack("customers")).toBe(customers.customersPack);
    expect(packs.getPack("build_in_public")).toBe(buildInPublic.buildInPublicPack);
    expect(interfaces.services).toBeTypeOf("function");
    expect(config.PLAY_CREDIT_LABEL).toMatch(/no real money/);
    expect(clock.dayIndexAt).toBeTypeOf("function");
    expect(days.dayStatus).toBeTypeOf("function");
    expect(ledger.appendLedgerEntry).toBeTypeOf("function");
    expect(jobs.queueJob).toBeTypeOf("function");
    expect(events.writeEvent).toBeTypeOf("function");
    expect(testingMongo.startReplSet).toBeTypeOf("function");
  });
});
