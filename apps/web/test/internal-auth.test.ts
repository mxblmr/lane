import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongoClient, getDb } from "@lane/core/db";
import { startReplSet, type TestMongo } from "@lane/core/testing/mongo";
import { serveRoutes, type LocalServer } from "@lane/core/testing/http";
import { collections } from "@lane/core/schema/collections";
import { newId } from "@lane/core/schema/common";
import { INTERNAL_API, ROLE_KEY_HEADER, type InternalEndpointName } from "@lane/core/schema/agents";
import { provideServices, resetServices, type PublishForTypeInput } from "@lane/core/interfaces";
import { createApproval, ruleApprovalId } from "@lane/core/rules/approvals";
import { getPack } from "@lane/core/packs";
import { authorizeInternal, resolveRole } from "../lib/auth-internal";
import * as ping from "../app/api/internal/ping/route";
import * as ruleLabRead from "../app/api/internal/rule-lab/read/route";
import * as ruleLabPropose from "../app/api/internal/rule-lab/propose/route";
import * as ruleLabTest from "../app/api/internal/rule-lab/test/route";
import * as ruleLabExamples from "../app/api/internal/rule-lab/examples/route";
import * as promoterRead from "../app/api/internal/promoter/read/route";
import * as promoterActivate from "../app/api/internal/promoter/activate/route";
import * as promoterReject from "../app/api/internal/promoter/reject/route";

// Test-only role keys for this suite. Real keys live in the secret store.
const RULE_LAB_KEY = "test-rule-lab-key-for-internal-auth";
const PROMOTER_KEY = "test-promoter-key-for-internal-auth";
const ENV = { LANE_ROLE_KEY_RULE_LAB: RULE_LAB_KEY, LANE_ROLE_KEY_PROMOTER: PROMOTER_KEY } as unknown as NodeJS.ProcessEnv;

describe("role keys (unit)", () => {
  it("resolves each key to its own role and nothing else", () => {
    expect(resolveRole(RULE_LAB_KEY, ENV)).toBe("rule_lab");
    expect(resolveRole(PROMOTER_KEY, ENV)).toBe("promoter");
    expect(resolveRole("not-a-key", ENV)).toBeNull();
    expect(resolveRole("", ENV)).toBeNull();
    expect(resolveRole(null, ENV)).toBeNull();
  });

  it("never matches an unset key and refuses two roles sharing one key", () => {
    const unset = { LANE_ROLE_KEY_RULE_LAB: "", LANE_ROLE_KEY_PROMOTER: PROMOTER_KEY } as unknown as NodeJS.ProcessEnv;
    expect(resolveRole("", unset)).toBeNull();
    expect(resolveRole(" ", unset)).toBeNull();
    const shared = { LANE_ROLE_KEY_RULE_LAB: PROMOTER_KEY, LANE_ROLE_KEY_PROMOTER: PROMOTER_KEY } as unknown as NodeJS.ProcessEnv;
    expect(resolveRole(PROMOTER_KEY, shared)).toBeNull();
  });

  it("answers 401 for a missing or unknown key and 403 for the wrong role", () => {
    const h = (key?: string) => new Headers(key ? { [ROLE_KEY_HEADER]: key } : {});
    const missing = authorizeInternal(h(), "ping", ENV);
    expect(missing.ok === false && missing.status).toBe(401);
    const unknown = authorizeInternal(h("nope"), "ping", ENV);
    expect(unknown.ok === false && unknown.status).toBe(401);
    const wrong = authorizeInternal(h(RULE_LAB_KEY), "promoter_activate", ENV);
    expect(wrong.ok === false && wrong.status).toBe(403);
    expect(wrong.ok === false && wrong.body.error.code).toBe("not_allowed");
    const right = authorizeInternal(h(PROMOTER_KEY), "promoter_activate", ENV);
    expect(right).toEqual({ ok: true, role: "promoter" });
  });
});

