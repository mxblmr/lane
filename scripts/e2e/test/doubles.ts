import { provideU18Services } from "@lane/core/checkin";
import { challengesService } from "@lane/core/challenges";
import { contractsService } from "@lane/core/contracts";
import { provideServices, resetServices, type LaneServices } from "@lane/core/interfaces";
import { playersService } from "@lane/core/players";
import type { OrchestratorDraftInput, OrchestratorDraftOutput, RefereeDisputeOutput } from "@lane/core/schema/agents";
import { collections } from "@lane/core/schema/collections";
import { fail } from "@lane/core/schema/common";
import { fakeChallenge, fakePlayer, fakeProof } from "@lane/core/testing/tools";

/**
 * Wiring for the U17 tests: the real U6 and U18 services (what main runs today), plus doubles for
 * the units not merged yet. No double calls a model or the network.
 * - agents: the orchestrator drafts (asking which platforms count for Build in Public, AE7) and
 *   answers questions; the referee calls every dispute unfounded.
 * - proofs: a stand-in for U5 that stores the proof, rejects an unknown commit with a reason and a
 *   fix, refuses short SHAs and deduplicates on the source key (KTD6).
 */

export const PLATFORM_QUESTION = "Which platforms count: X, Instagram, LinkedIn or Threads?";

export function agentsDouble(): LaneServices["agents"]["invoke"] {
  return (async (req: { workspace: string; mode: string; input: unknown }) => {
    const done = (output: unknown) => ({ ok: true, status: "completed", output, execution_id: "exec_test", latency_ms: 1 });
    if (req.workspace === "orchestrator" && req.mode === "draft") {
      const input = req.input as OrchestratorDraftInput;
      const bip = input.challenge_type === "build_in_public" || input.sentence.quoted_data.includes("Build in Public");
      const base = { question: null, missing_fields: [], title: null, goal: 5, days: 7, params: {} };
      if (bip && !input.answer) {
        const question: OrchestratorDraftOutput = { ...base, kind: "question", challenge_type: "build_in_public", question: PLATFORM_QUESTION, missing_fields: ["platforms"], goal: null, days: null };
        return done(question);
      }
      const params: OrchestratorDraftOutput = bip
        ? { ...base, kind: "params", challenge_type: "build_in_public", title: "Build in Public", params: { platforms: ["x", "linkedin"] } }
        : { ...base, kind: "params", challenge_type: "ship_week", title: "Ship Week" };
      return done(params);
    }
    if (req.workspace === "orchestrator" && req.mode === "answer") {
      return done({ answer: "You are tied for first with 0 verified days." });
    }
    if (req.workspace === "referee" && req.mode === "dispute") {
      const out: RefereeDisputeOutput = { outcome: "unfounded", reason: "No sign of a cheat.", fix: "", cheat_class: null, confidence: 0.6, extra_proof: null };
      return done(out);
    }
    throw new Error(`unexpected agent call ${req.workspace}.${req.mode}`);
  }) as unknown as LaneServices["agents"]["invoke"];
}

export interface ProofsDoubleOptions {
  /** Misbehave on purpose: accept every commit, to show the e2e check catches it. */
  acceptEverything?: boolean;
}

export function proofsDouble(options: ProofsDoubleOptions = {}): Pick<LaneServices["proofs"], "submit"> {
  return {
    async submit(db, input) {
      const now = input.now ?? new Date();
      const sha = String(input.fields.sha ?? "");
      if (sha.length !== 40) return fail("short_sha", "Lane needs the full commit SHA.", "Send the full 40-character SHA.");
      const c = collections(db);
      const challenge = await c.challenges.findOne({ _id: input.challenge_id as never });
      const player = await c.players.findOne({ _id: input.player_id as never });
      if (!challenge || !player) return fail("not_found", "Lane cannot find that challenge.", "Check in to see your challenges.");
      const source_key = `${String(input.fields.repo)}@${sha}`;
      const existing = await c.proofs.findOne({ challenge_id: challenge._id, player_id: player._id, source_key });
      if (existing) {
        return { ok: true, proof: existing, outcome: existing.status as never, duplicate: true, verdict: existing.verdict, request: null, lines: [] };
      }
      const accepted = options.acceptEverything === true;
      const base = fakeProof(fakeChallenge({ _id: challenge._id, type: challenge.type }), fakePlayer({ _id: player._id }), {
        source_key,
        claimed: accepted,
        status: accepted ? "accepted" : "rejected",
        received_at: now,
        updated_at: now,
      });
      const proof = {
        ...base,
        verdict: {
          ...base.verdict!,
          outcome: accepted ? ("accept" as const) : ("reject" as const),
          decided_by: "authenticity" as never,
          ai_calls: 0,
          ai_judgment: false,
          reason: accepted ? "Looks fine." : "Lane could not find this commit on GitHub.",
          fix: accepted ? "" : "Send a commit that exists on your own public repository.",
        },
      };
      await c.proofs.insertOne(proof);
      return { ok: true, proof, outcome: accepted ? "accepted" : "rejected", duplicate: false, verdict: proof.verdict, request: null, lines: [] };
    },
  };
}

/** What main runs today: the real U6 and U18 services, with every other service a U3 stub. */
export function wireMain(): void {
  resetServices();
  provideServices({ players: playersService, challenges: challengesService, contracts: contractsService });
  provideU18Services();
}

/** Main plus doubles for the agents and, unless `proofs` is false, the U5 proof pipeline. */
export function wireWithDoubles(options: { proofs?: boolean | ProofsDoubleOptions } = {}): void {
  wireMain();
  provideServices({ agents: { invoke: agentsDouble() } });
  if (options.proofs !== false) {
    provideServices({ proofs: proofsDouble(typeof options.proofs === "object" ? options.proofs : {}) });
  }
}
