---
id: DIPO-405
title: Pick the reviewer's model per tier
status: Done
assignee: []
created_date: '2026-10-31 08:39'
updated_date: '2026-10-31 10:33'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/config/schema.ts
  - packages/engine/src/run/review-launch.ts
  - packages/engine/schema/office.schema.json
  - .dipo/office.yaml
priority: high
type: enhancement
ordinal: 383000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: an office can give its reviewer a model per tier, so a tier:S story is reviewed by a faster model while tier M and L keep the stronger one.

The maintainer asked on 2026-10-31 for faster reviews: sonnet for tier:S, opus for M and L, at medium effort. Today `review` in the office config (config/schema.ts `Review`) has one model and effort for every tier; .dipo/office.yaml already sets `review.effort: medium`. 0002, 0017, 0008.

```dipo
branch: "DIPO-405/review-model-per-tier"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) a tier:S story's review session uses the tier's review model, and tier M uses the office default"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The office config can set the reviewer's model and effort per tier (for example review.tiers.S.model), optional, with the office-wide review.model and review.effort as the fallback, in config version 14 with defaults and the regenerated office.schema.json
- [x] #2 The tier lookup happens where reviewerSettings reads the run's start snapshot (runConfigOf), so a run uses the tier settings it started with; a test per tier and one for a run started before a config change
- [x] #3 This repository's .dipo/office.yaml has an explicit review block: sonnet for tier S, opus for M and L, effort medium (PR #502 already sets the effort)
- [x] #4 The dipo review comment on the PR names the model and effort it used, as it does now
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
The office config takes optional review.tiers.{S,M,L}.{model,effort} (default {}, no version bump as 0017 allows for a new key with a default; schema regenerated). A review session takes its story's tier settings key by key, else the office-wide review.model and effort; the tier is the one pickup recorded from the tier: label, and a run keeps the tiers of its start snapshot. This repository reviews tier:S with sonnet and M and L with opus, at medium effort, committed by the orchestrating session because only dipo or the maintainer writes .dipo/. A builder built it after dipo's run parked on that .dipo/ edit (gap G20, DIPO-409).
<!-- SECTION:FINAL_SUMMARY:END -->
