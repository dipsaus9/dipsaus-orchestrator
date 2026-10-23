---
id: DIPO-311
title: Alert on daily and monthly token spend across offices
status: Done
assignee: []
created_date: '2026-10-22 20:56'
updated_date: '2026-10-23 11:30'
labels:
  - 'tier:M'
  - 'slice:m1b'
milestone: m-1
dependencies:
  - DIPO-158
references:
  - packages/contract/src/software.ts
  - packages/contract/src/config.ts
  - packages/contract/schema/
  - packages/engine/src/config/software.ts
  - packages/engine/test/config/
  - packages/engine/src/views/summary.ts
  - packages/engine/src/views/
  - packages/engine/test/views/
  - packages/engine/src/ingest/usage.ts
  - packages/engine/src/pricing/
  - packages/engine/test/pricing/
  - packages/engine/src/reads/hello.ts
  - packages/engine/src/run/
  - packages/engine/test/run/
  - packages/cli/src/
  - packages/tui/src/
modified_files:
  - packages/cli/src/daemon-commands.ts
  - packages/cli/src/desk-command.test.ts
  - packages/cli/src/desk-command.ts
  - packages/cli/src/watch-command.test.ts
  - packages/cli/src/watch-command.ts
  - packages/client/src/index.ts
  - packages/client/src/recovery.ts
  - packages/client/src/usage-text.ts
  - packages/client/test/unit/config.test.ts
  - packages/client/test/unit/lifecycle.test.ts
  - packages/contract/schema/config.schema.json
  - packages/contract/schema/events.schema.json
  - packages/contract/schema/reads.schema.json
  - packages/contract/schema/shared.schema.json
  - packages/contract/src/config.test.ts
  - packages/contract/src/config.ts
  - packages/contract/src/software.ts
  - packages/contract/src/version.ts
  - packages/daemon/src/foreground-bootout.test.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/test/integration/foreground.test.ts
  - packages/engine/src/index.ts
  - packages/engine/src/reads/hello.ts
  - packages/engine/src/run/index.ts
  - packages/engine/src/run/usage-alerts.ts
  - packages/engine/src/views/index.ts
  - packages/engine/src/views/summary.ts
  - packages/engine/src/views/usage.ts
  - packages/engine/test/config/software.test.ts
  - packages/engine/test/reads/hello.test.ts
  - packages/engine/test/views/usage.test.ts
  - packages/tui/src/overview.test.tsx
  - packages/tui/src/overview.tsx
priority: medium
type: feature
ordinal: 296000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: dipo tells the maintainer when the tokens used today or this month pass the level they set, in the TUI, in the plain-text views and once as a notice, so the shared plan is not used up by surprise.

