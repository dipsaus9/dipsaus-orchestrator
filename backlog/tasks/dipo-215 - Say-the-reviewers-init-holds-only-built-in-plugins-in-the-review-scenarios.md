---
id: DIPO-215
title: Say the reviewer's init holds only built-in plugins in the review scenarios
status: Done
assignee: []
created_date: '2026-10-19 14:43'
updated_date: '2026-10-20 07:58'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - tools/recordings/scenarios.ts
  - packages/engine/test/recordings/claude-cli/review-approved-live/meta.json
  - packages/engine/test/recordings/claude-cli/review-blocked-live/meta.json
priority: low
type: chore
ordinal: 215000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the expected text of the live review scenarios says what their captures show: no skill and no plugin beyond Claude Code's built-ins.

Context: review of PR #231. The review-approved-live and review-blocked-live scenarios in tools/recordings/scenarios.ts say "no skill and no installed plugin", but their live captures list three plugins in system/init. A probe on 2026-10-19 showed them as cc-plugin-agents-md, cc-plugin-telemetry and cc-plugin-plugin-authoring, each with source <name>@builtin and path builtin; dipo's reviewer check accepts @builtin by design (packages/engine/src/workers/claude-cli/plugins.ts).

```dipo
branch: "DIPO-215/review-scenarios-builtin-plugins"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) the recordings tests pass with the reworded expected text in both scenarios and both meta.json files"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The expected text of review-approved-live and review-blocked-live in tools/recordings/scenarios.ts and in their meta.json says no skill and no plugin beyond Claude Code's built-ins, and the recordings tests pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M5C43N6FKMRJHN9NS8ZFYY9N (Haiku, 13 turns, about $0.01, under 1 min) reported done, In Review, with no denied call and no write outside the References. The review-approved-live and review-blocked-live scenarios in tools/recordings/scenarios.ts and their meta.json now say the reviewer's init holds no skill and no plugin beyond Claude Code's built-ins (the three @builtin plugins accepted on 2026-10-19); only the expected lines changed, no hash or stream line. Review passed with no findings. Verify outside the sandbox: 3865 tests, 0 fail; DIPO_TEST_CI=1 tools tests pass (319); recordings:derive leaves the tree unchanged.
<!-- SECTION:NOTES:END -->
