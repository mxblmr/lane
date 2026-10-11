import { z } from "zod";
import type { FeatureCatalog, Pack } from "../../schema/pack";
import { genericValue } from "../../schema/pack";
import { NOTE_CAP_CHARS } from "../../config";

/**
 * STUB Talk to Customers pack (U3). U15 replaces this folder. Keep the export name.
 * The proof schema already applies KTD15's reductions, because nothing else may see full
 * addresses or long notes: attendees become domains and notes are capped.
 */

export const PERSONAL_EMAIL_DOMAINS = ["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "proton.me", "protonmail.com", "aol.com"] as const;

/** "Jane <jane@acme.com>" or "jane@acme.com" or "acme.com" -> "acme.com". */
export function toDomain(attendee: string): string {
  const trimmed = attendee.trim().toLowerCase();
  const inBrackets = trimmed.match(/<([^>]+)>/)?.[1] ?? trimmed;
  const at = inBrackets.lastIndexOf("@");
  return (at >= 0 ? inBrackets.slice(at + 1) : inBrackets).replace(/[^a-z0-9.-]/g, "");
}

export const CustomersProofSchema = z
  .object({
    event_id: z.string().trim().min(1, "Send the calendar event id.").max(200),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
    attendees: z.array(z.string()).max(50).default([]),
    notes: z.string().optional(),
  })
  .transform((p) => ({
    event_id: p.event_id,
    starts_at: p.starts_at,
    ends_at: p.ends_at,
    attendee_domains: [...new Set(p.attendees.map(toDomain).filter(Boolean))],
    notes_summary: p.notes ? p.notes.slice(0, NOTE_CAP_CHARS) : null,
  }));
export type CustomersProof = z.infer<typeof CustomersProofSchema>;

export const CUSTOMERS_FEATURES: FeatureCatalog = {
  duration_min: { kind: "number", description: "Call length in minutes.", ops: ["lt", "lte", "gt", "gte"], bound: { min: 0, max: 30 } },
  attendee_count: { kind: "number", description: "Outside attendees.", ops: ["lt", "lte", "gt", "gte", "eq"], bound: { min: 0, max: 10 } },
  attendee_domains: { kind: "string_list", description: "Attendee domains.", ops: ["in"] },
  all_personal_email: { kind: "boolean", description: "Every outside attendee uses a personal email domain.", ops: ["eq"] },
  internal_only: { kind: "boolean", description: "Every attendee shares the player's domain.", ops: ["eq"] },
  has_notes: { kind: "boolean", description: "Meeting notes were sent.", ops: ["eq"] },
  short_call: { kind: "boolean", description: "The call lasted under five minutes.", ops: ["eq"] },
};

export const CUSTOMERS_CHEAT_CLASSES = ["all_personal_email", "internal_only", "short_call"] as const;

export const customersPack: Pack<CustomersProof> = {
  type: "customers",
  title: "Talk to Customers",
  proofSchema: CustomersProofSchema,
  sourceKey: (proof) => proof.event_id,
  sourceTime: (proof) => new Date(proof.starts_at),
  handlePlatform: () => null,
  features: CUSTOMERS_FEATURES,
  extractFeatures: ({ proof }) => {
    const duration = Math.max(0, Math.round((Date.parse(proof.ends_at) - Date.parse(proof.starts_at)) / 60_000));
    const domains = proof.attendee_domains;
    return {
      duration_min: duration,
      attendee_count: domains.length,
      attendee_domains: domains,
      all_personal_email: domains.length > 0 && domains.every((d) => (PERSONAL_EMAIL_DOMAINS as readonly string[]).includes(d)),
      internal_only: false,
      has_notes: proof.notes_summary !== null,
      short_call: duration < 5,
    };
  },
  recheck: async () => ({ status: "agent_attested", source: null, reason: null, info: {} }),
  verifyHandle: async () => ({ verified: true, reason: null }),
  finalCheck: async () => ({ not_counted: [], requests: [] }),
  cheatClasses: CUSTOMERS_CHEAT_CLASSES,
  scoreUnit: "conversations",
  contract: {
    paramsSchema: z.object({}),
    requiredDraftFields: [],
    render: ({ goal }) => ({
      send: ["For each customer or prospect call: the calendar event id, start and end, attendee addresses, and an optional short note summary."],
      scoring: `Each real conversation with a customer or prospect counts once. Reach ${goal}.`,
      extra_proof: ["Meeting notes, or the original invite email."],
      agent_instructions:
        "After each customer call, read the calendar event and call lane_submit_proof with event_id, starts_at, ends_at, attendees and notes.",
    }),
    doesNotCount: {
      all_personal_email: () => "every outside attendee uses a personal email address",
      internal_only: () => "every attendee is from the player's own company",
      short_call: () => "the call lasted under five minutes",
      duration_min: (c) => `the call lasted ${c.op === "lt" || c.op === "lte" ? "at most" : "at least"} ${genericValue(c)} minutes`,
      attendee_domains: (c) => `an attendee is from ${genericValue(c)}`,
    },
  },
  seedRules: [],
  examples: [],
  summarize: (f) => `call, ${Number(f.duration_min ?? 0)} min, ${Number(f.attendee_count ?? 0)} attendees`,
};
