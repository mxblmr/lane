import type { Db } from "mongodb";
import { fail, type LaneError } from "./schema/common";
import { collections } from "./schema/collections";
import type { Challenge } from "./schema/challenges";
import type { AnyPack } from "./schema/pack";
import {
  AskContextSchema,
  OrchestratorAnswerOutputSchema,
  quote,
  type AskContext,
} from "./schema/agents";
import { NotImplementedError, services, type AskInput, type AskResult, type LaneServices } from "./interfaces";
import { currentDayIndex } from "./clock";
import { getPack } from "./packs/index";
import { buildFeed, safeDisplayName } from "./feed";
import { standingsFor } from "./checkin";

/**
 * `lane_ask` (U18, R25, F5). The core builds a context from the asking player's own data and
 * public standings, and the orchestrator answers from it alone (KTD15). Other players' proofs
 * appear only as redacted feed items: summary, status and what decided it. The question reaches
 * the orchestrator as quoted data (KTD18). Asking writes nothing.
 */

const ASK_STATUSES: Challenge["status"][] = ["active", "settling", "settled"];
const MAX_MY_PROOFS = 30;
const ASK_FEED_LIMIT = 20;

export interface AskOptions {
  /** Test seam: resolve a pack other than the registry's. */
  packFor?: (type: Challenge["type"]) => AnyPack;
}

export async function buildAskContext(
  db: Db,
  input: { player_id: string; challenge_id?: string; now: Date },
  opts: AskOptions = {},
): Promise<{ ok: true; context: AskContext } | { ok: false; error: LaneError }> {
  const col = collections(db);
  const player = await col.players.findOne({ _id: input.player_id }, { projection: { _id: 1, display_name: 1 } });
  if (!player) {
    return fail("unauthenticated", "Lane does not know this player.", "Register with lane_register, then send the player key it returns.");
  }
  const memberships = await col.memberships.find({ player_id: player._id }, { projection: { challenge_id: 1 } }).toArray();
  let ids = memberships.map((m) => m.challenge_id);
  if (input.challenge_id) {
    if (!ids.includes(input.challenge_id)) {
      return fail("not_member", "You are not in that challenge.", "Ask about a challenge listed in your own check-in, or leave out challenge_id.");
    }
    ids = [input.challenge_id];
  }
  const challenges = await col.challenges
    .find({ _id: { $in: ids }, status: { $in: ASK_STATUSES } })
    .sort({ created_at: 1 })
    .toArray();
  const packFor = opts.packFor ?? getPack;

  const context: AskContext = {
    player: { player_id: player._id, display_name: safeDisplayName(player.display_name) },
    challenges: await Promise.all(
      challenges.map(async (challenge) => {
        const pack = packFor(challenge.type);
        const [standings, contract, mine, feed] = await Promise.all([
          standingsFor(db, challenge, player._id, input.now, pack),
          col.contracts.findOne({ challenge_id: challenge._id }, { sort: { version: -1 } }),
          col.proofs
            .find(
              { challenge_id: challenge._id, player_id: player._id, day_index: { $ne: null } },
              { projection: { _id: 1, day_index: 1, status: 1, verdict: 1, challenge_type: 1 } },
            )
            .sort({ received_at: -1 })
            .limit(MAX_MY_PROOFS)
            .toArray(),
          buildFeed(db, { challenge_id: challenge._id, viewer_player_id: player._id, limit: ASK_FEED_LIMIT }, { packFor }),
        ]);
        return {
          challenge_id: challenge._id,
          type: challenge.type,
          title: challenge.title,
          status: challenge.status,
          day_index: challenge.clock ? currentDayIndex(challenge.clock, input.now) : null,
          standings,
          rules: contract?.does_not_count.map((l) => l.line) ?? [],
          // The player's own verdict reasons are theirs to see.
          my_proofs: mine.map((p) => ({
            proof_id: p._id,
            day_index: p.day_index as number,
            status: p.status,
            reason: p.verdict?.reason.slice(0, 500) ?? null,
            fix: p.verdict?.fix.slice(0, 500) ?? null,
          })),
          feed: feed.filter((f) => f.player_id !== player._id),
        };
      }),
    ),
  };
  return { ok: true, context: AskContextSchema.parse(context) };
}

/** Lane's own short answer when the orchestrator cannot answer. */
function fallbackAnswer(context: AskContext): string {
  if (context.challenges.length === 0) return "You are not in an active challenge yet. Ask your Muse to join one with its join code.";
  const lines = context.challenges.map((c) => {
    const me = c.standings.find((s) => s.is_you);
    const standing = me ? `you are ranked ${me.rank} with ${me.score} ${me.unit}` : "no standing yet";
    return `${c.title}: ${standing}.`;
  });
  return `Lane could not answer that right now. ${lines.join(" ")} Try asking again in a minute.`.slice(0, 1000);
}

export async function askLane(db: Db, input: AskInput, opts: AskOptions = {}): Promise<AskResult> {
  const now = input.now ?? new Date();
  const question = input.question.trim();
  if (!question) return fail("invalid_input", "The question is empty.", "Call lane_ask again with a question.");
  const built = await buildAskContext(db, { player_id: input.player_id, challenge_id: input.challenge_id, now }, opts);
  if (!built.ok) return built;
  try {
    const res = await services().agents.invoke({
      workspace: "orchestrator",
      mode: "answer",
      input: { mode: "answer", question: quote(question, 500), context: built.context },
      meta: { player_id: input.player_id, challenge_id: input.challenge_id ?? null },
    });
    if (res.ok && res.status === "completed") {
      const parsed = OrchestratorAnswerOutputSchema.safeParse(res.output);
      if (parsed.success) return { ok: true, answer: parsed.data.answer };
    }
  } catch (err) {
    if (!(err instanceof NotImplementedError)) throw err;
  }
  return { ok: true, answer: fallbackAnswer(built.context) };
}

/** The U18 ask service, in the shape of `LaneServices["ask"]`. */
export const askService = {
  ask: (db: Db, input: AskInput) => askLane(db, input),
} satisfies LaneServices["ask"];
