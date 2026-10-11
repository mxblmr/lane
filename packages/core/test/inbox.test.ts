import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addInboxItem, deliverInfoItems, expireInboxItems, listOpenActions, releaseDueInboxItems, resolveInboxItem } from "../src/inbox";
import { demoClockSettings, manualClock } from "../src/clock";
import { collections } from "../src/schema/collections";
import { startReplSet, type TestMongo } from "../src/testing/mongo";
import {
  extraProofItem,
  infoItem,
  seedChallenge,
  seedMembership,
  seedPlayer,
  seedProof,
  surpriseCheckItem,
} from "./helpers/u18-seed";

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startReplSet();
});
afterAll(async () => {
  await mongo?.stop();
});

const START = new Date("2026-10-11T20:00:00.000Z");
const at = (sec: number) => new Date(START.getTime() + sec * 1000);

async function world() {
  const db = await mongo.freshDb();
  const clock = demoClockSettings(START, { day_length_sec: 300, days: 3, grace_sec: 90 });
  const gary = await seedPlayer(db, "Gary");
  const priya = await seedPlayer(db, "Priya");
  const challenge = await seedChallenge(db, { creator: gary, clock, type: "customers", title: "Talk to Customers" });
  await seedMembership(db, challenge, gary);
  await seedMembership(db, challenge, priya);
  const garyProof = await seedProof(db, { challenge, player: gary, day_index: 0, status: "held", held_reason: "extra_proof" });
  return { db, clock, gary, priya, challenge, garyProof };
}

describe("inbox add (KTD6)", () => {
  it("keeps at most one open extra-proof request per proof, and a second request only adds watchers", async () => {
    const { db, gary, priya, challenge, garyProof } = await world();
    const first = await addInboxItem(
      db,
      extraProofItem({ player_id: gary._id, challenge_id: challenge._id, proof_id: garyProof._id, due_at: at(200) }),
      { now: at(10) },
    );
    expect(first.created).toBe(true);
    // A dispute on the same proof adds the disputer for notification only.
    const second = await addInboxItem(
      db,
      extraProofItem({ player_id: gary._id, challenge_id: challenge._id, proof_id: garyProof._id, due_at: at(250), notify: [priya._id] }),
      { now: at(20) },
    );
    expect(second.created).toBe(false);
    expect(second.item._id).toBe(first.item._id);
    expect(second.item.notify_player_ids).toEqual([priya._id]);
    expect(second.item.due_at).toEqual(at(200));
    expect(await collections(db).inbox.countDocuments({ kind: "extra_proof" })).toBe(1);
  });

  it("two concurrent extra-proof requests for one proof store one item", async () => {
    const { db, gary, challenge, garyProof } = await world();
    const item = extraProofItem({ player_id: gary._id, challenge_id: challenge._id, proof_id: garyProof._id, due_at: at(200) });
    const results = await Promise.all([1, 2, 3].map(() => addInboxItem(db, item, { now: at(10) })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.item._id)).size).toBe(1);
    expect(await collections(db).inbox.countDocuments({ kind: "extra_proof" })).toBe(1);
  });

  it("stores one surprise check per player, day and slot", async () => {
    const { db, gary, challenge } = await world();
    const check = surpriseCheckItem({ player_id: gary._id, challenge_id: challenge._id, day_index: 1, slot: 0, release_at: at(360), due_at: at(450) });
    const a = await addInboxItem(db, check, { now: at(10) });
    const b = await addInboxItem(db, check, { now: at(11) });
    expect(a.created).toBe(true);
    expect(a.item.status).toBe("scheduled");
    expect(b.created).toBe(false);
    expect(await collections(db).inbox.countDocuments({ kind: "surprise_check" })).toBe(1);
  });

  it("refuses an extra-proof item without a subject proof", async () => {
    const { db, gary, challenge } = await world();
    const bad = { ...extraProofItem({ player_id: gary._id, challenge_id: challenge._id, proof_id: "x", due_at: at(200) }), subject_proof_id: null };
    await expect(addInboxItem(db, bad, { now: at(10) })).rejects.toThrow(/subject_proof_id/);
  });
});

