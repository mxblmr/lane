import type { ClientSession, Db } from "mongodb";
import { newId, type ChallengeType } from "./schema/common";
import { collections } from "./schema/collections";
import type { Challenge } from "./schema/challenges";
import { ContractSchema, type CheckInTerms, type Contract, type ContractFields, type DoesNotCountLine } from "./schema/contracts";
import type { Rule } from "./schema/rules";
import type { AnyPack } from "./schema/pack";
import type {
  PublishContractInput,
  PublishContractResult,
  PublishForTypeInput,
  PublishForTypeResult,
} from "./interfaces";
import { services } from "./interfaces";
import { getPack, renderRuleLine } from "./packs/index";
import { inTransaction } from "./ledger";
import { CHECKIN_INTERVAL_MIN, PLAY_CREDIT_LABEL, QUIET_HOURS, SURPRISE_CHECKS_PER_DAY } from "./config";
import { windowEnd, windowStart } from "./clock";
import { writeEvent } from "./events";

/**
 * Versioned contracts (U6 approach step 5, R8, R9, KTD10, KTD15).
 *
 * A contract version is built from the pack's contract template (typed parameters only) plus one
 * "does not count" line per active rule, rendered from the rule's predicate by the pack's
 * per-feature templates, never from the rule-writer's reason or a literal string value.
 * Versions are allocated by incrementing the challenge's counter, so concurrent publishes get
 * distinct numbers. Every member gets one contract_update info item through the inbox interface.
 */

const LINE_MAX = 300;
const INSTRUCTION_MAX = 600;

