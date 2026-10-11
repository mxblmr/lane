/**
 * The `lane_ping` result shared by the MCP tool and the JSON route, so U2 can
 * test both connector faces against the same answer.
 */
export type PingResult = {
  ok: true;
  service: "lane";
  /** Server time as an ISO 8601 UTC string. */
  server_time: string;
  /** Plain line an agent can relay to the player. */
  message: string;
};

export const LANE_PING_TOOL = {
  name: "lane_ping",
  title: "Ping Lane",
  description:
    "Check that Lane is reachable. Returns Lane's server time. Takes no arguments and changes nothing.",
} as const;

export function ping(now: Date = new Date()): PingResult {
  const server_time = now.toISOString();
  return {
    ok: true,
    service: "lane",
    server_time,
    message: `Lane is reachable. Server time is ${server_time}.`,
  };
}
