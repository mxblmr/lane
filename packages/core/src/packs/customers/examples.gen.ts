import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Features } from "../../schema/common";
import type { LabelledExample } from "../../schema/examples";
import { extractCustomersFeatures, summarizeCustomers } from "./features";
import { CUSTOMERS_CHEAT_CLASSES, type CustomersCheatClass } from "./predicates";
import { CustomersProofSchema } from "./index";

/**
 * Generator for `examples.json` (U15 approach step 5, R31). Each example is a synthetic calendar
 * event in the flat shape Muse sends, run through the same path as a live proof: the proof
 * schema's parse reduces it (KTD15) and `extractCustomersFeatures` reads the result. The labelled
 * features are therefore exactly what Lane computes for such a call. The generator refuses an
 * honest example that trips internal_only or short_call, or that has all_personal_email without
 * notes, and a cheat example whose own class feature is false.
 *
 * Honest calls include prospects on personal email who sent meeting notes, because real small
 * shops use gmail.com. That is why a plain personal-email rule fails the gate, and the AE2 rule
 * asks for notes instead.
 *
 * Regenerate after changing the parse or the extractor:
 *   pnpm exec tsx packages/core/src/packs/customers/examples.gen.ts
 * The pack test fails while `examples.json` is stale.
 */

const START = Date.parse("2026-10-05T07:00:00Z");

/** A time on challenge day `day` (0 to 6) plus `minutes`, in UTC. */
function at(day: number, hour: number, minute = 0): string {
  return new Date(START + day * 86_400_000 + hour * 3_600_000 + minute * 60_000).toISOString();
}

interface CallSpec {
  attendees: string[];
  minutes: number;
  notes?: string;
  day: number;
  hour: number;
  minute?: number;
}

function featuresOf(spec: CallSpec, n: number): Features {
  const startsAt = at(spec.day, spec.hour, spec.minute ?? 0);
  const proof = CustomersProofSchema.parse({
    event_id: `evt_${n.toString(36).padStart(6, "0")}`,
    starts_at: startsAt,
    ends_at: new Date(Date.parse(startsAt) + spec.minutes * 60_000).toISOString(),
    attendees: spec.attendees,
    notes: spec.notes,
  });
  return extractCustomersFeatures(proof);
}

// ------------------------------------------------------------------ pools

const PLAYER_DOMAINS = ["northloop.io", "brightcart.co", "fernstudio.com", "tidelabs.dev", "kilnworks.ca"];
const PLAYER_NAMES = ["gary", "priya", "maya", "sam", "lea"];
const CUSTOMER_DOMAINS = [
  "harborfoods.ca", "pinecrestgoods.com", "lumenretail.com", "atlasfreight.com", "bluefinapparel.com",
  "cedarclinic.io", "orbitpayments.com", "maplegrocers.ca", "quartzlegal.com", "riverbendcoffee.com",
  "summitgear.co", "vantaops.com", "wildroseskin.com", "zephyrbikes.com", "copperkettle.ca",
  "driftwoodhome.com", "emberfitness.com", "foxglovebooks.com", "granitebuild.com", "hollowtreetoys.com",
  "ironleafteas.com", "junipermedia.co", "kestrelanalytics.com", "lanternhotels.com", "mosaicdental.ca",
];
const CONTACTS = [
  ["Ana Ruiz", "ana"], ["Marc Tremblay", "marc"], ["Lena Fischer", "lena"], ["Omar Haddad", "omar"],
  ["Chloe Martin", "chloe"], ["Raj Patel", "raj"], ["Sofia Rossi", "sofia"], ["Ben Okafor", "ben"],
  ["Julie Gagnon", "julie"], ["Tom Becker", "tom"], ["Nina Kowalski", "nina"], ["Luis Ortega", "luis"],
] as const;
const PERSONAL = ["gmail.com", "yahoo.com", "icloud.com", "hotmail.com", "outlook.com", "proton.me"];
const HONEST_MINUTES = [8, 10, 12, 15, 20, 25, 30, 40, 45, 60];
const HONEST_NOTES = [
  "Walked through their returns flow. They want a pilot on two stores next month.",
  "Discovery call: 40 SKUs, Shopify Plus, pain is abandoned carts on mobile. Sending a proposal Friday.",
  "Renewal check-in. Happy with onboarding emails, asked for a quarterly review.",
  "They compared us with two other vendors. Pricing is fine, need a security questionnaire.",
  "Demo of the dashboard. Their ops lead asked about CSV exports and SSO.",
  "Follow-up on the trial: 3 of 5 users active, blocked on the calendar sync.",
  "Intro from a mutual customer. They run 4 cafes and want loyalty texts.",
];
const PROSPECT_NOTES = [
  "Solo seller on Etsy, 120 orders a month. Wants abandoned-cart emails before the holidays.",
  "Freelance bookkeeper, runs her practice from gmail. Asked for a quote for 3 seats.",
  "Small bakery owner. Interested in pre-orders, sent their menu and current order volume.",
  "Independent coach on Instagram. Wants a booking page, budget about 200 a month.",
  "Two-person candle shop. Walked through their Shopify setup and shipping rules.",
];

