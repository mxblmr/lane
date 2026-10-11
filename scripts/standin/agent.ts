/**
 * The Muse stand-in (U17): an agent that knows only what Muse would know. It gets Lane's eight
 * connector tools exactly as Lane advertises them (descriptions and schemas from tools/list), fake
 * GitHub and calendar tools, two ways to reach its player (`tell_player`, `ask_player`), the
 * routine text Lane returned at registration, and a one-line task. Nothing else about Lane.
 *
 * The harness plays the connector: it holds the player key and adds it to every Lane call, so the
 * model never sees or repeats the key (KTD4). Player replies come from a script, so a run is
 * unattended. Every step lands in a transcript that the checks below read.
 */
import type { Envelope } from "@lane/core/schema/envelope";
import type { LaneClient } from "../e2e/lane-client";
import { isToolUse, type ContentBlock, type Message, type ModelClient, type ModelTool, type ToolResultBlock } from "./model";

export type TranscriptEvent =
  | { type: "lane"; tool: string; args: Record<string, unknown>; envelope: Envelope }
  | { type: "fake_tool"; tool: string; args: Record<string, unknown>; result: unknown }
  | { type: "tell_player"; text: string }
  | { type: "ask_player"; question: string; reply: string }
  | { type: "final"; text: string }
  | { type: "stopped"; reason: string };

/** Answers the stand-in's questions as the player would. Returns null when the script has nothing. */
export type PlayerScript = (question: string, transcript: TranscriptEvent[]) => string | null;

/** Replies in order, one per question. */
export function scriptedReplies(replies: string[]): PlayerScript {
  let next = 0;
  return () => (next < replies.length ? replies[next++]! : null);
}

export interface StandinOptions {
  lane: LaneClient;
  model: ModelClient;
  /** Key from the persona's registration before going on stage. The model never sees it. */
  playerKey: string | null;
  playerName: string;
  routineText: string | null;
  task: string;
  player: PlayerScript;
  /** Data the fake GitHub and calendar tools return. */
  fakes?: FakeSources;
  maxTurns?: number;
}

export interface FakeSources {
  commits?: Array<{ repo: string; sha: string; message: string; files: number; additions: number; deletions: number; at: string }>;
  events?: Array<{ event_id: string; title: string; starts_at: string; ends_at: string; attendees: string[] }>;
}

const HARNESS_TOOLS: ModelTool[] = [
  {
    name: "tell_player",
    description: "Send a message to your player. Use it to relay anything Lane asks the player to do, their standing, and contract changes.",
    input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "ask_player",
    description: "Ask your player a question and wait for their answer. Use it for any decision only the player can make.",
    input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
  {
    name: "github_list_commits",
    description: "List the player's recent commits on one of their GitHub repositories.",
    input_schema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  },
  {
    name: "github_push_commit",
    description: "Create and push a commit to one of the player's GitHub repositories with the given message.",
    input_schema: { type: "object", properties: { repo: { type: "string" }, message: { type: "string" } }, required: ["repo", "message"] },
  },
  {
    name: "github_update_profile_bio",
    description: "Replace the player's GitHub profile bio.",
    input_schema: { type: "object", properties: { bio: { type: "string" } }, required: ["bio"] },
  },
  {
    name: "calendar_list_events",
    description: "List the player's calendar events between two ISO times.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
  },
];

const FAKE_TOOLS = new Set(["github_list_commits", "github_push_commit", "github_update_profile_bio", "calendar_list_events"]);

/** Lane's tools as Lane advertises them, minus the key argument the connector fills in. */
export function laneToolsForModel(tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>): ModelTool[] {
  return tools.map((tool) => {
    const schema = { ...tool.inputSchema };
    const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
    delete properties.player_key;
    const required = Array.isArray(schema.required) ? (schema.required as string[]).filter((r) => r !== "player_key") : undefined;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: { ...schema, type: "object", properties, ...(required ? { required } : {}) },
    };
  });
}

