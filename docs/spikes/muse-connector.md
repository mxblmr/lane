# Muse connector test (U2)

Tested on 2026-10-11 between 2:55 and 3:15 PM PDT, in Max's Muse at muse.ai in Chrome, against the production deployment `https://lane-seven-phi.vercel.app`.

## Decisions for the demo

- **Connector face:** MCP over streamable HTTP at `https://lane-seven-phi.vercel.app/api/mcp`. The JSON mirror (U19) is not needed and issue #19 is closed.
- **Identity style:** no auth header is needed to connect. Players send their Lane key as the `player_key` argument, which U7 supports alongside a bearer header. The bearer-header style was not tested.
- **Routine:** a Muse scheduled task. Muse accepted a 5-minute interval, so the plan's 27-minute check-in routine fits.
- **Approval setting:** each player's Muse must have "Always allow this site" set for `lane-seven-phi.vercel.app` before the demo, or routine runs stop at an approval prompt.

## What happened

1. **Adding the connector.** Muse's Settings → Connectors page lists only built-in apps (Gmail, Google Drive, GitHub and others) and has no custom-connector entry. Asking Muse in chat to connect to the MCP URL worked: Muse reported server `lane` v0.1.0, MCP protocol 2025-03-26 over streamable HTTP, no auth and no session ID, listed `lane_ping`, and returned the server time.
2. **Approval prompts.** Every call to Lane showed "Allow Muse to share information with lane-seven-phi.vercel.app?" with Allow once, Always allow this site and Deny. The first test needed two "Allow once" clicks, and the first scheduled setup needed one more. After "Always allow this site", Muse confirmed "Request approved permanently for this domain" and stopped asking.
3. **Scheduled task.** Asked for a ping every 5 minutes for 15 minutes, Muse created a real scheduled task ("Lane ping test (every 5 min)") plus a second task to stop it at 3:24 PM.
4. **Unattended run.** The 3:12 PM run fired on its own with no approval prompt and reached Lane. U7 had just replaced `lane_ping` with the eight `lane_` tools, so the call returned "Tool lane_ping not found". Muse then listed the new tools on its own, stopped the remaining scheduled runs, and posted a message in the chat explaining what changed. Results of a scheduled run therefore reach the player as a chat message without anyone watching.

## Not tested

- Sending the key as a bearer header in the connector.
- Intervals shorter than 5 minutes.
- Whether a player key persists between scheduled runs. Lane had no key flow live during the test; the routine text from `lane_register` should be checked once the database is connected.
- The Muse mobile app.

## Fallbacks

- **Muse cannot reach Lane on stage:** use the scripted players and the stand-in from the runbook, and drive check-ins from the presenter's laptop.
- **A routine stalls at an approval prompt:** open that player's Muse and choose "Always allow this site".
- **A scheduled run does not fire:** ask Muse to check in manually (R12).
