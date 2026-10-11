import type { Features } from "../../schema/common";
import { NOTE_CAP_CHARS } from "../../config";

/**
 * Talk to Customers feature extractor (U15 approach steps 2 and 3).
 *
 * Calendar proof carries third-party data, so the proof schema's parse (KTD15) runs these
 * helpers first: every attendee becomes a domain, and notes are capped with any address inside
 * them reduced to its domain. Nothing after the parse (referee input, stored payload, events,
 * logs, features) ever sees a full address. The extractor then reads only the reduced proof.
 */

// ------------------------------------------------------------------ domains

/** Consumer mailbox providers. A call whose outside attendees all use one of these is the personal-email class. */
export const PERSONAL_EMAIL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "qq.com",
  "163.com",
  "web.de",
  "free.fr",
  "orange.fr",
  "laposte.net",
  "videotron.ca",
  "sympatico.ca",
] as const;

const PERSONAL_SET: ReadonlySet<string> = new Set(PERSONAL_EMAIL_DOMAINS);
/** Country variants of the large consumer providers, such as yahoo.fr, hotmail.co.uk or yahoo.com.br. */
const PERSONAL_FAMILY = /^(yahoo|ymail|hotmail|outlook|live|gmx|yandex)\.(?:[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;

export function isPersonalDomain(domain: string): boolean {
  return PERSONAL_SET.has(domain) || PERSONAL_FAMILY.test(domain);
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_BODY = `${LABEL}(?:\\.${LABEL})*\\.[a-z]{2,24}`;
/** An email address. The local part stops at characters that delimit addresses in a header or a list. */
const EMAIL = new RegExp(`[^\\s<>()\\[\\],;:"']+@(${DOMAIN_BODY})(?![a-z0-9-])`, "gi");
/** A bare domain, optionally with a leading `@` or a trailing dot. */
const BARE_DOMAIN = new RegExp(`^@?(${DOMAIN_BODY})\\.?$`, "i");

/** The marker for the player's own address: a leading `self:` or a trailing `(self)`. */
const SELF_PREFIX = /^\s*self\s*:\s*/i;
const SELF_SUFFIX = /\s*\(self\)\s*$/i;

/** Every domain in one attendee entry, in order, lowercase. */
function domainsIn(entry: string): string[] {
  const found = [...entry.matchAll(EMAIL)].map((m) => (m[1] ?? "").toLowerCase());
  if (found.length > 0) return found;
  const bare = BARE_DOMAIN.exec(entry.trim());
  return bare?.[1] ? [bare[1].toLowerCase()] : [];
}

/** "Jane <jane@acme.com>", "jane@acme.com" or "acme.com" to "acme.com"; null when the entry has no address or domain. */
export function toDomain(entry: string): string | null {
  return domainsIn(entry.replace(SELF_PREFIX, "").replace(SELF_SUFFIX, ""))[0] ?? null;
}

export interface ReducedAttendees {
  /** Domain of the entry marked as the player's own address, or null when none is marked. */
  player_domain: string | null;
  /** Unique domains of every other attendee, in first-seen order. */
  attendee_domains: string[];
}

/**
 * KTD15: reduce an attendee list to domains. Names and local parts are dropped here and never
 * stored. The first address of the first entry marked `self:` (or `(self)`) is the player's own.
 * Every other address, including any later entry marked self, is an attendee, so a self marker
 * cannot hide one. The player's colleagues stay in `attendee_domains` with the player's domain.
 */
export function reduceAttendees(entries: readonly string[]): ReducedAttendees {
  let playerDomain: string | null = null;
  const others: string[] = [];
  for (const raw of entries) {
    const self = SELF_PREFIX.test(raw) || SELF_SUFFIX.test(raw);
    const domains = domainsIn(raw.replace(SELF_PREFIX, "").replace(SELF_SUFFIX, ""));
    if (self && playerDomain === null && domains.length > 0) {
      playerDomain = domains[0] ?? null;
      others.push(...domains.slice(1));
    } else {
      others.push(...domains);
    }
  }
  return { player_domain: playerDomain, attendee_domains: [...new Set(others)] };
}

/**
 * KTD15: cap a note summary. Any address inside it is reduced to its domain first, so a cut can
 * never leave part of an address. Blank notes become null.
 */
export function reduceNotes(notes: string | null | undefined): string | null {
  if (notes === null || notes === undefined) return null;
  const reduced = notes.replace(EMAIL, (_match, domain: string) => domain.toLowerCase()).replace(/\s+/g, " ").trim();
  return reduced ? reduced.slice(0, NOTE_CAP_CHARS) : null;
}

// ------------------------------------------------------------------ extractor

/** The reduced proof fields the extractor reads. */
export interface CallFacts {
  starts_at: string;
  ends_at: string;
  player_domain: string | null;
  attendee_domains: readonly string[];
  notes_summary: string | null;
}

export const SHORT_CALL_MINUTES = 5;

/** Whole minutes between start and end; 0 when the times are unreadable or reversed. */
export function callMinutes(facts: Pick<CallFacts, "starts_at" | "ends_at">): number {
  const ms = Date.parse(facts.ends_at) - Date.parse(facts.starts_at);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60_000) : 0;
}

/** The player's company domain: the marked domain unless it is a personal one, which is never a company. */
function companyDomain(playerDomain: string | null): string | null {
  return playerDomain && !isPersonalDomain(playerDomain) ? playerDomain : null;
}

/**
 * Outside attendee domains: every attendee domain except the player's own company domain. When
 * the player uses gmail.com, a gmail.com attendee is still outside.
 */
export function outsideDomains(facts: Pick<CallFacts, "player_domain" | "attendee_domains">): string[] {
  const company = companyDomain(facts.player_domain);
  return facts.attendee_domains.filter((d) => d !== company);
}

/** Features of one calendar event, from the reduced proof. */
export function extractCustomersFeatures(facts: CallFacts): Features {
  const minutes = callMinutes(facts);
  const outside = outsideDomains(facts);
  const company = companyDomain(facts.player_domain);
  return {
    duration_min: minutes,
    attendee_count: outside.length,
    attendee_domains: [...facts.attendee_domains],
    all_personal_email: outside.length > 0 && outside.every(isPersonalDomain),
    internal_only: company !== null && facts.attendee_domains.length > 0 && facts.attendee_domains.every((d) => d === company),
    has_notes: facts.notes_summary !== null,
    short_call: minutes < SHORT_CALL_MINUTES,
  };
}

/** Lane-built feed line from features, for example "call, 30 min, 2 outside domains, notes" (KTD15). */
export function summarizeCustomers(features: Features): string {
  const minutes = Number(features.duration_min ?? 0);
  const outside = Number(features.attendee_count ?? 0);
  const notes = features.has_notes === true ? ", notes" : "";
  return `call, ${minutes} min, ${outside} outside ${outside === 1 ? "domain" : "domains"}${notes}`;
}
