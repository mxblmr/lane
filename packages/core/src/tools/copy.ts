import type { WinnerRule } from "../schema/challenges";
import type { HandlePlatform } from "../schema/common";

/** R6: the two winner rules, as Lane words them for the creator. */
export const WINNER_RULE_CHOICES: readonly { value: WinnerRule; label: string }[] = [
  { value: "top_score", label: "Highest verified score takes the pot, and ties split it." },
  { value: "finishers_split", label: "Everyone who reaches the goal splits the pot." },
];

export function winnerRuleLabel(rule: WinnerRule): string {
  return WINNER_RULE_CHOICES.find((c) => c.value === rule)?.label ?? rule;
}

/** KTD21: the handle each platform needs, as Muse asks the player for it. */
export const HANDLE_NAMES: Record<HandlePlatform, string> = {
  github: "GitHub username",
  x: "X handle",
  instagram: "Instagram handle",
  linkedin: "LinkedIn handle",
  threads: "Threads handle",
};

export const CHALLENGE_NAMES = {
  ship_week: "Ship Week",
  customers: "Talk to Customers",
  build_in_public: "Build in Public",
} as const;
