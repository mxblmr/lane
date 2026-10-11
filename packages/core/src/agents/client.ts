/**
 * Lane's Agent Engine client (U8; KTD10, KTD11, KTD18).
 *
 * The core is the only caller of Lane's four Agent Engine workspaces. This client:
 * - exchanges the service-account secret for an access token and caches it until five
 *   minutes before it expires (cloud mode);
 * - applies the KTD10 session policy: the orchestrator and the referee each reuse one
 *   session id, the promoter uses one per candidate and rule-lab one per learning run;
 * - sends U3's `AgentPayload` (prompt, output JSON Schema, input, internal API contract)
 *   on every invoke (KTD11), so a prompt or schema change needs no redeploy;
 * - validates every answer against the caller's schema, so a malformed answer is a
 *   failure and never an acceptance;
 * - resumes a suspended promoter execution with the flat body the API Gateway requires;
 * - supports `cloud` (deployed workspaces) and `local` (`agentengine dev up` behind a
 *   tunnel, the 2:45 PM fallback) modes.
 *
 * Results use the field names of U3's `AgentInvokeResult` in `interfaces.ts`, so the
 * `services().agents` implementation can return them as they are.
 *
 * Wire format sources: https://www.mongodb.com/docs/agentengine/deploy/invoke-agent/,
 * https://www.mongodb.com/docs/agentengine/deploy/human-in-the-loop/,
 * https://www.mongodb.com/docs/agentengine/api-keys-service-accounts/ and the official
 * chatbot-client template in github.com/mongodb/agent-engine-examples (local paths).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AGENT_WORKSPACES,
  PromoterInterruptSchema,
  type AgentPayload,
  type AgentWorkspace,
  type PromoterInterrupt,
} from "../schema/agents";
import { APPROVAL_DECISIONS, type ApprovalDecision } from "../schema/approvals";

export const AGENT_ENGINE_DEFAULT_BASE_URL = "https://agentengine.mongodb.com";

/** Refresh a cached access token this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Default deadline for one call, including status polling. */
export const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Environment variable names, exactly as listed in U1's `.env.example`. */
export const AGENT_ENGINE_ENV = {
  mode: "AGENT_ENGINE_MODE",
  baseUrl: "AGENT_ENGINE_BASE_URL",
  projectId: "AGENT_ENGINE_PROJECT_ID",
  clientId: "AGENT_ENGINE_CLIENT_ID",
  clientSecret: "AGENT_ENGINE_CLIENT_SECRET",
  localUrl: "AGENT_ENGINE_LOCAL_URL",
} as const;

/**
 * Workspace ids for cloud mode, listed in `.env.example`. The ids come from
 * `agentengine workspace list` after `agentengine init`.
 */
export const AGENT_ENGINE_WORKSPACE_ENV: Readonly<Record<AgentWorkspace, string>> = {
  orchestrator: "AGENT_ENGINE_WORKSPACE_ORCHESTRATOR",
  referee: "AGENT_ENGINE_WORKSPACE_REFEREE",
  rule_lab: "AGENT_ENGINE_WORKSPACE_RULE_LAB",
  promoter: "AGENT_ENGINE_WORKSPACE_PROMOTER",
};

/** Agent names in `agents/agents/<dir>/agent.yaml`. Local mode addresses a workspace by name. */
export const AGENT_ENGINE_AGENT_NAMES: Readonly<Record<AgentWorkspace, string>> = {
  orchestrator: "orchestrator",
  referee: "referee",
  rule_lab: "rule-lab",
  promoter: "promoter",
};

export type CloudTarget = {
  mode: "cloud";
  baseUrl: string;
  projectId: string;
  clientId: string;
  clientSecret: string;
  workspaceIds: Readonly<Record<AgentWorkspace, string>>;
};

/**
 * `localUrl` is the public tunnel URL of the `agentengine dev up` UI port, which serves
 * both invoke and the review (resume) API.
 */
export type LocalTarget = {
  mode: "local";
  localUrl: string;
};

