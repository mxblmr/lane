import type { Db } from "mongodb";
import type { HandlePlatform } from "../schema/common";
import type { Challenge } from "../schema/challenges";
import type { Membership } from "../schema/memberships";
import type { AnyPack, PackContext, RecheckResult } from "../schema/pack";
import type { Handle, Player } from "../schema/players";
import { normalizeHandle } from "../schema/players";
import type { TrustLevel } from "../schema/proofs";
import { collections, isDuplicateKeyError } from "../schema/collections";
import { dayGraceEnd, dayIndexAt, isDayInWindow, isProofDayOpen } from "../clock";
import { dayLabel } from "./state";

/**
 * Authenticity (U5 approach step 2, R14, R16, KTD13, KTD14, KTD21): the source is real, the
 * player's own and inside the window. Membership is checked before the proof is stored, so it
 * is not repeated here. Claiming the source (KTD6) happens in the pipeline, because it is the
 * write that makes authenticity stick.
 */

/** Allowed clock skew between the source's own time and Lane's receive time. */
const FUTURE_SKEW_MS = 5 * 60_000;

export interface AuthenticityInput {
  pack: AnyPack;
  /** The proof after the pack's proof-schema parse. */
  payload: Record<string, unknown>;
  challenge: Challenge;
  player: Player;
  membership: Membership;
  ctx: PackContext;
  /** When Lane received the proof. The day's grace period is judged at this time (KTD13). */
  receivedAt: Date;
}

interface Known {
  recheck: RecheckResult | null;
  trust: TrustLevel;
  source_time: Date | null;
  day_index: number | null;
  push_event_time: Date | null;
}

export type AuthenticityResult =
  | (Known & { status: "pass"; recheck: RecheckResult; source_time: Date; day_index: number })
  /** Authentic except that the bound handle is not verified yet (KTD21): hold, do not claim. */
  | (Known & { status: "hold_handle"; platform: HandlePlatform; source_time: Date; day_index: number })
  | (Known & { status: "reject"; reason: string; fix: string })
  /** The re-check could not run right now (network, rate limit). Nothing is decided. */
  | { status: "unavailable"; reason: string };

/** KTD14: `rechecked` when Lane confirmed the source itself, `agent_attested` when it cannot. */
export function trustLevelFor(recheck: RecheckResult | null): TrustLevel {
  return recheck?.status === "rechecked" ? "rechecked" : "agent_attested";
}

/** KTD14: the GitHub push-event time is information only and never gates a verdict. */
function pushEventTime(recheck: RecheckResult | null): Date | null {
  const raw = recheck?.info?.push_event_time;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? null : t;
}

export async function checkAuthenticity(input: AuthenticityInput): Promise<AuthenticityResult> {
  const { pack, payload, challenge, player, membership, ctx, receivedAt } = input;
  const clock = challenge.clock;
  if (!clock) return { status: "unavailable", reason: "The challenge has no clock yet." };

  const platform = pack.handlePlatform(challenge);
  const handle: Handle | null = platform ? (player.handles[platform] ?? null) : null;
  const known: Known = { recheck: null, trust: "agent_attested", source_time: null, day_index: null, push_event_time: null };
  const reject = (reason: string, fix: string): AuthenticityResult => ({ ...known, status: "reject", reason, fix });

  if (platform && !handle) {
    return reject(
      `No ${platform} handle is bound to you for this challenge.`,
      `Join the challenge again with your ${platform} handle, then resend the proof.`,
    );
  }

  // R16: re-check public sources where they exist. Tests inject ctx.fetch, so nothing reaches the network.
  let recheck: RecheckResult;
  try {
    recheck = await pack.recheck(payload, player, handle, ctx);
  } catch {
    return { status: "unavailable", reason: "Lane could not re-check the source just now." };
  }
  if (recheck.status === "pending") {
    return { status: "unavailable", reason: recheck.reason ?? "Lane could not re-check the source just now." };
  }
  known.recheck = recheck;
  known.trust = trustLevelFor(recheck);
  known.push_event_time = pushEventTime(recheck);
  if (recheck.status === "failed") {
    return reject(
      recheck.reason ?? "Lane could not confirm that this source exists.",
      "Send a source that exists, is public and was made by you.",
    );
  }

  // The source belongs to the player's bound handle (KTD21). Only a re-checked source can show this.
  if (platform && handle && recheck.status === "rechecked") {
    const author = recheck.source?.author ?? null;
    if (!author || normalizeHandle(author) !== handle.handle) {
      return reject(
        `This source does not belong to your ${platform} handle @${handle.handle}.`,
        `Send a source you made yourself as @${handle.handle}.`,
      );
    }
  }

  // KTD13: the day index comes from the source time, and the day's grace period must still be open.
  const sourceTime = pack.sourceTime(payload, recheck);
  if (!sourceTime || Number.isNaN(sourceTime.getTime())) {
    return reject("Lane could not tell when this source was made.", "Send the proof with its source_time.");
  }
  known.source_time = sourceTime;
  if (sourceTime.getTime() > receivedAt.getTime() + FUTURE_SKEW_MS) {
    return reject("The source time is in the future.", "Send the source's real creation time.");
  }
  const dayIndex = dayIndexAt(clock, sourceTime);
  if (!isDayInWindow(clock, dayIndex)) {
    return reject("This source was made outside the challenge window.", "Send a source made during the challenge window.");
  }
  known.day_index = dayIndex;
  if (dayIndex < membership.joined_day_index) {
    return reject(`This source was made before you joined (${dayLabel(dayIndex)}).`, "Send a source made after you joined.");
  }
  if (!isProofDayOpen(clock, dayIndex, receivedAt)) {
    return reject(
      `The grace period for ${dayLabel(dayIndex)} closed at ${dayGraceEnd(clock, dayIndex).toISOString()}.`,
      "Send proof for a day whose grace period is still open.",
    );
  }

  if (platform && handle && handle.status !== "verified") {
    return { ...known, status: "hold_handle", platform, source_time: sourceTime, day_index: dayIndex };
  }
  return { ...known, status: "pass", recheck, source_time: sourceTime, day_index: dayIndex };
}

export type ConfirmHandleResult =
  | { status: "verified"; already: boolean }
  | { status: "not_found" }
  | { status: "taken" };

/**
 * KTD21: verify a bound handle by finding the bind code in the platform's public profile
 * (the pack fetches it), then mark it verified with one conditional update. A verified handle
 * is unique per platform, so a duplicate-key error means another player holds it.
 */
export async function confirmHandle(
  db: Db,
  input: { pack: AnyPack; player: Player; platform: HandlePlatform; code: string; ctx: PackContext },
): Promise<ConfirmHandleResult> {
  const handle = input.player.handles[input.platform];
  if (!handle) return { status: "not_found" };
  if (handle.status === "verified") return { status: "verified", already: true };
  const check = await input.pack.verifyHandle(handle.handle, input.code, input.ctx);
  if (!check.verified) return { status: "not_found" };
  const statusPath = `handles.${input.platform}.status`;
  try {
    await collections(db).players.updateOne(
      { _id: input.player._id, [statusPath]: "unverified" },
      {
        $set: {
          [statusPath]: "verified",
          [`handles.${input.platform}.verified_at`]: input.ctx.now,
          updated_at: input.ctx.now,
        },
      },
    );
  } catch (err) {
    if (isDuplicateKeyError(err)) return { status: "taken" };
    throw err;
  }
  return { status: "verified", already: false };
}
