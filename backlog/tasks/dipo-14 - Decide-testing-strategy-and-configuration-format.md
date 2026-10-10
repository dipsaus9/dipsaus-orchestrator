---
id: DIPO-14
title: Decide testing strategy and configuration format
status: In Progress
assignee: []
created_date: '2026-10-10 11:03'
updated_date: '2026-10-10 11:18'
labels:
  - architecture
milestone: m-0
dependencies:
  - DIPO-1
priority: high
type: spike
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR defining how the engine is tested without calling Claude, and the single configuration format used across offices. Testing: unit tests with bun test; a fake worker adapter that replays recorded Claude Code stream-json sessions so engine behaviour is tested without tokens or a subscription; integration tests against real temporary git repositories, worktrees and a Backlog.md project; contract tests for commands and events; TUI tests with Ink render tests; how recordings are captured, stored and kept current; which tests run in verify and which only in CI. Configuration: one format for office configuration (tiers, budgets, timeouts, script overrides) and later role files, chosen from YAML, JSON or TOML, validated with zod, with schema versioning and migration. DIPO-10 owns measuring token savings against the dipsaus-ai baseline; recordings keep the usage fields that measurement needs. Configuration consumers are DIPO-4 (budgets), DIPO-5 (tier to model, budget and loop cap) and DIPO-9 (what a script override means); DIPO-14 owns only the file format, location, validation and versioning. The verify composition from ADR 0004 is unchanged; the split between verify and CI-only tests is made inside bun test (for example by file naming or an environment flag). DIPO-6 owns confirming Ink render tests under bun test; DIPO-14 only places TUI tests in the layer model.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 ADR docs/decisions/0017-testing-strategy-and-configuration.md defines the test layers, what each covers, and which run in verify versus CI only
- [x] #2 ADR defines the fake worker: recorded Claude Code sessions, how they are captured and refreshed, and how they cover parking, budget overruns and failures
- [x] #3 ADR defines integration tests on real temporary git repositories, worktrees and Backlog.md projects
- [x] #4 ADR chooses one configuration format with zod validation, schema versioning and migration, and where office and role configuration files live
- [ ] #5 Maintainer approved the decision
- [x] #6 Fake-worker recordings keep the usage fields DIPO-10's measurement needs
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Draft ADR 0017 written by research agent, reviewed by independent reviewer (pass, 9 advisories, all applied; Bun 1.4.2 probes re-run from a scratch copy). Waiting for maintainer approval.
<!-- SECTION:NOTES:END -->
