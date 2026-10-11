/**
 * The `agents` service (U8 owns it in `SERVICE_OWNERS`): U3's `LaneServices["agents"]` on
 * top of the Agent Engine client.
 *
 * For every invoke it checks the mode and the input against `AGENT_SCHEMAS`, loads the
 * prompt (KTD11), sends the mode's output schema, adds the internal API contract for
 * rule-lab and the promoter, and maps the client's answer to U3's `AgentInvokeResult`.
 * Resume validates the promoter's answer against `PromoterOutputSchema`.
 *
 * It never throws: a missing configuration, a bad input or an Agent Engine failure is an
 * `ok: false` result, which every caller already treats as "no agent answer".
 */
import type { z } from "zod";
import type { AgentInvokeInput, AgentInvokeResult, AgentResumeInput, LaneServices } from "../interfaces";
import { laneDb } from "../interfaces";
import {
  AGENT_SCHEMAS,
  PromoterOutputSchema,
  internalApiDescription,
  type AgentIO,
  type AgentWorkspace,
  type InternalRole,
} from "../schema/agents";
import { agentClientConfigFromEnv, createAgentClient, type AgentCallResult, type AgentClient } from "./client";
import { defaultAgentPrompt, loadAgentPrompt } from "./prompts";

/** Environment variable with Lane's public base URL, sent to rule-lab and the promoter. */
export const LANE_BASE_URL_ENV = "LANE_BASE_URL";

export type PromptLoader = (workspace: AgentWorkspace, mode: string) => Promise<string>;

export interface AgentsServiceDeps {
  /** The client, or a factory called on first use. Defaults to the environment configuration. */
  client?: AgentClient | (() => AgentClient);
  /** Defaults to the `agent_prompts` override in MongoDB, else the code default. */
  loadPrompt?: PromptLoader;
  /** Lane's base URL for the internal API contract. Defaults to `LANE_BASE_URL`. */
  laneBaseUrl?: () => string | undefined;
  now?: () => number;
}

type ModeEntry = { input: z.ZodType; output: z.ZodType };

export function createAgentsService(deps: AgentsServiceDeps = {}): LaneServices["agents"] {
  const now = deps.now ?? Date.now;
  const loadPrompt = deps.loadPrompt ?? loadPromptFromDb;
  const laneBaseUrl = deps.laneBaseUrl ?? (() => process.env[LANE_BASE_URL_ENV]?.trim() || undefined);
  let client: AgentClient | null = deps.client && typeof deps.client !== "function" ? deps.client : null;
  const makeClient = typeof deps.client === "function" ? deps.client : () => createAgentClient(agentClientConfigFromEnv(process.env));

  /** One client per process, so its token cache is shared. A configuration error is retried on the next call. */
  function getClient(): AgentClient {
    client ??= makeClient();
    return client;
  }

  function failure(error: string, startedAt: number, context: string): { ok: false; error: string; schema_valid: true; timed_out: false; execution_id: null; latency_ms: number } {
    console.error(`[agents] ${context}: ${error}`);
    return { ok: false, error, schema_valid: true, timed_out: false, execution_id: null, latency_ms: Math.max(0, now() - startedAt) };
  }

  async function invoke<W extends AgentWorkspace>(request: AgentInvokeInput<W>): Promise<AgentInvokeResult<W>> {
    const startedAt = now();
    const { workspace, mode } = request;
    const context = `${workspace}.${mode}`;
    const entry = modeEntry(workspace, mode);
    if (!entry) {
      return failure(`Unknown agent mode ${context}`, startedAt, context);
    }
    const input = entry.input.safeParse(request.input);
    if (!input.success) {
      const fields = input.error.issues
        .slice(0, 5)
        .map((issue) => issue.path.join(".") || "(root)")
        .join(", ");
      return failure(`Agent input failed its schema at: ${fields}`, startedAt, context);
    }

    let internalApi: Record<string, unknown> | null = null;
    if (workspace === "rule_lab" || workspace === "promoter") {
      const baseUrl = laneBaseUrl();
      if (!baseUrl || !isHttpUrl(baseUrl)) {
        return failure(`${LANE_BASE_URL_ENV} must be set to Lane's absolute URL for ${workspace}`, startedAt, context);
      }
      internalApi = internalApiDescription(workspace as InternalRole, baseUrl);
    }

    let agentClient: AgentClient;
    let prompt: string;
    try {
      agentClient = getClient();
      prompt = await loadPrompt(workspace, mode);
    } catch (err) {
      return failure(`Agent Engine call not prepared: ${errorMessage(err)}`, startedAt, context);
    }

    const result = await agentClient.invoke({
      workspace,
      prompt,
      input: input.data,
      outputSchema: entry.output,
      internalApi,
      sessionId: request.session_id,
      timeoutMs: request.timeout_ms,
    });
    if (!result.ok) console.error(`[agents] ${context} failed (${result.reason}): ${result.error}`);
    return toInvokeResult<W>(result);
  }

  async function resume(request: AgentResumeInput): Promise<AgentInvokeResult<"promoter">> {
    const startedAt = now();
    const context = "promoter.resume";
    if (request.workspace !== "promoter") {
      return failure(`Only the promoter can be resumed, not ${String(request.workspace)}`, startedAt, context);
    }
    let agentClient: AgentClient;
    try {
      agentClient = getClient();
    } catch (err) {
      return failure(`Agent Engine call not prepared: ${errorMessage(err)}`, startedAt, context);
    }
    const result = await agentClient.resume({
      workspace: "promoter",
      executionId: request.execution_id,
      decision: request.decision,
      outputSchema: PromoterOutputSchema,
    });
    if (!result.ok) console.error(`[agents] ${context} failed (${result.reason}): ${result.error}`);
    return toInvokeResult<"promoter">(result);
  }

  return { invoke, resume };
}

/** The deployed service: environment configuration, read on first use (never at import or build time). */
export const agentsService: LaneServices["agents"] = createAgentsService();

function modeEntry(workspace: AgentWorkspace, mode: string): ModeEntry | null {
  const modes = AGENT_SCHEMAS[workspace] as unknown as Record<string, ModeEntry> | undefined;
  if (!modes || !Object.prototype.hasOwnProperty.call(modes, mode)) return null;
  return modes[mode] ?? null;
}

/** Maps the client's result to U3's `AgentInvokeResult`, field for field. */
function toInvokeResult<W extends AgentWorkspace>(result: AgentCallResult<unknown>): AgentInvokeResult<W> {
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      schema_valid: result.schema_valid,
      timed_out: result.timed_out,
      execution_id: result.execution_id,
      latency_ms: result.latency_ms,
    };
  }
  if (result.status === "suspended") {
    return {
      ok: true,
      status: "suspended",
      execution_id: result.execution_id,
      workspace_id: result.workspace_id,
      interrupt: result.interrupt,
      latency_ms: result.latency_ms,
    };
  }
  return {
    ok: true,
    status: "completed",
    // Validated by the client against AGENT_SCHEMAS[workspace][mode].output.
    output: result.output as AgentIO[W]["output"],
    execution_id: result.execution_id,
    latency_ms: result.latency_ms,
  };
}

async function loadPromptFromDb(workspace: AgentWorkspace, mode: string): Promise<string> {
  try {
    return await loadAgentPrompt(await laneDb(), workspace, mode);
  } catch (err) {
    const fallback = defaultAgentPrompt(workspace, mode);
    if (fallback === null) throw err;
    console.error(`[agents] MongoDB unavailable for prompt ${workspace}.${mode}; using the default:`, errorMessage(err));
    return fallback;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
