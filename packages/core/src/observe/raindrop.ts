// Raindrop agent observability (KTD24). Raindrop observes agent calls and rule
// decisions and never decides anything: every send is bounded by a 2-second
// timeout, a failure is logged and ignored, and nothing is sent when
// RAINDROP_WRITE_KEY is unset. Lane posts to the HTTP ingest API directly
// instead of using the raindrop-ai SDK, which flushes only on close().

export const RAINDROP_EVENTS_URL = "https://api.raindrop.ai/v1/events/track";
export const RAINDROP_SIGNALS_URL = "https://api.raindrop.ai/v1/signals/track";
export const RAINDROP_TIMEOUT_MS = 2000;

export type RaindropProperties = Record<string, unknown>;

export type RaindropSentiment = "POSITIVE" | "NEGATIVE";

export interface RaindropAiData {
  /** Model name, when Lane knows it. */
  model?: string;
  /** The quoted, capped input the agent already received. */
  input: string;
  /** The agent's output. */
  output: string;
  /** Lane's challenge id. */
  convoId?: string;
}

export interface TrackEventInput {
  /** Lane's verdict, job or execution id. Signals reference events by it. */
  eventId: string;
  /** The player id, or `lane-system`. */
  userId: string;
  /** For example `referee.verdict` or `rule.verdict`. */
  event: string;
  properties?: RaindropProperties;
  /** Omit for events with no AI call, such as `rule.verdict`. */
  aiData?: RaindropAiData;
}

export interface TrackSignalInput {
  /** The id of an event already sent through trackEvent. */
  eventId: string;
  /** For example `rule_activated` or `live_cheat_missed`. */
  signalName: string;
  sentiment: RaindropSentiment;
  properties?: RaindropProperties;
}

/** Wire shape of one element of the `/v1/events/track` array body. */
export interface RaindropEventBody {
  event_id: string;
  user_id: string;
  event: string;
  properties?: RaindropProperties;
  ai_data?: {
    model?: string;
    input: string;
    output: string;
    convo_id?: string;
  };
}

/** Wire shape of one element of the `/v1/signals/track` array body. */
export interface RaindropSignalBody {
  event_id: string;
  signal_name: string;
  sentiment: RaindropSentiment;
  signal_type: "default";
  properties?: RaindropProperties;
}

/**
 * Records one agent or rule event. Resolves within the 2-second timeout and
 * never rejects. Does nothing when RAINDROP_WRITE_KEY is unset.
 */
export async function trackEvent(input: TrackEventInput): Promise<void> {
  const body: RaindropEventBody = {
    event_id: input.eventId,
    user_id: input.userId,
    event: input.event,
  };
  if (input.properties !== undefined) body.properties = input.properties;
  if (input.aiData !== undefined) {
    const { model, input: aiInput, output, convoId } = input.aiData;
    body.ai_data = { input: aiInput, output };
    if (model !== undefined) body.ai_data.model = model;
    if (convoId !== undefined) body.ai_data.convo_id = convoId;
  }
  await send(RAINDROP_EVENTS_URL, [body], `event ${input.event}`);
}

/**
 * Records one signal on an event already sent. Resolves within the 2-second
 * timeout and never rejects. Does nothing when RAINDROP_WRITE_KEY is unset.
 */
export async function trackSignal(input: TrackSignalInput): Promise<void> {
  const body: RaindropSignalBody = {
    event_id: input.eventId,
    signal_name: input.signalName,
    sentiment: input.sentiment,
    signal_type: "default",
  };
  if (input.properties !== undefined) body.properties = input.properties;
  await send(RAINDROP_SIGNALS_URL, [body], `signal ${input.signalName}`);
}

async function send(url: string, body: unknown[], label: string): Promise<void> {
  // Read at call time so the key is never captured at import.
  const key = process.env.RAINDROP_WRITE_KEY?.trim();
  if (!key) return;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Race the request against the timer so the 2-second bound holds even if
    // a fetch implementation ignores the abort signal.
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        // Resolve before aborting so the race reports a timeout, not the
        // AbortError the abort raises in fetch.
        resolve("timeout");
        controller.abort();
      }, RAINDROP_TIMEOUT_MS);
    });
    const request = fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = await Promise.race([request, timedOut]);
    if (result === "timeout") {
      warn(`${label} timed out after ${RAINDROP_TIMEOUT_MS}ms`);
    } else if (!result.ok) {
      warn(`${label} failed with HTTP ${result.status}`);
    }
  } catch (error) {
    warn(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function warn(message: string): void {
  try {
    console.warn(`[raindrop] ${message}`);
  } catch {
    // Logging must never break a verdict, job or approval either.
  }
}