const contact = (k: number) => CONTACTS[k % CONTACTS.length]!;
const customer = (k: number) => CUSTOMER_DOMAINS[k % CUSTOMER_DOMAINS.length]!;
const withName = (k: number, domain: string) => `${contact(k)[0]} <${contact(k)[1]}@${domain}>`;
const address = (k: number, domain: string) => `${contact(k)[1]}@${domain}`;
const self = (k: number) => `self:${PLAYER_NAMES[k % PLAYER_NAMES.length]}@${PLAYER_DOMAINS[k % PLAYER_DOMAINS.length]}`;
const colleague = (k: number) => `ops@${PLAYER_DOMAINS[k % PLAYER_DOMAINS.length]}`;

// ------------------------------------------------------------------ honest calls

function honestCalls(): CallSpec[] {
  const out: CallSpec[] = [];
  for (let i = 0; i < 100; i++) {
    const day = i % 7;
    const hour = 14 + (i % 8);
    const minute = (i * 7) % 60;
    const minutes = HONEST_MINUTES[(i + Math.floor(i / 10)) % HONEST_MINUTES.length]!;
    const notes = i % 3 === 0 ? HONEST_NOTES[i % HONEST_NOTES.length] : undefined;
    const c = customer(i);
    let attendees: string[];
    let callNotes = notes;
    switch (i % 10) {
      case 0:
        attendees = [self(i), withName(i, c)];
        break;
      case 1:
        attendees = [self(i), address(i, c), address(i + 1, c)];
        break;
      case 2:
        attendees = [self(i), colleague(i), withName(i, c)];
        break;
      case 3:
        attendees = [address(i, c)];
        break;
      case 4:
        // A solo founder on gmail.com talking to a company.
        attendees = [`self:${PLAYER_NAMES[i % PLAYER_NAMES.length]}.builds@gmail.com`, withName(i, c)];
        break;
      case 5:
        attendees = [self(i), c];
        break;
      case 6:
        attendees = [self(i), address(i, c), address(i + 3, customer(i + 7))];
        break;
      case 7:
        attendees = [self(i), withName(i, c)];
        callNotes = HONEST_NOTES[(i + 2) % HONEST_NOTES.length];
        break;
      case 8:
        // A real prospect who uses personal email, with meeting notes.
        attendees = [self(i), address(i, PERSONAL[i % PERSONAL.length]!)];
        callNotes = PROSPECT_NOTES[i % PROSPECT_NOTES.length];
        break;
      default:
        attendees = [`${PLAYER_NAMES[i % PLAYER_NAMES.length]}@${PLAYER_DOMAINS[i % PLAYER_DOMAINS.length]} (self)`, colleague(i), withName(i, c)];
        callNotes = HONEST_NOTES[(i + 4) % HONEST_NOTES.length];
        break;
    }
    out.push({ attendees, minutes, notes: callNotes, day, hour, minute });
  }
  return out;
}

// ------------------------------------------------------------------ cheat calls

