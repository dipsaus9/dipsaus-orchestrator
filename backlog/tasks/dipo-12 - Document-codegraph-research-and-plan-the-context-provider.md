---
id: DIPO-12
title: Document codegraph research and plan the context provider
status: Done
assignee: []
created_date: '2026-10-10 10:27'
updated_date: '2026-10-10 10:30'
labels:
  - research
milestone: m-0
dependencies: []
priority: high
type: docs
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: codegraph (colbymchenry/codegraph) is documented as a fourth comparable tool, and the maintainer's decision is planned: a context provider interface in the engine decides which code a worker sees; the default uses the story scope and the declared component map; codegraph is an optional backend called through its CLI, and becomes a default only after measurement on real stories against the dipsaus-ai baseline.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 docs/research/2026-10-comparable-tools.md has a codegraph section: what it is, how the graph is built, how agents use it, claimed savings and their limits, fit with our design, alternatives, and adopted ideas with owners
- [x] #2 DIPO-10 has criteria for the context provider interface, the default provider, the optional codegraph backend and its measurement
- [x] #3 docs/plan.md and the milestones show when the context provider and the codegraph backend are built and measured
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
codegraph documented as research section 7 with ideas 23-28. Context provider planned: DIPO-10 designs it, M0 builds interface and default provider, M1 adds the optional codegraph backend with measurement. Review: pass, advisories applied.
<!-- SECTION:FINAL_SUMMARY:END -->