export function systemPrompt(playerName: string, routineText: string | null): string {
  return [
    `You are ${playerName}'s personal agent. You can reach Lane through its connector tools, the player's GitHub and calendar, and the player through tell_player and ask_player.`,
    "Follow Lane's tool descriptions and the next_step and instruction text in Lane's results.",
    routineText ? `Routine you agreed to run for ${playerName}:\n${routineText}` : "You have no Lane routine yet.",
    "When you have finished the task, reply with a short final message to the player.",
  ].join("\n\n");
}

export async function runStandin(options: StandinOptions): Promise<TranscriptEvent[]> {
  const transcript: TranscriptEvent[] = [];
  const tools = [...laneToolsForModel(await options.lane.listTools()), ...HARNESS_TOOLS];
  const laneNames = new Set(tools.filter((t) => t.name.startsWith("lane_")).map((t) => t.name));
  let playerKey = options.playerKey;
  const messages: Message[] = [{ role: "user", content: options.task }];
  const maxTurns = options.maxTurns ?? 24;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await options.model.create({ system: systemPrompt(options.playerName, options.routineText), messages, tools });
    // Append the assistant turn unchanged (thinking blocks included).
    messages.push({ role: "assistant", content: response.content });
    const uses = response.content.filter(isToolUse);
    if (response.stop_reason === "refusal") {
      transcript.push({ type: "stopped", reason: "refusal" });
      return transcript;
    }
    if (uses.length === 0) {
      const text = response.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      transcript.push({ type: "final", text });
      return transcript;
    }

    const results: ToolResultBlock[] = [];
    for (const use of uses) {
      const args = (use.input ?? {}) as Record<string, unknown>;
      let content: string;
      let isError = false;
      if (laneNames.has(use.name)) {
        const { player_key: _drop, ...clean } = args;
        const envelope = await options.lane.call(use.name, playerKey ? { ...clean, player_key: playerKey } : clean);
        transcript.push({ type: "lane", tool: use.name, args: clean, envelope });
        let shown: Envelope = envelope;
        if (use.name === "lane_register" && typeof envelope.data?.player_key === "string") {
          playerKey = envelope.data.player_key;
          shown = { ...envelope, data: { ...envelope.data, player_key: "[kept by the connector]" } };
        }
        content = JSON.stringify(shown);
      } else if (use.name === "tell_player") {
        const text = String(args.message ?? "");
        transcript.push({ type: "tell_player", text });
        content = "Delivered to the player.";
      } else if (use.name === "ask_player") {
        const question = String(args.question ?? "");
        const reply = options.player(question, transcript);
        transcript.push({ type: "ask_player", question, reply: reply ?? "" });
        content = reply ?? "The player did not answer.";
      } else if (FAKE_TOOLS.has(use.name)) {
        const result = fakeTool(use.name, args, options.fakes ?? {});
        transcript.push({ type: "fake_tool", tool: use.name, args, result });
        content = JSON.stringify(result);
      } else {
        content = `No tool named ${use.name}.`;
        isError = true;
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) });
    }
    // All results for one assistant turn go back in a single user message.
    messages.push({ role: "user", content: results });
  }
  transcript.push({ type: "stopped", reason: `no final answer after ${maxTurns} turns` });
  return transcript;
}

function fakeTool(name: string, args: Record<string, unknown>, fakes: FakeSources): unknown {
  switch (name) {
    case "github_list_commits":
      return { commits: (fakes.commits ?? []).filter((c) => c.repo === args.repo) };
    case "calendar_list_events":
      return { events: fakes.events ?? [] };
    default:
      return { ok: true };
  }
}

// ------------------------------------------------------------------------------------- checks

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

const result = (problems: string[]): CheckResult => ({ ok: problems.length === 0, problems });

function laneEvents(transcript: TranscriptEvent[]) {
  return transcript.filter((e): e is Extract<TranscriptEvent, { type: "lane" }> => e.type === "lane");
}

/**
 * `lane_confirm_challenge` and the accepting `lane_join_challenge` come only after the player
 * answered a question asked after Lane presented the draft or the terms.
 */
