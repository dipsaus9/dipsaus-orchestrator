---
id: DIPO-14
title: Decide testing strategy and configuration format
status: To Do
assignee: []
created_date: '2026-10-10 11:03'
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
Outcome: an ADR defining how the engine is tested without calling Claude, and the single configuration format used across offices. Testing: unit tests with bun test; a fake worker adapter that replays recorded Claude Code stream-json sessions so engine behaviour is tested without tokens or a subscription; integration tests against real temporary git repositories, worktrees and a Backlog.md project; contract tests for commands and events; TUI tests with Ink render tests; how recordings are captured, stored and kept current; which tests run in verify and which only in CI. Configuration: one format for office configuration (tiers, budgets, timeouts, script overrides) and later role files, chosen from YAML, JSON or TOML, validated with zod, with schema versioning and migration. This is also the basis for measuring token savings against the dipsaus-ai baseline (DIPO-10).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0017-testing-strategy-and-configuration.md defines the test layers, what each covers, and which run in verify versus CI only
- [ ] #2 ADR defines the fake worker: recorded Claude Code sessions, how they are captured and refreshed, and how they cover parking, budget overruns and failures
- [ ] #3 ADR defines integration tests on real temporary git repositories, worktrees and Backlog.md projects
- [ ] #4 ADR chooses one configuration format with zod validation, schema versioning and migration, and where office and role configuration files live
- [ ] #5 Maintainer approved the decision
<!-- AC:END -->
