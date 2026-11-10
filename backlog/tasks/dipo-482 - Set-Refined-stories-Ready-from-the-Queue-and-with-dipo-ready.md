---
id: DIPO-482
title: Set Refined stories Ready from the Queue and with dipo ready
status: In Progress
assignee: []
created_date: '2026-11-10 15:30'
updated_date: '2026-11-10 17:37'
labels:
  - 'tier:M'
milestone: m-3
dependencies:
  - DIPO-479
  - DIPO-480
references:
  - packages/engine/src/run/planning-session.ts
  - packages/engine/src/gate-decisions/feature.ts
  - packages/engine/src/backlog/lane/planning.ts
  - packages/engine/src/records/story-keys.ts
  - packages/contract/src/office.ts
  - packages/cli/src/index.ts
  - packages/tui/src/queue.tsx
  - packages/tui/src/keys.ts
  - packages/engine/test/run/planning-ready.test.ts
  - docs/decisions/0012-story-standard.md
  - docs/decisions/0009-tui.md
  - docs/design/tui-v2/keymap.json
  - docs/design/tui-v2/screens/05-queue.txt
  - docs/design/tui-v2/spec.md
priority: high
type: feature
ordinal: 454000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want to pick Refined stories in the Queue, or name them to the dipo ready command, and set the ones that pass the Ready gate Ready with one key and one confirm, so that stories stop piling up in Refined because the only way to Ready is the end of the planning session that filed them.

M3 (0022): it widens M3's Ready step (DIPO-451) beyond a planning session, and M3 is the milestone in progress, so it is not held behind M6. The maintainer's words (2026-11-10): "it is annoying now that we have a lot of things in the refined lane but not ready. I don't know how I get them into ready. This has to be easier. Maybe even in the queue view?"

On main the only way is `planning.ready`, key Ctrl-G in the Plan view today (Y in the Ready step from DIPO-487), and only for stories that session filed or edited: `ready` in packages/engine/src/run/planning-session.ts (:788-860) refuses any other story with `planning.storyUnknown` (:801-822), and `#readyOne` (:861-908) does the work: a story with no key yet (filing PR not merged) or with an edit still open in the lane is refused, the gate is evaluated in the `ready` mode and its decision stored (`recordGateDecision`), and a passing story is set Ready through the planning lane (`lane.setReady`), in a backlog PR other than the one that filed it (0012). The Queue already shows a Refined story's first gate failure and, in its preview, the gate from `story.gate` (packages/tui/src/queue.tsx:57-60), but not that a story passes.

One mechanism (0001): `#readyOne` moves out of the planning session into one engine function that a new office command `story.ready { stories }` and `planning.ready` both call; it is not copied. `planning.ready` keeps its "only this session's stories" rule as its own choice of stories, since it is the session's end step, through the session-story helper DIPO-480 adds (which also covers a story whose filing PR has not merged); `story.ready` takes any story the office has on the base. Who may set Ready does not widen: only the maintainer's commands (TUI and CLI) send it, never a worker, reviewer or planner, which have no command access (0008, 0022). What the old path refuses stays refused on the new one, and `story.ready` adds one rule the planning path did not need: only a Refined story is set Ready.

The Queue: Refined rows show "gate passes" (ok) or the first failure in plain words with what to fix, from the engine's stored gate result; space marks a row; Y sets the marked rows (or the focused one) Ready after one confirm that lists them; the result shows per story set, queued or refused with the gate's messages, and a queued one names the backlog PR it waits on from the command result's flush (`LaneFlush`, held or opened with its PR); DIPO-481's lane read adds the CI state once it lands, with no change here. The CLI verb `dipo ready <id>...` sends the same command and prints the same result.

