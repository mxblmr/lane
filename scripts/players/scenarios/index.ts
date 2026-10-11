import type { ChallengeType } from "@lane/core/schema/common";
import type { ScriptedPlayerName } from "../../seed/roster";
import type { Scenario } from "../runner";
import { samAe1, samCheckIn, samFirstRename, samInjection, samSecondRename } from "./ship-week";
import { garyHonest, garyPriyaShipWeek, priyaHonest } from "./ship-week-honest";
import { ae2Customers } from "./customers";

export interface RegisteredScenario extends Scenario {
  challenge_type: ChallengeType;
  /** Players whose environment variables the scenario needs; the first one watches for resets. */
  players: ScriptedPlayerName[];
  /** False when the players push nothing to GitHub, so only their Lane keys are required. */
  needs_github?: boolean;
}

export const SCENARIOS: Record<string, RegisteredScenario> = {
  "sam-ae1": { ...samAe1, challenge_type: "ship_week", players: ["Sam"] },
  "sam-injection": { ...samInjection, challenge_type: "ship_week", players: ["Sam"] },
  "gary-priya-ship-week": { ...garyPriyaShipWeek, challenge_type: "ship_week", players: ["Gary", "Priya"] },
  "ae2-customers": { ...ae2Customers, challenge_type: "customers", players: ["Gary", "Priya"], needs_github: false },
  /** The full Ship Week stage: honest commits from Gary and Priya, then Sam's AE1. */
  "ship-week-stage": {
    id: "ship-week-stage",
    title: "Ship Week on stage: Gary and Priya ship, Sam cheats (AE1)",
    steps: [garyHonest, priyaHonest, samCheckIn, samFirstRename, samSecondRename],
    challenge_type: "ship_week",
    players: ["Sam", "Gary", "Priya"],
  },
};
