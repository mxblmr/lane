# Lane demo runbook

Demo: 5:00 PM PDT, 2026-10-11. Merges freeze at 4:30 PM. Presenter: Max. Operator and backup: Antoine.

This runbook covers setup, the reset before every run, the stage script with AE1 first, who clicks what, and the fallback for each failure named in the plan's Goal Capsule and Risks & Dependencies.

## URLs

| What | URL |
|---|---|
| Production alias | https://lane-seven-phi.vercel.app |
| Muse connector (MCP, streamable HTTP, no auth) | https://lane-seven-phi.vercel.app/api/mcp |
| JSON ping (U1) | https://lane-seven-phi.vercel.app/api/v1/ping |
| OpenAPI stub (U1, U19) | https://lane-seven-phi.vercel.app/api/v1/openapi.json |
| Database health | https://lane-seven-phi.vercel.app/api/health/db |
| Judges' dashboard, three challenges (U12) | https://lane-seven-phi.vercel.app/ |
| Stage screen, one challenge (U12) | https://lane-seven-phi.vercel.app/c/<challenge id> |
| Rule history (U12) | https://lane-seven-phi.vercel.app/rules |
| Pinned deployment for rehearsals and the stage | write the `*.vercel.app` deployment URL here at 4:30 PM: ______________ |

## Commands

Run from the repo root on the presenter laptop. `<url>` is the pinned deployment URL from 4:30 PM on, the production alias before that.

| Command | Use |
|---|---|
| `pnpm mcp:smoke --url <url>` | Lists the eight `lane_` tools and calls `lane_check_in` with no key, which writes nothing. |
| `pnpm players:stage --url <url>` | U13's stage runner. One scripted step per keypress, Sam's AE1 scenario first. |
| `pnpm e2e --url <url>` | U17 end-to-end checks for F1 to F6 and AE2 to AE8. Writes only clearly marked `E2E` players. Never run it against the stage challenge during a rehearsal. |
| `pnpm standin --url <url>` | U17 Muse stand-in: a Claude agent that knows only the Lane connector. Needs `ANTHROPIC_API_KEY` in the shell. |

`pnpm e2e` exit codes: 0 every selected check passed, 1 at least one failed, 2 nothing failed but some checks are blocked on a unit that is not live yet (the report names the unit).

## Setup checklist (people only, never an agent)

Done by Max or Antoine before 4:30 PM. Keys go into the team secret store and the Vercel environment settings, never into the repo or a projected terminal.

- [ ] Atlas Flex cluster, database user, network access open to Vercel. `MONGODB_URI` and `MONGODB_DB` set on Vercel production. `/api/health/db` answers OK.
- [ ] Agent Engine project logged in, service account with Project Owner, egress entry for the production host, all four agents deployed from main by Antoine (or the tunnel fallback below is running).
- [ ] LLM API key set where the agents and the stand-in read it.
- [ ] Vercel Deployment Protection off for the production alias.
- [ ] Public GitHub sandbox repositories, one GitHub login and write token per scripted player, one read token for the verifier.
- [ ] `RAINDROP_WRITE_KEY` on Vercel production only. Raindrop Events view filtered to Ship Week saved after the first AE1 run.
- [ ] Docker Desktop and a tunnel tool on one laptop, for the Agent Engine fallback.
- [ ] Muse signed in on the presenter phone, with the Lane connector added (next section).
- [ ] Operator passcode in the secret store. Log in to the operator panel on the presenter laptop before going on stage, not on the projector.

## Muse connector setup (tested live today)

1. In a Muse chat, add a custom connector by asking Muse to connect to `https://lane-seven-phi.vercel.app/api/mcp`. Muse connects over streamable HTTP with no auth.
2. On the first call Muse asks "Allow Muse to share information with lane-seven-phi.vercel.app?". Choose **Always allow this site**. Without it, Muse asks again on every call and the routine stalls. It is already set to always allow on the presenter account; check it again after any connector change.
3. Muse supports scheduled tasks at a 5-minute interval. The contract asks for a 27-minute routine (R10). On stage the presenter triggers check-ins by asking Muse directly (R12), so the routine interval does not gate the demo.
4. If the pinned deployment has a different host than the production alias, keep Muse on the production alias. Muse's "always allow" is per site, and the alias points at the pinned deployment anyway.

## Register stage personas before going on stage

No player key is ever projected.

1. Before 4:45 PM, the presenter registers on the phone ("Register me with Lane as Max, time zone America/Los_Angeles"). Muse keeps the key. Do not ask Muse to show the key.
2. U13's seed registers Gary, Priya and Sam as scripted players with verified handles. Their keys stay in the stage runner's environment, never on screen.
3. Close every terminal that printed a key before the projector is connected. `pnpm e2e` and `pnpm standin` never print keys.

## Reset before every run

Every rehearsal and the stage run start from a reset (KTD22). The reset cancels the previous stage challenge of that type, refunds every stake as new ledger entries, expires its inbox items, rolls the type's rules back to their seed versions, removes non-seed examples, declines open rule approvals, cancels suspended promoter executions, and creates a fresh stage challenge on a demo clock with the scripted players joined.

