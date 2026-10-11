/**
 * Connector smoke check (Verification Contract): an MCP client that calls
 * `tools/list` against a deployed or local Lane and checks the tool names.
 *
 *   pnpm mcp:smoke --url https://<production host>
 *   pnpm mcp:smoke --url http://localhost:3000/api/mcp --expect lane_ping
 *
 * A bare origin gets `/api/mcp` appended. `--expect` takes a comma-separated
 * list and defaults to the eight `lane_` tools (U7). When `lane_check_in` is
 * listed, the check also calls it with no player key, which writes nothing, and
 * expects an envelope with a recovery instruction and the server time. When
 * `lane_ping` is listed, the check calls it and prints the server time.
 * Exits 0 when every expected tool is listed and each probe answers, 1 otherwise.
 */
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export const DEFAULT_EXPECTED_TOOLS = [
  "lane_register",
  "lane_create_challenge",
  "lane_confirm_challenge",
  "lane_join_challenge",
  "lane_check_in",
  "lane_submit_proof",
  "lane_ask",
  "lane_dispute",
] as const;

export type SmokeOptions = {
  url: string;
  expected: string[];
};

export type ToolComparison = {
  ok: boolean;
  missing: string[];
  extra: string[];
};

export type SmokeResult = ToolComparison & {
  url: string;
  tools: string[];
  /** Server time returned by `lane_ping` or the keyless `lane_check_in` probe. */
  serverTime?: string;
  /** Recovery instruction from the keyless `lane_check_in` probe, when that tool was listed. */
  checkInRecovery?: string;
};

export function parseArgs(argv: string[]): SmokeOptions {
  let url: string | undefined;
  let expected: string[] = [...DEFAULT_EXPECTED_TOOLS];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = () => {
      const next = inline ?? argv[i + 1];
      if (next === undefined || (inline === undefined && next.startsWith("--"))) {
        throw new Error(`${flag} needs a value`);
      }
      if (inline === undefined) i += 1;
      return next;
    };
    if (flag === "--url") {
      url = value();
    } else if (flag === "--expect") {
      expected = value()
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!url) {
    throw new Error("Usage: pnpm mcp:smoke --url <deployed url> [--expect a,b,c]");
  }
  if (expected.length === 0) {
    throw new Error("--expect needs at least one tool name");
  }
  return { url: normalizeMcpUrl(url), expected };
}

/** Adds `/api/mcp` to a bare origin; leaves any other path alone. */
export function normalizeMcpUrl(input: string): string {
  const url = new URL(input);
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/api/mcp";
  }
  return url.toString();
}

export function compareToolNames(expected: string[], actual: string[]): ToolComparison {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name));
  const extra = actual.filter((name) => !expectedSet.has(name));
  return { ok: missing.length === 0, missing, extra };
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const client = new Client({ name: "lane-mcp-smoke", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(options.url));
  await client.connect(transport);
  try {
    const tools: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools.map((tool) => tool.name));
      cursor = page.nextCursor;
    } while (cursor);

    const comparison = compareToolNames(options.expected, tools);
    const result: SmokeResult = { url: options.url, tools, ...comparison };

    if (tools.includes("lane_ping")) {
      const ping = await client.callTool({ name: "lane_ping", arguments: {} });
      const structured = ping.structuredContent as { server_time?: unknown } | undefined;
      if (ping.isError || typeof structured?.server_time !== "string") {
        result.ok = false;
      } else {
        result.serverTime = structured.server_time;
      }
    }

    if (tools.includes("lane_check_in")) {
      // No key: Lane must answer with an envelope and a recovery instruction, and write nothing.
      const probe = await client.callTool({ name: "lane_check_in", arguments: {} });
      const envelope = probe.structuredContent as
        | { status?: unknown; server_time?: unknown; error?: { code?: unknown; recovery?: unknown } | null }
        | undefined;
      const recovery = envelope?.error?.recovery;
      if (
        probe.isError ||
        envelope?.status !== "error" ||
        envelope.error?.code !== "unauthenticated" ||
        typeof recovery !== "string" ||
        typeof envelope.server_time !== "string"
      ) {
        result.ok = false;
      } else {
        result.checkInRecovery = recovery;
        result.serverTime ??= envelope.server_time;
      }
    }
    return result;
  } finally {
    await client.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`MCP smoke: ${options.url}`);
  const result = await runSmoke(options);
  console.log(`tools/list: ${result.tools.join(", ") || "(none)"}`);
  if (result.serverTime) console.log(`server_time: ${result.serverTime}`);
  if (result.checkInRecovery) console.log(`lane_check_in without a key: ${result.checkInRecovery}`);
  if (result.extra.length > 0) console.log(`not expected (ignored): ${result.extra.join(", ")}`);
  if (result.missing.length > 0) console.error(`MISSING: ${result.missing.join(", ")}`);
  if (result.tools.includes("lane_ping") && !result.serverTime) {
    console.error("FAIL: lane_ping did not return a server_time");
  }
  if (result.tools.includes("lane_check_in") && !result.checkInRecovery) {
    console.error("FAIL: lane_check_in without a key did not return an envelope with a recovery instruction");
  }
  console.log(result.ok ? "PASS" : "FAIL");
  process.exitCode = result.ok ? 0 : 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    console.log("FAIL");
    process.exitCode = 1;
  });
}
