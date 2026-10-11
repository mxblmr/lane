# Lane roadmap

Lane's MVP for the MongoDB #SFTechWeek hackathon (2026-10-11) is three separate challenges (Ship
Week, Talk to Customers, Build in Public) that people join through their own AI agent. Everyone in
a challenge puts the same play-credit stake into its pot, each person's agent sends proof of
progress, Lane's referee agents check it and learn new anti-cheat rules as they go, and the pot is
paid out under the winner rule the creator picked. The MVP plan is
`docs/plans/2026-10-11-1233-feat-lane-mvp-plan.md`. Everything below is deliberately left out of
the MVP and kept here so it isn't lost.

Research behind these items lives in the HQ knowledge file
`companies/lane/knowledge/market/lane-gamification-research.md`.

## Betting on people

- Side bets on any person, for or against, on any checkable condition by a date ("$10 says Gary
  won't run 10 km by Friday"). A bookie agent turns the sentence into a checkable condition and asks
  clarifying questions back through the person's agent.
- One parimutuel market per person, so Lane never takes a side. Caps keep bribery unprofitable:
  a person can bet only on themselves, never against, and the pool against any person is capped
  at the stake.
- Betting locks at the challenge midpoint. Bets against someone are never anonymous, and anyone
  betting on a person can't see that person's raw data or judge their proof.
- Each person chooses whether friends can bet against them ("roast mode" or "supportive only").
- Live odds per person: crowd odds next to Lane's own forecast from the progress trend.

## Commitment deposit (the negative bet)

- A person puts money on hold at the start (for example $250) and loses it if they miss the goal.
- The challenge creator picks where lost deposits go when creating the challenge: a charity, a
  cause the person dislikes, or the people who finished.

## Hail Mary

- Once per challenge, a person who missed a day or is on track to fail can call a Hail Mary: a
  harder make-up task with a tight deadline, sized from their own data.
- It costs part of the deposit, friends get a quick side bet on whether it succeeds, and the
  referees use their strictest checks during the window.

## Coach agent

- A coach that remembers each person's goals, baseline and history, plans their week, writes the
  daily nudge their agent delivers, designs Hail Marys, and proposes the next challenge.
- In the MVP, Lane's orchestrator only reports progress. Muse picks it up on its own routine,
  because Lane can't message Muse first.

## Proof levels driven by money at stake

- Each person's required proof level rises when money rides against them, when they were flagged
  before, or when their account is new, and relaxes after clean challenges.
- The level also changes which tools that person's agent may use (for example, no self-reported
  progress once money rides against them).

## More challenge types

- Weight loss (scale photo with a one-time code, Withings data), nutrition (meal photos checked
  by AI), 75 Hard-style daily rule sets, sleep (watch data with heart rate), fitness (Garmin and
  Apple Health), saving (bank data), learning (public profiles and certificates).
- Wearables reach Lane through the person's agent (for example Garmin syncing into Apple Health,
  which Muse reads).

## Open challenges with strangers

- A public list of challenges anyone can join. This carries the most legal risk once real money is
  involved.

## More agents and channels

- Instinct, through a personal web page its browser can operate or an email endpoint.
- Listings in the Muse, Claude and ChatGPT directories for a play-money version.
- The Meta and Sierra Personal Agent Protocol once its spec is published.
- A Lane mobile app that reads HealthKit and Health Connect directly for the strongest proof.

## Real money

- Today everything runs on play credits. Before real money, Lane needs a payment processor that
  accepts skill contests (Stripe prohibits paid-entry prize contests), legal review in the US and
  Canada, an 18+ age gate, deposit limits, and self-exclusion.
- In Canada, the Criminal Code's exemptions for private bets and for a stakeholder holding money
  for up to ten people look like the most promising route and need counsel.
