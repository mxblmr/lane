import { z } from "zod";
import type { Pack } from "../../schema/pack";
import { LabelledExampleSchema } from "../../schema/examples";
import { customersContract } from "./contract";
import { extractCustomersFeatures, reduceAttendees, reduceNotes, summarizeCustomers } from "./features";
import { CUSTOMERS_CHEAT_CLASSES, CUSTOMERS_FEATURES, CUSTOMERS_SEED_RULES } from "./predicates";
import { attestCalendarEvent, verifyNoHandle } from "./recheck";
import examplesJson from "./examples.json";

/**
 * Talk to Customers pack (U15): R2 counts real conversations with customers or prospects during
 * the window. Proof is a calendar event the player's agent reads; Lane cannot re-check it, so
 * every proof is agent-attested (KTD14). The proof parse reduces attendees to domains and caps
 * notes before anything else sees them (KTD15), and extra-proof answers (meeting notes or the
 * original invite email) go through the same parse.
 */

export { CUSTOMERS_CHEAT_CLASSES, CUSTOMERS_FEATURES, CUSTOMERS_SEED_RULES } from "./predicates";
export { CUSTOMERS_DOES_NOT_COUNT, CustomersParamsSchema, customersContract } from "./contract";
export {
  PERSONAL_EMAIL_DOMAINS,
  SHORT_CALL_MINUTES,
  callMinutes,
  extractCustomersFeatures,
  isPersonalDomain,
  outsideDomains,
  reduceAttendees,
  reduceNotes,
  summarizeCustomers,
  toDomain,
} from "./features";
export { attestCalendarEvent, renderCallText, verifyNoHandle } from "./recheck";

const isoTime = (field: string) =>
  z.iso.datetime({ offset: true, message: `Send ${field} as an ISO time with a time zone, for example 2026-10-11T17:00:00Z.` });

/**
 * The flat submit-proof fields for one calendar event (`event_id`, `starts_at`, `ends_at`,
 * `attendees`, `notes`). The output is the minimal payload Lane stores: no names, no full
 * addresses, notes capped.
 */
export const CustomersProofSchema = z
  .object({
    event_id: z.string().trim().min(1, "Send the calendar event id.").max(200, "Send the calendar event id, at most 200 characters."),
    starts_at: isoTime("starts_at"),
    ends_at: isoTime("ends_at"),
    attendees: z
      .array(z.string().max(200, "Send each attendee as one email address or domain."), {
        message: "Send the call's attendees as a list of email addresses or domains.",
      })
      .max(50, "Send at most 50 attendees."),
    notes: z.string().max(4000, "Send a short summary of the notes, not the full notes.").nullish(),
  })
  .superRefine((p, ctx) => {
    if (Date.parse(p.ends_at) <= Date.parse(p.starts_at)) {
      ctx.addIssue({ code: "custom", path: ["ends_at"], message: "Send an ends_at later than starts_at." });
    }
    if (Array.isArray(p.attendees) && reduceAttendees(p.attendees).attendee_domains.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["attendees"],
        message: "Send at least one attendee besides the player, as an email address or a domain.",
      });
    }
  })
  .transform((p) => {
    const { player_domain, attendee_domains } = reduceAttendees(p.attendees);
    return {
      event_id: p.event_id,
      starts_at: new Date(p.starts_at).toISOString(),
      ends_at: new Date(p.ends_at).toISOString(),
      player_domain,
      attendee_domains,
      notes_summary: reduceNotes(p.notes),
    };
  });
export type CustomersProof = z.infer<typeof CustomersProofSchema>;

export const CUSTOMERS_EXAMPLES = z.array(LabelledExampleSchema).parse(examplesJson);

export const customersPack: Pack<CustomersProof> = {
  type: "customers",
  title: "Talk to Customers",
  proofSchema: CustomersProofSchema,
  /** The calendar event id. */
  sourceKey: (proof) => proof.event_id,
  /** The call's start sets its day (KTD13). */
  sourceTime: (proof) => {
    const d = new Date(proof.starts_at);
    return Number.isNaN(d.getTime()) ? null : d;
  },
  handlePlatform: () => null,
  features: CUSTOMERS_FEATURES,
  extractFeatures: ({ proof }) => extractCustomersFeatures(proof),
  recheck: (proof, _player, _handle, ctx) => attestCalendarEvent(proof, ctx),
  verifyHandle: () => verifyNoHandle(),
  /** A calendar event has no public source to re-fetch at window close. */
  finalCheck: async () => ({ not_counted: [], requests: [] }),
  cheatClasses: CUSTOMERS_CHEAT_CLASSES,
  scoreUnit: "conversations",
  contract: customersContract,
  seedRules: CUSTOMERS_SEED_RULES,
  examples: CUSTOMERS_EXAMPLES,
  summarize: summarizeCustomers,
};