function cheatCalls(): Record<CustomersCheatClass, CallSpec[]> {
  return {
    // Calls with friends or family.
    all_personal_email: [
      { attendees: [self(0), "Jordan <jordan.k@gmail.com>"], minutes: 30, day: 0, hour: 19 },
      { attendees: ["mom.k@yahoo.com"], minutes: 45, day: 0, hour: 22 },
      { attendees: [self(1), "alex.runs@icloud.com"], minutes: 25, day: 1, hour: 18 },
      { attendees: ["self:gary.builds@gmail.com", "pal.from.school@gmail.com"], minutes: 40, day: 1, hour: 21 },
      { attendees: [self(2), colleague(2), "cousin.dee@hotmail.com"], minutes: 20, day: 2, hour: 17 },
      { attendees: [self(3), "sis@outlook.com", "bro@gmail.com"], minutes: 60, day: 2, hour: 20 },
      { attendees: ["Chris <chris1990@gmail.com>"], minutes: 15, day: 3, hour: 16 },
      { attendees: [self(4), "neighbour.anne@proton.me"], minutes: 35, day: 3, hour: 19 },
      { attendees: [self(0), "roommate@gmail.com"], minutes: 50, day: 4, hour: 21 },
      { attendees: ["self:priya.makes@gmail.com", "auntie.r@yahoo.com"], minutes: 30, day: 4, hour: 15 },
      { attendees: [self(1), "dave.golf@hotmail.fr"], minutes: 25, day: 5, hour: 18 },
      { attendees: [self(2), "old.teammate@gmail.com"], minutes: 45, day: 5, hour: 20 },
      { attendees: ["friend.kim@icloud.com", "friend.lee@gmail.com"], minutes: 30, day: 6, hour: 17 },
      // Agent-attested notes do not make a friend a customer.
      { attendees: [self(3), "best.friend@gmail.com"], minutes: 30, day: 1, hour: 22, notes: "Caught up about the weekend and his new job." },
      { attendees: [self(4), "dad@yahoo.com"], minutes: 20, day: 3, hour: 21, notes: "Talked about the business in general." },
      { attendees: ["self:sam.ships@gmail.com", "gym.buddy@gmail.com"], minutes: 40, day: 6, hour: 19, notes: "Chatted about my product idea." },
    ],
    // Meetings with only the player's own colleagues.
    internal_only: [
      { attendees: [self(0), colleague(0)], minutes: 15, day: 0, hour: 16 },
      { attendees: [self(1), `cto@${PLAYER_DOMAINS[1]}`, `design@${PLAYER_DOMAINS[1]}`], minutes: 30, day: 0, hour: 17 },
      { attendees: [self(2), `team@${PLAYER_DOMAINS[2]}`], minutes: 45, day: 1, hour: 15, notes: "Sprint planning for the checkout work." },
      { attendees: [self(3), `Jo Ng <jo@${PLAYER_DOMAINS[3]}>`], minutes: 30, day: 1, hour: 18 },
      { attendees: [self(4), PLAYER_DOMAINS[4]!], minutes: 20, day: 2, hour: 16 },
      { attendees: [self(0), colleague(0), `sales@${PLAYER_DOMAINS[0]}`, `cs@${PLAYER_DOMAINS[0]}`], minutes: 60, day: 2, hour: 19 },
      { attendees: [self(1), colleague(1)], minutes: 25, day: 3, hour: 15, notes: "Weekly one-on-one." },
      { attendees: [self(2), `founders@${PLAYER_DOMAINS[2]}`], minutes: 40, day: 4, hour: 17 },
      { attendees: [self(3), colleague(3), `intern@${PLAYER_DOMAINS[3]}`], minutes: 15, day: 4, hour: 20 },
      { attendees: [self(4), `Ops <ops@${PLAYER_DOMAINS[4]}>`], minutes: 30, day: 5, hour: 16, notes: "Reviewed the pipeline spreadsheet." },
      { attendees: [`${PLAYER_NAMES[0]}@${PLAYER_DOMAINS[0]} (self)`, colleague(0)], minutes: 20, day: 5, hour: 18 },
      { attendees: [self(1), `all-hands@${PLAYER_DOMAINS[1]}`], minutes: 50, day: 6, hour: 16 },
    ],
    // Calls under five minutes.
    short_call: [
      { attendees: [self(0), withName(0, customer(0))], minutes: 2, day: 0, hour: 18 },
      { attendees: [self(1), address(1, customer(1))], minutes: 1, day: 0, hour: 20 },
      { attendees: [address(2, customer(2))], minutes: 3, day: 1, hour: 16 },
      { attendees: [self(3), customer(3)], minutes: 2, day: 1, hour: 19 },
      { attendees: [self(4), withName(4, customer(4)), colleague(4)], minutes: 4, day: 2, hour: 15 },
      { attendees: ["self:maya.codes@gmail.com", address(5, customer(5))], minutes: 2, day: 2, hour: 21 },
      { attendees: [self(0), address(6, customer(6))], minutes: 1, day: 3, hour: 17 },
      { attendees: [self(1), withName(7, customer(7))], minutes: 3, day: 3, hour: 20, notes: "Left a voicemail." },
      { attendees: [self(2), address(8, customer(8)), address(9, customer(8))], minutes: 2, day: 4, hour: 16 },
      { attendees: [self(3), withName(10, customer(10))], minutes: 4, day: 5, hour: 19 },
      { attendees: [address(11, customer(11))], minutes: 2, day: 6, hour: 15 },
      { attendees: [self(4), customer(12)], minutes: 1, day: 6, hour: 18 },
    ],
  };
}

// ------------------------------------------------------------------ assemble

export function generateCustomersExamples(): LabelledExample[] {
  const examples: LabelledExample[] = [];
  let n = 1;
  honestCalls().forEach((spec, i) => {
    const features = featuresOf(spec, n++);
    const tripped: string[] = ["internal_only", "short_call"].filter((f) => features[f] === true);
    if (features.all_personal_email === true && features.has_notes !== true) tripped.push("all_personal_email without notes");
    if (tripped.length > 0) throw new Error(`honest example ${i + 1} trips ${tripped.join(", ")}`);
    examples.push({
      example_key: `cust-honest-${String(i + 1).padStart(3, "0")}`,
      label: "honest",
      cheat_class: null,
      features,
      summary: summarizeCustomers(features),
    });
  });
  const cheats = cheatCalls();
  for (const cls of CUSTOMERS_CHEAT_CLASSES) {
    cheats[cls].forEach((spec, i) => {
      const features = featuresOf(spec, n++);
      if (features[cls] !== true) throw new Error(`cheat example ${cls} ${i + 1} does not show ${cls}`);
      examples.push({
        example_key: `cust-cheat-${cls.replace(/_/g, "-")}-${String(i + 1).padStart(2, "0")}`,
        label: "cheat",
        cheat_class: cls,
        features,
        summary: summarizeCustomers(features),
      });
    });
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
  const examples = generateCustomersExamples();
  writeFileSync(target, formatExamplesJson(examples));
  const honest = examples.filter((e) => e.label === "honest").length;
  console.log(`wrote ${examples.length} examples (${honest} honest, ${examples.length - honest} cheat) to ${target}`);
}
