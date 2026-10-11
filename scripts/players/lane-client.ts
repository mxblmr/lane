/**
 * A scripted player's connection to Lane: an MCP client at `--url`, exactly like Muse (R30).
 * The player's Lane key travels as a bearer header (KTD4), never in a URL or in printed output.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

/** Adds `/api/mcp` to a bare origin; leaves any other path alone. */
export function mcpUrl(input: string): string {
  const url = new URL(input);
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/api/mcp";
  return url.toString();
}

/** The connector envelope, read loosely so the runner keeps working while U7's payloads settle. */
export interface EnvelopeLike {
  status?: string;
  lines?: string[];
  error?: { code?: string; recovery?: string } | null;
  data?: Record<string, unknown> | null;
  challenges?: EnvelopeChallengeLike[];
  [key: string]: unknown;
}

export interface EnvelopeChallengeLike {
  challenge_id: string;
  type?: string;
  title?: string;
  status?: string;
  day_index?: number | null;
  contract_version?: number;
  contract_changed?: boolean;
  contract?: { version?: number; does_not_count?: string[]; changes?: string[] } | null;
  messages?: string[];
  feed?: { proof_id?: string; status?: string; decided_by?: string | null; summary?: string }[];
  [key: string]: unknown;
}

export class LaneToolError extends Error {
  constructor(tool: string, detail: string) {
    super(`${tool} failed: ${detail}`);
    this.name = "LaneToolError";
  }
}

export class LaneClient {
  private client: Client | null = null;
  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly key: string,
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: `lane-stage-${this.name.toLowerCase()}`, version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl(this.url)), {
      requestInit: { headers: { Authorization: `Bearer ${this.key}` } },
    });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<EnvelopeLike> {
    const client = await this.connect();
    const result = await client.callTool({ name: tool, arguments: args });
    const structured = result.structuredContent as EnvelopeLike | undefined;
    let envelope: EnvelopeLike | undefined = structured;
    if (!envelope) {
      const text = (result.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text;
      if (text) {
        try {
          envelope = JSON.parse(text) as EnvelopeLike;
        } catch {
          throw new LaneToolError(tool, text.slice(0, 300));
        }
      }
    }
    if (!envelope) throw new LaneToolError(tool, "empty result");
    if (result.isError && envelope.status !== "error") throw new LaneToolError(tool, JSON.stringify(envelope).slice(0, 300));
    return envelope;
  }

  checkIn(): Promise<EnvelopeLike> {
    return this.call("lane_check_in", {});
  }

  submitProof(args: Record<string, unknown>): Promise<EnvelopeLike> {
    return this.call("lane_submit_proof", args);
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}

/** The player's live challenge of a type, newest first if several are listed. */
export function findChallenge(env: EnvelopeLike, type: string): EnvelopeChallengeLike | null {
  const list = (env.challenges ?? []).filter((c) => c.type === type && (c.status === undefined || c.status === "active"));
  return list.length > 0 ? list[list.length - 1]! : null;
}

export function contractVersion(c: EnvelopeChallengeLike): number {
  return c.contract_version ?? c.contract?.version ?? 0;
}

/** The verdict of one submission, from the submit envelope or a feed line. */
export interface VerdictView {
  proof_id: string | null;
  /** accepted, flagged_accept, rejected, held, pending, not_counted, ai_review... */
  outcome: string | null;
  decided_by: string | null;
  ai_calls: number | null;
  reason: string | null;
  duplicate: boolean;
}

const OUTCOME_ALIASES: Record<string, string> = { reject: "rejected", accept: "accepted", flag: "flagged_accept", ask_more: "held" };

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function readVerdict(env: EnvelopeLike): VerdictView {
  const data = (env.data ?? {}) as Record<string, unknown>;
  const proof = (data.proof ?? null) as Record<string, unknown> | null;
  const verdict = (data.verdict ?? proof?.verdict ?? null) as Record<string, unknown> | null;
  const rawOutcome = str(data.outcome) ?? str(proof?.status) ?? str(verdict?.outcome) ?? (env.status === "pending" ? "pending" : null);
  const aiCalls = verdict?.ai_calls ?? data.ai_calls;
  return {
    proof_id: str(data.proof_id) ?? str(proof?._id) ?? str(proof?.proof_id) ?? str(proof?.id),
    outcome: rawOutcome ? (OUTCOME_ALIASES[rawOutcome] ?? rawOutcome) : null,
    decided_by: str(verdict?.decided_by) ?? str(data.decided_by),
    ai_calls: typeof aiCalls === "number" ? aiCalls : null,
    reason: str(verdict?.reason) ?? (env.lines ?? [])[0] ?? null,
    duplicate: data.duplicate === true,
  };
}

export const FINAL_OUTCOMES = new Set(["accepted", "flagged_accept", "rejected", "not_counted"]);
export const COUNTING_OUTCOMES = new Set(["accepted", "flagged_accept"]);
