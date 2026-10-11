"use client";

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { CHALLENGE_TYPES } from "@lane/core/schema/common";
import { OpsButton } from "./OpsButton";
import type { OverviewWire } from "./Overview";
import { POLL_MS, answerMessage, fetchJson, postOps } from "./wire";

const TYPE_TITLES: Record<(typeof CHALLENGE_TYPES)[number], string> = {
  ship_week: "Ship Week",
  customers: "Talk to Customers",
  build_in_public: "Build in Public",
};

/** Passcode form shown instead of the operator panel when there is no operator cookie. */
export function PasscodeForm() {
  const router = useRouter();
  const [passcode, setPasscode] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    const answer = await postOps("/api/ops/login", { passcode });
    setSending(false);
    if (answer.ok) {
      setPasscode("");
      router.refresh();
    } else {
      setMessage(answerMessage(answer));
    }
  }

  return (
    <form className="panel passcode" onSubmit={submit}>
      <h2>Operator sign-in</h2>
      <label htmlFor="ops-passcode">Passcode</label>
      <input
        id="ops-passcode"
        type="password"
        autoComplete="current-password"
        value={passcode}
        onChange={(e) => setPasscode(e.target.value)}
      />
      <button type="submit" className="btn btn-primary" disabled={sending || passcode.length === 0}>
        {sending ? "Checking..." : "Sign in"}
      </button>
      {message ? <p className="ops-error">{message}</p> : null}
    </form>
  );
}

/** Settings switches (KTD23) and demo controls. Renders only for the operator. */
export function OpsPanel() {
  const router = useRouter();
  const { data, mutate } = useSWR<OverviewWire>("/api/data/overview", fetchJson, { refreshInterval: POLL_MS, keepPreviousData: true });
  const [limit, setLimit] = useState<string>("");
  const settings = data?.settings;
  const refresh = () => void mutate();

  return (
    <div className="ops-panel">
      <section className="panel">
        <h2>Switches</h2>
        {!settings ? <p className="muted">Loading...</p> : null}
        {settings ? (
          <div className="switches">
            <Switch label="Learning" on={!settings.learning_paused} patchWhenFlipped={{ learning_paused: !settings.learning_paused }} onDone={refresh} />
            <Switch label="Registration" on={settings.registration_open} patchWhenFlipped={{ registration_open: !settings.registration_open }} onDone={refresh} />
            <Switch
              label="Surprise checks"
              on={settings.surprise_checks_enabled}
              patchWhenFlipped={{ surprise_checks_enabled: !settings.surprise_checks_enabled }}
              onDone={refresh}
            />
            <div className="switch">
              <span>Payout limit: {settings.payout_limit} {data?.credit_label}</span>
              <input
                aria-label="New payout limit"
                type="number"
                min={0}
                step={1}
                value={limit}
                placeholder={String(settings.payout_limit)}
                onChange={(e) => setLimit(e.target.value)}
              />
              <OpsButton
                label="Save limit"
                path="/api/ops/settings"
                body={{ patch: { payout_limit: Number(limit) } }}
                disabled={limit === "" || !Number.isInteger(Number(limit)) || Number(limit) < 0}
                onDone={(a) => {
                  if (a.ok) setLimit("");
                  refresh();
                }}
              />
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <h2>Demo controls</h2>
        <table className="table">
          <tbody>
            {CHALLENGE_TYPES.map((type) => (
              <tr key={type}>
                <td>{TYPE_TITLES[type]}</td>
                <td>
                  <OpsButton
                    label="Reset stage"
                    path="/api/ops/reset"
                    body={{ challenge_type: type, confirm: true }}
                    confirm
                    tone="danger"
                    onDone={(a) => {
                      const next = a.body.new_challenge_id;
                      if (a.ok && typeof next === "string") router.push(`/c/${encodeURIComponent(next)}`);
                    }}
                  />
                </td>
                <td>
                  <OpsButton label="Run red team" path="/api/ops/red-team" body={{ challenge_type: type }} doneMessage="Red team started." />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Advance day, close window and surprise checks are on each challenge's stage screen.</p>
      </section>

      <section className="panel">
        <SignOut />
      </section>
    </div>
  );
}

function Switch({
  label,
  on,
  patchWhenFlipped,
  onDone,
}: {
  label: string;
  on: boolean;
  patchWhenFlipped: Record<string, boolean>;
  onDone: () => void;
}) {
  return (
    <div className="switch">
      <span>
        {label}: <strong className={on ? "ok" : "bad"}>{on ? "on" : "off"}</strong>
      </span>
      <OpsButton label={on ? `Turn ${label.toLowerCase()} off` : `Turn ${label.toLowerCase()} on`} path="/api/ops/settings" body={{ patch: patchWhenFlipped }} onDone={onDone} />
    </div>
  );
}

function SignOut() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn btn-plain"
      onClick={async () => {
        await postOps("/api/ops/logout", {});
        router.refresh();
      }}
    >
      Sign out of operator mode
    </button>
  );
}
