"use client";

import useSWR from "swr";
import { useRouter } from "next/navigation";
import { StageScreen, type StageData } from "./StageScreen";
import { POLL_MS, fetchJson, type OpsAnswer } from "./wire";

/** Polls the challenge data route every 2.5 seconds (KTD16) and renders the stage screen. */
export function ChallengeLive({ id, operator }: { id: string; operator: boolean }) {
  const router = useRouter();
  const { data, error, mutate } = useSWR<StageData>(`/api/data/challenges/${encodeURIComponent(id)}`, fetchJson, {
    refreshInterval: POLL_MS,
    keepPreviousData: true,
  });

  const onChanged = (answer: OpsAnswer) => {
    const next = answer.body.new_challenge_id;
    if (answer.ok && typeof next === "string") {
      router.push(`/c/${encodeURIComponent(next)}`);
      return;
    }
    void mutate();
  };

  if (!data) {
    return <p className="muted">{error ? `Could not load this challenge: ${(error as Error).message}` : "Loading..."}</p>;
  }
  return (
    <>
      {error ? <p className="notice">Live updates paused: {(error as Error).message}</p> : null}
      <StageScreen data={data} operator={operator} onChanged={onChanged} />
    </>
  );
}
