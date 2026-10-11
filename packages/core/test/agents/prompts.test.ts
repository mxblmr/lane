import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  AGENT_PROMPTS_COLLECTION,
  DEFAULT_AGENT_PROMPTS,
  defaultAgentPrompt,
  loadAgentPrompt,
} from "../../src/agents/prompts";
import { AGENT_SCHEMAS, AGENT_WORKSPACES } from "../../src/schema/agents";
import { startReplSet, type TestMongo } from "../../src/testing/mongo";

describe("default agent prompts", () => {
  it("has a non-empty prompt for every workspace mode in AGENT_SCHEMAS, and nothing else", () => {
    for (const workspace of AGENT_WORKSPACES) {
      expect(Object.keys(DEFAULT_AGENT_PROMPTS[workspace]).sort(), workspace).toEqual(Object.keys(AGENT_SCHEMAS[workspace]).sort());
      for (const mode of Object.keys(AGENT_SCHEMAS[workspace])) {
        expect(defaultAgentPrompt(workspace, mode)?.length, `${workspace}.${mode}`).toBeGreaterThan(0);
      }
    }
    expect(defaultAgentPrompt("referee", "settle")).toBeNull();
    expect(defaultAgentPrompt("referee", "toString")).toBeNull();
  });
});

describe("loadAgentPrompt", () => {
  let mongo: TestMongo;
  let errors: MockInstance<typeof console.error>;
  beforeAll(async () => {
    mongo = await startReplSet();
  });
  afterAll(async () => {
    await mongo?.stop();
  });
  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
  });

  it("returns the default when no override is stored", async () => {
    const db = await mongo.freshDb();
    expect(await loadAgentPrompt(db, "referee", "proof")).toBe(DEFAULT_AGENT_PROMPTS.referee.proof);
  });

  it("returns a stored override, read fresh on every call", async () => {
    const db = await mongo.freshDb();
    const prompts = db.collection<{ _id: string; text: string }>(AGENT_PROMPTS_COLLECTION);
    await prompts.insertOne({ _id: "orchestrator.answer", text: "Answer in one sentence." });
    expect(await loadAgentPrompt(db, "orchestrator", "answer")).toBe("Answer in one sentence.");

    await prompts.updateOne({ _id: "orchestrator.answer" }, { $set: { text: "Answer in two sentences." } });
    expect(await loadAgentPrompt(db, "orchestrator", "answer")).toBe("Answer in two sentences.");
    expect(await loadAgentPrompt(db, "orchestrator", "draft")).toBe(DEFAULT_AGENT_PROMPTS.orchestrator.draft);
  });

  it("falls back to the default and logs when the override is invalid", async () => {
    const db = await mongo.freshDb();
    await db.collection<{ _id: string; text: string }>(AGENT_PROMPTS_COLLECTION).insertOne({ _id: "promoter.promote", text: "   " });

    expect(await loadAgentPrompt(db, "promoter", "promote")).toBe(DEFAULT_AGENT_PROMPTS.promoter.promote);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("promoter.promote"));
  });

  it("throws on an unknown mode", async () => {
    const db = await mongo.freshDb();
    await expect(loadAgentPrompt(db, "rule_lab", "promote")).rejects.toThrow("Unknown agent mode rule_lab.promote");
  });
});
