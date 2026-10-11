import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  RAINDROP_EVENTS_URL,
  RAINDROP_SIGNALS_URL,
  RAINDROP_TIMEOUT_MS,
  trackEvent,
  trackSignal,
  type TrackEventInput,
} from "../../src/observe/raindrop";

const WRITE_KEY = "test-raindrop-write-key";

type FetchArgs = [input: string, init: RequestInit];
const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();
let warnSpy: MockInstance<typeof console.warn>;

function ok(): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 204 }));
}

function onlyCall(): FetchArgs {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error("fetch was not called");
  return call;
}

function parsedBody(init: RequestInit): unknown {
  expect(typeof init.body).toBe("string");
  return JSON.parse(init.body as string);
}

function headersOf(init: RequestInit): Headers {
  return new Headers(init.headers);
}

function warnings(): string {
  return warnSpy.mock.calls.map((args) => args.join(" ")).join("\n");
}

const refereeVerdict: TrackEventInput = {
  eventId: "verdict_123",
  userId: "player_sam",
  event: "referee.verdict",
  properties: {
    challenge_type: "ship_week",
    proof_id: "proof_9",
    verdict_id: "verdict_123",
    decided_by: "ai",
    cheat_class: "rename_only",
    ai_call_count: 1,
    latency_ms: 840,
    schema_valid: true,
  },
  aiData: {
    model: "referee-model",
    input: "commit: rename x to y\n- const x = 1\n+ const y = 1",
    output: '{"verdict":"reject","cheat_class":"rename_only"}',
    convoId: "challenge_ship_week",
  },
};

