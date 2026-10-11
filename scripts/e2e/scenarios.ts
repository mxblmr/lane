/**
 * End-to-end scenarios (U17) for the plan's Key Flows F1 to F6 and Acceptance Examples AE2 to AE8.
 * Each scenario acts only through the eight `lane_` tools, as Muse and the scripted players do,
 * and, when the runner has a read-only database handle, also asserts MongoDB state.
 *
 * Test players are clearly marked: every display name starts with "E2E" and carries the run id,
 * and every handle starts with "e2e-". Lane has no delete tool, so nothing is removed afterwards;
 * the marked players and their challenges are never stage challenges, and U13's reset leaves
 * them alone.
 *
 * A scenario that reaches a service Lane has not shipped yet ends as BLOCKED with the unit it
 * waits on, never as a pass. Scenarios that need the operator routes (approve, advance the clock,
 * close the window) end as BLOCKED until an operator client is wired in.
 */
import type { getDb } from "@lane/core/db";
import { collections } from "@lane/core/schema/collections";
import type { Envelope } from "@lane/core/schema/envelope";
import { isNotLive, type LaneClient } from "./lane-client";

/** The core's MongoDB handle type, without a direct `mongodb` dependency in scripts. */
export type Db = Awaited<ReturnType<typeof getDb>>;

export type ScenarioStatus = "pass" | "fail" | "blocked";

export interface E2EContext {
  lane: LaneClient;
  /** Short id of this run, letters and digits, used to mark test players. */
  runId: string;
  /** Read-only database handle for state assertions. Optional against a deployed URL. */
  db?: Db;
  /** Collects progress notes for the report. */
  note(line: string): void;
}

export interface Scenario {
  id: string;
  title: string;
  covers: string[];
  /** Units whose services this scenario needs, named in the BLOCKED report. */
  waitsOn: string[];
  run(ctx: E2EContext): Promise<void>;
}

export class Blocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Blocked";
  }
}

export class CheckFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckFailed";
  }
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

// ---------------------------------------------------------------------------------- helpers

export interface TestPlayer {
  name: string;
  key: string;
  player_id: string;
  handle: string;
}

type Data = Record<string, unknown>;

function data(env: Envelope): Data {
  return (env.data ?? {}) as Data;
}

/** One tool call. A "not live yet" answer from a stubbed service ends the scenario as BLOCKED. */
export async function call(
  ctx: E2EContext,
  player: TestPlayer | null,
  tool: string,
  args: Record<string, unknown>,
  waitsOn: string,
): Promise<Envelope> {
  const env = await ctx.lane.call(tool, player ? { ...args, player_key: player.key } : args);
  if (isNotLive(env)) throw new Blocked(`${tool} answered "not live yet": waits on ${waitsOn}`);
  // Lane's agents are not deployed, or did not answer. Reported as blocked on the agents, never as a pass.
  if (env.status === "error" && env.error?.code === "agent_failed") {
    throw new Blocked(`${tool} answered agent_failed, so the agent behind it did not answer: waits on ${waitsOn}`);
  }
  return env;
}

function expectOk(env: Envelope, what: string): void {
  check(env.status !== "error", `${what}: expected ok, got error ${env.error?.code ?? ""}: ${env.lines.join(" ")}`);
}

export async function registerTestPlayer(ctx: E2EContext, persona: string): Promise<TestPlayer> {
  const name = `E2E ${persona} ${ctx.runId}`.slice(0, 24);
  const env = await call(ctx, null, "lane_register", { display_name: name, time_zone: "America/Los_Angeles" }, "U6");
  expectOk(env, "lane_register");
  const d = data(env);
  check(typeof d.player_key === "string" && typeof d.player_id === "string", "lane_register returned no key or player id");
  check(d.credits === 1000, `lane_register should start the player with 1000 play credits, got ${String(d.credits)}`);
  check(
    typeof d.routine_text === "string" && d.routine_text.includes("lane_check_in"),
    "lane_register should return routine text that calls lane_check_in (R10)",
  );
  return {
    name,
    key: d.player_key as string,
    player_id: d.player_id as string,
    handle: `e2e-${ctx.runId}-${persona.toLowerCase()}`.slice(0, 39),
  };
}