Context: follows research idea 6 (daily and monthly thresholds with an alert level, because plan limits are shared across all offices), 0007 section 4 (the daemon sums `usage_daily` over all offices for spend alerts at the software level), 0008 sections 4 and 9 (budget tokens are input, output and cache creation; cache reads shown, not counted; estimated cost from the catalog, never a cap), 0009 section 3 (evidence labels), section 4 (switcher `ALERT day usage`) and section 8 (`OfficeSummary.dayUsage` with tokens, limit, share, alert and estimated cost, capability flag `usage.alerts`; tokens first, dollars only as an estimated note; the cost view's "alert at 80%"), 0006 amendment of 2026-10-12 and 0017 section 5 (software settings in `<state>/config.yaml`, versioned and validated; `office.local.yaml` accepts only `timeouts`, `privacy` and `retention`). Today `usage_daily` is keyed by UTC day, `DayUsage` exists in the contract, the TUI switcher and overview render it when present (`packages/tui/src/views.tsx`, `packages/tui/src/overview.tsx`), and the engine never fills it. `once_notices` exists for notices raised once.

The maintainer answered this story's questions on 2026-10-22 by accepting the recommended answers. They are in the unknowns below and in the 0009 and 0017 amendments of that day. The cost view `5` and `office.usage` are not part of this story (they fit the M3 retro and insights).

```dipo
branch: "DIPO-311/spend-alerts"
unknowns:
  - q: "Q18. Where the thresholds live and what they count over: all offices together in the software config, or per office."
    status: "resolved"
    answer: "In the software config <state>/config.yaml at version 2: usage.alerts.dayTokens, usage.alerts.monthTokens and usage.alerts.level (default 0.8). Counted over all offices together. Each office's summary shows its own tokens, the total's limit and the total's share and alert. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q19. Default thresholds, or alerts off until set."
    status: "resolved"
    answer: "No default limits. Alerts are off until set; tokens still show. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q20. The unit of the thresholds: budget tokens or estimated dollars."
    status: "resolved"
    answer: "Budget tokens, as the budget counts them. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q21. The day and month windows: UTC calendar day and month, local time, or rolling windows."
    status: "resolved"
    answer: "UTC calendar day and UTC calendar month, shown with UTC next to the reset time. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q22. What happens at the limit: alert only, or hold new pickups."
    status: "resolved"
    answer: "Alert only. Nothing is held or parked; per-story budgets and plan-limit holds stay the only stops. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q23. Where the alert shows, and whether the cost view 5 is part of this story."
    status: "resolved"
    answer: "The TUI switcher (exists), the overview count line (today and this month), the dipo watch header, the dipo desk count line, and one engine.notice per window and level. The cost view 5 stays out of M1b (it fits the M3 retro and insights). (maintainer, 2026-10-22: accepted the recommended answers)"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the software config schema accepts usage.alerts.dayTokens, usage.alerts.monthTokens and usage.alerts.level at version 2, refuses a negative value or an unknown key with the path named, and migrates version 1 in memory"
    - kind: "automated"
      check: "(unit) the day and month sums over fixture usage rows of two offices count input, output and cache creation of worker, reviewer and session runs, leave cache reads out, include live rows of open agents, and split at the UTC day and month edges"
    - kind: "automated"
      check: "(unit) OfficeSummary carries dayUsage and monthUsage with the office's tokens, the all-office limit, share, alert and estimated cost, and no share or alert without a limit"
    - kind: "automated"
      check: "(unit, manual clock) crossing the level and the limit raises one notice each per window, none again after a restart, and a new one in the next window; at the limit no pickup is held and no story parks"
    - kind: "automated"
      check: "(unit, TUI harness) the switcher shows the alert and the overview count line shows today and this month of the limit"
    - kind: "automated"
      check: "(unit, cli) the dipo watch header and the dipo desk count line show today's and this month's tokens of the limit with UTC next to the reset time"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The software configuration `<state>/config.yaml` at version 2 accepts `usage.alerts.dayTokens` and `usage.alerts.monthTokens` (budget tokens, no default, so alerts stay off until set) and `usage.alerts.level` (default 0.8), validated with the config's zod schema with an in-memory migration from version 1, and its JSON schema is regenerated
- [x] #2 Engine code sums budget tokens (input, output and cache creation; cache reads left out) of every run kind, story worker, reviewer and session, final rows plus the live rows of open agents, per office and over all offices, for the UTC calendar day and the UTC calendar month, with the estimated cost from the pricing catalog
- [x] #3 `OfficeSummary.dayUsage` is filled and a new optional `monthUsage` of the same shape is added, under capability flag `usage.alerts`: each office's summary carries its own tokens and the limit, share and alert of the all-office total; tokens carry the label `claimed` and cost `estimated`; a summary event follows a usage change at most once a minute (design choice)
- [x] #4 Crossing the alert level and crossing the limit of the all-office total each raise one `engine.notice` per window (warn at the level, error at the limit), recorded in `once_notices` so a daemon restart does not repeat it
- [x] #5 At a limit dipo only alerts: no pickup is held and no story parks; per-story budgets and plan-limit holds stay the only stops
- [x] #6 The TUI switcher keeps its `ALERT day usage`, and the overview count line, the `dipo watch` header and the `dipo desk` count line show today's and this month's tokens of the limit, with "UTC" next to the reset time
- [x] #7 With no limit set the tokens still show, with no share and no alert
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-10-23 11:30 UTC
- Criteria met: 7 of 7 (as the worker reported them)
- Loops: 0; CI attempts: 0
- Review rounds: 1, failed 0
- Budget used: 273,956 of 1,000,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 0
<!-- SECTION:FINAL_SUMMARY:END -->
