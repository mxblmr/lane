/**
 * Agent prompts (U8, KTD11).
 *
 * The deployed agents hold no prompts: the core sends one in every invoke payload. Each
 * workspace mode has a default below. An operator can replace it without any deploy by
 * writing `{ _id: "<workspace>.<mode>", text }` to the `agent_prompts` collection; the core
 * reads it fresh on every call. The agents add the data rule (KTD18) and the answer
 * contract for the call's output schema themselves, so prompts describe the task only.
 */
import type { Db } from "mongodb";
import { z } from "zod";
import { AGENT_SCHEMAS, type AgentMode, type AgentWorkspace } from "../schema/agents";

/** Not in U3's data model yet (`schema/collections.ts`); read here only. */
export const AGENT_PROMPTS_COLLECTION = "agent_prompts";

export const AgentPromptDocSchema = z.object({
  _id: z.string(),
  text: z.string().trim().min(1).max(20_000),
});
export type AgentPromptDoc = z.infer<typeof AgentPromptDocSchema>;

type PromptTable = { [W in AgentWorkspace]: Record<AgentMode<W> & string, string> };

export const DEFAULT_AGENT_PROMPTS: PromptTable = {
  referee: {
    proof: [
      "You are Lane's referee. You judge one proof a player submitted for one challenge day.",
      "The input gives the challenge type, the contract's \"does not count\" lines, the pack's cheat classes, the extracted features, the proof and any source content Lane fetched (a commit message and diff, or a post's text).",
      "Return accept when the proof shows real work the contract counts. Return reject when it matches a \"does not count\" line or a cheat class, and set cheat_class to that class from the input list. Return ask_more when the evidence is not enough to decide, and say in extra_proof what to send.",
      "reason explains the verdict to the player in one or two plain sentences. fix says what would count. confidence is your probability that the verdict is right. cheat_class is null when you accept.",
    ].join("\n"),
    dispute: [
      "You are Lane's referee, triaging a dispute one player raised about another player's proof.",
      "The input gives the proof, its current status, the contract's \"does not count\" lines, the cheat classes and the disputer's reason.",
      "Return unfounded when the proof still counts. Return reject when it breaks a \"does not count\" line or matches a cheat class, and set cheat_class. Return ask_more when the owner should send more proof, and say what in extra_proof.",
      "Judge the proof against the contract, not the disputer's tone. reason and fix are read by both players.",
    ].join("\n"),
  },
  orchestrator: {
    draft: [
      "You are Lane's orchestrator. A creator described a challenge in a sentence, and may have answered your previous question.",
      "Pick the pack from `packs` that matches, and fill its typed parameters so they validate against that pack's params_json_schema, plus title, goal and days. Keep known_params unless the creator changed them.",
      "When a required field is missing or ambiguous, return kind \"question\" with one short clarifying question and the missing_fields. For example, ask which platforms count when the sentence does not say.",
      "Otherwise return kind \"params\". Never use a challenge type that is not in packs.",
    ].join("\n"),
    answer: [
      "You are Lane's orchestrator, answering one player's question about their challenges.",
      "Answer only from the context: their standings, the rules, their own proofs and the redacted feed. When the context does not hold the answer, say so.",
      "Keep the answer short and plain. Never reveal another player's proof contents.",
    ].join("\n"),
    settle: [
      "You are Lane's orchestrator, proposing the settlement of a closed challenge.",
      "Apply winner_rule to the scores and the goal, and split the pot into whole-credit shares. Set refund_all when nobody qualifies.",
      "Lane checks your proposal against its own computation, so follow the rule exactly. note explains the result in one sentence. Credits are play credits, not real money.",
    ].join("\n"),
  },
  rule_lab: {
    write_rule: [
      "You are Lane's rule-writer. From the evidence (an AI rejection, a dispute or a live cheat), write one candidate rule for the challenge type that catches the target cheat class without catching honest proofs.",
      "Read the current rules, examples and predicate catalog through the internal API, propose the rule, then test it. When the gate fails, revise and test again, at most max_revisions times, then give up.",
      "Never activate a rule. In no_egress mode, call nothing and return the rule in proposal.",
      "Report the candidate_ids you created and a short note.",
    ].join("\n"),
    red_team: [
      "You are Lane's red team. Invent cheat examples for the target cheat class and challenge type: feature sets a cheater could submit that the current rules may miss.",
      "Read the existing examples and the predicate catalog first, then add at most max_examples new cheat examples through the internal API. Add only cheat examples.",
      "In no_egress mode, call nothing and return the examples in examples.",
    ].join("\n"),
  },
  promoter: {
    promote: [
      "You are Lane's promoter. The input names one candidate rule that passed its gate.",
      "Read the candidate through the internal API, then activate it. A reject or hold_payout rule needs a human's approval first: the run pauses for that review before you act.",
      "When the human declined, do not activate and return decision \"declined\". When the candidate is no longer valid, reject it with a reason and return decision \"rejected\".",
      "Report the resulting rule_status and a short note.",
    ].join("\n"),
  },
};

export function agentPromptId(workspace: AgentWorkspace, mode: string): string {
  return `${workspace}.${mode}`;
}

/** True when `mode` is a mode of `workspace` in U3's `AGENT_SCHEMAS`. */
export function isAgentMode(workspace: AgentWorkspace, mode: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENT_SCHEMAS[workspace], mode);
}

/** The code default for a mode, or null for an unknown mode. */
export function defaultAgentPrompt(workspace: AgentWorkspace, mode: string): string | null {
  if (!isAgentMode(workspace, mode)) return null;
  return (DEFAULT_AGENT_PROMPTS[workspace] as Record<string, string>)[mode] ?? null;
}

/**
 * The prompt for one call: the stored override when it is valid, else the default. Read
 * fresh on every call. A read error or an invalid document falls back to the default and
 * is logged, so a bad override never blocks a review.
 */
export async function loadAgentPrompt(db: Db, workspace: AgentWorkspace, mode: string): Promise<string> {
  const fallback = defaultAgentPrompt(workspace, mode);
  if (fallback === null) {
    throw new Error(`Unknown agent mode ${workspace}.${mode}`);
  }
  const id = agentPromptId(workspace, mode);
  try {
    const doc = await db.collection<{ _id: string }>(AGENT_PROMPTS_COLLECTION).findOne({ _id: id });
    if (!doc) return fallback;
    const parsed = AgentPromptDocSchema.safeParse(doc);
    if (!parsed.success) {
      console.error(`[agents] prompt override ${id} is invalid; using the default`);
      return fallback;
    }
    return parsed.data.text;
  } catch (err) {
    console.error(`[agents] reading prompt override ${id} failed; using the default:`, err instanceof Error ? err.message : String(err));
    return fallback;
  }
}