export interface CreatedChallenge {
  challenge_id: string;
  join_code: string;
  draft_id: string;
  questions: string[];
}

/**
 * F1 for the creator: sentence, any clarifying questions answered from `answers`, then confirm
 * with the winner rule and stake the player chose.
 */
export async function createChallenge(
  ctx: E2EContext,
  creator: TestPlayer,
  sentence: string,
  answers: string[],
  stake = 50,
): Promise<CreatedChallenge> {
  const questions: string[] = [];
  let env = await call(ctx, creator, "lane_create_challenge", { sentence }, "U6 and the U8 orchestrator");
  expectOk(env, "lane_create_challenge");
  for (let i = 0; data(env).kind === "question"; i += 1) {
    check(i < answers.length, `lane_create_challenge asked more questions than expected: ${String(data(env).question)}`);
    questions.push(String(data(env).question));
    env = await call(
      ctx,
      creator,
      "lane_create_challenge",
      { sentence: answers[i], draft_id: data(env).draft_id },
      "U6 and the U8 orchestrator",
    );
    expectOk(env, "lane_create_challenge (answer)");
  }
  const draft = data(env);
  check(draft.kind === "draft", "lane_create_challenge should end with a draft");
  const present = draft.present as { lines?: unknown[] } | undefined;
  check((present?.lines?.length ?? 0) > 0, "the draft should carry lines for the player (R8)");
  const draftId = String(draft.draft_id);

  const confirmed = await call(
    ctx,
    creator,
    "lane_confirm_challenge",
    { draft_id: draftId, winner_rule: "top_score", stake },
    "U6",
  );
  expectOk(confirmed, "lane_confirm_challenge");
  const c = data(confirmed);
  check(typeof c.join_code === "string" && typeof c.challenge_id === "string", "lane_confirm_challenge returned no join code");
  check(
    confirmed.lines.join(" ").includes("play credits (no real money)"),
    "lane_confirm_challenge should label the stake as play credits (R7)",
  );
  return { challenge_id: c.challenge_id as string, join_code: c.join_code as string, draft_id: draftId, questions };
}

/** F1 for a joiner: the terms first, then the accepting call with the handle. */
export async function joinChallenge(
  ctx: E2EContext,
  player: TestPlayer,
  joinCode: string,
  handle: string | null,
): Promise<{ terms: Data; joined: Envelope }> {
  const termsEnv = await call(ctx, player, "lane_join_challenge", { join_code: joinCode }, "U6");
  expectOk(termsEnv, "lane_join_challenge (terms)");
  const terms = data(termsEnv);
  check(terms.phase === "terms", "the first lane_join_challenge call should return terms, not join");
  const lines = ((terms.present as { lines?: string[] } | undefined)?.lines ?? []).join(" ");
  check(lines.includes("play credits (no real money)"), "the terms should label the stake as play credits (R7)");
  const joined = await call(
    ctx,
    player,
    "lane_join_challenge",
    { join_code: joinCode, accepted_terms_version: terms.terms_version, ...(handle ? { handle } : {}) },
    "U6",
  );
  expectOk(joined, "lane_join_challenge (accept)");
  check(data(joined).phase === "joined", "the accepting lane_join_challenge call should join");
  return { terms, joined };
}

const SHIP_WEEK_SENTENCE = "start Ship Week with my friends: a meaningful commit on our own projects every day";
const SHIP_WEEK_ANSWERS = ["A meaningful commit on my own GitHub project each day, 7 days, goal 5 days."];

interface ShipWeekPair {
  maya: TestPlayer;
  priya: TestPlayer;
  challenge: CreatedChallenge;
}