function capLine(line: string): string {
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 3)}...` : line;
}

/** Check-in terms from config (R10). The grace period comes from the challenge clock. */
export function checkInTerms(challenge: Pick<Challenge, "clock">): CheckInTerms {
  return {
    interval_min: CHECKIN_INTERVAL_MIN,
    surprise_checks_per_day: SURPRISE_CHECKS_PER_DAY,
    quiet_hours: { ...QUIET_HOURS },
    grace_sec: challenge.clock?.grace_sec ?? 0,
  };
}

/** Narrow a challenge to a confirmed one, or throw: contracts exist only for confirmed challenges. */
export function confirmedParts(challenge: Challenge): {
  stake: number;
  winner_rule: NonNullable<Challenge["winner_rule"]>;
  goal: number;
  clock: NonNullable<Challenge["clock"]>;
} {
  const { stake, winner_rule, goal, clock } = challenge;
  if (stake === null || winner_rule === null || goal === null || clock === null) {
    throw new Error(`Challenge ${challenge._id} is not confirmed; it has no contract.`);
  }
  return { stake, winner_rule, goal, clock };
}

/** The structured contract fields, rendered from the pack template and typed parameters (R8). */
export function buildContractFields(challenge: Challenge, pack: AnyPack = getPack(challenge.type)): {
  fields: ContractFields;
  agent_instructions: string;
} {
  const { stake, winner_rule, goal, clock } = confirmedParts(challenge);
  const rendered = pack.contract.render({
    params: challenge.params,
    title: challenge.title,
    goal,
    stake,
    winner_rule,
    days: clock.days,
    day_length_sec: clock.day_length_sec,
  });
  const fields: ContractFields = {
    challenge_type: challenge.type,
    title: challenge.title,
    goal,
    score_unit: pack.scoreUnit,
    window: {
      start_at: windowStart(clock),
      end_at: windowEnd(clock),
      days: clock.days,
      day_length_sec: clock.day_length_sec,
    },
    stake,
    winner_rule,
    credit_label: PLAY_CREDIT_LABEL,
    checkin: checkInTerms(challenge),
    send: rendered.send.map(capLine),
    scoring: capLine(rendered.scoring),
    extra_proof: rendered.extra_proof.map(capLine),
    params: challenge.params,
  };
  return { fields, agent_instructions: rendered.agent_instructions.slice(0, 4000) };
}

/** Active rules for a challenge type, in a stable order (one indexed query, KTD7). */
export async function activeRules(db: Db, type: ChallengeType, session?: ClientSession): Promise<Rule[]> {
  return collections(db)
    .rules.find({ challenge_type: type, status: "active" }, { session })
    .sort({ rule_key: 1, version: 1 })
    .toArray();
}

/**
 * One "does not count" line per active rule, rendered only from the rule's predicate and action
 * through the pack's templates (KTD15). The rule's reason is never read here.
 */
export function renderDoesNotCount(pack: AnyPack, rules: readonly Pick<Rule, "rule_key" | "version" | "when" | "action">[]): DoesNotCountLine[] {
  return rules.map((rule) => ({
    rule_key: rule.rule_key,
    rule_version: rule.version,
    line: capLine(renderRuleLine(pack, { when: rule.when, action: rule.action })),
  }));
}

/** Lane-rendered change lines between two versions' "does not count" lists (R9). */
export function diffDoesNotCount(previous: readonly DoesNotCountLine[] | null, next: readonly DoesNotCountLine[]): string[] {
  if (!previous) return ["First version of the contract."];
  const before = new Set(previous.map((l) => l.line));
  const after = new Set(next.map((l) => l.line));
  const added = next.filter((l) => !before.has(l.line)).map((l) => capLine(`New rule: ${l.line}`));
  const removed = previous.filter((l) => !after.has(l.line)).map((l) => capLine(`Rule removed: ${l.line}`));
  const lines = [...added, ...removed];
  return lines.length > 0 ? lines : ["No change to what counts."];
}

/** The latest contract version of a challenge, or null before the first one. */
export async function latestContract(db: Db, challengeId: string, session?: ClientSession): Promise<Contract | null> {
  return collections(db).contracts.findOne({ challenge_id: challengeId }, { session, sort: { version: -1 } });
}

export interface PublishOptions {
  /** Join an outer transaction, for example U6's confirm step. */
  session?: ClientSession;
}

/**
 * Publish a new contract version for one challenge. Implements the U3 `contracts.publish`
 * interface that U9 reaches through `publishForType` on activation and rollback.
 */
export async function publishContract(
  db: Db,
  input: PublishContractInput,
  opts: PublishOptions = {},
): Promise<PublishContractResult> {
  const now = input.now ?? new Date();
  const col = collections(db);

  return inTransaction(
    db,
    async (session) => {
      // Allocate the version first: the atomic increment gives concurrent publishes distinct numbers.
      const challenge = await col.challenges.findOneAndUpdate(
        { _id: input.challenge_id },
        { $inc: { contract_version: 1 }, $set: { updated_at: now } },
        { session, returnDocument: "after" },
      );
      if (!challenge) throw new Error(`Challenge ${input.challenge_id} does not exist.`);
      const pack = getPack(challenge.type);
      const { fields, agent_instructions } = buildContractFields(challenge, pack);
      const rules = await activeRules(db, challenge.type, session);
      const doesNotCount = renderDoesNotCount(pack, rules);
      const previous = await col.contracts.findOne(
        { challenge_id: challenge._id, version: { $lt: challenge.contract_version } },
        { session, sort: { version: -1 } },
      );
      const changes = (input.changes && input.changes.length > 0
        ? input.changes
        : diffDoesNotCount(previous?.does_not_count ?? null, doesNotCount)
      ).map(capLine);

      const contract = ContractSchema.parse({
        _id: newId("contract"),
        challenge_id: challenge._id,
        version: challenge.contract_version,
        fields,
        agent_instructions,
        does_not_count: doesNotCount,
        built_from_rules: rules.map((r) => ({ rule_key: r.rule_key, version: r.version })),
        reason: input.reason.slice(0, 64),
        changes,
        created_at: now,
      } satisfies Contract);
      await col.contracts.insertOne(contract, { session });

      // One info item per member, delivered once at their next check-in (R9, R11).
      const members = await col.memberships.find({ challenge_id: challenge._id }, { session }).toArray();
      const instruction = `Contract version ${contract.version} of ${challenge.title} is live. Switch to it now. ${changes.join(" ")}`.slice(
        0,
        INSTRUCTION_MAX,
      );
      for (const member of members) {
        await services().inbox.add(
          db,
          {
            player_id: member.player_id,
            challenge_id: challenge._id,
            kind: "contract_update",
            actor: "agent",
            instruction,
            answer_tool: null,
            answer_args: {},
            day_index: null,
            subject_proof_id: null,
            slot: null,
            code: null,
            release_at: null,
            due_at: null,
          },
          { session, now },
        );
      }

      await writeEvent(
        db,
        {
          kind: "contract.published",
          summary: `${challenge.title}: contract version ${contract.version} (${contract.reason})`,
          challenge_id: challenge._id,
          challenge_type: challenge.type,
          data: { version: contract.version, rules: rules.length, members: members.length },
          at: now,
        },
        { session },
      );
      return { contract };
    },
    opts.session,
  );
}

/**
 * Publish a new contract version for every active challenge of a type. Implements the U3
 * `contracts.publishForType` interface that U9 calls on rule activation and rollback.
 */
export async function publishContractsForType(db: Db, input: PublishForTypeInput): Promise<PublishForTypeResult> {
  const challenges = await collections(db)
    .challenges.find({ type: input.challenge_type, status: "active" }, { projection: { _id: 1 } })
    .toArray();
  const contracts: PublishForTypeResult["contracts"] = [];
  for (const { _id } of challenges) {
    const { contract } = await publishContract(db, {
      challenge_id: _id,
      reason: input.reason,
      changes: input.changes,
      now: input.now,
    });
    contracts.push({ challenge_id: _id, version: contract.version });
  }
  return { contracts };
}

/** The U6 `contracts` service, for the composition root (U7). */
export const contractsService = {
  publish: (db: Db, input: PublishContractInput) => publishContract(db, input),
  publishForType: publishContractsForType,
};
