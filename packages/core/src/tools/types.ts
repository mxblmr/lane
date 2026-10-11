import type { Db } from "mongodb";
import type { ToolName } from "../schema/common";
import type { Envelope, ToolArgs } from "../schema/envelope";
import type { Player } from "../schema/players";

/** A call to `lane_register`, the one tool that runs without a player key. */
export interface OpenToolCall<A> {
  db: Db;
  args: A;
  now: Date;
}

/** A call from a resolved player (KTD4). */
export interface PlayerToolCall<A> extends OpenToolCall<A> {
  player: Player;
}

export type ToolCall<N extends ToolName> = N extends "lane_register"
  ? OpenToolCall<ToolArgs[N]>
  : PlayerToolCall<ToolArgs[N]>;

/** MCP tool annotations. Hints only; Lane enforces everything on the server. */
export interface LaneToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * One connector tool, written once so every face (MCP now, the U19 JSON mirror later) runs the
 * same handler. The description is product copy that Muse reads to decide when and how to call.
 */
export interface LaneTool<N extends ToolName = ToolName> {
  name: N;
  title: string;
  description: string;
  annotations: LaneToolAnnotations;
  /** Plain-language description of each argument, added to the advertised JSON Schema. */
  fields: Record<string, string>;
  handle(call: ToolCall<N>): Promise<Envelope>;
}
