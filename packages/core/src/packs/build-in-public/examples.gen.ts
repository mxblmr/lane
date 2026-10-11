import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LabelledExample } from "../../schema/examples";
import type { Features } from "../../schema/common";
import type { PackContext } from "../../schema/pack";
import type { Handle } from "../../schema/players";
import type { Proof } from "../../schema/proofs";
import { extractBuildInPublicFeatures, summarizeBuildInPublic } from "./features";
import { BIP_CHEAT_CLASSES, type BuildInPublicCheatClass } from "./predicates";
import { parsePostUrl, recheckPost, type BipPlatform } from "./recheck";

/**
 * Generator for `examples.json` (R31). Each example is a synthetic post run through the same
 * path as a live proof: `recheckPost` re-fetches it from a local fetch double that answers like
 * the platform's public endpoint (X returns the embed HTML, Instagram and Threads confirm the
 * post exists, a deleted post answers not found, LinkedIn makes no call), and
 * `extractBuildInPublicFeatures` reads the result against the player's earlier posts. The
 * labelled features are therefore exactly what Lane computes for such a post. The generator
 * refuses an honest example that trips any cheat feature, and a cheat example whose own class
 * feature is false. It never reaches the network.
 *
 * Regenerate after changing the extractor or the re-check:
 *   pnpm exec tsx packages/core/src/packs/build-in-public/examples.gen.ts
 * The pack test fails while `examples.json` is stale.
 */

const WINDOW_START_MS = Date.UTC(2026, 9, 5, 7, 0, 0);
const FETCHED_AT = new Date("2026-10-12T07:00:00Z");
const X_EPOCH_MS = 1_288_834_974_657;
const HANDLE: Handle = { platform: "x", handle: "player", status: "verified", bind_code: null, verified_at: FETCHED_AT };

// ------------------------------------------------------------------ post builders

interface PostSpec {
  platform: BipPlatform;
  text: string;
}

function at(day: number, hour: number): number {
  return WINDOW_START_MS + day * 86_400_000 + hour * 3_600_000;
}

