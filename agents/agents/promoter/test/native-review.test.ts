import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { LangGraphBaseAgent } from "@mongodb-js/agent-engine-sdk-langgraph";
import { app, buildAgent } from "../src/promoter_agent/main.js";

test("native SDK resume preserves the approval gate and decline cannot call Lane", async () => {
  process.env.LLM_API_KEY = "test-key";
  const saver = new MemorySaver();
  let laneCalls = 0;
  const model = {
    bindTools() { return this; },
    async invoke() { return new AIMessage('{"decision":"decline","candidate_id":"probe"}'); },
  };
  const runtimeApp = app as any;
  runtimeApp.llm = () => model;
  runtimeApp.checkpointer = () => saver;
  runtimeApp.getTools = () => [{ name: "lane_internal_api", invoke: async () => { laneCalls++; throw new Error("Declined candidate reached Lane"); } }];
  const graph = buildAgent();
  const adapter = new LangGraphBaseAgent(graph as never, [], runtimeApp.prepareInputFn);
  const input = { payload: { lane: {
    workspace: "promoter", prompt: "Return the human decision.",
    output_schema: { type: "object", required: ["decision", "candidate_id"] },
    input: { candidate_id: "probe", action: "reject", requires_approval: true, no_egress: false },
    internal_api: null,
  } } };
  const context = { executionId: "probe", sessionId: "probe", workspaceId: "promoter", userId: "test" };
  const suspended = await adapter.invoke(context as never, input as never);
  assert.equal((suspended as any).response.status, "suspended", "Review must suspend before any model or Lane call");
  const completed = await adapter.resume(context as never, input as never, "decline");
  assert.equal((completed as any).response.status, "completed");
  assert.equal(JSON.parse((completed as any).response.response).decision, "decline");
  assert.equal(laneCalls, 0);
});
