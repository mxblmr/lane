import { challengesService } from "@lane/core/challenges";
import { provideU18Services } from "@lane/core/checkin";
import { contractsService } from "@lane/core/contracts";
import { provideServices, type ServiceName } from "@lane/core/interfaces";
import { playersService } from "@lane/core/players";
import { stageService } from "@lane/scripts/seed/reset";
import { settlementService } from "@lane/core/settlement/payout";
import { approvalsService } from "@lane/core/rules/approvals";
import { learningJobHandlers, learningService } from "@lane/core/rules/learning";
import { lifecycleService } from "@lane/core/rules/lifecycle";
import { provideJobHandlers } from "@lane/core/tick";
import { agentsService } from "@lane/core/agents/service";
import { createProofService } from "@lane/core/proofs/pipeline";
import { engineService } from "@lane/core/rules/engine";
import { after } from "next/server";

/**
 * The web app's composition root (U3 interfaces, U7 wiring). Routes call `wireServices()` once at
 * module load, which hands every owner unit's real implementation to `provideServices`. Services
 * whose owner has not merged yet keep U3's stubs, which throw `NotImplementedError`; the tool
 * runner turns that into an envelope telling Muse to try again later.
 *
 * When an owner unit merges, import its service object here, add it to `provideServices`, and
 * flip its entry in `SERVICE_WIRING` to "real".
 */

export type Wiring = "real" | "stub";

/** What the deployed routes run with, per service. Jobs and ledger are U3's own implementations. */
export const SERVICE_WIRING: Record<ServiceName, Wiring> = {
  jobs: "real",
  ledger: "real",
  players: "real",
  challenges: "real",
  contracts: "real",
  checkin: "real",
  inbox: "real",
  feed: "real",
  tick: "real",
  disputes: "real",
  ask: "real",
  proofs: "real",
  approvals: "real",
  learning: "real",
  lifecycle: "real",
  engine: "real",
  agents: "real",
  settlement: "real",
  stage: "real",
};

let wired = false;

/** Idempotent. Tests that need doubles call `provideServices` after importing a route. */
export function wireServices(): void {
  if (wired) return;
  wired = true;
  // U6
  provideServices({
    players: playersService,
    challenges: challengesService,
    contracts: contractsService,
  });
  // U18: checkin, inbox, feed, tick, disputes and ask, plus the settlement job handler.
  provideU18Services();
  // U13: the KTD22 stage reset behind U12's reset control.
  provideServices({ stage: stageService });
  // U4: the rule engine. U5: the proof pipeline; a referee reply that misses the request window
  // finishes in Next's `after()` so the verdict still lands.
  provideServices({ engine: engineService, proofs: createProofService({ runAfter: after }) });
  // U11: scoring, settlement and payouts, run by U18's settlement job handler.
  provideServices({ settlement: settlementService });
  // U9: approvals, the learning chain and the rule lifecycle, plus the learning job handlers the
  // tick runs.
  provideServices({ approvals: approvalsService, learning: learningService, lifecycle: lifecycleService });
  provideJobHandlers(learningJobHandlers());
  // U8: the Agent Engine adapter. It reads its configuration on first call, never at build time.
  provideServices({ agents: agentsService });
}
