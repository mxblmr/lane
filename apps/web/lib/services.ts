import { challengesService } from "@lane/core/challenges";
import { contractsService } from "@lane/core/contracts";
import { provideServices, type ServiceName } from "@lane/core/interfaces";
import { playersService } from "@lane/core/players";

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
  proofs: "stub",
  checkin: "stub",
  disputes: "stub",
  ask: "stub",
  inbox: "stub",
  feed: "stub",
  tick: "stub",
  approvals: "stub",
  learning: "stub",
  lifecycle: "stub",
  engine: "stub",
  agents: "stub",
  settlement: "stub",
  stage: "stub",
};

let wired = false;

/** Idempotent. Tests that need doubles call `provideServices` after importing a route. */
export function wireServices(): void {
  if (wired) return;
  wired = true;
  provideServices({
    // U6
    players: playersService,
    challenges: challengesService,
    contracts: contractsService,
    // U18 (checkin, disputes, ask, inbox, feed, tick) and U5 (proofs) are added here as they merge.
  });
}
