import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { appendLedgerEntry, inTransaction, ledgerBalanceOf, potOf } from "../src/ledger";
import { collections } from "../src/schema/collections";
import type { Player } from "../src/schema/players";
import { startReplSet, type TestMongo } from "../src/testing/mongo";

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startReplSet();
});
afterAll(async () => {
  await mongo?.stop();
});

const NOW = new Date("2026-10-11T20:00:00.000Z");

async function seedPlayer(db: Db, id: string): Promise<void> {
  const player: Player = {
    _id: id,
    display_name: id,
    time_zone: "America/Los_Angeles",
    key_hash: createHash("sha256").update(id).digest("hex"),
    routine_text: "routine",
    handles: {},
    credits: 0,
    scripted: false,
    created_at: NOW,
    updated_at: NOW,
  };
  await collections(db).players.insertOne(player);
}

async function credits(db: Db, id: string): Promise<number | undefined> {
  return (await collections(db).players.findOne({ _id: id }))?.credits;
}

describe("ledger function (KTD12)", () => {
  it("grants credits and records the balance after", async () => {
    const db = await mongo.freshDb();
    await seedPlayer(db, "maya");
    const res = await appendLedgerEntry(db, { player_id: "maya", challenge_id: null, kind: "grant", amount: 1000 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.delta).toBe(1000);
    expect(res.entry.balance_after).toBe(1000);
    expect(await credits(db, "maya")).toBe(1000);
  });

  it("refuses a debit larger than the player's balance and writes nothing", async () => {
    const db = await mongo.freshDb();
    await seedPlayer(db, "sam");
    await appendLedgerEntry(db, { player_id: "sam", challenge_id: null, kind: "grant", amount: 100 });
    const before = await collections(db).ledger.countDocuments();

    const res = await appendLedgerEntry(db, { player_id: "sam", challenge_id: "chl_1", kind: "stake", amount: 101 });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("insufficient_credits");
    expect(res.error.recovery).toBeTruthy();
    expect(await credits(db, "sam")).toBe(100);
    expect(await collections(db).ledger.countDocuments()).toBe(before);
    expect(await collections(db).ledger.countDocuments({ kind: "stake" })).toBe(0);
  });

  it("debits a stake once, and a repeated stake returns the existing entry without a second debit", async () => {
    const db = await mongo.freshDb();
    await seedPlayer(db, "priya");
    await appendLedgerEntry(db, { player_id: "priya", challenge_id: null, kind: "grant", amount: 1000 });

    const first = await appendLedgerEntry(db, { player_id: "priya", challenge_id: "chl_1", kind: "stake", amount: 100 });
    const second = await appendLedgerEntry(db, { player_id: "priya", challenge_id: "chl_1", kind: "stake", amount: 100 });

    expect(first.ok && !first.duplicate).toBe(true);
    expect(second.ok && second.duplicate).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.entry._id).toBe(first.entry._id);
    expect(await credits(db, "priya")).toBe(900);
  });

  it("gives one entry and one debit for concurrent duplicate stakes", async () => {
    const db = await mongo.freshDb();
    await seedPlayer(db, "gary");
    await appendLedgerEntry(db, { player_id: "gary", challenge_id: null, kind: "grant", amount: 1000 });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        appendLedgerEntry(db, { player_id: "gary", challenge_id: "chl_2", kind: "stake", amount: 100 }),
      ),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
    expect(await collections(db).ledger.countDocuments({ kind: "stake", player_id: "gary" })).toBe(1);
    expect(await credits(db, "gary")).toBe(900);
  });

  it("keeps each balance equal to the sum of the player's ledger entries, and the pot equal to the stakes", async () => {
    const db = await mongo.freshDb();
    await seedPlayer(db, "maya");
    await seedPlayer(db, "sam");
    for (const p of ["maya", "sam"]) {
      await appendLedgerEntry(db, { player_id: p, challenge_id: null, kind: "grant", amount: 1000 });
      await appendLedgerEntry(db, { player_id: p, challenge_id: "chl_3", kind: "stake", amount: 200 });
    }
    await appendLedgerEntry(db, { player_id: "maya", challenge_id: "chl_3", kind: "payout", amount: 400, ref: "snp_1" });

    expect(await potOf(db, "chl_3")).toBe(400);
    expect(await ledgerBalanceOf(db, "maya")).toBe(await credits(db, "maya"));
    expect(await ledgerBalanceOf(db, "sam")).toBe(await credits(db, "sam"));
    expect(await credits(db, "maya")).toBe(1200);
    expect(await credits(db, "sam")).toBe(800);
  });

  it("joins an outer transaction, and an aborted outer transaction leaves nothing behind", async () => {
    const db = await mongo.freshDb();
    await seedPlayer(db, "maya");
    await appendLedgerEntry(db, { player_id: "maya", challenge_id: null, kind: "grant", amount: 500 });

    await expect(
      inTransaction(db, async (session) => {
        const res = await appendLedgerEntry(
          db,
          { player_id: "maya", challenge_id: "chl_4", kind: "stake", amount: 100 },
          { session },
        );
        expect(res.ok).toBe(true);
        throw new Error("abort the join");
      }),
    ).rejects.toThrow("abort the join");

    expect(await credits(db, "maya")).toBe(500);
    expect(await collections(db).ledger.countDocuments({ kind: "stake" })).toBe(0);
  });

  it("rejects malformed entries before touching the database", async () => {
    const db = await mongo.freshDb();
    await seedPlayer(db, "maya");
    const grantWithChallenge = await appendLedgerEntry(db, { player_id: "maya", challenge_id: "chl_1", kind: "grant", amount: 10 });
    const stakeWithoutChallenge = await appendLedgerEntry(db, { player_id: "maya", challenge_id: null, kind: "stake", amount: 10 });
    const fractional = await appendLedgerEntry(db, { player_id: "maya", challenge_id: null, kind: "grant", amount: 1.5 });
    const unknownPlayer = await appendLedgerEntry(db, { player_id: "nobody", challenge_id: null, kind: "grant", amount: 10 });
    expect(grantWithChallenge.ok || stakeWithoutChallenge.ok || fractional.ok || unknownPlayer.ok).toBe(false);
    if (!unknownPlayer.ok) expect(unknownPlayer.error.code).toBe("not_found");
    expect(await collections(db).ledger.countDocuments()).toBe(0);
  });
});