export type AgentClientOptions = {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
  /** Injected for tests; waits between status polls. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export type AgentClientConfig = (CloudTarget | LocalTarget) & AgentClientOptions;

export type AgentFailureReason =
  | "invalid_request"
  | "auth_error"
  | "http_error"
  | "network_error"
  | "timeout"
  | "agent_error"
  | "bad_response"
  | "unexpected_interrupt"
  | "schema_invalid";

export type AgentCallRequest<T> = {
  workspace: AgentWorkspace;
  /** The prompt for this call, read by the caller (KTD11). */
  prompt: string;
  /** U3 agent input. Untrusted text inside it is already `Quoted` (KTD18). */
  input: unknown;
  /** Schema the answer must satisfy. Sent to the agent as JSON Schema. */
  outputSchema: z.ZodType<T>;
  /** U3 `internalApiDescription(role, baseUrl)` for rule-lab and the promoter, else null. */
  internalApi?: Record<string, unknown> | null;
  /** Overrides the KTD10 default from `agentSessionId`. */
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AgentCallResult<T> =
  | {
      ok: true;
      status: "completed";
      output: T;
      /** Empty when Agent Engine returned an answer without an execution id. */
      execution_id: string;
      session_id: string;
      latency_ms: number;
    }
  | {
      ok: true;
      status: "suspended";
      execution_id: string;
      workspace_id: string;
      interrupt: PromoterInterrupt;
      suspend_reason: string | null;
      /** Raw context, stored on the rule approval (U3 `RuleApprovalSchema.suspend_context`). */
      suspend_context: Record<string, unknown>;
      session_id: string;
      latency_ms: number;
    }
  | {
      ok: false;
      error: string;
      reason: AgentFailureReason;
      /** False when the agent answered but failed its schema. Never treat a failure as an acceptance. */
      schema_valid: boolean;
      timed_out: boolean;
      http_status: number | null;
      execution_id: string | null;
      session_id: string | null;
      latency_ms: number;
    };

export type AgentResumeRequest<T> = {
  workspace: AgentWorkspace;
  executionId: string;
  decision: ApprovalDecision;
  reviewerNotes?: string;
  /** Schema of the answer the execution produces after it resumes. */
  outputSchema: z.ZodType<T>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AgentExecution = {
  executionId: string;
  status: string;
  sessionId: string | null;
  /** Raw agent output: the `response` or `result` field, before validation. */
  result: unknown;
  error: string | null;
  suspendReason: string | null;
  suspendContext: Record<string, unknown> | null;
  /** Raw interrupt list (`[{id, value}]`) when Agent Engine returns one. */
  interrupts: unknown[] | null;
};

export type AgentExecutionResult =
  | { ok: true; execution: AgentExecution }
  | { ok: false; error: string; reason: AgentFailureReason; http_status: number | null };

export class AgentClientConfigError extends Error {
  override name = "AgentClientConfigError";
}

class AgentRequestError extends Error {
  constructor(
    readonly reason: AgentFailureReason,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

type ParsedExecution = Omit<AgentExecution, "executionId"> & { executionId: string | null };

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PENDING_STATUSES = new Set(["pending", "queued", "running", "resuming"]);
const FAILED_STATUSES = new Set(["error", "failed", "cancelled", "canceled"]);

/**
 * KTD10 session policy. The orchestrator and the referee reuse one session id each, which
 * shares one sandbox reservation. The promoter uses one session per candidate (from
 * `input.candidate_id`). Rule-lab uses one per learning run; one invoke is one run, so
 * the default is a fresh id and U10 may pass its own run id instead.
 */
export function agentSessionId(workspace: AgentWorkspace, input: unknown, override?: string): string {
  let sessionId: string;
  if (override !== undefined) {
    sessionId = override;
  } else if (workspace === "orchestrator" || workspace === "referee") {
    sessionId = `lane-${workspace}`;
  } else if (workspace === "promoter") {
    const candidateId = isRecord(input) ? input.candidate_id : undefined;
    if (typeof candidateId !== "string" || !candidateId) {
      throw new AgentRequestError("invalid_request", "Promoter input needs a candidate_id for its session id");
    }
    sessionId = `lane-promoter-${candidateId}`;
  } else {
    sessionId = `lane-rule_lab-${randomUUID()}`;
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AgentRequestError("invalid_request", 'Session ids are 1 to 128 letters, digits, "_" or "-"');
  }
  return sessionId;
}

/**
 * Builds the invoke body. Agent Engine forwards everything beyond `message` to the agent
 * as its execution payload; the deployed graphs read U3's `AgentPayload` from the `lane`
 * key. Each call builds a new object from its own request only.
 */
export function buildInvokeBody<T>(
  request: AgentCallRequest<T>,
  sessionId: string,
  mode: "cloud" | "local",
): Record<string, unknown> {
  const lane: AgentPayload = {
    workspace: request.workspace,
    prompt: request.prompt,
    output_schema: z.toJSONSchema(request.outputSchema, { unrepresentable: "any" }) as Record<string, unknown>,
    input: request.input,
    internal_api: request.internalApi ?? null,
  };
  return {
    message: `Lane ${request.workspace}`,
    // Cloud reads the session from the X-Session-ID header; the local server reads the body.
    ...(mode === "local" ? { session_id: sessionId, wait: true } : {}),
    lane,
  };
}

/** Reads the client configuration from the environment names in U1's `.env.example`. */
export function agentClientConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: AgentClientOptions = {},
): AgentClientConfig {
  const read = (name: string) => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const mode = (read(AGENT_ENGINE_ENV.mode) ?? "cloud").toLowerCase();

  if (mode === "local") {
    const localUrl = read(AGENT_ENGINE_ENV.localUrl);
    if (!localUrl) {
      throw new AgentClientConfigError(`Agent Engine local mode needs ${AGENT_ENGINE_ENV.localUrl}`);
    }
    return { mode: "local", localUrl, ...options };
  }
  if (mode !== "cloud") {
    throw new AgentClientConfigError(`${AGENT_ENGINE_ENV.mode} must be "cloud" or "local"`);
  }

  const missing: string[] = [];
  const need = (name: string) => {
    const value = read(name);
    if (!value) missing.push(name);
    return value ?? "";
  };
  const projectId = need(AGENT_ENGINE_ENV.projectId);
  const clientId = need(AGENT_ENGINE_ENV.clientId);
  const clientSecret = need(AGENT_ENGINE_ENV.clientSecret);
  const workspaceIds: Record<AgentWorkspace, string> = {
    orchestrator: need(AGENT_ENGINE_WORKSPACE_ENV.orchestrator),
    referee: need(AGENT_ENGINE_WORKSPACE_ENV.referee),
    rule_lab: need(AGENT_ENGINE_WORKSPACE_ENV.rule_lab),
    promoter: need(AGENT_ENGINE_WORKSPACE_ENV.promoter),
  };
  if (missing.length > 0) {
    throw new AgentClientConfigError(`Agent Engine cloud mode needs ${missing.join(", ")}`);
  }
  return {
    mode: "cloud",
    baseUrl: read(AGENT_ENGINE_ENV.baseUrl) ?? AGENT_ENGINE_DEFAULT_BASE_URL,
    projectId,
    clientId,
    clientSecret,
    workspaceIds,
    ...options,
  };
}

export function createAgentClient(config: AgentClientConfig): AgentClient {
  return new AgentClient(config);
}

export class AgentClient {
  readonly mode: "cloud" | "local";
  private readonly target: CloudTarget | LocalTarget;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private token: { value: string; refreshAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(config: AgentClientConfig) {
    this.target = validateTarget(config);
    this.mode = this.target.mode;
    this.fetchImpl = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = config.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Invokes one workspace and validates its answer against `outputSchema`. Never throws. */
  async invoke<T>(request: AgentCallRequest<T>): Promise<AgentCallResult<T>> {
    const startedAt = this.now();
    let sessionId: string | null = null;
    let executionId: string | null = null;
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const { signal, dispose } = deadlineSignal(timeoutMs, request.signal);
    try {
      sessionId = agentSessionId(request.workspace, request.input, request.sessionId);
      // Serialized before any await, so the body is a snapshot of this call alone.
      const body = JSON.stringify(buildInvokeBody(request, sessionId, this.target.mode));
      const headers = await this.headers(sessionId);
      const response = await this.send(this.invokeUrl(request.workspace), "POST", headers, body, signal);
      let execution = parseExecution(response.json);
      executionId = execution.executionId;
      sessionId = response.headers.get("x-session-id") ?? execution.sessionId ?? sessionId;

      if (PENDING_STATUSES.has(execution.status)) {
        if (!executionId) {
          throw new AgentRequestError("bad_response", `Agent Engine returned "${execution.status}" without an execution id`);
        }
        execution = await this.waitForExecution(request.workspace, executionId, startedAt + timeoutMs, signal, false);
      }
      return this.toResult(request.workspace, execution, request.outputSchema, sessionId, startedAt);
    } catch (error) {
      return this.failure(error, executionId, sessionId, startedAt);
    } finally {
      dispose();
    }
  }

  /**
   * Resumes a suspended execution with the flat `{ decision, reviewer_notes }` body (the
   * API Gateway rejects a decision nested in a `human_review` object), then waits for the
   * execution to finish and validates its answer. Never throws.
   */
  async resume<T>(request: AgentResumeRequest<T>): Promise<AgentCallResult<T>> {
    const startedAt = this.now();
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const { signal, dispose } = deadlineSignal(timeoutMs, request.signal);
    let sessionId: string | null = null;
    try {
      assertExecutionId(request.executionId);
      if (!(APPROVAL_DECISIONS as readonly string[]).includes(request.decision)) {
        throw new AgentRequestError("invalid_request", `Decision must be one of ${APPROVAL_DECISIONS.join(", ")}`);
      }
      const body = JSON.stringify({
        decision: request.decision,
        ...(request.reviewerNotes ? { reviewer_notes: request.reviewerNotes } : {}),
      });
      const headers = await this.headers();
      const url = this.executionUrl(request.workspace, request.executionId, "/resume");
      const response = await this.send(url, "POST", headers, body, signal);
      const resumed = parseExecution(response.json);
      sessionId = resumed.sessionId;

      let execution: ParsedExecution = resumed;
      const finished = resumed.status === "completed" || FAILED_STATUSES.has(resumed.status);
      if (!finished) {
        execution = await this.waitForExecution(request.workspace, request.executionId, startedAt + timeoutMs, signal, true);
      }
      sessionId = execution.sessionId ?? sessionId;
      const withId = { ...execution, executionId: execution.executionId ?? request.executionId };
      return this.toResult(request.workspace, withId, request.outputSchema, sessionId ?? "", startedAt);
    } catch (error) {
      return this.failure(error, request.executionId, sessionId, startedAt);
    } finally {
      dispose();
    }
  }

  /** Reads one execution's status and raw result, for reconciliation (U9, U12). */
  async getExecution(
    workspace: AgentWorkspace,
    executionId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<AgentExecutionResult> {
    const { signal, dispose } = deadlineSignal(options.timeoutMs ?? this.timeoutMs, options.signal);
    try {
      assertExecutionId(executionId);
      return { ok: true, execution: await this.fetchExecution(workspace, executionId, signal) };
    } catch (error) {
      const { reason, message, httpStatus } = toCallError(error);
      return { ok: false, error: message, reason, http_status: httpStatus };
    } finally {
      dispose();
    }
  }

  /**
   * Polls until the execution leaves a pending status. After a resume, "suspended" also
   * counts as pending: the promoter interrupts once, so a suspended read right after a
   * resume is the state from before it.
   */
  private async waitForExecution(
    workspace: AgentWorkspace,
    executionId: string,
    deadline: number,
    signal: AbortSignal,
    afterResume: boolean,
  ): Promise<AgentExecution> {
    for (;;) {
      if (this.now() >= deadline) {
        throw new AgentRequestError("timeout", `Execution ${executionId} did not finish before the deadline`);
      }
      await this.sleep(this.pollIntervalMs);
      const execution = await this.fetchExecution(workspace, executionId, signal);
      const pending =
        PENDING_STATUSES.has(execution.status) ||
        (afterResume && (execution.status === "suspended" || execution.status === "unknown"));
      if (!pending) return execution;
    }
  }

  private async fetchExecution(workspace: AgentWorkspace, executionId: string, signal: AbortSignal): Promise<AgentExecution> {
    const headers = await this.headers();
    const response = await this.send(this.executionUrl(workspace, executionId, ""), "GET", headers, undefined, signal);
    const execution = parseExecution(response.json);
    return { ...execution, executionId: execution.executionId ?? executionId };
  }

  private toResult<T>(
    workspace: AgentWorkspace,
    execution: ParsedExecution,
    outputSchema: z.ZodType<T>,
    sessionId: string,
    startedAt: number,
  ): AgentCallResult<T> {
    const { executionId, status } = execution;
    const latency_ms = Math.max(0, this.now() - startedAt);

    if (status === "suspended") {
      if (!executionId) {
        throw new AgentRequestError("bad_response", "Agent Engine reported a suspension without an execution id");
      }
      if (workspace !== "promoter") {
        throw new AgentRequestError("unexpected_interrupt", `The ${workspace} workspace suspended, which it never should`);
      }
      const context = execution.suspendContext ?? {};
      const interrupt = parseInterrupt(context, execution.interrupts);
      if (!interrupt) {
        throw new AgentRequestError("bad_response", "Suspend context is not a promoter interrupt");
      }
      return {
        ok: true,
        status: "suspended",
        execution_id: executionId,
        workspace_id: this.workspaceId(workspace),
        interrupt,
        suspend_reason: execution.suspendReason,
        suspend_context: context,
        session_id: sessionId,
        latency_ms,
      };
    }
    if (FAILED_STATUSES.has(status)) {
      throw new AgentRequestError("agent_error", execution.error ?? `Agent execution ended with status "${status}"`);
    }
    if (status !== "completed") {
      throw new AgentRequestError("bad_response", `Unexpected Agent Engine execution status "${status}"`);
    }

    const output = extractOutput(execution.result);
    if (output === undefined) {
      throw new AgentRequestError("schema_invalid", "Agent answer is not a JSON object");
    }
    const parsed = outputSchema.safeParse(output);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new AgentRequestError("schema_invalid", `Agent answer failed its schema: ${issues}`);
    }
    return { ok: true, status: "completed", output: parsed.data, execution_id: executionId ?? "", session_id: sessionId, latency_ms };
  }

  private failure(error: unknown, executionId: string | null, sessionId: string | null, startedAt: number): AgentCallResult<never> {
    const { reason, message, httpStatus } = toCallError(error);
    return {
      ok: false,
      error: message,
      reason,
      schema_valid: reason !== "schema_invalid",
      timed_out: reason === "timeout",
      http_status: httpStatus,
      execution_id: executionId,
      session_id: sessionId,
      latency_ms: Math.max(0, this.now() - startedAt),
    };
  }

  private workspaceId(workspace: AgentWorkspace): string {
    return this.target.mode === "cloud" ? this.target.workspaceIds[workspace] : AGENT_ENGINE_AGENT_NAMES[workspace];
  }

  private async headers(sessionId?: string): Promise<Headers> {
    const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
    if (sessionId) {
      headers.set("X-Session-ID", sessionId);
    }
    if (this.target.mode === "cloud") {
      headers.set("Authorization", `Bearer ${await this.accessToken(this.target)}`);
    }
    return headers;
  }

  /** Cached service-account token; concurrent callers share one token request. */
  private async accessToken(target: CloudTarget): Promise<string> {
    if (this.token && this.now() < this.token.refreshAt) {
      return this.token.value;
    }
    if (!this.pendingToken) {
      this.pendingToken = this.requestToken(target).finally(() => {
        this.pendingToken = null;
      });
    }
    return this.pendingToken;
  }

  private async requestToken(target: CloudTarget): Promise<string> {
    const basic = Buffer.from(`${target.clientId}:${target.clientSecret}`, "utf8").toString("base64");
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const { signal, dispose } = deadlineSignal(TOKEN_REQUEST_TIMEOUT_MS);
    try {
      const url = new URL("/api/v1/oauth/token", target.baseUrl);
      const body = new URLSearchParams({ grant_type: "client_credentials" }).toString();
      const response = await this.send(url, "POST", headers, body, signal).catch((error: unknown) => {
        const status = error instanceof AgentRequestError ? error.httpStatus : null;
        throw new AgentRequestError(
          "auth_error",
          `Service account token request failed${status ? ` with HTTP ${status}` : ""}`,
          status,
        );
      });
      const parsed = TokenResponseSchema.safeParse(response.json);
      if (!parsed.success) {
        throw new AgentRequestError("auth_error", "Service account token response is invalid");
      }
      const lifetimeMs = parsed.data.expires_in * 1000;
      this.token = {
        value: parsed.data.access_token,
        // Short-lived tokens refresh at half their life instead of immediately.
        refreshAt: this.now() + Math.max(lifetimeMs - TOKEN_REFRESH_MARGIN_MS, lifetimeMs / 2),
      };
      return this.token.value;
    } finally {
      dispose();
    }
  }

  private invokeUrl(workspace: AgentWorkspace): URL {
    if (this.target.mode === "cloud") {
      const { baseUrl, projectId, workspaceIds } = this.target;
      return new URL(
        `/api/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceIds[workspace])}/invoke`,
        baseUrl,
      );
    }
    const url = new URL("/invoke", this.target.localUrl);
    url.searchParams.set("workspace", AGENT_ENGINE_AGENT_NAMES[workspace]);
    return url;
  }

  private executionUrl(workspace: AgentWorkspace, executionId: string, suffix: "" | "/resume"): URL {
    const id = encodeURIComponent(executionId);
    if (this.target.mode === "cloud") {
      const { baseUrl, projectId, workspaceIds } = this.target;
      const url = new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/executions/${id}${suffix}`, baseUrl);
      url.searchParams.set("workspace_id", workspaceIds[workspace]);
      return url;
    }
    const url = new URL(`/api/v1/executions/${id}${suffix}`, this.target.localUrl);
    url.searchParams.set("workspace", AGENT_ENGINE_AGENT_NAMES[workspace]);
    return url;
  }

  private async send(
    url: URL,
    method: "GET" | "POST",
    headers: Headers,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<{ headers: Headers; json: unknown }> {
    // `cache` is not in Node's RequestInit type, but Next.js reads it: never cache a poll.
    const init: RequestInit & { cache: "no-store" } = { method, headers, body, signal, cache: "no-store" };
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      if (signal.aborted) {
        throw new AgentRequestError("timeout", "Agent Engine request timed out or was aborted");
      }
      throw new AgentRequestError("network_error", `Agent Engine request failed: ${errorMessage(error)}`);
    }
    const text = await response.text().catch(() => "");
    const json = parseJson(text);
    if (!response.ok) {
      if (response.status === 401) {
        // A revoked or expired token: the next call fetches a new one.
        this.token = null;
      }
      const reason = response.status === 401 || response.status === 403 ? "auth_error" : "http_error";
      throw new AgentRequestError(reason, upstreamMessage(json, response.status), response.status);
    }
    return { headers: response.headers, json };
  }
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

function validateTarget(config: AgentClientConfig): CloudTarget | LocalTarget {
  if (config.mode === "local") {
    requireUrl(config.localUrl, AGENT_ENGINE_ENV.localUrl, false);
    return { mode: "local", localUrl: config.localUrl };
  }
  requireUrl(config.baseUrl, AGENT_ENGINE_ENV.baseUrl, true);
  const required: ReadonlyArray<readonly [string, string]> = [
    [config.projectId, AGENT_ENGINE_ENV.projectId],
    [config.clientId, AGENT_ENGINE_ENV.clientId],
    [config.clientSecret, AGENT_ENGINE_ENV.clientSecret],
  ];
  for (const [value, name] of required) {
    if (!value) throw new AgentClientConfigError(`Agent Engine cloud mode needs ${name}`);
  }
  if (config.clientId.includes(":")) {
    throw new AgentClientConfigError(`${AGENT_ENGINE_ENV.clientId} must not contain a colon`);
  }
  for (const workspace of AGENT_WORKSPACES) {
    if (!config.workspaceIds[workspace]) {
      throw new AgentClientConfigError(`Agent Engine cloud mode needs ${AGENT_ENGINE_WORKSPACE_ENV[workspace]}`);
    }
  }
  return {
    mode: "cloud",
    baseUrl: config.baseUrl,
    projectId: config.projectId,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    workspaceIds: { ...config.workspaceIds },
  };
}

function requireUrl(value: string, name: string, httpsUnlessLoopback: boolean): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentClientConfigError(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AgentClientConfigError(`${name} must use http or https`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (httpsUnlessLoopback && url.protocol !== "https:" && !loopback) {
    throw new AgentClientConfigError(`${name} must use https`);
  }
}

function assertExecutionId(executionId: string): void {
  const valid =
    typeof executionId === "string" &&
    executionId.length > 0 &&
    executionId.length <= 200 &&
    executionId !== "." &&
    executionId !== ".." &&
    !/[/?#\\%\s]/.test(executionId);
  if (!valid) {
    throw new AgentRequestError("invalid_request", "Invalid Agent Engine execution id");
  }
}

/** Normalizes an invoke response (cloud or local), a resume response or an execution detail. */
function parseExecution(json: unknown): ParsedExecution {
  const root = isRecord(json) ? json : {};
  const inner = isRecord(root.execution) ? root.execution : root;
  const hasResult = "response" in inner || "result" in inner;
  let status = asString(inner.status)?.toLowerCase() ?? null;
  if (!status && root.success === false) status = "error";
  if (!status && root.success === true && hasResult) status = "completed";
  return {
    executionId: asString(inner.execution_id),
    status: status ?? "unknown",
    sessionId: asString(inner.session_id),
    result: "response" in inner ? inner.response : inner.result,
    error: asString(inner.error) ?? asString(root.error),
    suspendReason: asString(inner.suspend_reason),
    suspendContext: isRecord(inner.suspend_context) ? inner.suspend_context : null,
    interrupts: Array.isArray(inner.interrupts) ? inner.interrupts : null,
  };
}

/**
 * The promoter's interrupt value. The promoter interrupts with a SuspendPayload
 * (`{suspend_reason, suspend_context}`), which the runtime turns into the execution's
 * suspend context. Agent Engine may instead surface the raw interrupt values (the
 * LangGraph adapter's `interrupt_values` or `interrupts[].value`), so those are accepted
 * too (open question in docs/spikes/agent-engine.md).
 */
function parseInterrupt(context: Record<string, unknown>, interrupts: unknown[] | null): PromoterInterrupt | null {
  const seeds: unknown[] = [
    context,
    context.value,
    context.interrupt,
    firstItem(context.interrupt_values),
    interruptValue(context.interrupts),
    interruptValue(interrupts),
  ];
  for (const seed of seeds) {
    for (const candidate of [seed, isRecord(seed) ? seed.suspend_context : undefined]) {
      const parsed = PromoterInterruptSchema.safeParse(candidate);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

function firstItem(list: unknown): unknown {
  return Array.isArray(list) ? list[0] : undefined;
}

function interruptValue(list: unknown): unknown {
  const first = firstItem(list);
  return isRecord(first) ? first.value : undefined;
}

/**
 * The deployed graphs end with an AI message whose content is the JSON answer. Agent
 * Engine returns it as a string, possibly inside the LangGraph adapter's wrapper
 * (`{response, execution_id, status, message_count, resumed}`), or possibly as a message
 * object or a state object with `messages`; all of these are accepted.
 */
function extractOutput(value: unknown): unknown {
  if (typeof value === "string") {
    return parseJsonText(value);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (isAdapterWrapper(value)) {
    return extractOutput(value.response);
  }
  if (Array.isArray(value.messages) && value.messages.length > 0) {
    return extractOutput(value.messages[value.messages.length - 1]);
  }
  const looksLikeMessage = "content" in value && ("type" in value || "role" in value);
  if (looksLikeMessage) {
    return extractOutput(contentText(value.content));
  }
  return value;
}

/** The LangGraph adapter's AgentOutput.response: the answer text plus run metadata. */
function isAdapterWrapper(value: Record<string, unknown>): boolean {
  return "response" in value && ("message_count" in value || "resumed" in value || "execution_id" in value);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function parseJsonText(text: string): Record<string, unknown> | undefined {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const direct = parseJson(trimmed);
  if (isRecord(direct)) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const inner = parseJson(trimmed.slice(start, end + 1));
    if (isRecord(inner)) return inner;
  }
  return undefined;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function upstreamMessage(json: unknown, status: number): string {
  if (isRecord(json)) {
    for (const key of ["error", "message", "detail"]) {
      const value = json[key];
      if (typeof value === "string" && value.trim()) {
        return `Agent Engine HTTP ${status}: ${value.trim().slice(0, 500)}`;
      }
    }
  }
  return `Agent Engine request failed with HTTP ${status}`;
}

function toCallError(error: unknown): { reason: AgentFailureReason; message: string; httpStatus: number | null } {
  if (error instanceof AgentRequestError) {
    return { reason: error.reason, message: error.message, httpStatus: error.httpStatus };
  }
  return { reason: "network_error", message: errorMessage(error), httpStatus: null };
}

/** An abort signal that fires at the deadline or when the caller's signal fires. */
function deadlineSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) {
    controller.abort(parent.reason);
  } else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error("Agent Engine deadline reached")), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
