import { vi } from "vitest";
import { RAINDROP_EVENTS_URL, RAINDROP_SIGNALS_URL } from "../../src/observe/raindrop";

/** One Raindrop request captured by the global fetch stub. */
export interface RaindropCall {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>[];
}

export const TEST_RAINDROP_KEY = "test-raindrop-write-key";

/**
 * Sets RAINDROP_WRITE_KEY and stubs global fetch so U20 hook tests never reach the network.
 * Only Raindrop URLs are recorded; any other global fetch fails the test. With `reject`, every
 * Raindrop request rejects, to prove a failed send changes no result. Call
 * `vi.unstubAllGlobals()` and `vi.unstubAllEnvs()` after each test.
 */
export function stubRaindrop(opts: { reject?: boolean } = {}) {
  vi.stubEnv("RAINDROP_WRITE_KEY", TEST_RAINDROP_KEY);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const calls: RaindropCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url !== RAINDROP_EVENTS_URL && url !== RAINDROP_SIGNALS_URL) {
      throw new Error(`real network call attempted: ${url}`);
    }
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>[],
    });
    if (opts.reject) throw new Error("raindrop is down");
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetchMock);

  /** Wait for the fire-and-forget sends to reach fetch. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  const signals = () => calls.filter((c) => c.url === RAINDROP_SIGNALS_URL);
  const events = () => calls.filter((c) => c.url === RAINDROP_EVENTS_URL);
  return { calls, fetchMock, settle, signals, events };
}