/** Maya creates a Ship Week challenge, binds her handle, and Priya joins with hers. */
async function shipWeekWithTwo(ctx: E2EContext): Promise<ShipWeekPair> {
  const maya = await registerTestPlayer(ctx, "Maya");
  const challenge = await createChallenge(ctx, maya, SHIP_WEEK_SENTENCE, SHIP_WEEK_ANSWERS);
  const bound = await call(ctx, maya, "lane_join_challenge", { join_code: challenge.join_code, handle: maya.handle }, "U6");
  expectOk(bound, "creator handle bind");
  const priya = await registerTestPlayer(ctx, "Priya");
  await joinChallenge(ctx, priya, challenge.join_code, priya.handle);
  return { maya, priya, challenge };
}

function randomSha(): string {
  let out = "";
  for (let i = 0; i < 40; i += 1) out += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return out;
}

async function counts(db: Db, challengeId: string): Promise<Record<string, number>> {
  const c = collections(db);
  const id = challengeId as never;
  const [memberships, stakes, proofs, disputes, challenges] = await Promise.all([
    c.memberships.countDocuments({ challenge_id: id }),
    c.ledger.countDocuments({ challenge_id: id, kind: "stake" }),
    c.proofs.countDocuments({ challenge_id: id }),
    c.disputes.countDocuments({ challenge_id: id }),
    c.challenges.countDocuments({}),
  ]);
  return { memberships, stakes, proofs, disputes, challenges };
}

function findChallenge(env: Envelope, challengeId: string) {
  return env.challenges.find((c) => c.challenge_id === challengeId);
}

// ---------------------------------------------------------------------------------- scenarios

const F1: Scenario = {
  id: "F1",
  title: "Create and register",
  covers: ["R4", "R5", "R6", "R7", "R8", "R10"],
  waitsOn: ["U6", "U8 orchestrator"],
  async run(ctx) {
    const { maya, priya, challenge } = await shipWeekWithTwo(ctx);
    ctx.note(`challenge ${challenge.challenge_id} created, Priya joined`);

    // Repeating a write changes nothing (KTD6).
    const before = ctx.db ? await counts(ctx.db, challenge.challenge_id) : null;
    const confirmAgain = await call(
      ctx,
      maya,
      "lane_confirm_challenge",
      { draft_id: challenge.draft_id, winner_rule: "top_score", stake: 50 },
      "U6",
    );
    check(
      confirmAgain.status === "error" || data(confirmAgain).challenge_id === challenge.challenge_id,
      "confirming the same draft twice should not create a second challenge",
    );
    const joinAgain = await call(
      ctx,
      priya,
      "lane_join_challenge",
      { join_code: challenge.join_code, accepted_terms_version: "repeat", handle: priya.handle },
      "U6",
    );
    check(
      joinAgain.status === "error" || data(joinAgain).already_member === true || data(joinAgain).phase === "terms",
      "joining twice should not stake twice",
    );

    if (ctx.db && before) {
      const after = await counts(ctx.db, challenge.challenge_id);
      check(after.memberships === 2, `expected 2 memberships, found ${after.memberships}`);
      check(after.stakes === 2, `expected 2 stake ledger entries, found ${after.stakes}`);
      check(after.challenges === before.challenges, "a repeated confirm created another challenge");
      const stored = await collections(ctx.db).challenges.findOne({ _id: challenge.challenge_id as never });
      check(stored?.status === "active", `expected the challenge to be active, found ${String(stored?.status)}`);
      check(stored?.winner_rule === "top_score", "the winner rule the creator picked should be stored (R6)");
      const players = await collections(ctx.db)
        .players.find({ _id: { $in: [maya.player_id, priya.player_id] as never[] } })
        .toArray();
      check(players.length === 2 && players.every((p) => p.credits === 950), "each player should have 950 credits after staking 50");
      check(players.every((p) => !JSON.stringify(p).includes(maya.key) && !JSON.stringify(p).includes(priya.key)), "a plaintext key is stored (KTD4)");
    }
  },
};