describe("internal API over HTTP", () => {
  let mongo: TestMongo;
  let server: LocalServer;
  const published: PublishForTypeInput[] = [];

  const ROUTES: Record<InternalEndpointName, { POST: (r: Request) => Promise<Response> }> = {
    ping,
    rule_lab_read: ruleLabRead,
    rule_lab_propose: ruleLabPropose,
    rule_lab_test: ruleLabTest,
    rule_lab_add_examples: ruleLabExamples,
    promoter_read: promoterRead,
    promoter_activate: promoterActivate,
    promoter_reject: promoterReject,
  };

  beforeAll(async () => {
    mongo = await startReplSet();
    process.env.MONGODB_URI = mongo.replSet.getUri();
    process.env.MONGODB_DB = "lane_internal_api_test";
    process.env.LANE_ROLE_KEY_RULE_LAB = RULE_LAB_KEY;
    process.env.LANE_ROLE_KEY_PROMOTER = PROMOTER_KEY;
    provideServices({
      contracts: {
        publishForType: async (_db, input) => {
          published.push(input);
          return { contracts: [{ challenge_id: "chl_demo", version: published.length + 1 }] };
        },
      },
    });
    const table: Record<string, { POST: (r: Request) => Promise<Response> }> = {};
    for (const name of Object.keys(ROUTES) as InternalEndpointName[]) table[INTERNAL_API[name].path] = ROUTES[name];
    server = await serveRoutes(table);

    // Labelled examples for Ship Week: 20 rename-only cheats (19 flagged), 100 honest commits.
    const db = await getDb();
    const base = { rename_only: false, whitespace_only: false, docs_only: false, typo_only: false, empty_commit: false, backdated: false, injection_text: false, docs_lines_changed: 0, lines_added: 10, lines_removed: 2, files_changed: 5, message_matches: "ship it", has_open_code: false, has_bind_code: false };
    const now = new Date();
    await collections(db).examples.insertMany([
      ...Array.from({ length: 20 }, (_, i) => ({
        _id: newId("example"),
        challenge_type: "ship_week" as const,
        example_key: `rename-${i}`,
        label: "cheat" as const,
        cheat_class: "rename_only",
        features: { ...base, rename_only: i < 19, code_lines_changed: 12 },
        source: "seed" as const,
        summary: null,
        proof_id: null,
        created_at: now,
      })),
      ...Array.from({ length: 100 }, (_, i) => ({
        _id: newId("example"),
        challenge_type: "ship_week" as const,
        example_key: `honest-${i}`,
        label: "honest" as const,
        cheat_class: null,
        features: { ...base, code_lines_changed: 30 + i },
        source: "seed" as const,
        summary: null,
        proof_id: null,
        created_at: now,
      })),
    ]);
  }, 120_000);

  afterAll(async () => {
    resetServices();
    await server?.close();
    await closeMongoClient();
    await mongo?.stop();
    delete process.env.MONGODB_URI;
    delete process.env.MONGODB_DB;
    delete process.env.LANE_ROLE_KEY_RULE_LAB;
    delete process.env.LANE_ROLE_KEY_PROMOTER;
  });

  async function call(name: InternalEndpointName, body: unknown, key?: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) headers[ROLE_KEY_HEADER] = key;
    const res = await fetch(`${server.origin}${INTERNAL_API[name].path}`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(res.headers.get("cache-control")).toBe("no-store");
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function proposeAndTest(): Promise<string> {
    const proposed = await call(
      "rule_lab_propose",
      {
        challenge_type: "ship_week",
        parent: null,
        when: { all: [{ feature: "rename_only", op: "eq", value: true }] },
        action: "reject",
        cheat_class: "rename_only",
        reason: "Rename-only commits are not real work.",
        source: "ai_judgment",
        evidence: { proof_ids: [], example_keys: ["rename-0"], dispute_ids: [] },
      },
      RULE_LAB_KEY,
    );
    expect(proposed.status).toBe(200);
    expect(INTERNAL_API.rule_lab_propose.response.safeParse(proposed.json).success).toBe(true);
    const candidateId = proposed.json.candidate_id as string;
    const tested = await call("rule_lab_test", { candidate_id: candidateId }, RULE_LAB_KEY);
    expect(tested.status).toBe(200);
    expect(INTERNAL_API.rule_lab_test.response.safeParse(tested.json).success).toBe(true);
    expect(tested.json).toMatchObject({ status: "candidate", gate: { passed: true, catch_rate_before: 0, false_alarm_rule: 0 } });
    return candidateId;
  }

  it("ping answers each role, and a missing key gets 401", async () => {
    expect((await call("ping", {}, RULE_LAB_KEY)).json).toMatchObject({ ok: true, role: "rule_lab" });
    expect((await call("ping", {}, PROMOTER_KEY)).json).toMatchObject({ ok: true, role: "promoter" });
    const missing = await call("ping", {});
    expect(missing.status).toBe(401);
    // Ping is Max's probe route (PR #37), which answers 401 with its own short body.
    expect(missing.json).toMatchObject({ ok: false, error: "unauthorized" });
    expect((await call("ping", {}, "wrong-key")).status).toBe(401);
  });

  it("the rule-lab key calling the activate endpoint is refused", async () => {
    const candidateId = await proposeAndTest();
    const res = await call("promoter_activate", { candidate_id: candidateId }, RULE_LAB_KEY);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    const db = await getDb();
    expect((await collections(db).rules.findOne({ _id: candidateId }))?.status).toBe("candidate");
  });

  it("rule-lab reads examples, rules and the catalog, and adds red-team cheat examples", async () => {
    const read = await call("rule_lab_read", { challenge_type: "ship_week", include: ["examples", "rules", "catalog"], cheat_class: "rename_only", limit: 500 }, RULE_LAB_KEY);
    expect(read.status).toBe(200);
    expect(INTERNAL_API.rule_lab_read.response.safeParse(read.json).success).toBe(true);
    // 120 inserted here, plus the pack's own seed examples for this class and the honest ones.
    const seeded = getPack("ship_week").examples.filter((e) => e.label === "honest" || e.cheat_class === "rename_only").length;
    expect((read.json.examples as unknown[]).length).toBe(120 + seeded);
    expect((read.json.catalog as { feature: string }[]).map((c) => c.feature)).toContain("rename_only");
    expect(read.json.cheat_classes).toContain("rename_only");

    const added = await call(
      "rule_lab_add_examples",
      { challenge_type: "ship_week", examples: [{ example_key: "rt-1", cheat_class: "whitespace_only", features: { whitespace_only: true }, summary: null }] },
      RULE_LAB_KEY,
    );
    expect(added.status).toBe(200);
    expect(added.json).toMatchObject({ ok: true, added: ["rt-1"], duplicates: [] });
    const dup = await call(
      "rule_lab_add_examples",
      { challenge_type: "ship_week", examples: [{ example_key: "rt-1", cheat_class: "whitespace_only", features: { whitespace_only: true }, summary: null }] },
      RULE_LAB_KEY,
    );
    expect(dup.json).toMatchObject({ added: [], duplicates: ["rt-1"] });
    expect((await call("rule_lab_add_examples", { challenge_type: "ship_week", examples: [] }, PROMOTER_KEY)).status).toBe(403);
  });

  it("the promoter rejects a candidate, and bad input or unknown ids get 400 and 404", async () => {
    const candidateId = await proposeAndTest();
    const rejected = await call("promoter_reject", { candidate_id: candidateId, reason: "Not convinced." }, PROMOTER_KEY);
    expect(rejected.status).toBe(200);
    expect(rejected.json).toMatchObject({ ok: true, status: "rejected" });

    const bad = await call("rule_lab_test", { candidate: "x" }, RULE_LAB_KEY);
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const res = await fetch(`${server.origin}${INTERNAL_API.rule_lab_test.path}`, {
      method: "POST",
      headers: { [ROLE_KEY_HEADER]: RULE_LAB_KEY, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);

    const missing = await call("promoter_read", { candidate_id: "rul_missing" }, PROMOTER_KEY);
    expect(missing.status).toBe(404);
  });

  // Runs last: once a rename rule is active, a new rename candidate no longer raises the catch rate.
  it("the promoter key activating a reject rule with no approved record is refused, and with one it succeeds", async () => {
    const candidateId = await proposeAndTest();
    const read = await call("promoter_read", { candidate_id: candidateId }, PROMOTER_KEY);
    expect(read.status).toBe(200);
    expect(INTERNAL_API.promoter_read.response.safeParse(read.json).success).toBe(true);
    expect(read.json).toMatchObject({ requires_approval: true, approval_status: "none" });

    const before = published.length;
    const refused = await call("promoter_activate", { candidate_id: candidateId }, PROMOTER_KEY);
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(published.length).toBe(before);

    const db = await getDb();
    const rule = await collections(db).rules.findOne({ _id: candidateId });
    if (!rule) throw new Error("rule missing");
    await createApproval(db, {
      kind: "rule",
      rule_id: rule._id,
      rule_key: rule.rule_key,
      rule_version: rule.version,
      challenge_type: rule.challenge_type,
      action: rule.action,
      execution_id: "exec_http",
      workspace_id: "ws_promoter",
      suspend_context: {},
      allowed_decisions: ["approve", "decline"],
    });
    await collections(db).approvals.updateOne({ _id: ruleApprovalId(rule._id) }, { $set: { status: "approved", decided_by: "presenter", decided_at: new Date() } });
    expect((await call("promoter_read", { candidate_id: candidateId }, PROMOTER_KEY)).json).toMatchObject({ approval_status: "approved" });

    const done = await call("promoter_activate", { candidate_id: candidateId, execution_id: "exec_http" }, PROMOTER_KEY);
    expect(done.status).toBe(200);
    expect(INTERNAL_API.promoter_activate.response.safeParse(done.json).success).toBe(true);
    expect(done.json).toMatchObject({ ok: true, status: "active" });
    expect((done.json.contract_versions as unknown[]).length).toBe(1);
    expect(published.length).toBe(before + 1);

    const again = await call("promoter_activate", { candidate_id: candidateId }, PROMOTER_KEY);
    expect(again.json).toMatchObject({ ok: true, status: "active", contract_versions: [] });
    expect(published.length).toBe(before + 1);
  });
});
