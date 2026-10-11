"use client";

import { useEffect, useRef, useState } from "react";
import { answerMessage, postOps, type OpsAnswer } from "./wire";

/**
 * One operator control (KTD16). It is disabled while its request is in flight or when the
 * caller says it no longer applies, ignores a second click while sending, and, with
 * `confirm`, needs a confirming second click before it sends anything.
 */

export interface OpsButtonState {
  phase: "idle" | "confirming" | "sending";
  message: string | null;
  error: boolean;
}

export type OpsButtonEvent =
  | { type: "click"; needsConfirm: boolean }
  | { type: "timeout" }
  | { type: "done"; ok: boolean; message: string | null };

export const IDLE: OpsButtonState = { phase: "idle", message: null, error: false };

/** How long the confirming state waits for the second click. */
export const CONFIRM_WINDOW_MS = 4_000;

export function opsButtonReducer(state: OpsButtonState, event: OpsButtonEvent): OpsButtonState {
  switch (event.type) {
    case "click":
      if (state.phase === "sending") return state;
      if (event.needsConfirm && state.phase === "idle") return { phase: "confirming", message: null, error: false };
      return { phase: "sending", message: null, error: false };
    case "timeout":
      return state.phase === "confirming" ? { ...state, phase: "idle" } : state;
    case "done":
      return { phase: "idle", message: event.message, error: !event.ok };
  }
}

export interface OpsButtonProps {
  label: string;
  path: string;
  body: Record<string, unknown>;
  confirm?: boolean;
  disabled?: boolean;
  tone?: "primary" | "danger" | "plain";
  /** Message shown after success; defaults to none (the polled data shows the result). */
  doneMessage?: string;
  onStart?: () => void;
  onDone?: (answer: OpsAnswer) => void;
}

export function OpsButton({ label, path, body, confirm, disabled, tone = "plain", doneMessage, onStart, onDone }: OpsButtonProps) {
  const [state, setState] = useState<OpsButtonState>(IDLE);
  const sending = useRef(false);

  useEffect(() => {
    if (state.phase !== "confirming") return;
    const timer = setTimeout(() => setState((s) => opsButtonReducer(s, { type: "timeout" })), CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [state.phase]);

  async function handleClick() {
    if (disabled || sending.current) return;
    const next = opsButtonReducer(state, { type: "click", needsConfirm: Boolean(confirm) });
    setState(next);
    if (next.phase !== "sending") return;
    sending.current = true;
    onStart?.();
    const answer = await postOps(path, body);
    sending.current = false;
    setState(opsButtonReducer(next, { type: "done", ok: answer.ok, message: answer.ok ? (doneMessage ?? null) : answerMessage(answer) }));
    onDone?.(answer);
  }

  const text = state.phase === "confirming" ? `Confirm: ${label}` : state.phase === "sending" ? "Working..." : label;
  return (
    <span className="ops-control">
      <button
        type="button"
        className={`btn btn-${tone}${state.phase === "confirming" ? " btn-confirming" : ""}`}
        disabled={Boolean(disabled) || state.phase === "sending"}
        onClick={handleClick}
      >
        {text}
      </button>
      {state.message ? <span className={state.error ? "ops-error" : "ops-note"}>{state.message}</span> : null}
    </span>
  );
}
