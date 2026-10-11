import { challengesService } from "@lane/core/challenges";
import { provideU18Services } from "@lane/core/checkin";
import { contractsService } from "@lane/core/contracts";
import { provideServices, type ServiceName } from "@lane/core/interfaces";
import { playersService } from "@lane/core/players";
import { stageService } from "@lane/scripts/seed/reset";

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
  proofs: "stub",
  approvals: "stub",
  learning: "stub",
  lifecycle: "stub",
  engine: "stub",
  agents: "stub",
  settlement: "stub",
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
  // U5 (proofs) is added here when it merges.
}