/** A URL whose id encodes the post time where the platform does (X, LinkedIn). */
function postUrl(platform: BipPlatform, n: number, timeMs: number): string {
  const code = `Cbip${n.toString(36).padStart(5, "0")}`;
  switch (platform) {
    case "x":
      return `https://x.com/player/status/${((BigInt(timeMs - X_EPOCH_MS) << 22n) + BigInt(n % 4096)).toString()}`;
    case "linkedin":
      return `https://www.linkedin.com/feed/update/urn:li:activity:${((BigInt(timeMs) << 22n) + BigInt(n % 4096)).toString()}/`;
    case "instagram":
      return `https://www.instagram.com/p/${code}/`;
    case "threads":
      return `https://www.threads.net/@player/post/${code}`;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A fetch double that answers like the platform's public oEmbed endpoint for one post. */
function platformDouble(spec: PostSpec, exists: boolean): typeof fetch {
  return (async () => {
    if (!exists) {
      return spec.platform === "x"
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify({ error: { code: 24, is_transient: false } }), { status: 400 });
    }
    const html =
      spec.platform === "x"
        ? `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">${escapeHtml(spec.text).replace(/\n/g, "<br>")}</p>&mdash; Player (@player) <a href="https://x.com/player/status/1">October 2026</a></blockquote>`
        : `<blockquote class="text-post-media"><a href="https://example.invalid/">View this post</a></blockquote>`;
    const body = spec.platform === "x" ? { author_url: "https://x.com/player", author_name: "Player", html } : { html };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

type Earlier = Pick<Proof, "player_id" | "source_key" | "payload">;

async function featuresOf(spec: PostSpec, n: number, day: number, earlier: Earlier[], exists = true): Promise<{ features: Features; self: Earlier }> {
  const url = postUrl(spec.platform, n, at(day, 18));
  const post = parsePostUrl(url);
  if (!post) throw new Error(`generator built an unparseable URL: ${url}`);
  const ctx: PackContext = { now: FETCHED_AT, fetch: platformDouble(spec, exists), githubToken: null };
  const recheck = await recheckPost({ post_url: url, platform: spec.platform }, HANDLE, ctx);
  const sourceKey = `${post.platform}:${post.post_id}`;
  const proof = { post_text: spec.text, platform: spec.platform };
  const features = extractBuildInPublicFeatures({ proof, sourceKey, recheck, earlierProofs: earlier, player_id: "plr_player" });
  return { features, self: { player_id: "plr_player", source_key: sourceKey, payload: { post_url: post.canonical_url, platform: spec.platform, post_text: spec.text } } };
}

// ------------------------------------------------------------------ honest posts: one player per row, one post per day

interface HonestPlayer {
  platform: BipPlatform;
  posts: string[];
}

function honestPlayers(): HonestPlayer[] {
  return [
    {
      platform: "x",
      posts: [
        "Day 1 of building Ledgerly in public. Set up the Next.js app, auth with magic links, and a Postgres schema for invoices.",
        "Day 2: invoice PDF export works. Took longer than expected because of font embedding, but it renders the same in Chrome and Safari now.",
        "Shipped recurring invoices today. You pick a schedule and Ledgerly drafts the next one 3 days before it is due.",
        "Talked to 4 freelancers about late payments. All of them want automatic reminders, so that is tomorrow's job.",
        "Automatic payment reminders are live: a gentle nudge at 7 days overdue, a firmer one at 14. Copy is in reminders.ts if you want to steal it.",
        "Stripe checkout links on every invoice now. First real payment came through this afternoon, $240 from a design client.",
        "Week one wrap-up: 11 signups, 3 paying, 1 bug report about currency rounding that I fixed in about ten minutes. Next week: multi-currency.",
      ],
    },
    {
      platform: "linkedin",
      posts: [
        "Starting a 7-day build in public challenge. I am building a scheduling tool for physiotherapy clinics. Today I mapped the booking flow with two clinic owners and cut it from 9 steps to 4.",
        "Built the first version of the calendar view today. Each therapist gets a column, and drag and drop moves an appointment without a page reload. Still rough on mobile.",
        "Spent the day on SMS reminders. No-shows cost the clinics I talked to roughly 12% of their slots, so this is the feature that pays for the product.",
        "Today was less glamorous: wrote the database migrations for multi-location clinics and backfilled the two pilot accounts. Nothing visible, but it unblocks the next month.",
        "A clinic owner asked for a waitlist when a slot frees up. Built it in an afternoon: patients opt in, and the first one to reply gets the slot.",
        "Ran the first real week of bookings through the pilot clinic. 63 appointments, 2 no-shows, both of which got the reminder. Learning a lot from the support inbox.",
        "Last day of the challenge. Shipped the billing page and annual pricing, and wrote down what I learned: talk to users before writing the schema, not after.",
      ],
    },
    {
      platform: "x",
      posts: [
        "Got the grappling hook physics feeling right today. The trick was clamping the rope length instead of using a spring.",
        "Added a level select screen and 3 new levels. The third one is mean, sorry.",
        "Rewrote the save system so progress syncs between the Steam Deck and desktop. Uses a tiny JSON file per slot.",
        "Playtest night with friends: everyone got stuck on the same jump in level 2, so I widened the ledge by half a tile.",
        "Composed the main menu theme in one long evening. 90 seconds, loops cleanly, and the file is menu_theme.ogg in the repo.",
        "Particles for the dash ability. Small thing, but the game feels twice as fast with them.",
        "Steam page draft is up for review. Capsule art, 5 screenshots and a short trailer cut from today's build.",
      ],
    },
    {
      platform: "instagram",
      posts: [
        "Building my ceramics shop in public this week. Today I photographed the first 12 mugs and set up the product pages.",
        "Wrote care instructions for every glaze and added them as a tab on the product page. Customers kept asking by email.",
        "Set up shipping rates by weight after a few painful quotes. Mugs ship in double boxes now.",
        "Kiln day, so no code. Spent the evening writing the story of the studio for the about page.",
        "Launched the restock waitlist. 37 people signed up for the speckled bowls in the first hour.",
        "Moved product photos to a lighter format and the collection page loads in half the time on my phone.",
        "First wholesale inquiry came in through the contact form, from a cafe two streets away.",
      ],
    },
    {
      platform: "threads",
      posts: [
        "Day 1: wired up the transcription pipeline. Audio goes in, a cleaned transcript comes out in about 20 seconds for a 10 minute call.",
        "Summaries now pull out action items with an owner and a due date. Tested it on 15 real meeting recordings from friends.",
        "Built search across all notes with embeddings. Searching for pricing finds the call where we argued about tiers, even though nobody said the word.",
        "Honest update: the summary quality dropped on calls with more than three speakers. Spent today on speaker labels instead of new features.",
        "Speaker labels are in. Accuracy on my test set went from 71% to 88%.",
        "Slack integration ships tomorrow: the bot posts the summary in the channel where the meeting was scheduled. Spent today on the permissions screen.",
        "Opened the beta to the first 25 people on the waitlist. Two of them found the same crash within an hour, fixed in v0.3.1.",
      ],
    },
    {
      platform: "linkedin",
      posts: [
        "Spent the whole day interviewing operations managers about how they track vendor contracts. Spreadsheets everywhere, and nobody trusts them.",
        "Turned yesterday's interviews into a one page problem statement and shared it with the five people I talked to. Three replied with corrections, which is the best outcome.",
        "Built a rough prototype that reads a contract and pulls out the renewal date, notice period and price. Works on 8 of the 10 contracts I tested.",
        "Rebuilt the upload flow so a contract can come from email forwarding instead of a file picker. Every interviewee mentioned their inbox first.",
        "Today I said no to a big feature request from a potential customer. It would have taken two weeks and helped exactly one company.",
        "Renewal alerts now go out 60 days before the notice deadline, with a link to the clause in the original document.",
        "Wrapped the week by pricing the product. Landed on a flat monthly fee per company rather than per seat, because the buyers are small teams.",
      ],
    },
    {
      platform: "x",
      posts: [
        "Pushed the first version of envcheck, a CLI that diffs your .env against .env.example and fails CI when keys are missing. github.com/ana/envcheck",
        "envcheck now supports monorepos: point it at a workspace and it checks every package. Added tests for pnpm and npm workspaces.",
        "Someone opened the first issue on envcheck! Windows paths were broken. Fixed with path.posix and a test that runs on windows-latest.",
        "Wrote the README properly: install, a 30 second demo gif, and a section on using it as a pre-commit hook.",
        "Added a --fix flag that appends missing keys with empty values and a comment. Small, but people asked for it twice.",
        "Published v1.0.0 to npm. 140 weekly downloads already, mostly from one company running it in CI.",
        "Recorded a 4 minute walkthrough of how envcheck parses dotenv files, including the weird edge cases with multiline values.",
      ],
    },
    {
      platform: "instagram",
      posts: [
        "Building a habit tracker for my coaching clients this week. Today: the daily check-in screen with water, steps and sleep.",
        "Clients can now upload a progress photo each Sunday, and only I can see it. Privacy was the first thing they asked about.",
        "Added streaks. Two clients messaged me tonight just to say they did not want to break theirs.",
        "Built the coach view: every client on one screen, sorted by who missed check-ins this week.",
        "Rest day from building. Spent it on the phone with three clients asking what they would pay for this.",
        "Weekly summary emails go out every Monday morning with each client's averages and one note from me.",
        "Moved the whole thing from my test workspace to production and invited all 18 clients.",
      ],
    },
    {
      platform: "x",
      posts: [
        "Started a browser extension that hides prices on shopping sites until you have waited 24 hours. Manifest v3 setup done.",
        "The cooldown timer works per product URL now, stored in chrome.storage so it survives restarts.",
        "Added support for 6 more stores. Each one needs its own price selector, which is the boring part.",
        "Built the popup with a list of everything you are waiting on and how long is left on each.",
        "Submitted to the Chrome Web Store. Review says up to 3 weeks, so I am writing the landing page meanwhile.",
        "Landing page is live at waitlist.so/ines-cooldown with a short demo video.",
        "First 50 installs from a Reddit post. The top request is a Firefox version, so that is next week.",
      ],
    },
    {
      platform: "threads",
      posts: [
        "Building in public, day one. My goal is a newsletter about bootstrapped SaaS pricing. Today I wrote the welcome email and set up the signup form.",
        "Published the first issue: how 5 small SaaS companies raised prices without losing customers.",
        "Set up a referral program: 3 referrals unlock the pricing teardown archive.",
        "Researched the second issue all day. Read every public pricing page of tools under 20 employees that I could find.",
        "Issue two is out. Open rate 61%, which I am told will not last.",
        "Moved the archive to a static site so issues show up in search. Each issue gets its own page with a canonical URL.",
        "Week one numbers: 212 subscribers, 9 replies, and one sponsor asking about rates.",
      ],
    },
    {
      platform: "linkedin",
      posts: [
        "This week I am building a soil moisture sensor for community gardens, in public. Day one: soldered the first board and read values over serial.",
        "Got the sensor reporting over LoRa to a gateway at the end of the garden, about 120 meters away.",
        "Wrote the firmware sleep cycle so a battery should last a full season. Measured 18 microamps in deep sleep.",
        "Built a small dashboard that shows each bed's moisture and turns a bed red when it is dry.",
        "Three gardeners tested the dashboard on their phones. They wanted fewer numbers and a simple water today or not.",
        "Redesigned the main view around that: one card per bed, a watering suggestion, and the history behind a tap.",
        "Printed enclosures for 6 sensors and installed them before the rain. Real data starts tomorrow.",
      ],
    },
    {
      platform: "x",
      posts: [
        "Built the event ingestion endpoint today. It takes batches of up to 500 events and writes them to ClickHouse.",
        "Funnels work. You pick steps and get conversion between each, computed in under a second on 2 million events.",
        "Spent the day on onboarding: a snippet to paste, and a live check that turns green when the first event arrives.",
        "Retention cohorts by signup week, rendered as the classic triangle chart.",
        "Found a nasty bug where events from two projects could mix when they shared a session id. Fixed and added a regression test.",
        "Pricing page is up: free under 100k events a month, then usage based.",
        "Three teams moved off Google Analytics onto the beta this week. Writing up what made them switch.",
      ],
    },
    {
      platform: "instagram",
      posts: [
        "Building my print shop in public. Today I scanned 20 illustrations at 600 dpi and cleaned the dust off in batches.",
        "Ordered test prints on three paper stocks and photographed them side by side for the product pages.",
        "Set up print on demand so I never hold stock. Each order goes straight to the printer in Lisbon.",
        "Wrote the shop's FAQ about sizes and framing. Most messages I get are about whether frames are included.",
        "Opened the shop to my mailing list first. 14 orders overnight, mostly the lighthouse series.",
        "Packaging day: designed a thank you card that slips into every tube.",
        "Added gift cards before the holidays and a size guide with a photo of each print on a real wall.",
      ],
    },
    {
      platform: "threads",
      posts: [
        "Day 1 of building Pocketplan in public. Today: set up the Expo project and the bottom tab navigation.",
        "Day 2 of building Pocketplan in public. Today: the budget screen with categories and a monthly limit.",
        "Day 3 of building Pocketplan in public. Today: bank sync through Plaid in sandbox mode.",
        "Day 4 of building Pocketplan in public. Today: push notifications when a category goes over its limit.",
        "Day 5 of building Pocketplan in public. Today: dark mode and a settings screen.",
        "Day 6 of building Pocketplan in public. Today: TestFlight build out to 12 friends.",
        "Day 7 of building Pocketplan in public. Today: fixed the 4 crashes the testers found and wrote the App Store copy.",
      ],
    },
    {
      platform: "x",
      posts: [
        "Shipped dark mode. tessbuilds.dev/changelog",
        "v0.2 is live: CSV export and tags.",
        "Fixed the login redirect loop in auth.ts",
        "New onboarding checklist, 3 steps instead of 7.",
        "Webhooks retry now, with exponential backoff.",
        "Cut the bundle size by 40%.",
        "Search across projects shipped today: tessbuilds.dev/search",
      ],
    },
  ];
}

// ------------------------------------------------------------------ cheats

interface CheatSpec {
  post: PostSpec;
  /** The same player's earlier posts in the challenge, oldest first. */
  earlier?: PostSpec[];
  /** False when the platform answers that the post does not exist. */
  exists?: boolean;
}

function cheats(): Record<BuildInPublicCheatClass, CheatSpec[]> {
  const x = (text: string): PostSpec => ({ platform: "x", text });
  const li = (text: string): PostSpec => ({ platform: "linkedin", text });
  const ig = (text: string): PostSpec => ({ platform: "instagram", text });
  const th = (text: string): PostSpec => ({ platform: "threads", text });
  const longPost =
    "Big milestone today: we migrated every customer to the new billing system, rewrote the invoice emails and finally retired the old admin panel after 2 years.";
  return {
    filler: [
      { post: x("working on stuff today") },
      { post: li("Productive day, more tomorrow") },
      { post: ig("Grinding 💪") },
      { post: x("Day 3: working on stuff today #buildinpublic #indiehackers #saas #startup") },
      { post: th("Big things coming soon 👀") },
      { post: x("Another day, another commit") },
      { post: li("Still building. Stay tuned!") },
      { post: x("Making progress on the app") },
      { post: x("Day 5/30 of #100DaysOfCode ✅") },
      { post: th("Heads down coding all day") },
      { post: x("Shipping, shipping, shipping") },
      { post: li("Worked on the product today, felt good") },
      { post: x("gm builders, back at it") },
      { post: ig("Small wins today 🙌") },
      { post: th("Busy day of building, update soon") },
      { post: li("Quick update: still working on it"), earlier: [li(longPost)] },
    ],
    near_duplicate: [
      {
        earlier: [x("Day 3: shipped the Stripe webhook handler and wrote tests for failed payments.")],
        post: x("Day 4: shipped the Stripe webhook handler and wrote tests for failed payments."),
      },
      {
        earlier: [li("Spent today on the onboarding flow, cut it from 6 screens to 3 and added a progress bar.")],
        post: li("Spent today on the onboarding flow, cut it from 6 screens to 3 and added a progress bar!"),
      },
      {
        earlier: [x("Built the CSV export for invoices and fixed the timezone bug in reminders.")],
        post: x("Built the CSV export for invoices today and fixed the timezone bug in reminders."),
      },
      {
        earlier: [x("New landing page is live with a demo video and a waitlist form: getpocket.dev")],
        post: x("New landing page is live with a demo video and a waitlist form: https://getpocket.dev/v2"),
      },
      { earlier: [li(longPost)], post: li(`${longPost} #buildinpublic #saas #startups`) },
      {
        earlier: [ig("Added dark mode and a settings screen to the iOS app, plus 2 bug fixes.")],
        post: ig("Added dark mode and a settings screen to the iOS app, plus 3 bug fixes."),
      },
      {
        earlier: [li("Wrote the database migrations for multi-location accounts and backfilled the pilot data.")],
        post: li("Wrote the database migrations for multi location accounts and backfilled the pilot data today."),
      },
      {
        earlier: [x("Recorded a 5 minute walkthrough of the editor and posted it on the docs site.")],
        post: x("Recorded a 6 minute walkthrough of the editor and posted it on the docs site."),
      },
      {
        earlier: [th("Connected the Slack integration so summaries post to the meeting channel automatically.")],
        post: th("Connected the Slack integration so summaries post to the meeting channel automatically 🚀"),
      },
      {
        earlier: [ig("Photographed 12 new mugs for the shop and updated the product pages with care instructions.")],
        post: ig("Photographed 14 new mugs for the shop and updated the product pages with care instructions."),
      },
      {
        earlier: [th("Search now works across all notes, including attachments and comments.")],
        post: th("Search now works across all notes including attachments and comments!!"),
      },
      {
        earlier: [
          x("Pricing page is up: free under 100k events a month, then usage based."),
          x("Retention cohorts by signup week, rendered as a triangle chart."),
        ],
        post: x("Pricing page is up, free under 100k events per month, then usage based."),
      },
    ],
    post_missing: [
      { post: x("Shipped the new billing page with annual plans and a 20% discount."), exists: false },
      { post: x("Finished the API docs for the public endpoints, with examples in curl and Python."), exists: false },
      { post: ig("New collection is up in the shop: 8 hand-thrown bowls in a speckled glaze."), exists: false },
      { post: th("Rebuilt the onboarding emails and connected them to the signup webhook."), exists: false },
      { post: x("Day 4: deployed the search service and cut query time from 900ms to 120ms."), exists: false },
      { post: th("Wrote the migration that splits users into workspaces, ran it on staging first."), exists: false },
      { post: ig("Packed and shipped 23 orders today, the most in a single day so far."), exists: false },
      { post: x("Added rate limiting to the public API: 60 requests a minute per key."), exists: false },
      { post: th("Our Chrome extension passed review and is live in the store today."), exists: false },
      { post: x("Recorded a demo video of the dashboard and pinned it to the landing page."), exists: false },
      { post: ig("Photographed the whole autumn range on linen, 30 shots, editing tomorrow."), exists: false },
      { post: x("Merged the realtime collaboration branch, cursors and comments sync over websockets."), exists: false },
    ],
  };
}

// ------------------------------------------------------------------ assemble

const BOOLEAN_CHEATS: readonly string[] = BIP_CHEAT_CLASSES;

export async function generateBuildInPublicExamples(): Promise<LabelledExample[]> {
  const examples: LabelledExample[] = [];
  let n = 1;
  let honestIndex = 0;
  for (const player of honestPlayers()) {
    const earlier: Earlier[] = [];
    for (const [day, text] of player.posts.entries()) {
      const spec = { platform: player.platform, text };
      const { features, self } = await featuresOf(spec, n++, day, earlier);
      honestIndex += 1;
      const tripped = BOOLEAN_CHEATS.filter((f) => features[f] === true);
      if (tripped.length > 0) throw new Error(`honest example ${honestIndex} trips ${tripped.join(", ")}: ${text}`);
      examples.push({
        example_key: `bip-honest-${String(honestIndex).padStart(3, "0")}`,
        label: "honest",
        cheat_class: null,
        features,
        summary: summarizeBuildInPublic(features),
      });
      earlier.push(self);
    }
  }
  const all = cheats();
  for (const cls of BIP_CHEAT_CLASSES) {
    for (const [i, spec] of all[cls].entries()) {
      const earlier: Earlier[] = [];
      let day = 0;
      for (const prior of spec.earlier ?? []) earlier.push((await featuresOf(prior, n++, day++, earlier)).self);
      const { features } = await featuresOf(spec.post, n++, day, earlier, spec.exists ?? true);
      if (features[cls] !== true) throw new Error(`cheat example ${cls} ${i + 1} does not show ${cls}: ${spec.post.text}`);
      examples.push({
        example_key: `bip-cheat-${cls.replace(/_/g, "-")}-${String(i + 1).padStart(2, "0")}`,
        label: "cheat",
        cheat_class: cls,
        features,
        summary: summarizeBuildInPublic(features),
      });
    }
  }
  return examples;
}

/** One example per line, so reviews and diffs stay readable. */
export function formatExamplesJson(examples: readonly LabelledExample[]): string {
  return `[\n${examples.map((e) => `  ${JSON.stringify(e)}`).join(",\n")}\n]\n`;
}

const isMain = typeof process !== "undefined" && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const target = fileURLToPath(new URL("./examples.json", import.meta.url));
  const examples = await generateBuildInPublicExamples();
  writeFileSync(target, formatExamplesJson(examples));
  const honest = examples.filter((e) => e.label === "honest").length;
  console.log(`wrote ${examples.length} examples (${honest} honest, ${examples.length - honest} cheat) to ${target}`);
}
