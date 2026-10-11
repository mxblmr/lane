import type { Db } from "mongodb";
import { fail, newId, type ChallengeType, type Features, type Id, type Outcome } from "../schema/common";
import { collections, isDuplicateKeyError } from "../schema/collections";
import { LabelledExampleSchema, type Example, type ExampleSource } from "../schema/examples";
import type { RedTeamExample } from "../schema/agents";
import type { Rule } from "../schema/rules";
import type { AnyPack } from "../schema/pack";
import { allPacks, getPack } from "../packs/index";

/**
 * Labelled examples and seed rules (U9 approach step 1, R31, KTD9).
 *
 * - Each pack's seed examples and seed rules load into MongoDB idempotently, so a pack that
 *   merges later is picked up on the next cold start (`ensurePackSeeds`).
 * - Honest examples come only from seed data. The red team, live cheats and disputes add
 *   only cheat examples, so nothing outside the seed can make a candidate look safer.
 */

export interface SeedLoadResult {
  challenge_type: ChallengeType;
  examples_added: number;
  rules_added: number;
}

/** Load one pack's seed examples and seed rules. Existing documents are never changed. */
export async function loadPackSeeds(db: Db, pack: AnyPack, opts: { now?: Date } = {}): Promise<SeedLoadResult> {
  const now = opts.now ?? new Date();
  const col = collections(db);
  let examplesAdded = 0;
  let rulesAdded = 0;

  for (const raw of pack.examples) {
    const ex = LabelledExampleSchema.parse(raw);
    const doc: Example = {
      _id: newId("example"),
      challenge_type: pack.type,
      example_key: ex.example_key,
      label: ex.label,
      cheat_class: ex.cheat_class,
      features: ex.features,
      source: "seed",
      summary: ex.summary,
      proof_id: null,
      created_at: now,
    };
    if (await upsertOnce(() => col.examples.updateOne(
      { challenge_type: pack.type, example_key: ex.example_key },
      { $setOnInsert: doc },
      { upsert: true },
    ))) {
      examplesAdded += 1;
    }
  }

  for (const seed of pack.seedRules) {
    const doc: Rule = {
      _id: newId("rule"),
      rule_key: seed.rule_key,
      version: 1,
      parent_version: null,
      challenge_type: pack.type,
      when: seed.when,
      action: seed.action,
      cheat_class: seed.cheat_class,
      reason: seed.reason.slice(0, 500),
      source: "seed",
      evidence: { proof_ids: [], example_keys: [], dispute_ids: [] },
      status: "active",
      test_results: null,
      approval_id: null,
      created_at: now,
      updated_at: now,
      activated_at: now,
      retired_at: null,
    };
    if (await upsertOnce(() => col.rules.updateOne(
      { challenge_type: pack.type, rule_key: seed.rule_key, version: 1 },
      { $setOnInsert: doc },
      { upsert: true },
    ))) {
      rulesAdded += 1;
    }
  }

  return { challenge_type: pack.type, examples_added: examplesAdded, rules_added: rulesAdded };
}

/** True when the upsert inserted. A concurrent loader's insert counts as already there. */
async function upsertOnce(run: () => Promise<{ upsertedCount: number }>): Promise<boolean> {
  try {
    return (await run()).upsertedCount === 1;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

/** Load every registered pack's seeds. */
export async function loadAllPackSeeds(db: Db, opts: { now?: Date } = {}): Promise<SeedLoadResult[]> {
  const results: SeedLoadResult[] = [];
  for (const pack of allPacks()) results.push(await loadPackSeeds(db, pack, opts));
  return results;
}

const seeded = new WeakMap<Db, Promise<void>>();

/** Load every pack's seeds once per process and database. Safe to call on every request. */
export function ensurePackSeeds(db: Db): Promise<void> {
  let pending = seeded.get(db);
  if (!pending) {
    pending = loadAllPackSeeds(db)
      .then(() => undefined)
      .catch((err: unknown) => {
        seeded.delete(db);
        throw err;
      });
    seeded.set(db, pending);
  }
  return pending;
}

export interface AddExamplesResult {
  added: string[];
  duplicates: string[];
}

/**
 * Add red-team cheat examples (rule-lab's examples endpoint, and the no-egress path where the
 * red team returns its examples as its result). Only cheats; the cheat class must be one of the
 * pack's classes.
 */
export async function addRedTeamExamples(
  db: Db,
  input: { challenge_type: ChallengeType; examples: RedTeamExample[] },
  opts: { now?: Date; pack?: AnyPack } = {},
): Promise<Outcome<AddExamplesResult>> {
  const pack = opts.pack ?? getPack(input.challenge_type);
  const unknown = input.examples.filter((e) => !pack.cheatClasses.includes(e.cheat_class)).map((e) => e.cheat_class);
  if (unknown.length > 0) {
    return fail(
      "invalid_input",
      `Unknown cheat class for ${pack.type}: ${[...new Set(unknown)].join(", ")}`.slice(0, 300),
      `Use one of: ${pack.cheatClasses.join(", ")}`.slice(0, 300),
    );
  }
  const added: string[] = [];
  const duplicates: string[] = [];
  for (const ex of input.examples) {
    const created = await insertCheatExample(db, {
      challenge_type: input.challenge_type,
      example_key: ex.example_key,
      cheat_class: ex.cheat_class,
      features: ex.features,
      source: "red_team",
      summary: ex.summary,
      proof_id: null,
      now: opts.now,
    });
    (created ? added : duplicates).push(ex.example_key);
  }
  return { ok: true, added, duplicates };
}

export interface CheatExampleInput {
  challenge_type: ChallengeType;
  example_key: string;
  cheat_class: string;
  features: Features;
  source: Exclude<ExampleSource, "seed">;
  summary: string | null;
  proof_id: Id | null;
  now?: Date;
}

/** Insert one cheat example. False when the key already exists for the type. */
export async function insertCheatExample(db: Db, input: CheatExampleInput): Promise<boolean> {
  const doc: Example = {
    _id: newId("example"),
    challenge_type: input.challenge_type,
    example_key: input.example_key,
    label: "cheat",
    cheat_class: input.cheat_class,
    features: input.features,
    source: input.source,
    summary: input.summary?.slice(0, 200) ?? null,
    proof_id: input.proof_id,
    created_at: input.now ?? new Date(),
  };
  return upsertOnce(() =>
    collections(db).examples.updateOne(
      { challenge_type: input.challenge_type, example_key: input.example_key },
      { $setOnInsert: doc },
      { upsert: true },
    ),
  );
}

/** Example key for a proof marked as a live cheat or upheld in a dispute. */
export function proofExampleKey(source: "live" | "dispute", proofId: Id): string {
  return `${source}-${proofId}`.slice(0, 80);
}

/** Every example for a challenge type, as the gate reads them. */
export async function listExamples(db: Db, challengeType: ChallengeType): Promise<Example[]> {
  return collections(db).examples.find({ challenge_type: challengeType }).sort({ example_key: 1 }).toArray();
}
