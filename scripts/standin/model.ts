/**
 * The model behind the Muse stand-in. `ModelClient` is the seam: tests pass a scripted double and
 * never call a model or the network; `pnpm standin` uses `anthropicModel`, which reads the API key
 * from the environment variable named in `STANDIN_KEY_ENV` and never logs it.
 *
 * The scripts package cannot take new dependencies in this unit, so the client posts to the
 * Messages API with `fetch` instead of the Anthropic SDK. The request shape follows the current
 * API: no `thinking` parameter (Claude Opus 5.5 runs adaptive thinking), `tool_choice` auto, and the
 * server-side refusal fallback. Assistant turns are appended unchanged, so thinking blocks replay.
 */

export const STANDIN_KEY_ENV = "ANTHROPIC_API_KEY";
export const STANDIN_MODEL_ENV = "LANE_STANDIN_MODEL";
export const DEFAULT_STANDIN_MODEL = "claude-opus-5-5";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: string; [key: string]: unknown };

export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type Message =
  | { role: "user"; content: string | Array<ToolResultBlock | { type: "text"; text: string }> }
  | { role: "assistant"; content: ContentBlock[] };

export interface ModelTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ModelTool[];
}

export interface ModelResponse {
  content: ContentBlock[];
  stop_reason: string | null;
}

export interface ModelClient {
  create(request: ModelRequest): Promise<ModelResponse>;
}

export function isToolUse(block: ContentBlock): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } {
  return block.type === "tool_use";
}

export interface AnthropicModelOptions {
  /** The environment to read the key from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  model?: string;
}

/** A Messages API client for the stand-in. Throws at construction when the key is missing. */
export function anthropicModel(options: AnthropicModelOptions = {}): ModelClient {
  const env = options.env ?? process.env;
  const apiKey = env[STANDIN_KEY_ENV];
  if (!apiKey) throw new Error(`Set ${STANDIN_KEY_ENV} to run the stand-in against a real model.`);
  const model = options.model ?? env[STANDIN_MODEL_ENV] ?? DEFAULT_STANDIN_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async create(request) {
      const response = await fetchImpl(MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "server-side-fallback-2026-07-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 16000,
          system: request.system,
          messages: request.messages,
          tools: request.tools,
          tool_choice: { type: "auto" },
          fallbacks: "default",
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { content?: ContentBlock[]; stop_reason?: string | null; error?: { type?: string; message?: string } }
        | null;
      if (!response.ok || !body?.content) {
        throw new Error(`Messages API ${response.status}: ${body?.error?.type ?? "error"} ${body?.error?.message ?? ""}`.trim());
      }
      return { content: body.content, stop_reason: body.stop_reason ?? null };
    },
  };
}