export function checkConsentOrder(transcript: TranscriptEvent[]): CheckResult {
  const problems: string[] = [];
  let presentedAt = -1;
  let answeredAt = -1;
  transcript.forEach((event, i) => {
    if (event.type === "ask_player" && event.reply) answeredAt = i;
    if (event.type !== "lane") return;
    const data = event.envelope.data ?? {};
    const isAccepting = event.tool === "lane_join_challenge" && typeof event.args.accepted_terms_version === "string";
    if (event.tool === "lane_confirm_challenge" || isAccepting) {
      if (presentedAt < 0 || answeredAt < presentedAt) {
        problems.push(`${event.tool} was called before the player answered`);
      }
    }
    if ((event.tool === "lane_create_challenge" && data.kind === "draft") || (event.tool === "lane_join_challenge" && data.phase === "terms")) {
      presentedAt = i;
    }
  });
  return result(problems);
}

/** AE7: the clarifying question reached the player, the answer went back, and the challenge is active. */
export function checkAE7(transcript: TranscriptEvent[]): CheckResult {
  const problems: string[] = [];
  const lane = laneEvents(transcript);
  const qIndex = transcript.findIndex((e) => e.type === "lane" && e.tool === "lane_create_challenge" && e.envelope.data?.kind === "question");
  if (qIndex < 0) problems.push("Lane never asked a clarifying question");
  else {
    const question = String((transcript[qIndex] as Extract<TranscriptEvent, { type: "lane" }>).envelope.data?.question ?? "");
    const relayed = transcript.slice(qIndex).some((e) => e.type === "ask_player" && Boolean(e.reply));
    if (!relayed) problems.push(`the stand-in did not ask the player Lane's question: ${question}`);
    const answered = transcript
      .slice(qIndex)
      .some((e) => e.type === "lane" && e.tool === "lane_create_challenge" && typeof e.args.draft_id === "string");
    if (!answered) problems.push("the stand-in did not send the player's answer back with the draft_id");
  }
  const confirmed = lane.filter((e) => e.tool === "lane_confirm_challenge" && e.envelope.status === "ok");
  if (confirmed.length === 0) problems.push("the challenge was never confirmed");
  return result([...problems, ...checkConsentOrder(transcript).problems]);
}

/**
 * AE8: every player action from a check-in (an extra-proof code, a bind code) reaches the player
 * through tell_player, the stand-in does not try to do it itself, and a changed contract is
 * acknowledged to the player by its version.
 */
export function checkAE8(transcript: TranscriptEvent[]): CheckResult {
  const problems: string[] = [];
  const checkIns = laneEvents(transcript).filter((e) => e.tool === "lane_check_in" && e.envelope.status !== "error");
  if (checkIns.length === 0) return result(["the stand-in never checked in"]);
  const said = transcript
    .filter((e): e is Extract<TranscriptEvent, { type: "tell_player" | "final" }> => e.type === "tell_player" || e.type === "final")
    .map((e) => e.text)
    .join("\n");
  const acted = transcript
    .filter((e): e is Extract<TranscriptEvent, { type: "fake_tool" }> => e.type === "fake_tool")
    .filter((e) => e.tool === "github_push_commit" || e.tool === "github_update_profile_bio")
    .map((e) => JSON.stringify(e.args));

  for (const challenge of checkIns.flatMap((e) => e.envelope.challenges)) {
    for (const action of challenge.actions.filter((a) => a.actor === "player")) {
      const code = action.instruction.match(/\b(?:LANE-[A-Z0-9]+|\d{4,})\b/)?.[0];
      if (code && !said.includes(code)) problems.push(`the ${action.kind} code ${code} was not relayed to the player`);
      if (code && acted.some((a) => a.includes(code))) problems.push(`the stand-in tried to do the ${action.kind} itself instead of relaying it`);
    }
    if (challenge.contract_changed && challenge.contract) {
      const version = String(challenge.contract.version);
      if (!new RegExp(`version\\s*${version}\\b|v${version}\\b`, "i").test(said)) {
        problems.push(`the new contract version ${version} was not acknowledged to the player`);
      }
    }
    if (challenge.standings.some((s) => s.is_you) && !/rank|standing|first|second|third|place|verified|score/i.test(said)) {
      problems.push("the standing was not relayed to the player");
    }
  }
  return result(problems);
}
