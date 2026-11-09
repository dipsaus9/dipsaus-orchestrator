---
id: DIPO-460
title: 'TUI v2: the Floor with one pipeline line for every story'
status: In Progress
assignee: []
created_date: '2026-11-06 14:12'
updated_date: '2026-11-09 10:46'
labels:
  - 'tier:M'
milestone: m-6
dependencies:
  - DIPO-457
  - DIPO-458
references:
  - packages/tui/src/overview.tsx
  - packages/tui/src/run.tsx
  - docs/design/tui-v2/spec.md
  - docs/design/tui-v2/screens/02-floor.txt
  - packages/tui/src/queue.tsx
  - docs/design/tui-v2/screens/05-queue.txt
  - docs/design/tui-v2/designs/dipo-ux-spec.html
  - packages/contract/src/office.ts
  - packages/engine/src/gate
modified_files:
  - docs/design/tui-v2/spec.md
  - packages/contract/schema/events.schema.json
  - packages/contract/schema/reads.schema.json
  - packages/contract/schema/shared.schema.json
  - packages/contract/src/office.ts
  - packages/contract/src/software.ts
  - packages/contract/src/work.test.ts
  - packages/contract/test/fixtures.ts
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/src/gate/evaluate.ts
  - packages/engine/src/overview/chain.ts
  - packages/engine/src/overview/feature.ts
  - packages/engine/src/overview/summary.ts
  - packages/engine/test/gate/story-gate.test.ts
  - packages/engine/test/overview/chain.test.ts
  - packages/tui/src/app.test.tsx
  - packages/tui/src/app.tsx
  - packages/tui/src/chain.test.ts
  - packages/tui/src/chain.ts
  - packages/tui/src/desk.test.tsx
  - packages/tui/src/detail.test.tsx
  - packages/tui/src/detail.tsx
  - packages/tui/src/digest.test.tsx
  - packages/tui/src/home.tsx
  - packages/tui/src/live.test.tsx
  - packages/tui/src/now.ts
  - packages/tui/src/overview.test.tsx
  - packages/tui/src/overview.tsx
  - packages/tui/src/pipeline.test.ts
  - packages/tui/src/pipeline.tsx
  - packages/tui/src/queue.test.tsx
  - packages/tui/src/queue.tsx
  - packages/tui/src/run.tsx
  - packages/tui/src/spans.tsx
  - packages/tui/test/support/fake-session.ts
  - packages/tui/test/support/mock-screens.ts
  - packages/tui/test/support/setup.tsx
priority: medium
type: feature
ordinal: 433000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the overview to show each story on the same five-phase pipeline line with only the health that needs me, so that I can glance at it from a second monitor and look away.

Step 4. One Pipeline component for setup, build, review, test and merge, with verify and CI as marks. RUNNING and IN REVIEW are exclusive. Health shows only when stuck, looping or lost. An UP NEXT chain sentence. The Queue gets its three groups (Ready, waiting on a dependency, Refined), the reason column, and a preview with the gate result, needs, unblocks, touches and the chain picture. Two engine additions land here: the engine computes the dependency chain from the graph and sends it (UP NEXT sentence, CHAIN picture, the everything-below-N line, and the waiting state behind a bare needs N), and story.gate returns its rule count.

Design: docs/design/tui-v2/ (spec.md, screens/, keymap.json, roles.json, migration.md). The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text. Where spec.md's Maintainer decisions (2026-11-06) differ from the HTML, the text files win.

```dipo
branch: "DIPO-460/tui-v2-floor"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) pipeline renders each phase state and the ascii twins"
    - kind: "automated"
      check: "(unit) a story in review with no session shows only under IN REVIEW"
    - kind: "manual"
      check: "With one story running and one in review, open the Floor and then the Queue next to designs/dipo-ux-spec.html S2 and S2b"
      expect: "Cards, pipeline lines, UP NEXT, Queue groups, reason column and preview match the HTML preview side by side"
    - kind: "automated"
      check: "(unit) the engine sends the dependency chain and a bare needs N for a waiting dependency"
    - kind: "automated"
      check: "(unit) story.gate returns the rule count and the Queue preview prints Gate ✓ N rules"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 One Pipeline component draws the five phases with verify and CI marks, and every view that shows a phase uses it
- [x] #2 A story shows under RUNNING or IN REVIEW, never both
- [x] #3 Health shows only when stuck, looping or lost
- [x] #4 The Floor shows the dependency chain as one sentence under UP NEXT
- [x] #5 The Queue shows Ready, waiting on a dependency and Refined groups with the reason column, and a preview with the chain picture that points to the Desk when a park blocks it
- [x] #6 The Floor and the Queue match the HTML preview's S2 and S2b. The screens must match `docs/design/tui-v2/designs/dipo-ux-spec.html` exactly; the text mocks in `screens/` are the same screens in text
- [x] #7 The engine computes the dependency chain from the graph and sends it (engine addition); the Floor sentence, the CHAIN picture and the everything-below-N line render it without deriving anything
- [x] #8 A bare needs N in the Queue means the dependency is itself waiting, a state the engine supplies
- [x] #9 story.gate returns the number of rules (engine addition), shown as Gate ✓ N rules
- [x] #10 In the Queue, . toggles show done (N)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-09 10:35 UTC
- Criteria met: 10 of 10 (as the worker reported them)
- Loops: 3; CI attempts: 0 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 2, failed 0
- Budget used: 511,395 of 800,000 tokens
- Runs: 1; resumes: 0
- Parks: none
- Grants: none
- Web calls: 0 searches, 0 fetches
- Proposals filed: 1
<!-- SECTION:FINAL_SUMMARY:END -->
