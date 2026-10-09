---
id: DIPO-1
title: 'Decide language, runtime and project structure'
status: To Do
assignee: []
created_date: '2026-10-09 19:16'
labels:
  - architecture
milestone: m-0
dependencies: []
priority: high
type: spike
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR choosing the implementation language, runtime, package layout and tooling for a long-lived, open source CLI/daemon. Constraints: engine is headless with separate UI clients; must spawn and supervise subprocesses; must ship as a single installable CLI; maintainer has node, bun and pnpm installed (no Go or Rust toolchain yet). Compare at least TypeScript on Node or Bun, Go and Rust against these constraints, distribution, contributor friendliness and the TUI options each offers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 ADR docs/decisions/0004-language-and-runtime.md records the options compared, the choice and why
- [ ] #2 ADR states the repo layout (engine, clients, shared types) and the verify command (lint, typecheck, test)
- [ ] #3 Maintainer approved the decision
<!-- AC:END -->
