/**
 * Gary and Priya, the honest Ship Week players (R30). Each pushes a meaningful commit to their own
 * sandbox repo, a new small function, and their agent submits it. The stage feed then shows
 * honest proofs accepted next to Sam's cheats, and the dashboard's honest examples stay honest.
 */
import type { ScriptedPlayerName } from "../../seed/roster";
import { contractVersion, findChallenge } from "../lane-client";
import { counts, describeVerdict, expectThat, short, submitAndSettle, type Scenario, type StageContext, type Step } from "../runner";

export const HONEST_FILE = "lane-stage/streaks.ts";

const HEADER = "// Lane stage sandbox: small helpers the scripted players ship each day.\n";

/** A new, real function with a unique name: a meaningful code change of about ten lines. */
export function honestFunction(suffix: string): string {
  return [
    "",
    `/** Longest run of shipped days, ${suffix}. */`,
    `export function longestStreak${suffix}(days: boolean[]): number {`,
    "  let best = 0;",
    "  let current = 0;",
    "  for (const shipped of days) {",
    "    current = shipped ? current + 1 : 0;",
    "    if (current > best) best = current;",
    "  }",
    "  return best;",
    "}",
    "",
  ].join("\n");
}

function suffixAt(ms: number): string {
  return `V${ms.toString(36).toUpperCase()}`;
}

function honestCommitStep(name: ScriptedPlayerName): Step {
  return {
    title: `${name} checks in, pushes a meaningful commit and submits it`,
    async run(ctx: StageContext) {
      const player = ctx.player(name);
      await player.github.assertIdentity();
      const env = await player.lane.checkIn();
      const c = findChallenge(env, "ship_week");
      expectThat(c, `${name} is not in a live Ship Week challenge. Reset the stage first.`);
      ctx.io.log(`${name} is in ${c.title ?? "Ship Week"} (${c.challenge_id}), contract v${contractVersion(c)}.`);
      ctx.state.shipWeek ??= { challenge_id: c.challenge_id, base_version: contractVersion(c), base_lines: c.contract?.does_not_count ?? [] };

      const suffix = suffixAt(ctx.io.now());
      const file = await player.github.getFile(HONEST_FILE);
      const content = `${file?.content ?? HEADER}${honestFunction(suffix)}`;
      const commit = await player.github.putFile(HONEST_FILE, content, `Add longestStreak${suffix} helper`, file?.sha);
      ctx.io.log(`Pushed ${short(commit.sha)}: adds longestStreak${suffix} (10 lines). ${commit.url}`);

      const v = await submitAndSettle(ctx, player.lane, { challenge_id: c.challenge_id, repo: player.github.repo, sha: commit.sha });
      ctx.io.log(describeVerdict(v));
      expectThat(counts(v), `${name}'s honest commit was ${v.outcome}; it should count.`);
      ctx.state[`${name.toLowerCase()}Proof`] = v;
    },
  };
}

export const garyHonest = honestCommitStep("Gary");
export const priyaHonest = honestCommitStep("Priya");

export const garyPriyaShipWeek: Scenario = {
  id: "gary-priya-ship-week",
  title: "Gary and Priya ship honest commits on Ship Week",
  steps: [garyHonest, priyaHonest],
};
