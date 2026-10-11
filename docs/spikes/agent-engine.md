# Agent Engine spike (U8)

Status: not deployed. Nothing below has been run against Agent Engine yet. This file
lists the questions the first deploy must answer, so the answers can be recorded here
with the date, the command and what was observed. Do not fill in a result that was not
observed.

Code under test:

- Agent Engine project: `agents/` (monorepo root `agents/agent.yaml`, four agents under
  `agents/agents/`).
- Agent client: `packages/core/src/agents/client.ts`.

Source notes (read, not observed on a deployment): the agents were built against
`@mongodb-js/agent-engine-sdk-langgraph` 0.11.8 and the official
`hello-world-agent-langgraph-ts` template from `mongodb/agent-engine-examples` (commit
`afd6406`). The promoter's interrupt follows that repository's `insurance-agent-ts`.

## Open questions for the first deploy

Each question names where the answer changes code. Record the result under it.

### Invoke and output

1. **Is the `lane` payload delivered to the graph in both modes?** The client sends the
   invoke body `{message, lane: AgentPayload}` (cloud) and `{message, session_id, wait,
   lane}` (local). The agents read `input.payload.lane`. Check that cloud forwards the
   extra key into `AgentInput.payload`, and that the local `/invoke` route does not
   strip it. If it is stripped: move the payload into `message` as JSON in
   `buildInvokeBody` and `lanePayload`.
   Result: not yet run.
2. **What shape is `response` on a completed execution?** The LangGraph adapter returns
   `{response: "<last AI text>", execution_id, status, message_count, resumed}`. The
   client accepts a string, that wrapper, a message object or a `messages` list. Record
   the shape actually returned by invoke (with `wait`) and by GET execution.
   Result: not yet run.
3. **Do the referee and orchestrator answer fixtures with schema-valid JSON in under
   20 seconds?** (U8 verification.) Record latency per workspace, cold and warm.
   Result: not yet run.
4. **AE1 (referee):** given a rename-only diff, does the deployed referee return reject
   with cheat class `rename_only`?
   Result: not yet run.
5. **AE7 (orchestrator):** given "start Build in Public with my friends", does the
   deployed orchestrator return a clarifying question about platforms?
   Result: not yet run.

### Promoter suspend and resume

6. **Does `suspend_context` carry the promoter's context?** The promoter calls
   `interrupt({suspend_reason: "awaiting_human_review", suspend_context: {candidate_id,
   action, line, allowed_decisions, message, response_schema}})`. The runtime source
   takes `suspend_reason` and `suspend_context` from the first interrupt value when it
   has that shape. Record where the execution detail exposes it (`suspend_context`,
   `interrupts[].value`, or `suspend_context.interrupt_values`). The client accepts all
   three.
   Result: not yet run.
7. **Which value does the graph receive on resume?** The client sends the flat body
   `{decision, reviewer_notes}`, as the human-in-the-loop docs require. With
   `durable_workflow: true` the adapter resumes through an activity-id-keyed resume map.
   The promoter's `normalizeReview` accepts a decision string, the flat object, a
   `human_review` object or a `resume_map`. Record what `interrupt()` actually returns,
   and confirm that `decline` never reaches the activate endpoint.
   Result: not yet run.
8. **Does the resume API accept a service-account token?** The docs say resuming needs
   `PROJECT_OWNER`. Probe: suspend the promoter, then resume it with the service-account
   token through `POST /api/internal/probe-resume`, body `{"execution_id": "...",
   "decision": "approve"}`, header `x-lane-role-key` set to the promoter's role key (Max's temporary route from PR #37; body also needs `workspace_id`).
   Result: not yet run.
9. **Does a fresh promoter execution on a candidate's session start clean** when an
   earlier execution on the same session is still suspended?
   Result: not yet run.
10. **What is the local get-execution path?** The client polls
    `/api/v1/executions/{id}?workspace=<agent>` and resumes on `.../resume` in local
    mode. Confirm both against `agentengine dev up`.
    Result: not yet run.

### Sessions and scaling

11. **Do concurrent executions on one shared session work** (KTD10: the orchestrator
    and the referee each reuse one session id)? The two graphs use one checkpoint thread
    per execution, so the question is whether Agent Engine queues or rejects a second
    execution on a busy session. Record what happens with 2 and with 10 concurrent
    referee calls.
    Result: not yet run.