const F2: Scenario = {
  id: "F2",
  title: "Daily proof",
  covers: ["R13", "R14", "R15", "R16", "R17", "R19"],
  waitsOn: ["U5 proof pipeline", "U14 Ship Week pack"],
  async run(ctx) {
    const { maya, challenge } = await shipWeekWithTwo(ctx);
    const args = { challenge_id: challenge.challenge_id, repo: `lane-e2e/${ctx.runId}`, sha: randomSha() };
    const first = await call(ctx, maya, "lane_submit_proof", args, "U5");
    expectOk(first, "lane_submit_proof");
    const d = data(first);
    check(typeof d.proof_id === "string", "lane_submit_proof returned no proof id");
    // The commit does not exist, so Lane must not count it (R14). An unverified handle may hold it (KTD21).
    check(d.outcome !== "accepted" && d.outcome !== "flagged_accept", `a commit that does not exist was ${String(d.outcome)}`);
    if (d.outcome === "rejected") {
      const verdict = d.verdict as { reason?: string; fix?: string } | null;
      check(Boolean(verdict?.reason) && Boolean(verdict?.fix), "a rejection should carry the reason and how to fix it (R19)");
    }
    ctx.note(`unknown commit -> ${String(d.outcome)}`);

    const again = await call(ctx, maya, "lane_submit_proof", args, "U5");
    expectOk(again, "lane_submit_proof (repeat)");
    check(data(again).duplicate === true, "submitting the same commit twice should come back as a duplicate (KTD6)");
    check(data(again).proof_id === d.proof_id, "a duplicate submission should return the first proof");

    const short = await call(ctx, maya, "lane_submit_proof", { ...args, sha: args.sha.slice(0, 7) }, "U5");
    check(short.status === "error" && Boolean(short.error?.recovery), "a short SHA should be refused with a recovery instruction");

    if (ctx.db) {
      const n = await collections(ctx.db).proofs.countDocuments({
        challenge_id: challenge.challenge_id as never,
        player_id: maya.player_id as never,
      });
      check(n === 1, `expected 1 proof after a repeated submission, found ${n}`);
    }
  },
};

const F3: Scenario = {
  id: "F3",
  title: "Check-in",
  covers: ["R9", "R10", "R11", "R12"],
  waitsOn: ["U18"],
  async run(ctx) {
    const { maya, priya, challenge } = await shipWeekWithTwo(ctx);
    const first = await call(ctx, priya, "lane_check_in", {}, "U18");
    expectOk(first, "lane_check_in");
    const mine = findChallenge(first, challenge.challenge_id);
    check(mine, "the check-in should list the challenge Priya joined");
    check(mine.contract_version >= 1, "the check-in should carry the contract version (R9)");
    const ids = mine.standings.map((s) => s.player_id).sort();
    check(
      ids.length === 2 && ids.includes(maya.player_id) && ids.includes(priya.player_id),
      "the check-in should carry standings for both players (R11)",
    );
    check(mine.standings.some((s) => s.player_id === priya.player_id && s.is_you), "the standing should mark Priya as is_you");
    for (const action of mine.actions) {
      check(action.actor === "agent" || action.actor === "player", "every action should say who does it (KTD5)");
      check(action.instruction.length > 0, "every action should carry an instruction");
    }
    check(first.next_check_in_at !== null, "the check-in should say when to check in next (R10)");
    const gapMin = (Date.parse(first.next_check_in_at) - Date.parse(first.server_time)) / 60_000;
    check(gapMin > 20 && gapMin <= 40, `the next check-in should be about 27 minutes out, got ${gapMin.toFixed(1)}`);

    const before = ctx.db ? await counts(ctx.db, challenge.challenge_id) : null;
    const second = await call(ctx, priya, "lane_check_in", {}, "U18");
    expectOk(second, "lane_check_in (repeat)");
    const again = findChallenge(second, challenge.challenge_id);
    check(again && !again.contract_changed, "a repeated check-in should not report the same contract as changed (R9)");

    if (ctx.db && before) {
      check(JSON.stringify(await counts(ctx.db, challenge.challenge_id)) === JSON.stringify(before), "a check-in wrote more than last-seen state (KTD6)");
      const membership = await collections(ctx.db).memberships.findOne({
        challenge_id: challenge.challenge_id as never,
        player_id: priya.player_id as never,
      });
      check(membership?.last_check_in_at, "the check-in should record Priya's last check-in time");
    }
  },
};