ADR lines that change (the maintainer approves the wording in this story's PR): 0012's Refined to Ready row ("At the end of a planning session ... Otherwise the maintainer sets the status in a backlog PR") gains "or from the Queue and `dipo ready`, through the same step"; 0022's Ready line stays; 0009's Queue view and actions table gain space and Y. Each gets one Replaced line where a rule is replaced.

This changes who may set a story Ready and when, so (CLAUDE.md, R30): the old path caught a story filed but not merged, a story whose edit still waits in the lane, a gate failure and (for `planning.ready`) a story of another session; each keeps a test. The new path also refuses a Draft, an In Progress, In Review, Parked or Done story and an unknown id. Bypass forms to test: a lower-case id, a `DRAFT-n` id, the same id twice, an archived story's id, and a list where one id is unknown (nothing changes) or one fails the gate (the others still go). The fail-closed test runs `story.ready` through the real engine command with a fixture-built office, the real gate and lane, never a fake gate.

Tier M: one moved engine function and one command, a CLI verb, and the Queue's marks and key. Needs DIPO-480, because both rewrite `ready` in planning-session.ts and this story keeps the session rule through 480's helper, and DIPO-479, because both change the Queue's keys, keymap.json `runNow` and ADR 0009's actions table (479 moves run now to r; this story adds space and Y beside it). It does not wait for DIPO-481.

```dipo
branch: "DIPO-482/ready-from-the-queue"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, fixture-built office) story.ready on two Refined stories on the base that pass the gate stores a passing decision for each and sets both Ready in one backlog PR that is not the PR that filed them"
    - kind: "automated"
      check: "(unit) planning.ready and story.ready call the same Ready function; planning.ready still refuses a story of another session with planning.storyUnknown"
    - kind: "automated"
      check: "(unit, fixture-built office) refusals: a story filed but not merged, a story with an open edit in the lane, a gate failure (with the gate's messages), a Draft, an In Progress, In Review, Parked and Done story, and an unknown id are each refused with a reason and stay as they are"
    - kind: "automated"
      check: "(unit, fixture-built office) bypass forms: a lower-case id resolves like its upper-case form; a DRAFT-n id, an archived story's id and an unknown id in the list refuse the whole command and change nothing; the same id twice is set once; one gate failure in the list leaves the others set Ready"
    - kind: "automated"
      check: "(fail-closed) story.ready through the real engine command, the real gate and the real lane on a fixture-built office refuses a story that fails the gate and never journals a Ready change for it"
    - kind: "automated"
      check: "(unit) the Queue shows 'gate passes' or the first failure in plain words on Refined rows, space marks rows, Y opens one confirm listing them, and the result shows set, queued (with the backlog PR from the flush) or refused per story"
    - kind: "automated"
      check: "(unit) dipo ready DIPO-1 dipo-2 sends story.ready with both ids and prints each story's result; it exits non-zero when any was refused"
    - kind: "manual"
      check: "On the scratch repository, with three Refined stories of which one fails the gate, open the Queue, mark all three with space and press Y, confirm"
      expect: "The failing one shows its gate messages and stays Refined; the other two show waiting for the backlog PR, then Ready once it merges; dipo ready on another Refined story does the same from the shell"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new office command story.ready sets each named Refined story on the base that passes the Ready gate Ready through the planning lane, stores the passing decision, and never in the PR that filed it
- [ ] #2 planning.ready and story.ready call one Ready function moved out of the planning session; planning.ready keeps its rule that only the session's stories are chosen, through DIPO-480's session-story helper
- [ ] #3 A story filed but not merged, a story with an open edit in the lane, a gate failure, a Draft, an In Progress, In Review, Parked or Done story and an unknown id are refused with a reason and stay as they are, each with a test
- [ ] #4 Bypass forms have tests: a lower-case id, a DRAFT-n id, the same id twice, an archived story's id, a list with an unknown id (nothing changes) and a list with one gate failure (the others still go)
- [ ] #5 A fail-closed test runs story.ready through the real engine command, gate and lane on a fixture-built office and shows a failing story gets no Ready change
- [ ] #6 The Queue shows on each Refined row that the gate passes or its first failure in plain words with what to fix
- [ ] #7 In the Queue, space marks Refined rows and Y sets the marked or focused stories Ready after one confirm that lists them, and the result shows each story set, queued with the backlog PR it waits on (from the flush result) or refused with the gate's messages
- [ ] #8 dipo ready <id>... sends story.ready and prints each story's result, exiting non-zero when one was refused
- [ ] #9 ADR 0012's Refined to Ready row and ADR 0009's Queue view and actions describe the Queue and dipo ready, with Replaced lines where a rule is replaced, and keymap.json, screens/05-queue.txt and spec.md show space and Y
<!-- AC:END -->
