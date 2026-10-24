---
id: DIPO-308
title: >-
  Triage the desk in the TUI: desk view, row actions, answers and review
  verdicts
status: Done
assignee: []
created_date: '2026-10-22 20:55'
updated_date: '2026-10-24 14:55'
labels:
  - 'tier:L'
  - 'slice:m1b'
milestone: m-1
dependencies:
  - DIPO-158
  - DIPO-155
  - DIPO-159
  - DIPO-161
  - DIPO-166
references:
  - packages/tui/src/
  - packages/tui/src/testing/
  - packages/client/src/store/
  - packages/contract/src/
  - packages/contract/schema/
  - packages/engine/src/reads/
  - packages/engine/src/views/
  - packages/engine/test/views/
  - packages/engine/test/reads/
  - packages/engine/src/db/migrations/
  - packages/engine/src/db/schema.ts
  - packages/daemon/src/server.ts
priority: high
type: feature
ordinal: 293000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the maintainer opens the TUI in the morning, presses `3`, sees everything that waits on them in the engine's order, and acts on each row with one key and a short prompt, without typing CLI commands.

Context: follows 0009 sections 3 to 7 and 9 (the desk mock, the interventions table, keys, connection states, narrow terminals), the 0009 amendment of 2026-10-16 (DIPO-132: the TUI desk reads the same `office.desk` as `dipo desk`), 0020 section 12 (the desk read, its six groups and order) and section 16 (the CLI forms the actions mirror), 0019 sections 11 and 14 (approve, reject and override; the verdict detail in the TUI is M1b), and 0021 section 11 (a worker's question is live only while a TUI is connected, so the TUI must be able to answer it). 0005 and 0009 forbid clients from deriving status: the TUI shows `DeskItem` rows as the engine orders them and offers only the actions a row lists. Today the TUI has the overview (`1`), the queue (`2`), the settings view, the live agent detail with `X` stop, and a shell hint (`dipo answer <id> ...`) for open questions (`packages/tui/src/detail.tsx`). It sends no answer, approve, reject, resume, hold, drop or discard.

The maintainer answered this story's questions on 2026-10-22 by accepting the recommended answers. They are in the unknowns below and in the 0005 and 0009 amendments of that day. The engine already tracks TUI connections for live questions (DIPO-279), which the stored disconnect time of criterion 8 builds on.

If DIPO-240 removes the permission relay, the permission-row part of criterion 6 (`A` or `n` allow or deny a permission row) falls away; DIPO-240 keeps the needs-permission park, so the answer row stays.

```dipo
branch: "DIPO-308/tui-desk-triage"
unknowns:
  - q: "Q1. Which actions the TUI desk binds, and whether steer, pause, hold and drop keys in the live detail and the queue are part of this story."
    status: "resolved"
    answer: "Every action office.desk can list (answer, allow, deny, approve, reject, resume, discard, drop, hold, test, proposal accept and dismiss), bound as 0009 section 5 shows, and in the same key table s steer and p pause in the live agent detail and h hold and d drop in the queue: one table and the same prompts. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q2. How the desk view stays current: re-read office.desk on desk-changing events, or a new engine event that carries the desk."
    status: "resolved"
    answer: "The TUI reads office.desk again after any office event that can change the desk (story.parked, a story leaving Parked, gate.reached, gate.decided, question.asked, a question closing, test.started, test.recorded, proposal.filed, proposal.closed, story.pr, work.phase) and after a stream reset, at most once a second. No contract change. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q3. Which keys accept and dismiss a PROPOSAL row (0009 binds none)."
    status: "resolved"
    answer: "y accepts and n dismisses on a PROPOSAL row; a view's row binding wins, as n already means deny or reject on other desk rows. (maintainer, 2026-10-22: accepted the recommended answers)"
  - q: "Q4. Whether the since-you-left digest is part of this story, and where its since time comes from."
    status: "resolved"
    answer: "In this story. The engine stores, per office in the database, when the last TUI client of that office disconnected (it already tracks TUI connections for live questions, DIPO-279); office.digest takes since as optional and defaults to that time; the overview shows one line under the count line. (maintainer, 2026-10-22: accepted the recommended answers)"
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, TUI harness) key 3 renders the desk rows of a fixture office.desk result in the read's order with Held by you apart, the empty-desk line, and one-line rows below 80 columns"
    - kind: "automated"
      check: "(unit, TUI harness) the desk view reads office.desk again after a desk-changing event and after a stream reset, at most once a second, and keeps the selected story"
    - kind: "automated"
      check: "(unit, TUI harness) each command in the key table is offered only on rows whose actions list it and when its capability flag is present; y and n accept and dismiss a PROPOSAL row; an unbound action shows its cli line"
    - kind: "automated"
      check: "(unit, TUI harness) answer, hold, reject, resume and discard prompts send the matching command with the typed text; reject and a budget resume ask yes or no first; discard and drop with branch deletion need the typed id after the loss list"
    - kind: "automated"
      check: "(unit, TUI harness) a prompt whose question or gate closed gets the engine's closed error and closes; an action is marked done only after the stream passes its reply cursor; a retryable error resends with the same request id"
    - kind: "automated"
      check: "(unit, TUI harness) Enter on a desk row shows the park record and each review verdict with per-criterion results, findings, evidence markers and an override; Esc returns to the same row"
    - kind: "automated"
      check: "(unit) office.digest without since uses the stored time the office's last TUI client disconnected, and the overview shows its line under the count line"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Key `3` opens Your desk: a count line, then the rows of `office.desk` in the read's order, each with its kind, story, reason and cause, detail and age, and "Held by you" listed apart; an empty desk says `Nothing waits on you.`; below 80 columns each row is one line (0009 section 9)
- [x] #2 The desk view reads `office.desk` again after any office event that can change the desk (`story.parked`, a story leaving Parked, `gate.reached`, `gate.decided`, `question.asked`, a question closing, `test.started`, `test.recorded`, `proposal.filed`, `proposal.closed`, `story.pr`, `work.phase`) and after a stream reset, at most once a second, and keeps the selection by story key
- [x] #3 Row keys come from one fixed table from command name to key: every action `office.desk` can list, bound as 0009 section 5 shows, `y` accept and `n` dismiss on a PROPOSAL row, and in the same table `s` steer and `p` pause in the live agent detail and `h` hold and `d` drop in the queue; a key is offered only when the row's `actions` lists the command and the engine's capability flags allow it, and an action the table does not bind shows its `cli` line in the footer
- [x] #4 Text prompts take `Enter` to send and `Esc` to cancel and keep the draft while offline: answer, hold note, reject note, discard note, steer text, and the resume note where the park needs one; reject asks yes or no first; a resume with a budget shows the caps before and after and asks yes or no (`confirmWhen`)
- [x] #5 Discard, and drop with branch deletion, show the `story.losses` list and then ask for the typed story id (`irreversibleWhen`, 0009 open question 4); every other action is one key or yes or no
- [x] #6 `a` answers an open worker question from its desk row, from the live agent detail and from an overview row whose run asks, and `A` or `n` allow or deny a permission row; a prompt whose question or gate closed in the meantime closes with the engine's message
- [x] #7 Enter on a desk row opens the story detail with the park record (reason, cause, detail) and every review verdict: round, commit, verdict, per-criterion results and findings with their evidence labels, any maintainer override and the comment URL; Esc returns to the desk with the same row selected
- [x] #8 The engine stores per office in its database when the last TUI client of that office disconnected; `office.digest` takes `since` as optional and defaults to that time; the overview shows one "since you left" line from `office.digest` under the count line
- [x] #9 An action counts as done only when the office stream passes its reply cursor; errors show in the footer, and a retryable one offers Ctrl-R with the same request id (0009 section 5)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-10-23 16:21 UTC: budget-exceeded (build)
- Detail: time cap reached: 180 of 180 minutes since the worker started
- Run: run_01M5MDFNQ99QDPAH2SMASVZT2F
- Criteria met: 9 of 9 (as the worker reported them)
- Loops: 0 of 8; CI attempts: 1 of 2
- Review rounds: 1, failed 0 of 3
- Budget used: 628,241 of 2,200,000 tokens; 189 of 300 turns; 181 of 180 minutes
- Last good commit: dc2ad468e4cf00d9c537dce3765e9c62adeeebc3
- Uncommitted files: not counted (a box run: undelivered work stays in the box)

Done 2026-10-24 (maintainer session, by the maintainer's choice to force M1 through): dipo's reviewer approved round 1 at dc2ad468; CI was red only on macOS runner timeouts that main fixed in DIPO-335, and the fix round then parked on its time cap after waiting for the plan-limit hold (gap G7, DIPO-338). The maintainer session merged main into the branch, renumbered this story's migration to 0055, put actions.ts, desk.tsx and story-card.tsx on the DIPO-127 exception lists (the maintainer will refactor them), and merged the PR by hand.
<!-- SECTION:NOTES:END -->
