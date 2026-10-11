import { describe, expect, it } from "vitest";
import { PLAY_CREDIT_LABEL } from "../../src/config";
import { EnvelopeSchema } from "../../src/schema/envelope";
import {
  MAX_LINES,
  MAX_LINE_CHARS,
  buildEnvelope,
  checkInChallenge,
  envelopeAction,
  envelopeChallenge,
  errorEnvelope,
  formatCredits,
} from "../../src/tools/envelope";
import {
  T0,
  ae8CheckInChallenge,
  fakeChallenge,
  fakeContract,
  fakeInboxItem,
  fakePlayer,
} from "../../src/testing/tools";

describe("formatCredits (R7)", () => {
  it("labels every amount as play credits with no real money", () => {
    expect(formatCredits(50)).toBe(`50 ${PLAY_CREDIT_LABEL}`);
    expect(formatCredits(1000)).toBe("1,000 play credits (no real money)");
    expect(formatCredits(1)).toBe("1 play credit (no real money)");
  });
});

describe("envelopeAction", () => {
  it("defaults to lane_submit_proof with the item id as request_id", () => {
    const player = fakePlayer();
    const item = fakeInboxItem({ player_id: player._id, challenge_id: "chl_a" });
    const action = envelopeAction(item);
    expect(action).toMatchObject({
      id: item._id,
      challenge_id: "chl_a",
      kind: "extra_proof",
      actor: "player",
      tool: "lane_submit_proof",
      args: { challenge_id: "chl_a", request_id: item._id },
      due_at: item.due_at!.toISOString(),
    });
  });

  it("keeps the answering tool and fixed arguments the inbox item names", () => {
    const item = fakeInboxItem({
      player_id: "plr_1",
      actor: "agent",
      kind: "refetch",
      answer_tool: "lane_submit_proof",
      answer_args: { challenge_id: "chl_b", request_id: "inb_fixed", platform: "x" },
    });
    expect(envelopeAction(item).args).toEqual({ challenge_id: "chl_b", request_id: "inb_fixed", platform: "x" });
  });
});

describe("envelopeChallenge", () => {
  it("drops action items already past their due time (KTD13) and keeps info items as messages", () => {
    const player = fakePlayer();
    const challenge = fakeChallenge();
    const live = fakeInboxItem({ player_id: player._id, challenge_id: challenge._id });
    const expired = fakeInboxItem({ player_id: player._id, challenge_id: challenge._id, due_at: new Date(T0.getTime() - 1) });
    const info = fakeInboxItem({ player_id: player._id, kind: "verdict", actor: "agent", instruction: "Day 1 counted." });
    const c = envelopeChallenge({
      challenge,
      day_index: 0,
      contract: null,
      contract_changed: false,
      actions: [live, expired],
      info: [info],
      now: T0,
    });
    expect(c.actions.map((a) => a.id)).toEqual([live._id]);
    expect(c.messages).toEqual(["Day 1 counted."]);
    expect(c.contract).toBeNull();
    expect(c.contract_changed).toBe(false);
  });

  it("carries the contract only when it changed, with its does-not-count lines", () => {
    const challenge = fakeChallenge({ contract_version: 2 });
    const c = envelopeChallenge({ challenge, day_index: 1, contract: fakeContract(challenge, 2), contract_changed: true, now: T0 });
    expect(c.contract_version).toBe(2);
    expect(c.contract_changed).toBe(true);
    expect(c.contract?.version).toBe(2);
    expect(c.contract?.does_not_count).toEqual(["A proof where the commit only renames does not count."]);
    expect(c.contract?.changes).toEqual(["Rename-only commits no longer count."]);
  });
});

describe("buildEnvelope", () => {
  it("validates against the U3 envelope schema with server time and next check-in", () => {
    const env = buildEnvelope({ now: T0, lines: ["Hello."], data: { at: T0 } });
    expect(EnvelopeSchema.parse(env)).toEqual(env);
    expect(env.server_time).toBe(T0.toISOString());
    expect(env.next_check_in_at).toBe(new Date(T0.getTime() + 27 * 60_000).toISOString());
    expect(env.data).toEqual({ at: T0.toISOString() });
    expect(env.error).toBeNull();
  });

  it("caps lines at three of 400 characters and drops blank ones", () => {
    const env = buildEnvelope({ now: T0, lines: ["", "a".repeat(900), "b", "c", "d"] });
    expect(env.lines).toHaveLength(MAX_LINES);
    expect(env.lines[0]).toHaveLength(MAX_LINE_CHARS);
    expect(env.lines.slice(1)).toEqual(["b", "c"]);
    expect(EnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("returns errors as results with a recovery instruction", () => {
    const env = errorEnvelope(
      { code: "unauthenticated", message: "Lane needs the player key.", recovery: "Send the key from lane_register." },
      T0,
    );
    expect(EnvelopeSchema.parse(env)).toEqual(env);
    expect(env.status).toBe("error");
    expect(env.error).toEqual({ code: "unauthenticated", recovery: "Send the key from lane_register." });
    expect(env.lines).toEqual(["Lane needs the player key."]);
  });
});

describe("check-in envelope (AE8)", () => {
  it("puts a player in two challenges into one envelope with both challenges", () => {
    const player = fakePlayer();
    const first = ae8CheckInChallenge(player);
    const second = ae8CheckInChallenge(player, fakeChallenge({ type: "customers", title: "Talk to Customers", contract_version: 1 }));
    second.actions = [];
    second.contract = null;
    second.contract_changed = false;

    const env = buildEnvelope({
      now: T0,
      lines: ["Lane has 1 request to relay to the player."],
      challenges: [checkInChallenge(first, T0), checkInChallenge(second, T0)],
    });

    expect(EnvelopeSchema.parse(env)).toEqual(env);
    expect(env.challenges.map((c) => c.challenge_id)).toEqual([first.challenge._id, second.challenge._id]);
    const [a, b] = env.challenges;
    // The code request is marked for the player to do, not the agent.
    expect(a!.actions).toHaveLength(1);
    expect(a!.actions[0]).toMatchObject({ kind: "extra_proof", actor: "player", tool: "lane_submit_proof" });
    expect(a!.actions[0]!.instruction).toMatch(/4821/);
    // Standing and the new contract version arrive in the same response.
    expect(a!.standings[0]).toMatchObject({ player_id: player._id, is_you: true, score: 2 });
    expect(a!.contract_changed).toBe(true);
    expect(a!.contract?.version).toBe(2);
    expect(a!.messages).toEqual(["Maya is first with 2 verified days."]);
    expect(b!.actions).toEqual([]);
    expect(b!.contract_changed).toBe(false);
  });
});
