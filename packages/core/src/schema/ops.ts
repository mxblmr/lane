import { z } from "zod";

export const TICK_LEASE_ID = "tick" as const;

/** `ops` collection: the tick lease (KTD13). Written by U18's tick only. Never projected. */
export const OpsLeaseSchema = z.object({
  _id: z.string().min(1).max(64),
  holder: z.string().max(100).nullable(),
  lease_until: z.date(),
  updated_at: z.date(),
});
export type OpsLease = z.infer<typeof OpsLeaseSchema>;
