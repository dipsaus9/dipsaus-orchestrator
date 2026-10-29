---
id: DIPO-371
title: Wire the office's main checkout into the story PR and web-call redaction
status: Ready
assignee: []
created_date: '2026-10-29 08:16'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/story-pr/prs.ts
  - packages/engine/src/run/web-calls.ts
  - packages/daemon/src/foreground.ts
priority: high
type: bug
ordinal: 351000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: review comments on a story PR are posted again, with the office's env values redacted.

Found by the cutover smoke run on 2026-10-29: every review comment was held back with "the office's main checkout is not known". DIPO-349 moved the env-secret read to the main checkout through an optional `checkout` dependency (`officeEnvSecrets`, run/env-secrets.ts), and packages/daemon/src/foreground.ts builds `StoryPrs` without it. `WebCalls` gets it in run/compose.ts. An optional dependency that silently turns a feature off is the mechanism this replaces.

```dipo
branch: "DIPO-371/wire-main-checkout"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) a StoryPrs built with the daemon's wiring posts a review comment with an env value redacted"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The daemon gives StoryPrs the office's main checkout, and a review comment is posted with the copied env files' values redacted
- [ ] #2 The checkout dependency of StoryPrs and WebCalls is required, so a composition that leaves it out fails the typecheck
- [ ] #3 A test proves a review comment is posted, not held back, for an office whose main checkout is known, and still held back when the env files cannot be read
<!-- AC:END -->