const F5: Scenario = {
  id: "F5",
  title: "Ask and dispute",
  covers: ["R19", "R20", "R25", "R26"],
  waitsOn: ["U18", "U8 orchestrator", "U5 proof pipeline"],
  async run(ctx) {
    const { maya, priya, challenge } = await shipWeekWithTwo(ctx);
    const ask = await call(
      ctx,
      priya,
      "lane_ask",
      { question: "What is my standing?", challenge_id: challenge.challenge_id },
      "U18 and the U8 orchestrator",
    );
    expectOk(ask, "lane_ask");
    check(typeof data(ask).answer === "string" && String(data(ask).answer).length > 0, "lane_ask should answer (R25)");

    const proof = await call(
      ctx,
      maya,
      "lane_submit_proof",
      { challenge_id: challenge.challenge_id, repo: `lane-e2e/${ctx.runId}`, sha: randomSha() },
      "U5",
    );
    expectOk(proof, "lane_submit_proof");
    const proofId = String(data(proof).proof_id);

    const reason = "E2E check: this commit is not on a real project.";
    const first = await call(ctx, priya, "lane_dispute", { proof_id: proofId, reason }, "U18");
    expectOk(first, "lane_dispute");
    check(data(first).created === true, "the first dispute should be created (R26)");
    const again = await call(ctx, priya, "lane_dispute", { proof_id: proofId, reason }, "U18");
    expectOk(again, "lane_dispute (repeat)");
    check(data(again).created === false && data(again).dispute_id === data(first).dispute_id, "a repeated dispute should not create another (KTD6)");

    const own = await call(ctx, maya, "lane_dispute", { proof_id: proofId, reason }, "U18");
    check(own.status === "error", "a player should not be able to dispute their own proof");

    if (ctx.db) {
      const n = await collections(ctx.db).disputes.countDocuments({ proof_id: proofId as never });
      check(n === 1, `expected 1 dispute after a repeated call, found ${n}`);
    }
  },
};

const AE7: Scenario = {
  id: "AE7",
  title: "Build in Public asks which platforms count",
  covers: ["R4"],
  waitsOn: ["U6", "U8 orchestrator", "U16 Build in Public pack"],
  async run(ctx) {
    const maya = await registerTestPlayer(ctx, "Maya");
    const created = await createChallenge(ctx, maya, "start Build in Public with my friends", [
      "X and LinkedIn",
      "7 days, a build-log post each day, goal 5 days",
      "Yes, that's right",
    ]);
    check(created.questions.length > 0, "the orchestrator should ask a clarifying question before creating the contract");
    check(/platform/i.test(created.questions[0] ?? ""), `the first question should ask which platforms count, got: ${created.questions[0] ?? ""}`);
    if (ctx.db) {
      const stored = await collections(ctx.db).challenges.findOne({ _id: created.challenge_id as never });
      check(stored?.type === "build_in_public" && stored.status === "active", "the Build in Public challenge should end active");
    }
  },
};

