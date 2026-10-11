import { describe, expect, it } from "vitest";
import { boundViolations, runGate, setCatches, type GateInput } from "../../src/rules/gate";
import { DEFAULT_SETTINGS } from "../../src/config";
import { SHIP_WEEK_FEATURES } from "../../src/packs/ship-week/index";
import { CUSTOMERS_FEATURES } from "../../src/packs/customers/index";
import type { When } from "../../src/schema/rule";
import {
  ae1Examples,
  ae2Examples,
  callFeatures,
  cheat,
  honest,
  PERSONAL_NO_NOTES_WHEN,
  RENAME_WHEN,
  shipFeatures,
  T0,
  toGateExamples,
  type ExampleSpec,
} from "./u9-fixtures";

const thresholds = DEFAULT_SETTINGS.gate;
const SHIP_PACK = { type: "ship_week" as const, features: SHIP_WEEK_FEATURES };

function shipGate(over: Partial<GateInput> & Pick<GateInput, "candidate">, specs: ExampleSpec[]): ReturnType<typeof runGate> {
  return runGate({ active: [], examples: toGateExamples(specs), pack: SHIP_PACK, thresholds, now: T0, ...over });
}

describe("test gate (R21, KTD9)", () => {
  it("AE1: a rename-only reject rule raising rename_only from 0% to 95% with no honest false alarms passes", () => {
    const gate = shipGate({ candidate: { rule_key: "learned-rename-only", when: RENAME_WHEN, action: "reject", cheat_class: "rename_only" } }, ae1Examples());
    expect(gate.passed).toBe(true);
    expect(gate.target_class).toBe("rename_only");
    expect(gate.catch_rate_before).toBe(0);
    expect(gate.catch_rate_after).toBeCloseTo(0.95, 10);
    expect(gate.false_alarm_rule).toBe(0);
    expect(gate.false_alarm_set).toBe(0);
    expect(gate.honest_count).toBe(100);
    expect(gate.per_class_after.whitespace_only).toBe(0);
    expect(gate.reasons).toEqual([]);
    expect(gate.thresholds).toEqual(thresholds);
  });

  it("AE5: a candidate that flags 3 of 100 honest examples is rejected with a false-alarm reason", () => {
    const specs: ExampleSpec[] = [];
    for (let i = 0; i < 10; i++) specs.push(cheat(`typo-${i}`, "typo_only", shipFeatures({ typo_only: true, code_lines_changed: 1 })));
    for (let i = 0; i < 100; i++) specs.push(honest(`honest-${i}`, shipFeatures({ code_lines_changed: i < 3 ? 2 : 30 })));
    const when: When = { all: [{ feature: "code_lines_changed", op: "lte", value: 3 }] };
    const gate = shipGate({ candidate: { rule_key: "small-commits", when, action: "reject", cheat_class: "typo_only" } }, specs);
    expect(gate.passed).toBe(false);
    expect(gate.catch_rate_after).toBe(1);
    expect(gate.false_alarm_rule).toBeCloseTo(0.03, 10);
    expect(gate.reasons).toContain("false alarms 3.0% > 1.0%");
  });

  it("AE2: an ask_more rule for personal-email calls without notes passes", () => {
    const gate = runGate({
      candidate: { rule_key: "personal-no-notes", when: PERSONAL_NO_NOTES_WHEN, action: "ask_more", cheat_class: "all_personal_email" },
      active: [],
      examples: toGateExamples(ae2Examples()),
      pack: { type: "customers", features: CUSTOMERS_FEATURES },
      thresholds,
      now: T0,
    });
    expect(gate.passed).toBe(true);
    expect(gate.catch_rate_after).toBe(1);
    expect(gate.false_alarm_rule).toBe(0);
  });

  it("rejects a candidate that improves its target class but drops another class by 5 points", () => {
    const specs: ExampleSpec[] = [];
    for (let i = 0; i < 20; i++) specs.push(cheat(`docs-${i}`, "docs_only", shipFeatures({ docs_only: true, files_changed: i < 19 ? 2 : 10 })));
    for (let i = 0; i < 10; i++) specs.push(cheat(`typo-${i}`, "typo_only", shipFeatures({ typo_only: true, files_changed: 1 })));
    for (let i = 0; i < 100; i++) specs.push(honest(`honest-${i}`, shipFeatures({ files_changed: 5 + (i % 10) })));
    const parent = { rule_key: "small-change", when: { all: [{ feature: "docs_only", op: "eq", value: true }] } as When, action: "flag" as const };
    const candidateWhen: When = {
      any: [
        { feature: "typo_only", op: "eq", value: true },
        { feature: "files_changed", op: "lte", value: 3 },
      ],
    };
    const gate = shipGate(
      { candidate: { rule_key: "small-change", when: candidateWhen, action: "flag", cheat_class: "typo_only" }, active: [parent] },
      specs,
    );
    expect(gate.catch_rate_before).toBe(0);
    expect(gate.catch_rate_after).toBe(1);
    expect(gate.per_class_before.docs_only).toBe(1);
    expect(gate.per_class_after.docs_only).toBeCloseTo(0.95, 10);
    expect(gate.passed).toBe(false);
    expect(gate.reasons).toContain("catch rate for docs_only dropped 5.0 points, limit 2.0");
  });

  it("measures false alarms only on seed honest examples and needs the minimum gain", () => {
    const specs: ExampleSpec[] = [
      ...ae1Examples(),
      // Not seed: ignored for false alarms even though the rule matches it.
      { key: "odd", label: "honest", cheat_class: null, features: shipFeatures({ rename_only: true }), source: "red_team" },
    ];
    const gate = shipGate({ candidate: { rule_key: "learned-rename-only", when: RENAME_WHEN, action: "reject", cheat_class: "rename_only" } }, specs);
    expect(gate.honest_count).toBe(100);
    expect(gate.false_alarm_rule).toBe(0);

    // The same rule already active: no gain, so it fails.
    const again = shipGate(
      {
        candidate: { rule_key: "learned-rename-only-2", when: RENAME_WHEN, action: "reject", cheat_class: "rename_only" },
        active: [{ rule_key: "learned-rename-only", when: RENAME_WHEN, action: "reject" }],
      },
      ae1Examples(),
    );
    expect(again.passed).toBe(false);
    expect(again.reasons[0]).toMatch(/rose 0\.0 points, needs 10\.0/);
  });

  it("rejects a rule outside a predicate's hard bound, using U4's grammar", () => {
    const when: When = { all: [{ feature: "code_lines_changed", op: "lte", value: 25 }] };
    expect(boundViolations(when, SHIP_PACK)).toEqual(['feature "code_lines_changed" must stay within its hard bound 0 to 20, got 25']);
    const gate = shipGate({ candidate: { rule_key: "too-wide", when, action: "flag", cheat_class: "rename_only" } }, ae1Examples());
    expect(gate.passed).toBe(false);
    expect(gate.bound_violations).toHaveLength(1);
    expect(boundViolations({ all: [{ feature: "unknown_feature", op: "eq", value: true }] }, SHIP_PACK)).toEqual([
      'feature "unknown_feature" is not in the ship_week feature catalog',
    ]);
    expect(boundViolations({ all: [{ feature: "rename_only", op: "gt", value: 1 }] }, SHIP_PACK)).toEqual([
      'operator "gt" is not allowed on feature "rename_only"',
    ]);
    expect(boundViolations(RENAME_WHEN, SHIP_PACK)).toEqual([]);
  });

  it("catches through U4's matcher: list features match on any item, missing features never match", () => {
    const rule = (when: When) => [{ rule_key: "r", when, action: "flag" as const }];
    const f = callFeatures({ attendee_domains: ["acme.com", "gmail.com"] });
    expect(setCatches(rule({ all: [{ feature: "attendee_domains", op: "in", value: ["gmail.com"] }] }), f)).toBe(true);
    expect(setCatches(rule({ all: [{ feature: "attendee_domains", op: "in", value: ["yahoo.com"] }] }), f)).toBe(false);
    expect(setCatches(rule({ all: [{ feature: "not_there", op: "eq", value: true }] }), f)).toBe(false);
    expect(
      setCatches(rule({ all: [{ feature: "message_matches", op: "matches", value: "WIP" }] }), shipFeatures({ message_matches: "wip: tidy" })),
    ).toBe(true);
    // Any action counts as caught, and an empty set catches nothing.
    expect(setCatches([{ rule_key: "r", when: RENAME_WHEN, action: "ask_more" }], shipFeatures({ rename_only: true }))).toBe(true);
    expect(setCatches([], shipFeatures({ rename_only: true }))).toBe(false);
  });
});
