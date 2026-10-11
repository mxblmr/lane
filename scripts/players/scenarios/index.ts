import type { ChallengeType } from "@lane/core/schema/common";
import type { ScriptedPlayerName } from "../../seed/roster";
import type { Scenario } from "../runner";
import { samAe1, samInjection } from "./ship-week";

export interface RegisteredScenario extends Scenario {
  challenge_type: ChallengeType;
  /** Players whose environment variables the scenario needs; the first one watches for resets. */
  players: ScriptedPlayerName[];
}

export const SCENARIOS: Record<string, RegisteredScenario> = {
  "sam-ae1": { ...samAe1, challenge_type: "ship_week", players: ["Sam"] },
  "sam-injection": { ...samInjection, challenge_type: "ship_week", players: ["Sam"] },
};