const AE8: Scenario = {
  id: "AE8",
  title: "One check-in response carries actions, standing and the contract",
  covers: ["R9", "R11", "R17"],
  waitsOn: ["U18", "U5 proof pipeline for the thin-commit trigger"],
  async run(ctx) {
    const { maya, challenge } = await shipWeekWithTwo(ctx);
    const env = await call(ctx, maya, "lane_check_in", {}, "U18");
    expectOk(env, "lane_check_in");
    const mine = findChallenge(env, challenge.challenge_id);
    check(mine, "the check-in should list Maya's challenge");
    check(mine.standings.some((s) => s.is_you), "the single response should carry Maya's standing");
    check(mine.contract_version >= 1, "the single response should carry the contract version");
    const bind = mine.actions.find((a) => a.kind === "bind_code");
    check(bind && bind.actor === "player", "Maya's bind code should wait in her inbox as a player action to relay");
    for (const action of mine.actions.filter((a) => a.kind === "extra_proof")) {
      check(action.actor === "player" && /\d{4}/.test(action.instruction), "an extra-proof request should give the player a code to put in a commit");
    }
  },
};

function needsOperator(id: string, title: string, covers: string[], waitsOn: string[], how: string): Scenario {
  return {
    id,
    title,
    covers,
    waitsOn,
    async run() {
      throw new Blocked(`needs ${how}; waits on ${waitsOn.join(", ")}`);
    },
  };
}

const F4 = needsOperator(
  "F4",
  "Learn a rule",
  ["R20", "R21", "R22", "R23", "R9"],
  ["U9", "U10", "U12 approve route", "U13"],
  "a real junk commit and the dashboard approve; AE1 runs through pnpm players:stage",
);
const F6 = needsOperator("F6", "Settlement", ["R6", "R27", "R28"], ["U11", "U12 close-window route"], "the operator close-window route");
const AE2 = needsOperator(
  "AE2",
  "Personal-Gmail call asks for meeting notes",
  ["R17", "R20", "R22", "R26"],
  ["U15 Talk to Customers pack", "U5", "U9"],
  "the Talk to Customers pack and the referee",
);
const AE3 = needsOperator(
  "AE3",
  "Filler post rejected, deleted post stops counting",
  ["R15", "R27"],
  ["U16 Build in Public pack", "U11", "U12 close-window route"],
  "the Build in Public pack and the final re-fetch",
);
const AE4 = needsOperator("AE4", "Unanswered surprise check voids the day", ["R18"], ["U12 trigger-surprise-check and advance-day routes"], "the operator surprise-check and advance-day routes");
const AE5 = needsOperator("AE5", "A rule with too many false alarms is rejected", ["R21"], ["U9 test gate", "U10 rule-lab"], "a rule-lab candidate");
const AE6 = needsOperator("AE6", "Tie splits the pot, over-limit share waits for approval", ["R6", "R28"], ["U11", "U12 payout approval"], "verified scores and the payout approval route");

export const SCENARIOS: Scenario[] = [F1, F2, F3, F4, F5, F6, AE2, AE3, AE4, AE5, AE6, AE7, AE8];

export interface ScenarioResult {
  id: string;
  title: string;
  status: ScenarioStatus;
  detail: string;
  notes: string[];
  ms: number;
}

export async function runScenario(scenario: Scenario, base: Omit<E2EContext, "note">): Promise<ScenarioResult> {
  const notes: string[] = [];
  const started = Date.now();
  const result = (status: ScenarioStatus, detail: string): ScenarioResult => ({
    id: scenario.id,
    title: scenario.title,
    status,
    detail,
    notes,
    ms: Date.now() - started,
  });
  try {
    await scenario.run({ ...base, note: (line) => notes.push(line) });
    return result("pass", `covers ${scenario.covers.join(", ")}`);
  } catch (error) {
    if (error instanceof Blocked) return result("blocked", error.message);
    if (error instanceof CheckFailed) return result("fail", error.message);
    return result("fail", `unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 0 when every scenario passed, 1 when any failed, 2 when none failed but some are blocked. */
export function exitCode(results: ScenarioResult[]): number {
  if (results.some((r) => r.status === "fail")) return 1;
  if (results.some((r) => r.status === "blocked")) return 2;
  return 0;
}
