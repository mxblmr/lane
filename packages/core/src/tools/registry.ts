import type { Db } from "mongodb";
import { z } from "zod";
import { NotImplementedError } from "../interfaces";
import { TOOL_NAMES, fail, type ToolName } from "../schema/common";
import { TOOL_ARGS, type Envelope } from "../schema/envelope";
import { askTool } from "./ask";
import { checkInTool } from "./check-in";
import { confirmChallengeTool } from "./confirm-challenge";
import { createChallengeTool } from "./create-challenge";
import { disputeTool } from "./dispute";
import { errorEnvelope } from "./envelope";
import { pickPlayerKey, resolvePlayer } from "./identity";
import { joinChallengeTool } from "./join-challenge";
import { registerTool } from "./register";
import { submitProofTool } from "./submit-proof";
import type { LaneTool } from "./types";

/**
 * The eight connector tools (KTD3) and the one runner every face calls. The MCP route (U7) and the
 * JSON mirror (U19) both call `runTool`, so a player action behaves the same on either face.
 */
export const LANE_TOOLS: { [N in ToolName]: LaneTool<N> } = {
  lane_register: registerTool,
  lane_create_challenge: createChallengeTool,
  lane_confirm_challenge: confirmChallengeTool,
  lane_join_challenge: joinChallengeTool,
  lane_check_in: checkInTool,
  lane_submit_proof: submitProofTool,
  lane_ask: askTool,
  lane_dispute: disputeTool,
};

/** In the order Muse usually meets them. */
export function listLaneTools(): LaneTool[] {
  return TOOL_NAMES.map((name) => LANE_TOOLS[name] as unknown as LaneTool);
}

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * The advertised argument schema: the flat U3 argument shape as JSON Schema, with each field's
 * plain-language description. Validation happens in `runTool`, so a bad argument comes back as
 * an envelope with a recovery instruction rather than a protocol error.
 */
export function toolInputJsonSchema(name: ToolName): Record<string, unknown> {
  const json = z.toJSONSchema(TOOL_ARGS[name], { io: "input", target: "draft-2020-12" }) as Record<string, unknown>;
  const properties = (json.properties ?? {}) as Record<string, Record<string, unknown>>;
  const fields = LANE_TOOLS[name].fields;
  for (const [field, schema] of Object.entries(properties)) {
    const description = fields[field];
    if (description) properties[field] = { ...schema, description };
  }
  return { ...json, type: "object", properties };
}

/** Player keys are at least 16 characters (`player_key` in U3's argument schemas). */
const MIN_REDACT_CHARS = 16;

export interface ToolContext {
  /** Lazily opens the database, so calls refused before any read never connect. */
  db: () => Promise<Db>;
  /** Token from the `Authorization: Bearer` header, when the face has one. */
  bearer?: string | null;
  now?: Date;
}

/**
 * Run one tool call: identity first (KTD4), then the flat arguments, then the handler. Every
 * failure, expected or not, comes back as an error envelope with a recovery instruction.
 * The player key never appears in any result except the `lane_register` result that issues it.
 */
export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<Envelope> {
  const now = ctx.now ?? new Date();
  if (!isToolName(name)) {
    return errorEnvelope(
      fail("not_found", `Lane has no tool named ${name.slice(0, 40)}.`, `Use one of: ${TOOL_NAMES.join(", ")}.`).error,
      now,
    );
  }
  const raw = isPlainObject(rawArgs) ? rawArgs : {};
  const argKey = typeof raw.player_key === "string" ? raw.player_key : null;
  // Real keys are long; a short bogus value is refused anyway and is not worth redacting.
  const secrets = [ctx.bearer, argKey]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length >= MIN_REDACT_CHARS);

  let envelope: Envelope;
  try {
    envelope = await dispatch(name, raw, argKey, ctx, now);
  } catch (error) {
    envelope = errorEnvelope(unexpected(name, error).error, now);
  }
  return name === "lane_register" ? envelope : redact(envelope, secrets);
}

async function dispatch(
  name: ToolName,
  raw: Record<string, unknown>,
  argKey: string | null,
  ctx: ToolContext,
  now: Date,
): Promise<Envelope> {
  if (name === "lane_register") {
    const args = TOOL_ARGS.lane_register.safeParse(raw);
    if (!args.success) return errorEnvelope(invalidInput(name, args.error).error, now);
    return LANE_TOOLS.lane_register.handle({ db: await ctx.db(), args: args.data, now });
  }

  // Identity first, so a call without a key is refused before anything is read or written.
  const key = pickPlayerKey({ bearer: ctx.bearer, argument: argKey });
  if (!key.ok) return errorEnvelope(key.error, now);

  const args = TOOL_ARGS[name].safeParse(raw);
  if (!args.success) return errorEnvelope(invalidInput(name, args.error).error, now);

  const db = await ctx.db();
  const who = await resolvePlayer(db, key.key);
  if (!who.ok) return errorEnvelope(who.error, now);

  const tool = LANE_TOOLS[name] as unknown as LaneTool<"lane_check_in">;
  return tool.handle({ db, args: args.data as never, player: who.player, now });
}

function invalidInput(name: ToolName, error: z.ZodError) {
  // Field paths and messages only: never echo argument values, which may hold the key.
  const problems = error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
    .join("; ");
  return fail(
    "invalid_input",
    `Some arguments to ${name} are missing or invalid (${problems}).`.slice(0, 300),
    `Fix those arguments and call ${name} again. Ask the player for anything only they can answer.`,
  );
}

function unexpected(name: ToolName, error: unknown) {
  if (error instanceof NotImplementedError) {
    return fail(
      "internal",
      "This part of Lane is not live yet.",
      `Tell the player Lane cannot do this yet, and call ${name} again in a few minutes.`,
    );
  }
  // Log the tool and the error message only: never the arguments, which may hold the key.
  console.error(`[lane] ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  return fail(
    "internal",
    "Lane hit an unexpected error.",
    `Call ${name} again in a minute. If it keeps failing, tell the player Lane is having trouble.`,
  );
}

/** Belt and braces for KTD4: no non-register result ever carries the caller's key. */
function redact(envelope: Envelope, secrets: string[]): Envelope {
  if (secrets.length === 0) return envelope;
  let text = JSON.stringify(envelope);
  let changed = false;
  for (const secret of secrets) {
    if (text.includes(secret)) {
      text = text.split(secret).join("[redacted]");
      changed = true;
    }
  }
  return changed ? (JSON.parse(text) as Envelope) : envelope;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