describe("inbox add inside a caller's transaction (U6 confirm, join and publish)", () => {
  it("writes through the session: committed adds persist, aborted adds leave nothing", async () => {
    const { db, gary, challenge } = await world();
    const kept = infoItem(gary._id, challenge._id, "contract_update", "Contract version 2 is live.");
    await mongo.client.withSession((session) =>
      session.withTransaction(async () => {
        const res = await addInboxItem(db, kept, { session, now: at(10) });
        expect(res.created).toBe(true);
      }),
    );
    expect(await collections(db).inbox.countDocuments({ kind: "contract_update" })).toBe(1);

    const dropped = infoItem(gary._id, challenge._id, "message", "This add is rolled back.");
    const session = mongo.client.startSession();
    try {
      session.startTransaction();
      await addInboxItem(db, dropped, { session, now: at(11) });
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }
    expect(await collections(db).inbox.countDocuments({ kind: "message" })).toBe(0);
  });

  it("a repeat inside a transaction returns the open item without aborting it", async () => {
    const { db, gary, priya, challenge, garyProof } = await world();
    const first = await addInboxItem(
      db,
      extraProofItem({ player_id: gary._id, challenge_id: challenge._id, proof_id: garyProof._id, due_at: at(200) }),
      { now: at(10) },
    );
    const check = surpriseCheckItem({ player_id: gary._id, challenge_id: challenge._id, day_index: 1, slot: 0, release_at: at(360), due_at: at(450) });
    await addInboxItem(db, check, { now: at(10) });
    await mongo.client.withSession((session) =>
      session.withTransaction(async () => {
        const again = await addInboxItem(
          db,
          extraProofItem({ player_id: gary._id, challenge_id: challenge._id, proof_id: garyProof._id, due_at: at(300), notify: [priya._id] }),
          { session, now: at(20) },
        );
        expect(again.created).toBe(false);
        expect(again.item._id).toBe(first.item._id);
        expect((await addInboxItem(db, check, { session, now: at(20) })).created).toBe(false);
      }),
    );
    const stored = await collections(db).inbox.findOne({ _id: first.item._id });
    expect(stored?.notify_player_ids).toEqual([priya._id]);
    expect(await collections(db).inbox.countDocuments()).toBe(2);
  });

  it("expire by item id closes a not-yet-due bind request at once (U6 rebind)", async () => {
    const { db, gary } = await world();
    const { item } = await addInboxItem(
      db,
      {
        player_id: gary._id,
        challenge_id: null,
        kind: "bind_code",
        actor: "player",
        instruction: "Put the code 7391 in your GitHub bio.",
        answer_tool: "lane_submit_proof",
        answer_args: {},
        day_index: null,
        subject_proof_id: null,
        slot: null,
        code: "7391",
        release_at: null,
        due_at: at(5000),
      },
      { now: at(10) },
    );
    const { expired } = await expireInboxItems(db, { now: at(20), item_ids: [item._id] });
    expect(expired.map((i) => i._id)).toEqual([item._id]);
    expect((await collections(db).inbox.findOne({ _id: item._id }))?.status).toBe("expired");
  });
});