beforeEach(() => {
  fetchMock.mockReset();
  // Any call that a test did not set up fails loudly instead of reaching the network.
  fetchMock.mockImplementation(() =>
    Promise.reject(new Error("unexpected fetch: tests must not reach the network")),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RAINDROP_WRITE_KEY", WRITE_KEY);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  warnSpy.mockRestore();
});

describe("trackEvent", () => {
  it("posts a referee.verdict as one array body to the events endpoint with the bearer key", async () => {
    fetchMock.mockImplementation(ok);

    await trackEvent(refereeVerdict);

    const [url, init] = onlyCall();
    expect(url).toBe("https://api.raindrop.ai/v1/events/track");
    expect(url).toBe(RAINDROP_EVENTS_URL);
    expect(init.method).toBe("POST");
    const headers = headersOf(init);
    expect(headers.get("authorization")).toBe(`Bearer ${WRITE_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("x-raindrop-project-id")).toBe(false);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = parsedBody(init);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body).toStrictEqual([
      {
        event_id: "verdict_123",
        user_id: "player_sam",
        event: "referee.verdict",
        properties: refereeVerdict.properties,
        ai_data: {
          model: "referee-model",
          input: refereeVerdict.aiData?.input,
          output: refereeVerdict.aiData?.output,
          convo_id: "challenge_ship_week",
        },
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("omits ai_data for a rule.verdict decided with no AI call", async () => {
    fetchMock.mockImplementation(ok);

    await trackEvent({
      eventId: "verdict_456",
      userId: "player_sam",
      event: "rule.verdict",
      properties: { decided_by: "rule", ai_call_count: 0, rule_key: "rename_only", rule_version: 1 },
    });

    const [, init] = onlyCall();
    const body = parsedBody(init) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).not.toHaveProperty("ai_data");
    expect(body[0]).toStrictEqual({
      event_id: "verdict_456",
      user_id: "player_sam",
      event: "rule.verdict",
      properties: { decided_by: "rule", ai_call_count: 0, rule_key: "rename_only", rule_version: 1 },
    });
  });

  it("omits optional fields that were not given", async () => {
    fetchMock.mockImplementation(ok);

    await trackEvent({
      eventId: "exec_1",
      userId: "lane-system",
      event: "rule_lab.run",
      aiData: { input: "evidence", output: "candidate" },
    });

    const [, init] = onlyCall();
    expect(parsedBody(init)).toStrictEqual([
      {
        event_id: "exec_1",
        user_id: "lane-system",
        event: "rule_lab.run",
        ai_data: { input: "evidence", output: "candidate" },
      },
    ]);
  });
});

describe("trackSignal", () => {
  it("posts one array body to the signals endpoint with signal_type default", async () => {
    fetchMock.mockImplementation(ok);

    await trackSignal({
      eventId: "exec_1",
      signalName: "rule_activated",
      sentiment: "POSITIVE",
      properties: { rule_key: "rename_only", rule_version: 1 },
    });

    const [url, init] = onlyCall();
    expect(url).toBe("https://api.raindrop.ai/v1/signals/track");
    expect(url).toBe(RAINDROP_SIGNALS_URL);
    expect(init.method).toBe("POST");
    expect(headersOf(init).get("authorization")).toBe(`Bearer ${WRITE_KEY}`);
    expect(headersOf(init).get("content-type")).toBe("application/json");
    expect(parsedBody(init)).toStrictEqual([
      {
        event_id: "exec_1",
        signal_name: "rule_activated",
        sentiment: "POSITIVE",
        signal_type: "default",
        properties: { rule_key: "rename_only", rule_version: 1 },
      },
    ]);
  });

  it("sends a NEGATIVE signal without properties when none are given", async () => {
    fetchMock.mockImplementation(ok);

    await trackSignal({ eventId: "verdict_123", signalName: "live_cheat_missed", sentiment: "NEGATIVE" });

    const [, init] = onlyCall();
    expect(parsedBody(init)).toStrictEqual([
      {
        event_id: "verdict_123",
        signal_name: "live_cheat_missed",
        sentiment: "NEGATIVE",
        signal_type: "default",
      },
    ]);
  });
});

describe("failures never throw", () => {
  const sends = [
    ["trackEvent", () => trackEvent(refereeVerdict)],
    [
      "trackSignal",
      () => trackSignal({ eventId: "exec_1", signalName: "rule_activated", sentiment: "POSITIVE" }),
    ],
  ] as const;

  it.each(sends)("%s resolves when fetch rejects", async (_name, send) => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));

    await expect(send()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toContain("fetch failed");
  });

  it.each(sends)("%s resolves when fetch throws synchronously", async (_name, send) => {
    fetchMock.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(send()).resolves.toBeUndefined();
    expect(warnings()).toContain("boom");
  });

  it.each(sends)("%s resolves and logs the status on a non-2xx response", async (_name, send) => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("nope", { status: 500 })));

    await expect(send()).resolves.toBeUndefined();
    expect(warnings()).toContain("HTTP 500");
  });

  it.each(sends)("%s aborts the request and resolves at the 2-second timeout", async (_name, send) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });

    let settled = false;
    const pending = send().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(RAINDROP_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(RAINDROP_TIMEOUT_MS).toBe(2000);
    expect(warnings()).toContain("timed out after 2000ms");
  });

  it("resolves at the timeout even if fetch ignores the abort signal", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

    const pending = trackEvent(refereeVerdict);
    await vi.advanceTimersByTimeAsync(RAINDROP_TIMEOUT_MS);

    await expect(pending).resolves.toBeUndefined();
    expect(warnings()).toContain("timed out");
  });

  it("clears the timeout timer after a successful send", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(ok);

    await trackEvent(refereeVerdict);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves without a request when properties cannot be serialized", async () => {
    fetchMock.mockImplementation(ok);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      trackEvent({ eventId: "verdict_1", userId: "player_sam", event: "referee.verdict", properties: circular }),
    ).resolves.toBeUndefined();
    await expect(
      trackSignal({
        eventId: "verdict_1",
        signalName: "verdict_disputed",
        sentiment: "NEGATIVE",
        properties: { big: 1n },
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("never writes the write key into a log line", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("fetch failed")));
    await trackEvent(refereeVerdict);
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 401 })));
    await trackSignal({ eventId: "exec_1", signalName: "rule_activated", sentiment: "POSITIVE" });

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnings()).not.toContain(WRITE_KEY);
  });
});

describe("write key", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("makes no request when RAINDROP_WRITE_KEY is %s", async (_label, value) => {
    vi.stubEnv("RAINDROP_WRITE_KEY", value);

    await expect(trackEvent(refereeVerdict)).resolves.toBeUndefined();
    await expect(
      trackSignal({ eventId: "exec_1", signalName: "rule_activated", sentiment: "POSITIVE" }),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reads the key from the environment at call time", async () => {
    fetchMock.mockImplementation(ok);

    vi.stubEnv("RAINDROP_WRITE_KEY", undefined);
    await trackEvent(refereeVerdict);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("RAINDROP_WRITE_KEY", "first-key");
    await trackEvent(refereeVerdict);
    vi.stubEnv("RAINDROP_WRITE_KEY", "second-key");
    await trackSignal({ eventId: "exec_1", signalName: "rule_activated", sentiment: "POSITIVE" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls;
    expect(first && headersOf(first[1]).get("authorization")).toBe("Bearer first-key");
    expect(second && headersOf(second[1]).get("authorization")).toBe("Bearer second-key");
  });
});
