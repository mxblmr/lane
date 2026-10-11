import { z } from "zod";
import { IdSchema } from "./common";

/**
 * Work that outlives a request (KTD20).
 * - referee_verdict: a referee call that missed the 20-second reply (U5).
 * - learning: one learning chain, keyed by evidence proof id or example key (U9).
 * - settlement: compute-and-pay, keyed by challenge id (U11).
 * - red_team: one red-team run (U9, U10).
 */
export const JOB_KINDS = ["referee_verdict", "learning", "settlement", "red_team"] as const;
export const JobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JOB_STATUSES = ["queued", "running", "done", "failed", "skipped"] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** `jobs` collection. Unique on (kind, dedup_key). */
export const JobSchema = z.object({
  _id: IdSchema,
  kind: JobKindSchema,
  dedup_key: z.string().min(1).max(200),
  payload: z.record(z.string(), z.unknown()),
  status: JobStatusSchema,
  due_at: z.date(),
  claimed_at: z.date().nullable(),
  renewed_at: z.date().nullable(),
  /** Bumped by every claim. A runner's writes must match it (fencing). */
  attempt: z.int().min(0),
  max_attempts: z.int().min(1),
  last_error: z.string().max(1000).nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.date(),
  updated_at: z.date(),
  finished_at: z.date().nullable(),
});
export type Job = z.infer<typeof JobSchema>;
