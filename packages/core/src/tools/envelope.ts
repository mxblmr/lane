import { nextCheckInAt } from "../clock";
import { PLAY_CREDIT_LABEL } from "../config";
import type { CheckInChallenge } from "../interfaces";
import type { Challenge } from "../schema/challenges";
import type { LaneError, PrimitiveMap, ToolName } from "../schema/common";
import type { Contract } from "../schema/contracts";
import type {
  Envelope,
  EnvelopeAction,
  EnvelopeChallenge,
  EnvelopeContract,
  EnvelopeStatus,
  FeedItem,
  Standing,
} from "../schema/envelope";
import { isActionKind, isInboxItemExpired, type InboxItem } from "../schema/inbox";

/**
 * The envelope builder (U7, High-Level Technical Design "Connector tool surface"). Every tool
 * returns one envelope: a status, one or two plain lines for Muse to relay, server time, the next
 * check-in time, an error with a recovery instruction or null, tool data, and a `challenges` list.
 * Only Lane-built text goes in (KTD15): contract lines, inbox instructions and lines rendered here.
 */

/** Envelope caps, from `EnvelopeSchema`. */
export const MAX_LINES = 3;
export const MAX_LINE_CHARS = 400;
const MAX_INSTRUCTION_CHARS = 600;
const MAX_AGENT_INSTRUCTIONS_CHARS = 4000;

/** "50 play credits (no real money)". Every credit amount in a tool line goes through here (R7). */
export function formatCredits(amount: number): string {
  const n = Math.trunc(amount);
  if (n === 1) return `1 ${PLAY_CREDIT_LABEL.replace(/^play credits/, "play credit")}`;
  return `${n.toLocaleString("en-US")} ${PLAY_CREDIT_LABEL}`;
}

export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Deep copy with Dates as ISO strings, so `data` is plain JSON on every face. */
export function toJsonData(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * An inbox action item as an envelope action. Items without an answering tool are answered by
 * `lane_submit_proof` with the item id as `request_id` (extra proof, surprise check, bind code).
 */
export function envelopeAction(item: InboxItem): EnvelopeAction {
  const tool: ToolName = item.answer_tool ?? "lane_submit_proof";
  const args: PrimitiveMap =
    tool === "lane_submit_proof"
      ? {
          ...(item.challenge_id ? { challenge_id: item.challenge_id } : {}),
          request_id: item._id,
          ...item.answer_args,
        }
      : { ...item.answer_args };
  return {
    id: item._id,
    challenge_id: item.challenge_id,
    kind: item.kind,
    actor: item.actor,
    instruction: cap(item.instruction, MAX_INSTRUCTION_CHARS),
    due_at: iso(item.due_at),
    tool,
    args,
  };
}

export function envelopeContract(contract: Contract): EnvelopeContract {
  return {
    version: contract.version,
    agent_instructions: cap(contract.agent_instructions, MAX_AGENT_INSTRUCTIONS_CHARS),
    send: [...contract.fields.send],
    does_not_count: contract.does_not_count.map((l) => l.line),
    changes: [...contract.changes],
  };
}

export interface EnvelopeChallengeInput {
  challenge: Challenge;
  day_index: number | null;
  /** Set when the player has not seen this contract version yet (R9). */
  contract: Contract | null;
  contract_changed: boolean;
  actions?: InboxItem[];
  info?: InboxItem[];
  standings?: Standing[];
  feed?: FeedItem[];
  now: Date;
}

/** One entry of the `challenges` list. Expired action items are dropped (KTD13 read rule). */
export function envelopeChallenge(input: EnvelopeChallengeInput): EnvelopeChallenge {
  const { challenge, now } = input;
  const actions = (input.actions ?? [])
    .filter((item) => isActionKind(item.kind) && !isInboxItemExpired(item, now))
    .map(envelopeAction);
  const messages = (input.info ?? []).map((item) => cap(item.instruction, MAX_INSTRUCTION_CHARS));
  const contract = input.contract ? envelopeContract(input.contract) : null;
  return {
    challenge_id: challenge._id,
    type: challenge.type,
    title: challenge.title,
    status: challenge.status,
    day_index: input.day_index,
    contract_version: Math.max(challenge.contract_version, contract?.version ?? 0),
    contract_changed: input.contract_changed && contract !== null,
    contract,
    actions,
    messages,
    standings: input.standings ?? [],
    feed: input.feed ?? [],
  };
}

/** A check-in challenge (U18 domain data) as an envelope challenge. */
export function checkInChallenge(c: CheckInChallenge, now: Date): EnvelopeChallenge {
  return envelopeChallenge({
    challenge: c.challenge,
    day_index: c.day_index,
    contract: c.contract,
    contract_changed: c.contract_changed,
    actions: c.actions,
    info: c.info,
    standings: c.standings,
    feed: c.feed,
    now,
  });
}

export interface BuildEnvelopeInput {
  now: Date;
  status?: EnvelopeStatus;
  /** Plain lines for Muse to relay. Capped at three lines of 400 characters. */
  lines: string[];
  data?: Record<string, unknown> | null;
  challenges?: EnvelopeChallenge[];
  /** Defaults to one routine interval from now (R10). Pass null for no check-in time. */
  next_check_in_at?: Date | null;
}

export function buildEnvelope(input: BuildEnvelopeInput): Envelope {
  const next = input.next_check_in_at === undefined ? nextCheckInAt(input.now) : input.next_check_in_at;
  return {
    status: input.status ?? "ok",
    lines: input.lines
      .filter((line) => line.trim().length > 0)
      .slice(0, MAX_LINES)
      .map((line) => cap(line, MAX_LINE_CHARS)),
    server_time: input.now.toISOString(),
    next_check_in_at: iso(next),
    error: null,
    data: input.data ? toJsonData(input.data) : null,
    challenges: input.challenges ?? [],
  };
}

/** Errors come back as results with a recovery instruction, never as protocol errors. */
export function errorEnvelope(error: LaneError, now: Date): Envelope {
  return {
    status: "error",
    lines: [cap(error.message, MAX_LINE_CHARS)],
    server_time: now.toISOString(),
    next_check_in_at: null,
    error: { code: error.code, recovery: cap(error.recovery, MAX_LINE_CHARS) },
    data: null,
    challenges: [],
  };
}
