/**
 * Talk to Customers scenario for Gary and Priya (AE2, R30).
 *
 * Gary's agent submits a call whose only attendee uses a personal Gmail address. Priya disputes
 * it. The referees ask Gary for meeting notes, which he never sends, so the call stops counting
 * after the grace period. The rule-writer learns that such calls need notes, and that rule goes
 * live without approval because it only asks for more proof (R22).
 */
import { contractVersion, findChallenge, type EnvelopeChallengeLike, type EnvelopeLike } from "../lane-client";
import { COUNTING_OUTCOMES } from "../lane-client";
import { describeVerdict, expectThat, submitAndSettle, type Scenario, type StageContext, type Step } from "../runner";

const TYPE = "customers";

export const DISPUTE_REASON = "The only attendee uses a personal Gmail address. That looks like a friend, not a customer.";

interface CustomersState {
  challenge_id: string;
  base_version: number;
  proof_id: string | null;
}

function customersState(ctx: StageContext): CustomersState {
  const s = ctx.state.customers as CustomersState | undefined;
  expectThat(s, "Run Gary's call step first.");
  return s;
}

function challengeIn(env: EnvelopeLike, id: string): EnvelopeChallengeLike | null {
  return (env.challenges ?? []).find((c) => c.challenge_id === id) ?? null;
}

interface ActionLike {
  id?: string;
  kind?: string;
  actor?: string;
  instruction?: string;
}

/** Gary's agent submits a call with only a personal-email attendee. */
export const garyFriendCall: Step = {
  title: "Gary's agent submits a call whose only attendee has a personal Gmail address",
  async run(ctx) {
    const gary = ctx.player("Gary");
    const env = await gary.lane.checkIn();
    const c = findChallenge(env, TYPE);
    expectThat(c, "Gary is not in a live Talk to Customers challenge. Reset that stage first.");
    ctx.io.log(`Gary is in ${c.title ?? "Talk to Customers"} (${c.challenge_id}), contract v${contractVersion(c)}.`);

    // The stage challenge started minutes ago at the reset, so the call starts now to sit inside its window.
    const start = new Date(ctx.io.now());
    const end = new Date(start.getTime() + 25 * 60_000);
    const v = await submitAndSettle(ctx, gary.lane, {
      challenge_id: c.challenge_id,
      event_id: `lane-stage-call-${start.getTime()}`,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      attendees: ["Alex <alex.friend@gmail.com>"],
    });
    ctx.io.log(describeVerdict(v));
    ctx.state.customers = { challenge_id: c.challenge_id, base_version: contractVersion(c), proof_id: v.proof_id } satisfies CustomersState;
    expectThat(v.proof_id, "Lane's reply had no proof id for Priya to dispute.");
  },
};

/** Priya disputes Gary's call from her feed. */
export const priyaDisputes: Step = {
  title: "Priya disputes Gary's call",
  async run(ctx) {
    const priya = ctx.player("Priya");
    const s = customersState(ctx);
    const env = await priya.lane.checkIn();
    const c = challengeIn(env, s.challenge_id);
    expectThat(c, "Priya is not in Gary's Talk to Customers challenge.");
    const line = (c.feed ?? []).find((f) => f.proof_id === s.proof_id);
    expectThat(line, "Gary's call is not in Priya's feed.");
    const res = await priya.lane.call("lane_dispute", { proof_id: s.proof_id, reason: DISPUTE_REASON });
    expectThat(res.status !== "error", `Lane refused the dispute: ${res.error?.code ?? "error"}. ${(res.lines ?? []).join(" ")}`);
    ctx.io.log(`Priya disputed Gary's call. ${(res.lines ?? []).join(" ")}`.trim());
  },
};

/** Gary's check-in carries the referees' request for meeting notes, which he never answers. */
export const garyAskedForNotes: Step = {
  title: "Gary's check-in asks for meeting notes; Gary has none",
  async run(ctx) {
    const gary = ctx.player("Gary");
    const s = customersState(ctx);
    const deadline = ctx.io.now() + ctx.verdictTimeoutMs;
    while (ctx.io.now() < deadline) {
      const c = challengeIn(await gary.lane.checkIn(), s.challenge_id);
      const actions = (c?.actions ?? []) as ActionLike[];
      const ask = actions.find((a) => a.kind === "extra_proof");
      if (ask) {
        ctx.io.log(`Lane asks Gary (${ask.actor ?? "player"} task): ${ask.instruction ?? "send more proof"}`);
        ctx.io.log("Gary has no notes for this call, so his agent sends nothing.");
        return;
      }
      await ctx.io.sleep(ctx.pollMs);
    }
    throw new Error("No extra-proof request reached Gary's check-in.");
  },
};

/** The call stops counting after the grace period, and the learned ask-more rule goes live by itself. */
export const callDropsAndRuleGoesLive: Step = {
  title: "Wait for the call to stop counting and the learned rule to go live without approval",
  async run(ctx) {
    const gary = ctx.player("Gary");
    const s = customersState(ctx);
    ctx.io.log("Waiting for the grace period to end (demo grace is 90 seconds; keep the dashboard open, its polling runs the tick).");
    let dropped: string | null = null;
    let live: EnvelopeChallengeLike | null = null;
    const deadline = ctx.io.now() + ctx.ruleTimeoutMs;
    while (ctx.io.now() < deadline && (!dropped || !live)) {
      const c = challengeIn(await gary.lane.checkIn(), s.challenge_id);
      expectThat(c, "Gary's Talk to Customers challenge is no longer live.");
      const line = (c.feed ?? []).find((f) => f.proof_id === s.proof_id);
      if (!dropped && line?.status && !COUNTING_OUTCOMES.has(line.status) && line.status !== "held") {
        dropped = line.status;
        ctx.io.log(`Gary's call is now ${line.status}.`);
      }
      if (!live && contractVersion(c) > s.base_version) {
        live = c;
        const added = (c.contract?.does_not_count ?? []).join("; ");
        ctx.io.log(`rule live (no approval needed): contract v${contractVersion(c)}${added ? ` says "${added}"` : ""}`);
      }
      if (!dropped || !live) await ctx.io.sleep(ctx.pollMs);
    }
    expectThat(dropped, "Gary's call still counts after the grace period.");
    expectThat(live, "The learned rule did not go live.");
  },
};

export const ae2Customers: Scenario = {
  id: "ae2-customers",
  title: "AE2: Gary's friend call on Talk to Customers, disputed by Priya",
  steps: [garyFriendCall, priyaDisputes, garyAskedForNotes, callDropsAndRuleGoesLive],
};
