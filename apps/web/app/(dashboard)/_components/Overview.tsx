"use client";

import useSWR from "swr";
import type { OverviewData } from "../../../lib/dashboard-data";
import { POLL_MS, credits, fetchJson, type Serialized } from "./wire";

export type OverviewWire = Serialized<OverviewData>;

/** The three challenges, one column per challenge type (R29). */
export function OverviewView({ data }: { data: OverviewWire }) {
  return (
    <div className="overview">
      <p className="meta">
        {data.pending_approvals > 0 ? (
          <span className="badge warn">{data.pending_approvals} waiting for approval</span>
        ) : (
          <span className="muted">Nothing waiting for approval</span>
        )}
        {data.tick.available ? null : <span className="muted">Tick not available yet</span>}
        {data.settings.learning_paused ? <span className="badge warn">Learning paused</span> : null}
      </p>
      <div className="columns">
        {data.types.map((t) => (
          <section key={t.type} className="panel">
            <h2>{t.title}</h2>
            {t.challenges.length === 0 ? <p className="muted">No live challenge.</p> : null}
            {t.challenges.map((card) => (
              <a key={card.challenge.id} className="card" href={`/c/${encodeURIComponent(card.challenge.id)}`}>
                <strong>{card.challenge.title}</strong>
                <span className="meta">
                  <span className={`badge status-${card.challenge.status}`}>{card.challenge.status}</span>
                  {card.challenge.stage ? <span className="badge">stage</span> : null}
                  {card.day_index !== null && card.challenge.clock ? (
                    <span>
                      Day {card.day_index + 1} of {card.challenge.clock.days}
                    </span>
                  ) : null}
                </span>
                <span>
                  {card.players} players, {card.proofs} proofs
                </span>
                <span>Pot {credits(card.pot, data.credit_label)}</span>
                {card.pending_approvals > 0 ? <span className="badge warn">{card.pending_approvals} waiting for approval</span> : null}
              </a>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

export function OverviewLive() {
  const { data, error } = useSWR<OverviewWire>("/api/data/overview", fetchJson, { refreshInterval: POLL_MS, keepPreviousData: true });
  if (!data) return <p className="muted">{error ? `Could not load challenges: ${(error as Error).message}` : "Loading..."}</p>;
  return <OverviewView data={data} />;
}
