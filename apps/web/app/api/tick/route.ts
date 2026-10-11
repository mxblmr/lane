import { after } from "next/server";
import { laneDb } from "@lane/core/interfaces";
import { runTick, runTickJobs } from "@lane/core/tick";

// KTD13 and KTD20: the clock tick and job recovery. Safe to call concurrently and as often as
// the dashboard polls: a 15-second lease lets one tick run, every transition is conditional,
// and the response holds only counts. Due jobs run after the response, inside after().
// No Vercel cron: the plan tier is Hobby, so the dashboard's data routes drive the tick.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(): Promise<Response> {
  try {
    const db = await laneDb();
    const result = await runTick(db, { holder: "api/tick" });
    after(async () => {
      try {
        await runTickJobs(db);
      } catch (err) {
        console.error("tick jobs failed", err instanceof Error ? err.message : String(err));
      }
    });
    const { ran, transitions, jobs_reclaimed } = result;
    return Response.json(
      { ok: true, ran, transitions, jobs_reclaimed, closed: result.details.closed.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("tick failed", err instanceof Error ? err.message : String(err));
    return Response.json({ ok: false, error: "tick failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export const GET = handle;
export const POST = handle;
