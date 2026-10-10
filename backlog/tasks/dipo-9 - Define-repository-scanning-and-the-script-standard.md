---
id: DIPO-9
title: Define repository scanning and the script standard
status: Done
assignee: []
created_date: '2026-10-09 19:46'
updated_date: '2026-10-10 11:43'
labels:
  - architecture
milestone: m-0
dependencies: []
priority: high
type: spike
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an ADR defining how the orchestrator learns to install, start, verify and test a product, and the standard script names the maintainer's projects follow. Each repository is self-sufficient (including its environment files); the orchestrator scans it, stores the run knowledge in the office's local database (DIPO-4), and refreshes it with a rescan command. A repository that follows the standard is understood by code alone; AI only infers non-standard setups and the maintainer confirms. Survey the maintainer's existing projects (for example couchcade, slaydoku, cadeauko in ~/Projects/Personal) to ground the standard in real scripts. See docs/vision.md section 7 and docs/decisions/0011-office-model.md item 8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 ADR docs/decisions/0013-repo-scan-and-script-standard.md defines the standard script names and their expected behavior
- [x] #2 ADR defines what the scan detects, what is stored, and when a rescan is needed
- [x] #3 ADR defines the AI fallback for non-standard repositories and how the maintainer confirms it
- [x] #4 ADR is grounded in a survey of at least three of the maintainer's existing projects
- [x] #5 Maintainer approved the decision
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Draft ADR 0013 written by research agent, reviewed by independent reviewer agent (verdict: pass, 12 advisory findings, all applied). Waiting for maintainer approval.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
ADR 0013 accepted: repository scan in pure code with run profile in the office database, fingerprint-based rescan, AI fallback only as proposals the maintainer confirms. Standard scripts: setup, dev (must honour PORT), test (required), lint, typecheck, verify (recommended, else composed from lint/typecheck/test, never build), build, format (check only). backlog-workflow.json is a temporary bridge. Follow-ups in other repos: verify:puzzle rename in slaydoku and cadeauko, PORT in couchcade.
<!-- SECTION:FINAL_SUMMARY:END -->
