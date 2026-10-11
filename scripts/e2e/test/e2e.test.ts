import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetServices } from "@lane/core/interfaces";
import { collections } from "@lane/core/schema/collections";
import type { LocalServer } from "@lane/core/testing/http";
import { startReplSet, type TestMongo } from "@lane/core/testing/mongo";
import { formatResult, newRunId, parseE2EArgs, runE2E } from "../run";
import { SCENARIOS, exitCode, type Db, type ScenarioResult } from "../scenarios";
import { serveLane } from "./lane-server";
import { wireMain, wireWithDoubles } from "./doubles";

// The e2e runner against Lane's real tool runner on a local MCP port and an in-memory replica set,
// with the real U6 and U18 services. Units not merged yet are doubles (see ./doubles.ts).
let mongo: TestMongo;
let server: LocalServer;
let db: Db;

beforeAll(async () => {
  mongo = await startReplSet();
  server = await serveLane(async () => db);
}, 120_000);

afterEach(() => {
  resetServices();
});

afterAll(async () => {
  await server?.close();
  await mongo?.stop();
});

function byId(results: ScenarioResult[]) {
  return Object.fromEntries(results.map((r) => [r.id, r]));
}

describe("parseE2EArgs", () => {
  it("reads --url and --only and normalizes the MCP path", () => {
    expect(parseE2EArgs(["--", "--url", "https://lane.example.com", "--only", "f1, ae7"])).toEqual({
      url: "https://lane.example.com/api/mcp",
      only: ["F1", "AE7"],
    });
    expect(parseE2EArgs(["--url=http://127.0.0.1:3000/api/mcp"]).only).toBeNull();
  });

  it("requires --url and refuses unknown flags and scenarios", () => {
    expect(() => parseE2EArgs([])).toThrow(/--url/);
    expect(() => parseE2EArgs(["--url", "https://x.test", "--fast"])).toThrow(/Unknown argument/);
    expect(() => parseE2EArgs(["--url", "https://x.test", "--only", "F9"])).toThrow(/Unknown scenario/);
  });
});

describe("scenario list", () => {
  it("covers F1 to F6 and AE2 to AE8", () => {
    expect(SCENARIOS.map((s) => s.id).sort()).toEqual(
      ["F1", "F2", "F3", "F4", "F5", "F6", "AE2", "AE3", "AE4", "AE5", "AE6", "AE7", "AE8"].sort(),
    );
  });

  it("uses run ids that fit Lane's display-name rule", () => {
    const id = newRunId();
    expect(`E2E Priya ${id}`).toMatch(/^[A-Za-z0-9 ]{1,24}$/);
  });
});

describe("exitCode", () => {
  const r = (status: ScenarioResult["status"]): ScenarioResult => ({ id: "F1", title: "", status, detail: "", notes: [], ms: 0 });
  it("is 0 on all pass, 1 on any fail, 2 when only blocked remain", () => {
    expect(exitCode([r("pass"), r("pass")])).toBe(0);
    expect(exitCode([r("pass"), r("blocked"), r("fail")])).toBe(1);
    expect(exitCode([r("pass"), r("blocked")])).toBe(2);
  });
});

describe("runE2E against a local Lane", () => {
  it("passes the flows reachable through the tools and reports the rest as blocked, with database checks", async () => {
    db = await mongo.freshDb();
    wireWithDoubles();
    const results = await runE2E({ url: server.origin, scenarios: SCENARIOS, db });
    const r = byId(results);
    for (const id of ["F1", "F2", "F3", "F5", "AE7", "AE8"]) {
      expect(r[id]!.status, formatResult(r[id]!)).toBe("pass");
    }
    for (const id of ["F4", "F6", "AE2", "AE3", "AE4", "AE5", "AE6"]) {
      expect(r[id]!.status, id).toBe("blocked");
      expect(r[id]!.detail).toMatch(/waits on U\d+/);
    }
    expect(exitCode(results)).toBe(2);

    // Every player the run created is clearly marked as a test player.
    const names = await collections(db).players.find({}, { projection: { display_name: 1 } }).toArray();
    expect(names.length).toBeGreaterThan(0);
    for (const p of names) expect(p.display_name).toMatch(/^E2E /);
  }, 120_000);

  it("reports a flow as blocked, naming the unit, when its service is still a stub on main", async () => {
    db = await mongo.freshDb();
    wireWithDoubles({ proofs: false });
    const results = await runE2E({ url: server.origin, scenarios: SCENARIOS.filter((s) => s.id === "F2" || s.id === "F3"), db });
    const r = byId(results);
    expect(r.F2!.status).toBe("blocked");
    expect(r.F2!.detail).toMatch(/lane_submit_proof answered "not live yet": waits on U5/);
    expect(r.F3!.status).toBe("pass");
  }, 60_000);

  it("reports F1 as blocked on the orchestrator when only main's services are wired", async () => {
    db = await mongo.freshDb();
    wireMain();
    const [f1] = await runE2E({ url: server.origin, scenarios: SCENARIOS.filter((s) => s.id === "F1"), db });
    expect(f1!.status).toBe("blocked");
    expect(f1!.detail).toMatch(/U8 orchestrator/);
  }, 60_000);

  it("fails F2 when Lane accepts a commit that does not exist", async () => {
    db = await mongo.freshDb();
    wireWithDoubles({ proofs: { acceptEverything: true } });
    const [f2] = await runE2E({ url: server.origin, scenarios: SCENARIOS.filter((s) => s.id === "F2"), db });
    expect(f2!.status).toBe("fail");
    expect(f2!.detail).toMatch(/does not exist was accepted/);
    expect(exitCode([f2!])).toBe(1);
  }, 60_000);

  it("runs without a database handle against a deployed URL", async () => {
    db = await mongo.freshDb();
    wireWithDoubles();
    const results = await runE2E({ url: server.origin, scenarios: SCENARIOS.filter((s) => ["F1", "F3"].includes(s.id)) });
    expect(results.map((r) => r.status)).toEqual(["pass", "pass"]);
  }, 60_000);
});
