import { z } from "zod";

/** The three challenge types. Each one is a pack (see `schema/pack.ts`). */
export const CHALLENGE_TYPES = ["ship_week", "customers", "build_in_public"] as const;
export const ChallengeTypeSchema = z.enum(CHALLENGE_TYPES);
export type ChallengeType = z.infer<typeof ChallengeTypeSchema>;

/** Platforms a player can bind a handle on (KTD21). */
export const HANDLE_PLATFORMS = ["github", "x", "instagram", "linkedin", "threads"] as const;
export const HandlePlatformSchema = z.enum(HANDLE_PLATFORMS);
export type HandlePlatform = z.infer<typeof HandlePlatformSchema>;

/** Every document id is a prefixed string, never an ObjectId, so JSON round-trips stay simple. */
export const IdSchema = z.string().min(1).max(64);
export type Id = z.infer<typeof IdSchema>;

export const ID_PREFIXES = {
  player: "plr",
  challenge: "chl",
  contract: "ctr",
  membership: "mem",
  proof: "prf",
  inbox: "inb",
  rule: "rul",
  example: "exm",
  dispute: "dsp",
  approval: "apr",
  ledger: "led",
  job: "job",
  event: "evt",
  snapshot: "snp",
} as const;
export type IdKind = keyof typeof ID_PREFIXES;

/** New random id such as `prf_3f2a...`. Works in Node and in the browser. */
export function newId(kind: IdKind): string {
  const uuid = globalThis.crypto.randomUUID().replace(/-/g, "");
  return `${ID_PREFIXES[kind]}_${uuid}`;
}

/** The eight connector tools (KTD3). */
export const TOOL_NAMES = [
  "lane_register",
  "lane_create_challenge",
  "lane_confirm_challenge",
  "lane_join_challenge",
  "lane_check_in",
  "lane_submit_proof",
  "lane_ask",
  "lane_dispute",
] as const;
export const ToolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolNameSchema>;

/** A feature value produced by a pack's feature extractor. */
export const FeatureValueSchema = z.union([z.number(), z.boolean(), z.string(), z.array(z.string())]);
export type FeatureValue = z.infer<typeof FeatureValueSchema>;
export const FeaturesSchema = z.record(z.string(), FeatureValueSchema);
export type Features = z.infer<typeof FeaturesSchema>;

/** Flat primitive map, used for tool arguments and typed contract parameters. */
export const PrimitiveSchema = z.union([z.string(), z.number(), z.boolean()]);
export type Primitive = z.infer<typeof PrimitiveSchema>;
export const PrimitiveMapSchema = z.record(z.string(), PrimitiveSchema);
export type PrimitiveMap = z.infer<typeof PrimitiveMapSchema>;

/** Contract parameters may also hold string lists, for example the platforms that count. */
export const ParamValueSchema = z.union([PrimitiveSchema, z.array(z.string())]);
export const ParamsSchema = z.record(z.string(), ParamValueSchema);
export type Params = z.infer<typeof ParamsSchema>;

/** Display names: 1 to 24 letters, digits and spaces (KTD15). */
export const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N} ]{1,24}$/u;
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .regex(DISPLAY_NAME_PATTERN, "Use 1 to 24 letters, digits and spaces.");

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, "Use an IANA time zone such as America/Los_Angeles.");

/** Short free text a person or model wrote. Always capped, always treated as quoted data (KTD18). */
export const ShortTextSchema = z.string().max(500);
export const LineSchema = z.string().max(300);

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Reference to one version of a rule. */
export const RuleRefSchema = z.object({
  rule_key: z.string().min(1).max(64),
  version: z.int().min(1),
});
export type RuleRef = z.infer<typeof RuleRefSchema>;

/** Errors come back as results with a recovery instruction, never as protocol errors. */
export const ERROR_CODES = [
  "unauthenticated",
  "registration_closed",
  "invalid_input",
  "not_found",
  "not_member",
  "already_member",
  "insufficient_credits",
  "duplicate",
  "window_closed",
  "grace_closed",
  "short_sha",
  "not_allowed",
  "handle_unverified",
  "handle_taken",
  "dispute_cap",
  "learning_paused",
  "conflict",
  "agent_failed",
  "internal",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const LaneErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: LineSchema,
  recovery: LineSchema,
});
export type LaneError = z.infer<typeof LaneErrorSchema>;

/** Domain functions return `Outcome<T>` instead of throwing for expected failures. */
export type Outcome<T> = ({ ok: true } & T) | { ok: false; error: LaneError };

export function fail(code: ErrorCode, message: string, recovery: string): { ok: false; error: LaneError } {
  return { ok: false, error: { code, message, recovery } };
}