describe("inbox resolve", () => {
  it("only the player who owns the subject proof can answer, and Priya answering Gary's request changes nothing", async () => {
    const { db, gary, priya, challenge, garyProof } = await world();
    const { item } = await addInboxItem(
      db,
      extraProofItem({ player_id: gary._id, challenge_id: challenge._id, proof_id: garyProof._id, due_at: at(200) }),
      { now: at(10) },
    );
    const refused = await resolveInboxItem(db, { item_id: item._id, by_player_id: priya._id, now: at(50) });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("not_allowed");
    expect((await collections(db).inbox.findOne({ _id: item._id }))?.status).toBe("open");

    const done = await resolveInboxItem(db, { item_id: item._id, by_player_id: gary._id, answer_proof_id: "prf_answer", now: at(60) });
    expect(done.ok && done.resolved).toBe(true);
    if (done.ok) expect(done.item.answer_proof_id).toBe("prf_answer");
    const again = await resolveInboxItem(db, { item_id: item._id, by_player_id: gary._id, now: at(61) });
    expect(again.ok && again.resolved).toBe(false);
  });

  it("refuses an answer after the due time even before the tick expires the item", async () => {
    const { db, gary, challenge, garyProof } = await world();
    const { item } = await addInboxItem(
      db,
      extraProofItem({ player_id: gary._id, challenge_id: challenge._id, proof_id: garyProof._id, due_at: at(200) }),
      { now: at(10) },
    );
    const late = await resolveInboxItem(db, { item_id: item._id, by_player_id: gary._id, now: at(200) });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe("grace_closed");
    expect((await collections(db).inbox.findOne({ _id: item._id }))?.status).toBe("open");
  });

  it("tells watchers the outcome in Lane's own words", async () => {
    const { db, gary, priya, challenge, garyProof } = await world();
    const { item } = await addInboxItem(
      db,
      extraProofItem({ player_id: gary._id, challenge_id: challenge._id, proof_id: garyProof._id, due_at: at(200), notify: [priya._id] }),
      { now: at(10) },
    );
    await resolveInboxItem(db, { item_id: item._id, by_player_id: gary._id, now: at(60) });
    const notices = await deliverInfoItems(db, priya._id, challenge._id, at(61));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe("dispute_notice");
    expect(notices[0]!.instruction).not.toContain("4821");
  });
});

describe("inbox expire and release", () => {
  it("expires only open items past due, once, even with concurrent callers", async () => {
    const { db, gary, challenge, garyProof } = await world();
    await addInboxItem(db, extraProofItem({ player_id: gary._id, challenge_id: challenge._id, proof_id: garyProof._id, due_at: at(200) }), { now: at(10) });
    expect((await expireInboxItems(db, { now: at(199) })).expired).toHaveLength(0);
    const runs = await Promise.all([1, 2, 3].map(() => expireInboxItems(db, { now: at(201) })));
    expect(runs.flatMap((r) => r.expired)).toHaveLength(1);
  });

  it("with a challenge id, expires every open or scheduled action item at once (reset)", async () => {
    const { db, gary, challenge, garyProof } = await world();
    await addInboxItem(db, extraProofItem({ player_id: gary._id, challenge_id: challenge._id, proof_id: garyProof._id, due_at: at(200) }), { now: at(10) });
    await addInboxItem(db, surpriseCheckItem({ player_id: gary._id, challenge_id: challenge._id, day_index: 1, slot: 0, release_at: at(360), due_at: at(450) }), { now: at(10) });
    const { expired } = await expireInboxItems(db, { now: at(20), challenge_id: challenge._id });
    expect(expired).toHaveLength(2);
  });

  it("releases scheduled items when due, and lists only live actions", async () => {
    const { db, gary, challenge } = await world();
    const clock = manualClock(at(10));
    await addInboxItem(db, surpriseCheckItem({ player_id: gary._id, challenge_id: challenge._id, day_index: 1, slot: 0, release_at: at(360), due_at: at(450) }), { now: clock.now() });
    expect(await listOpenActions(db, gary._id, challenge._id, clock.now())).toHaveLength(0);
    clock.set(at(359));
    expect((await releaseDueInboxItems(db, clock.now())).released).toHaveLength(0);
    clock.set(at(361));
    expect((await releaseDueInboxItems(db, clock.now())).released).toHaveLength(1);
    expect(await listOpenActions(db, gary._id, challenge._id, clock.now())).toHaveLength(1);
    clock.set(at(450));
    expect(await listOpenActions(db, gary._id, challenge._id, clock.now())).toHaveLength(0);
  });

  it("delivers an info item once across concurrent check-ins", async () => {
    const { db, gary, challenge } = await world();
    await addInboxItem(db, infoItem(gary._id, challenge._id, "message", "Your proof for day 1 was accepted."), { now: at(10) });
    const runs = await Promise.all([1, 2, 3].map(() => deliverInfoItems(db, gary._id, challenge._id, at(20))));
    expect(runs.flat()).toHaveLength(1);
  });
});