1. Operator panel on the stage screen: **Reset stage**, then the confirming second click. Antoine clicks.
2. Wait for the dashboard to show the new Ship Week stage challenge with Gary, Priya and Sam at zero, and the rule chart at the seed versions only.
3. If the reset control fails, use U13's reset entry point from the laptop (see U13's README for the exact command) and reload the dashboard.
4. Do not run `pnpm e2e` between the reset and the stage run.

## Stage script (AE1 first)

Roles: **Max** presents and drives Muse and the stage runner. **Antoine** clicks on the dashboard (approve, advance day, close window) and watches the logs.

### Part 1, AE1: a junk commit, a learned rule, a rule catch (target under 2 minutes)

1. Max: "Sam is a cheater. His agent sends a commit that only renames a variable." Press the key in `pnpm players:stage` for Sam's first rename-only commit.
2. Dashboard feed: Sam's proof shows **rejected**, decided by **AI**, with the reason and how to fix it.
3. Rule activity strip: the rule-writer proposes "rename, whitespace or docs-only commits don't count", the test gate shows catch rate up and false alarms within the thresholds, and the entry waits for approval because the rule rejects proof.
4. Antoine: **Approve** on the pending rule. One click; the button disables while it works.
5. The strip shows **active**. The stage runner prints "rule live".
6. Max: press the key for Sam's second rename-only commit.
7. Feed: **rejected**, decided by **rule**, **0 AI calls**. The rule chart shows the new version with catch rate higher.

### Part 2, a real person through their own Muse

1. Max, on the phone: "Join Lane challenge <join code>." Muse shows the terms. Max answers "yes" himself; Muse never accepts for him.
2. Max: "Send Lane my latest commit on <repo>." The proof appears in the feed.
3. Max: "Check in with Lane." Muse relays the standings and any request.

### Part 3, optional, only if Parts 1 and 2 finished early

- AE8: a thin commit gets an extra-proof request. Max asks Muse to check in; Muse relays "put code NNNN in your next commit message" and the standing, and switches to the new contract version.
- AE6: Antoine advances the clock to the end and clicks **Close window**, then approves the payout if a share is above 150 credits.

All credits are play credits, no real money (R7). Say it once on stage.

## Fallbacks

| Failure | Pre-decided action |
|---|---|
| Muse cannot call Lane by any route (2:30 PM checkpoint) | Scripted players carry the demo. Max narrates what Muse would do and runs `pnpm standin --url <url>` on the laptop to show an agent that knows only the connector joining and checking in. |
| Muse calls work but each call asks "Allow Muse to share information..." | Choose "Always allow this site". If it keeps asking, drive check-ins manually on stage (R12) by asking Muse each time. |
| Muse routine stalls on approval prompts | Skip the routine. Max asks Muse to check in or send proof on cue (R12). |
| MCP route fails for Muse but JSON works | Use the JSON mirror (U19) at `/api/v1/` through Muse's API-based custom connector. |
| Agents not deployed by 2:45 PM, or Agent Engine preview breaks | Run `agentengine dev up` on the fallback laptop behind a public tunnel and switch the deployed core's agent mode to `local`. In local mode the dashboard's approve activates the rule through U9 directly, and the approval record still gates it. Tell the judges the agents run locally. |
| Resume refuses the service-account token | Approve on Lane's dashboard first (records the approval), then approve on Agent Engine's Pending Reviews page. |
| Agent egress to Lane blocked | Switch to no-egress mode: the core runs the gate between two rule-lab invocations and applies the promoter's decision through U9. Activation still needs the approved record. |
| Full AE1 not running on the deployed site at 4:00 PM | Both people stop all other merges and work only on AE1. |
| A deploy after 4:30 PM breaks the site | Vercel instant rollback to the pinned deployment (next section). |
| Approve clicked, resume failed | The approval entry shows **Retry**. Click it once; it re-sends the same decision. |
| Post re-fetch fails for X or LinkedIn | Build in Public is not the stage challenge. Posts fall back to agent-attested (KTD14). Do not demo Build in Public. |
| Team behind at 3 PM | Build in Public drops first, then Talk to Customers (KTD19). Ship Week always ships. |
| Deployment Protection blocks Meta or Agent Engine | Turn protection off for the production alias in Vercel project settings. |
| Raindrop outage | Nothing changes in Lane (KTD24). Skip the Raindrop view. |
| Dashboard stops updating | Reload. The data routes call the tick on every poll, so a reload also recovers stalled jobs. |
| GitHub rate limit or a sandbox push fails | Use the second scripted player's repository, or narrate from the last good run. Do not switch to a personal token on stage. |

## Pinned deployment and rollback

1. At 4:30 PM merges freeze. In the Vercel dashboard, open the project's Deployments, find the current production deployment, and copy its `*.vercel.app` URL into the table at the top of this file.
2. Run `pnpm mcp:smoke --url <pinned url>` and confirm PASS.
3. Run both rehearsals against the pinned URL, each from a reset.
4. If anything is promoted to production after the freeze by mistake, or production breaks: Vercel dashboard, Deployments, the pinned deployment, **Instant Rollback**. Or from the laptop: `vercel rollback <pinned url>`. Then run `pnpm mcp:smoke --url https://lane-seven-phi.vercel.app` to confirm the alias answers.
5. Muse stays pointed at the production alias. After a rollback, ask Muse to check in once to confirm it still reaches Lane.

## Rehearsal log

| Run | Time | Reset done | AE1 junk to rule catch | Result | Notes |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
