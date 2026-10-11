import { hashPlayerKey } from "@lane/core/players";
import type { HandlePlatform } from "@lane/core/schema/common";

/**
 * The three scripted demo players (R30, KTD17). Gary, Priya and Sam each act through the real
 * connector with their own Lane key and push commits from their own GitHub login.
 *
 * Every identity, key and token comes from environment variables, never from the repo:
 *   <NAME>_LANE_KEY       the player's Lane key (16 to 200 characters). The seed stores only its
 *                         SHA-256 hash; the stage runner sends it as a bearer header (KTD4).
 *   <NAME>_GITHUB_LOGIN   the player's GitHub login, seeded as the verified GitHub handle (KTD21).
 *   <NAME>_GITHUB_TOKEN   a token for that login with write access to its sandbox repo.
 *   <NAME>_GITHUB_REPO    the player's public sandbox repo, as owner/name.
 */

export const SCRIPTED_PLAYER_NAMES = ["Gary", "Priya", "Sam"] as const;
export type ScriptedPlayerName = (typeof SCRIPTED_PLAYER_NAMES)[number];

export interface ScriptedPlayerDef {
  name: ScriptedPlayerName;
  /** Environment variable prefix, for example SAM. */
  envPrefix: string;
  time_zone: string;
}

export const ROSTER: Record<ScriptedPlayerName, ScriptedPlayerDef> = {
  Gary: { name: "Gary", envPrefix: "GARY", time_zone: "America/Los_Angeles" },
  Priya: { name: "Priya", envPrefix: "PRIYA", time_zone: "America/Los_Angeles" },
  Sam: { name: "Sam", envPrefix: "SAM", time_zone: "America/Los_Angeles" },
};

export type Env = Record<string, string | undefined>;

export function envName(name: ScriptedPlayerName, suffix: string): string {
  return `${ROSTER[name].envPrefix}_${suffix}`;
}

/** Thrown when required environment variables are missing. The message names every one. */
export class MissingEnvError extends Error {
  readonly missing: string[];
  constructor(missing: string[], purpose: string) {
    super(
      `Missing environment variables for ${purpose}: ${missing.join(", ")}. ` +
        "Set them in your shell from the team's secret store (see the U13 PR for what each one needs). " +
        "Never commit their values.",
    );
    this.name = "MissingEnvError";
    this.missing = missing;
  }
}

/** Read the named variables, or throw one error that lists every missing name. */
export function requireEnv(env: Env, names: string[], purpose: string): Record<string, string> {
  const missing = names.filter((n) => !env[n] || !env[n]!.trim());
  if (missing.length > 0) throw new MissingEnvError(missing, purpose);
  return Object.fromEntries(names.map((n) => [n, env[n]!.trim()]));
}

const MIN_KEY = 16;
const MAX_KEY = 200;

/** SHA-256 hex of a player key, the only form Lane stores (KTD4). U6's hashing, so lookups match. */
export function hashLaneKey(key: string): string {
  return hashPlayerKey(key);
}

export function readLaneKey(env: Env, name: ScriptedPlayerName): string {
  const varName = envName(name, "LANE_KEY");
  const key = requireEnv(env, [varName], `${name}'s Lane key`)[varName]!;
  if (key.length < MIN_KEY || key.length > MAX_KEY) {
    throw new Error(`${varName} must be ${MIN_KEY} to ${MAX_KEY} characters long.`);
  }
  return key;
}

/** What the seed needs per player: the Lane key (hashed) and the handles to seed as verified. */
export interface SeedPlayerInput {
  name: ScriptedPlayerName;
  time_zone: string;
  key_hash: string;
  handles: Partial<Record<HandlePlatform, string>>;
}

/** Handle platforms each player needs for the given challenge types, with their env suffix. */
const HANDLE_ENV: Partial<Record<HandlePlatform, string>> = {
  github: "GITHUB_LOGIN",
  threads: "THREADS_HANDLE",
};

export function seedPlayerInputs(env: Env, platforms: HandlePlatform[], names: readonly ScriptedPlayerName[] = SCRIPTED_PLAYER_NAMES): SeedPlayerInput[] {
  const wanted: string[] = [];
  for (const name of names) {
    wanted.push(envName(name, "LANE_KEY"));
    for (const platform of platforms) {
      const suffix = HANDLE_ENV[platform];
      if (!suffix) throw new Error(`No scripted-player handle variable for ${platform}.`);
      wanted.push(envName(name, suffix));
    }
  }
  const values = requireEnv(env, wanted, "seeding the scripted players");
  return names.map((name) => {
    const key = readLaneKey(env, name);
    const handles: Partial<Record<HandlePlatform, string>> = {};
    for (const platform of platforms) {
      handles[platform] = values[envName(name, HANDLE_ENV[platform]!)]!;
    }
    return { name, time_zone: ROSTER[name].time_zone, key_hash: hashLaneKey(key), handles };
  });
}

/** What the stage runner needs to act as a player on Ship Week. */
export interface PlayerGithubEnv {
  login: string;
  token: string;
  /** owner/name */
  repo: string;
}

/** Everything the stage runner needs for one player, checked together so one error names every gap. */
export function readStagePlayer(env: Env, name: ScriptedPlayerName): { laneKey: string; github: PlayerGithubEnv } {
  requireEnv(
    env,
    ["LANE_KEY", "GITHUB_LOGIN", "GITHUB_TOKEN", "GITHUB_REPO"].map((s) => envName(name, s)),
    `${name} on stage`,
  );
  return { laneKey: readLaneKey(env, name), github: readPlayerGithub(env, name) };
}

export function readPlayerGithub(env: Env, name: ScriptedPlayerName): PlayerGithubEnv {
  const names = [envName(name, "GITHUB_LOGIN"), envName(name, "GITHUB_TOKEN"), envName(name, "GITHUB_REPO")];
  const v = requireEnv(env, names, `${name}'s GitHub pushes`);
  const repo = v[names[2]!]!;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`${names[2]} must be owner/name, for example sam-lane-demo/sandbox.`);
  }
  return { login: v[names[0]!]!, token: v[names[1]!]!, repo };
}
