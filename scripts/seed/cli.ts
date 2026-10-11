/**
 * Seed and stage reset from a laptop, against the database in MONGODB_URI (U13).
 *
 *   pnpm exec tsx scripts/seed/cli.ts seed [--types ship_week,customers,build_in_public]
 *   pnpm exec tsx scripts/seed/cli.ts reset --type ship_week
 *
 * `seed` upserts Gary, Priya and Sam with verified handles and their starting grant, then makes
 * sure each type has one live stage challenge on a demo clock. It needs MONGODB_URI and, per
 * player, <NAME>_LANE_KEY plus the handle variables the chosen types need (GitHub logins for Ship
 * Week, Threads handles for Build in Public). `reset` runs the KTD22 reset, the same code the
 * dashboard's reset control calls, and needs only MONGODB_URI.
 * Secrets are read from the environment and never printed.
 */
import { pathToFileURL } from "node:url";
import { laneDb } from "@lane/core/interfaces";
import { closeMongoClient } from "@lane/core/db";
import { CHALLENGE_TYPES, type ChallengeType, type HandlePlatform } from "@lane/core/schema/common";
import { MissingEnvError, seedPlayerInputs, type Env } from "./roster";
import { seed } from "./seed";
import { resetStageDetailed } from "./reset";
import { stageHandlePlatform } from "./stage";
import { wireServices } from "./wire";

export type CliCommand =
  | { command: "seed"; types: ChallengeType[] }
  | { command: "reset"; type: ChallengeType };

function parseType(value: string): ChallengeType {
  if (!(CHALLENGE_TYPES as readonly string[]).includes(value)) {
    throw new Error(`Unknown challenge type ${value}. Use one of ${CHALLENGE_TYPES.join(", ")}.`);
  }
  return value as ChallengeType;
}

export function parseCliArgs(argv: string[]): CliCommand {
  const args = argv.filter((a) => a !== "--");
  const [command, ...rest] = args;
  const flag = (name: string): string | undefined => {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === name) return rest[i + 1];
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
    }
    return undefined;
  };
  if (command === "seed") {
    const raw = flag("--types");
    const types = raw ? raw.split(",").map((t) => parseType(t.trim())) : [...CHALLENGE_TYPES];
    return { command: "seed", types };
  }
  if (command === "reset") {
    const raw = flag("--type");
    if (!raw) throw new Error("Usage: reset --type ship_week");
    return { command: "reset", type: parseType(raw) };
  }
  throw new Error("Usage: cli.ts seed [--types a,b] | cli.ts reset --type <type>");
}

/** Handle platforms the scripted players need for these types. */
export function platformsFor(types: readonly ChallengeType[]): HandlePlatform[] {
  const set = new Set<HandlePlatform>();
  for (const t of types) {
    const p = stageHandlePlatform(t);
    if (p) set.add(p);
  }
  return [...set];
}

async function main(argv: string[], env: Env): Promise<number> {
  const cmd = parseCliArgs(argv);
  const wired = await wireServices();
  if (wired.missing.length > 0) console.log(`Not merged yet (stubs stay): ${wired.missing.join(", ")}`);
  const db = await laneDb();
  try {
    if (cmd.command === "seed") {
      const players = seedPlayerInputs(env, platformsFor(cmd.types));
      const result = await seed(db, { players, types: cmd.types });
      for (const p of result.players) console.log(`player ${p.name}: ${p.created ? "created" : "already seeded"} (${p.player_id})`);
      for (const s of result.stage) console.log(`stage ${s.type}: ${s.created ? "created" : "already live"} (${s.challenge_id})`);
      return 0;
    }
    const result = await resetStageDetailed(db, { challenge_type: cmd.type, by: "seed-cli" });
    if (!result.ok) {
      console.error(`Reset failed: ${result.error.message} ${result.error.recovery}`);
      return 1;
    }
    const r = result.report;
    console.log(
      `Reset ${cmd.type}: cancelled ${r.cancelled.length}, refunds ${r.refunds}, declined approvals ${r.declined_approvals}, ` +
        `rolled back ${r.rolled_back.length}, removed examples ${r.removed_examples}, new challenge ${r.new_challenge_id}`,
    );
    return 0;
  } finally {
    await closeMongoClient();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof MissingEnvError || error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
