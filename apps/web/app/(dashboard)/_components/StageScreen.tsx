"use client";

import { useState } from "react";
import type {
  ApprovalEntry,
  CandidateStep,
  ChallengeData,
  FeedEntry,
  PayoutApprovalEntry,
  RuleApprovalEntry,
  RuleVersionPoint,
} from "../../../lib/dashboard-data";
import { OpsButton } from "./OpsButton";
import {
  approvalPhase,
  clockTime,
  credits,
  decidedByLabel,
  pct,
  phaseLabel,
  recordedDecision,
  trustLabel,
  type OpsAnswer,
  type Serialized,
} from "./wire";

/**
 * The stage screen (U12, AE1): proof feed on one side; rule activity strip, approval queue and
 * rule version chart on the other. Player and AI text renders as plain text only (KTD16).
 * Operator controls render only when `operator` is true (the page checks the cookie).
 */

export type StageData = Serialized<ChallengeData>;

export interface StageScreenProps {
  data: StageData;
  operator: boolean;
  /** Called after any operator action so the caller can re-poll. */
  onChanged?: (answer: OpsAnswer) => void;
}

export function StageScreen({ data, operator, onChanged }: StageScreenProps) {
  const { challenge, clock } = data;
  const active = challenge.status === "active";
  return (
    <div className="stage">
      <header className="stage-header">
        <div>
          <p className="eyebrow">{data.pack_title}</p>
          <h1>{challenge.title}</h1>
          <p className="meta">
            <span className={`badge status-${challenge.status}`}>{challenge.status}</span>
            {clock ? (
              <span>
                {clock.current_day === null ? "Outside the window" : `Day ${clock.current_day + 1} of ${clock.days}`}
                {clock.mode === "demo" ? " (demo clock)" : ""}
              </span>
            ) : null}
            <span>Contract v{challenge.contract_version}</span>
            {data.tick.available ? null : <span className="muted">Tick not available yet</span>}
          </p>
        </div>
        <div className="pot">
          <span className="pot-label">Pot</span>
          <span className="pot-amount">{credits(data.pot, data.credit_label)}</span>
          {challenge.stake !== null ? <span className="muted">Stake {credits(challenge.stake, data.credit_label)}</span> : null}
        </div>
      </header>

      {challenge.status === "cancelled" ? (
        <p className="notice">
          This stage challenge was reset. <a href="/">Open the current challenges</a>.
        </p>
      ) : null}

      {operator ? (
        <section className="ops-bar" aria-label="Operator controls">
          <OpsButton
            label="Advance one day"
            path="/api/ops/advance-day"
            body={{ challenge_id: challenge.id, expected_day_index: clock?.day_index ?? -1 }}
            disabled={!active || !clock || clock.day_index >= clock.days}
            onDone={onChanged}
          />
          <OpsButton
            label="Close window"
            path="/api/ops/close-window"
            body={{ challenge_id: challenge.id, expected_status: "active", confirm: true }}
            confirm
            tone="danger"
            disabled={!active}
            onDone={onChanged}
          />
          <OpsButton
            label="Trigger surprise check"
            path="/api/ops/surprise-check"
            body={{ challenge_id: challenge.id }}
            disabled={!active}
            onDone={onChanged}
          />
          {challenge.stage ? (
            <OpsButton
              label="Reset stage"
              path="/api/ops/reset"
              body={{ challenge_type: challenge.type, confirm: true }}
              confirm
              tone="danger"
              onDone={onChanged}
            />
          ) : null}
        </section>
      ) : null}

      <div className="stage-grid">
        <section className="panel feed" aria-label="Proof feed">
          <h2>Proof feed</h2>
          {data.feed.length === 0 ? <p className="muted">No proofs yet.</p> : null}
          <ol className="feed-list">
            {data.feed.map((p) => (
              <FeedRow key={p.id} proof={p} operator={operator} onChanged={onChanged} />
            ))}
          </ol>
        </section>

        <div className="side">
          <RuleActivityStrip data={data} />
          <ApprovalQueue data={data} operator={operator} onChanged={onChanged} />
          <RuleChart versions={data.rules.versions} maxFalseAlarm={data.rules.thresholds.max_false_alarm_set} />
        </div>
      </div>

      <Standings data={data} />

      {data.activity.length > 0 ? (
        <section className="panel">
          <h2>Activity</h2>
          <ul className="activity">
            {data.activity.map((e) => (
              <li key={e.id}>
                <span className="muted">{clockTime(e.at)}</span> {e.summary}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function outcomeClass(status: string): string {
  if (status === "accepted") return "ok";
  if (status === "flagged_accept") return "warn";
  if (status === "rejected" || status === "not_counted") return "bad";
  return "wait";
}

function FeedRow({ proof, operator, onChanged }: { proof: Serialized<FeedEntry>; operator: boolean; onChanged?: (a: OpsAnswer) => void }) {
  const v = proof.verdict;
  const noAiCall = v !== null && v.decided_by === "rule" && v.ai_calls === 0;
  return (
    <li className={`feed-item outcome-${outcomeClass(proof.status)}`}>
      <div className="feed-top">
        <strong>{proof.display_name}</strong>
        <span className="muted">{clockTime(proof.received_at)}</span>
        {proof.day_index !== null ? <span className="muted">day {proof.day_index + 1}</span> : null}
      </div>
      <div className="feed-summary">{proof.summary ?? "Proof received"}</div>
      <div className="feed-badges">
        <span className={`badge outcome-badge-${outcomeClass(proof.status)}`}>{proof.status.replace(/_/g, " ")}</span>
        <span className={`badge decided-${v?.decided_by ?? "none"}`}>
          Decided by {decidedByLabel(v?.decided_by ?? null)}
          {v?.rule ? ` (${v.rule.rule_key} v${v.rule.version})` : ""}
        </span>
        {noAiCall ? <span className="badge no-ai">No AI call</span> : null}
        {v?.ai_judgment ? <span className="badge ai-judgment">AI judgment</span> : null}
        <span className="badge trust">{trustLabel(v?.trust_level ?? null)}</span>
      </div>
      {v ? (
        <p className="feed-reason">
          {v.reason ?? (v.cheat_class ? `Cheat class: ${v.cheat_class}${v.rule ? `, rule ${v.rule.rule_key}` : ""}` : "")}
        </p>
      ) : null}
      {operator && (proof.status === "accepted" || proof.status === "flagged_accept") ? (
        <OpsButton label="Mark as live cheat" path="/api/ops/live-cheat" body={{ proof_id: proof.id }} doneMessage="Sent to rule-lab." onDone={onChanged} />
      ) : null}
    </li>
  );
}

const STEPS: { step: CandidateStep; label: string }[] = [
  { step: "proposed", label: "Proposed" },
  { step: "tested", label: "Tested" },
  { step: "awaiting_approval", label: "Awaiting approval" },
  { step: "active", label: "Active" },
];

function RuleActivityStrip({ data }: { data: StageData }) {
  const activity = data.rules.activity;
  if (!activity) {
    return (
      <section className="panel strip" aria-label="Rule activity">
        <h2>Rule activity</h2>
        <p className="muted">No new rule in this run yet.</p>
      </section>
    );
  }
  const index = STEPS.findIndex((s) => s.step === activity.step);
  const gate = activity.rule.test_results;
  return (
    <section className="panel strip" aria-label="Rule activity">
      <h2>Rule activity</h2>
      <p className="rule-line">{activity.rule.line ?? `${activity.rule.rule_key} v${activity.rule.version}`}</p>
      {index === -1 ? (
        <p className="badge bad">{activity.step === "rejected" ? "Rejected" : "Retired"}</p>
      ) : (
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.step} className={i < index ? "step done" : i === index ? "step current" : "step"}>
              {s.label}
            </li>
          ))}
        </ol>
      )}
      {gate ? (
        <p className={gate.passed ? "gate ok" : "gate bad"}>
          Test gate {gate.passed ? "passed" : "failed"}: catch rate {pct(gate.catch_rate_before)} to {pct(gate.catch_rate_after)}, false
          alarms {pct(gate.false_alarm_set, 1)}
        </p>
      ) : null}
    </section>
  );
}

function ApprovalQueue({ data, operator, onChanged }: { data: StageData; operator: boolean; onChanged?: (a: OpsAnswer) => void }) {
  const pending = data.approvals.filter((a) => a.status === "pending");
  const decided = data.approvals.filter((a) => a.status !== "pending");
  return (
    <section className="panel approvals" aria-label="Approval queue">
      <h2>Approval queue</h2>
      {pending.length === 0 ? <p className="muted">Nothing waiting for approval.</p> : null}
      {pending.map((a) => (
        <ApprovalCard key={a.id} entry={a} creditLabel={data.credit_label} operator={operator} onChanged={onChanged} />
      ))}
      {decided.length > 0 ? <h3>Recently decided</h3> : null}
      {decided.map((a) => (
        <ApprovalCard key={a.id} entry={a} creditLabel={data.credit_label} operator={operator} onChanged={onChanged} />
      ))}
    </section>
  );
}

export function ApprovalCard({
  entry,
  creditLabel,
  operator,
  onChanged,
}: {
  entry: Serialized<ApprovalEntry>;
  creditLabel: string;
  operator: boolean;
  onChanged?: (a: OpsAnswer) => void;
}) {
  const [deciding, setDeciding] = useState(false);
  const phase = approvalPhase(entry);
  const finish = (answer: OpsAnswer) => {
    // Keep the buttons disabled after a successful decision until the poll shows the new phase.
    if (!answer.ok) setDeciding(false);
    onChanged?.(answer);
  };
  return (
    <article className={`approval phase-${phase}`}>
      <p className="approval-phase">{deciding && phase === "pending" ? "Deciding..." : phaseLabel(entry)}</p>
      {entry.kind === "rule" ? <RuleApprovalBody entry={entry} /> : <PayoutApprovalBody entry={entry} creditLabel={creditLabel} />}
      {operator && phase === "pending" ? (
        <div className="approval-actions">
          <OpsButton
            label="Approve"
            tone="primary"
            path="/api/ops/decide"
            body={{ approval_id: entry.id, decision: "approve" }}
            disabled={deciding}
            onStart={() => setDeciding(true)}
            onDone={finish}
          />
          <OpsButton
            label="Decline"
            path="/api/ops/decide"
            body={{ approval_id: entry.id, decision: "decline" }}
            disabled={deciding}
            onStart={() => setDeciding(true)}
            onDone={finish}
          />
        </div>
      ) : null}
      {operator && phase === "failed" ? (
        <div className="approval-actions">
          <OpsButton
            label="Retry"
            tone="primary"
            path="/api/ops/decide"
            body={{ approval_id: entry.id, decision: recordedDecision(entry), retry: true }}
            onDone={onChanged}
          />
          {entry.follow_up.error ? <span className="ops-error">{entry.follow_up.error}</span> : null}
        </div>
      ) : null}
    </article>
  );
}

function RuleApprovalBody({ entry }: { entry: Serialized<RuleApprovalEntry> }) {
  const gate = entry.gate;
  return (
    <>
      <p className="rule-line">{entry.line ?? `${entry.rule_key} v${entry.rule_version}`}</p>
      <dl className="facts">
        <dt>Action</dt>
        <dd>{entry.action.replace(/_/g, " ")}</dd>
        <dt>Rule</dt>
        <dd>
          {entry.rule_key} v{entry.rule_version}
          {entry.parent_version !== null ? `, changes v${entry.parent_version}` : ", new rule"}
        </dd>
        {entry.cheat_class ? (
          <>
            <dt>Cheat class</dt>
            <dd>{entry.cheat_class}</dd>
          </>
        ) : null}
        {entry.evidence_summary ? (
          <>
            <dt>Evidence</dt>
            <dd>{entry.evidence_summary}</dd>
          </>
        ) : null}
        <dt>Test gate</dt>
        <dd>
          {gate
            ? `${gate.passed ? "passed" : "failed"}: catch rate ${pct(gate.catch_rate_before)} to ${pct(gate.catch_rate_after)}, false alarms ${pct(gate.false_alarm_set, 1)}`
            : "no result"}
        </dd>
      </dl>
    </>
  );
}

function PayoutApprovalBody({ entry, creditLabel }: { entry: Serialized<PayoutApprovalEntry>; creditLabel: string }) {
  return (
    <>
      <p className="rule-line">Payout of {credits(entry.pot, creditLabel)}</p>
      <dl className="facts">
        <dt>Winner rule</dt>
        <dd>{entry.winner_rule === "top_score" ? "Top score takes the pot" : "Finishers split the pot"}</dd>
        <dt>Why it waits</dt>
        <dd>{entry.approval_reasons.map((r) => r.replace(/_/g, " ")).join(", ") || "operator"}</dd>
      </dl>
      <ul className="shares">
        {entry.shares.map((s) => (
          <li key={s.player_id}>
            {entry.names[s.player_id] ?? "Player"}: {credits(s.amount, creditLabel)}
          </li>
        ))}
        {entry.refunds.map((s) => (
          <li key={`r-${s.player_id}`}>
            {entry.names[s.player_id] ?? "Player"} refund: {credits(s.amount, creditLabel)}
          </li>
        ))}
      </ul>
    </>
  );
}

export function RuleChart({ versions, maxFalseAlarm }: { versions: Serialized<RuleVersionPoint>[]; maxFalseAlarm: number }) {
  return (
    <section className="panel chart" aria-label="Rule versions">
      <h2>Rule versions</h2>
      {versions.length === 0 ? <p className="muted">No rules yet.</p> : null}
      <ul className="bars">
        {versions.map((v) => {
          const rate = v.catch_rate_after;
          const overLimit = v.false_alarm_set !== null && v.false_alarm_set > maxFalseAlarm;
          return (
            <li key={`${v.rule_key}-${v.version}`} className={`bar-row status-${v.status}`}>
              <span className="bar-label">
                {v.rule_key} v{v.version} <span className="muted">{v.source === "seed" ? "seed" : "learned"}, {v.status.replace(/_/g, " ")}</span>
              </span>
              <span className="bar-track" aria-hidden="true">
                <span className="bar-fill" style={{ width: `${Math.round((rate ?? 0) * 100)}%` }} />
              </span>
              <span className="bar-value">
                catch {pct(rate)}
                {v.false_alarm_set !== null ? (
                  <span className={overLimit ? "bad" : "muted"}>, false alarms {pct(v.false_alarm_set, 1)}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Standings({ data }: { data: StageData }) {
  const unit = data.score_unit;
  return (
    <section className="panel" aria-label="Players and standings">
      <h2>Players and scores</h2>
      {data.standings.available ? (
        <table className="table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Player</th>
              <th>Score ({unit})</th>
              <th>Goal</th>
            </tr>
          </thead>
          <tbody>
            {data.standings.standings.map((s) => (
              <tr key={s.player_id}>
                <td>{s.rank}</td>
                <td>{s.display_name}</td>
                <td>{s.score}</td>
                <td>{s.reached_goal ? "reached" : "not yet"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <p className="muted">
            Scores are not available yet{data.standings.owner ? ` (waits on ${data.standings.owner})` : ""}.
            {unit === "days" ? " Counted days come from the day-status rule." : ""}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Player</th>
                {unit === "days" ? <th>Counted days</th> : null}
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.players.map((p) => (
                <tr key={p.player.id}>
                  <td>
                    {p.player.display_name}
                    {p.player.scripted ? <span className="muted"> (scripted)</span> : null}
                  </td>
                  {unit === "days" ? <td>{p.counted_days ?? 0}</td> : null}
                  <td>{credits(p.player.credits, data.credit_label)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
