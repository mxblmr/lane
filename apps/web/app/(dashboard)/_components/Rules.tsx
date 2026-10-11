"use client";

import useSWR from "swr";
import type { RulesData } from "../../../lib/dashboard-data";
import { OpsButton } from "./OpsButton";
import { POLL_MS, clockTime, fetchJson, pct, type Serialized } from "./wire";

export type RulesWire = Serialized<RulesData>;

/** Every rule version with its parent, status and test results (R23, R29). */
export function RulesView({ data, operator, onChanged }: { data: RulesWire; operator: boolean; onChanged?: () => void }) {
  return (
    <div className="rules">
      {data.types.map((t) => (
        <section key={t.type} className="panel">
          <h2>{t.title}</h2>
          {t.rules.length === 0 ? <p className="muted">No rules yet.</p> : null}
          {t.rules.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Does not count</th>
                  <th>Action</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Catch rate</th>
                  <th>False alarms</th>
                  <th>Created</th>
                  {operator ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {t.rules.map((r) => (
                  <tr key={r.id} className={`status-${r.status}`}>
                    <td>
                      {r.rule_key} v{r.version}
                      <div className="muted">{r.parent_version !== null ? `parent v${r.parent_version}` : "no parent"}</div>
                    </td>
                    <td>{r.line ?? ""}</td>
                    <td>{r.action.replace(/_/g, " ")}</td>
                    <td>{r.source.replace(/_/g, " ")}</td>
                    <td>{r.status.replace(/_/g, " ")}</td>
                    <td>
                      {r.test_results ? `${pct(r.test_results.catch_rate_before)} to ${pct(r.test_results.catch_rate_after)}` : "not tested"}
                    </td>
                    <td>{r.test_results ? pct(r.test_results.false_alarm_set, 1) : ""}</td>
                    <td>{clockTime(r.created_at)}</td>
                    {operator ? (
                      <td>
                        {r.status === "active" && r.source !== "seed" && r.parent_version !== null ? (
                          <OpsButton
                            label={`Roll back to v${r.parent_version}`}
                            path="/api/ops/rollback"
                            body={{ challenge_type: r.challenge_type, rule_key: r.rule_key, confirm: true }}
                            confirm
                            tone="danger"
                            onDone={onChanged}
                          />
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ))}
    </div>
  );
}

export function RulesLive({ operator }: { operator: boolean }) {
  const { data, error, mutate } = useSWR<RulesWire>("/api/data/rules", fetchJson, { refreshInterval: POLL_MS, keepPreviousData: true });
  if (!data) return <p className="muted">{error ? `Could not load rules: ${(error as Error).message}` : "Loading..."}</p>;
  return <RulesView data={data} operator={operator} onChanged={() => void mutate()} />;
}