12. **Does a suspended promoter execution hold a sandbox reservation** while it waits
    for a human, and does that count against `replicas: 16`?
    Result: not yet run.
13. **Is `ctx.executionId` stable across a resume?** The orchestrator and referee
    thread ids include it. They never suspend, but record it for the promoter too.
    Result: not yet run.

### Project files

14. **Does `agentengine init` accept the monorepo from `agents/`** with the root
    `agents/agent.yaml` and agent names `orchestrator`, `referee`, `rule-lab` and
    `promoter`? (Agent names cannot contain underscores, so the core's `rule_lab`
    workspace key maps to the agent name `rule-lab`.)
    Result: not yet run.
15. **Is `agents/project-config.yaml` with `{}` accepted, or ignored?** Workspaces are
    declared in the root `agent.yaml` and egress per agent, as the docs describe.
    Result: not yet run.

### Egress and secrets

16. **Can rule-lab reach the internal ping route?** Probe: invoke rule-lab with an
    input that asks it to call `/api/internal/ping`, after allowing Lane's host on the
    tool sandbox. The ping route itself is deferred until U1's app exists.
    Result: not yet run.
17. **Does `secrets: ["*"]` on the tool sandbox expose `LANE_BASE_URL` and the role
    key to the `lane_internal_api` tool,** or does the sandbox need the names listed?
    Result: not yet run.
18. **Does the agent sandbox's allow list (api.openai.com and api.anthropic.com on
    443) cover the LLM calls,** or does the secure LLM proxy route them elsewhere?
    Result: not yet run.

## Deploy handoff (owned by Codex)

All MongoDB account configuration (Agent Engine setup, deploy, Policy Engine) is done by
Codex. Commands below come from the Agent Engine docs at the time of writing; check each
with `--help` first. Never paste a secret value into a file or a chat.

1. Install the `agentengine` CLI from the official download page and verify its
   checksum, then `agentengine auth login`.
2. From `agents/`, run `agentengine init`. It registers the four agents as workspaces
   and writes `.agentengine/state.json` in each agent directory.
3. Store secrets with `agentengine secret set <NAME>` (it prompts for the value):
   - `LLM_API_KEY` for all four agents. An Anthropic key (`sk-ant-...`) selects
     Claude; any other key selects OpenAI.
   - `LANE_BASE_URL` for rule-lab and the promoter.
   - `LANE_ROLE_KEY_RULE_LAB` for rule-lab only and `LANE_ROLE_KEY_PROMOTER` for the
     promoter only, as workspace secrets rather than project secrets.
4. In `agents/agents/rule-lab/` and `agents/agents/promoter/`, allow Lane's production
   host on the tool sandbox:
   `agentengine agent egress add --component tool <lane-host>:443`.
5. Run `agentengine atlas setup` if the project has no linked Atlas cluster.
6. Build and deploy: `agentengine deploy` from each agent directory (interactive, it
   builds when no image exists), or `agentengine build` in each agent directory, then
   `agentengine deploy --all` from `agents/`.
7. Create the service account the core uses:
   `agentengine service-account create <name> --project-id <id> --role PROJECT_OWNER`.
8. Set these Vercel environment variables (names from U1's `.env.example`, plus the
   four workspace ids, which U1's `.env.example` does not list yet):
   - `AGENT_ENGINE_MODE=cloud`, `AGENT_ENGINE_BASE_URL` (optional, defaults to
     `https://agentengine.mongodb.com`), `AGENT_ENGINE_PROJECT_ID`,
     `AGENT_ENGINE_CLIENT_ID`, `AGENT_ENGINE_CLIENT_SECRET`.
   - `AGENT_ENGINE_WORKSPACE_ORCHESTRATOR`, `AGENT_ENGINE_WORKSPACE_REFEREE`,
     `AGENT_ENGINE_WORKSPACE_RULE_LAB`, `AGENT_ENGINE_WORKSPACE_PROMOTER`, from
     `agentengine workspace list`.
   - `LANE_ROLE_KEY_RULE_LAB` and `LANE_ROLE_KEY_PROMOTER`, the same values as the
     agents' secrets, so the internal API can check them.
9. Run the questions above and record each result here.
