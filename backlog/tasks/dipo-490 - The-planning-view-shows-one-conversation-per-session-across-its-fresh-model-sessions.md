---
id: DIPO-490
title: >-
  The planning view shows one conversation per session across its fresh model
  sessions
status: Refined
assignee: []
created_date: '2026-11-13 09:09'
updated_date: '2026-11-13 09:29'
labels:
  - 'tier:M'
milestone: m-3
dependencies:
  - DIPO-489
references:
  - packages/tui/src/planning.tsx
  - packages/tui/src/transcript.ts
  - packages/tui/src/planning.test.tsx
  - packages/tui/src/transcript.test.ts
  - packages/client/src/store/office-store.ts
  - packages/client/test/unit/office-store.test.ts
  - packages/contract/src/work.ts
  - packages/contract/src/office.ts
  - packages/engine/src/run/planning-session.ts
  - packages/engine/test/run/planning-world.ts
  - docs/decisions/0022-planning-sessions.md
  - docs/decisions/0009-tui.md
priority: high
type: bug
ordinal: 462000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the planning view to show one conversation per planning session, across every fresh model session it continued in and with my own messages, so that a handover or a reopened TUI never empties the screen I am planning in.

M3 (0022), a bug from the maintainer's M4 planning hand test on 2026-11-12: after a handover at 13:36:52 "The output was gone all of sudden." Split from the handover bug with DIPO-489 (the engine side: the real context measure, the maintainer's messages in the record, the notice); this story is the transcript and needs DIPO-489's message entries.

1. The transcript is per run. The TUI reads the output of `state.planning.run` only (`useTranscript`, packages/tui/src/planning.tsx:183-215, the `readOutput` loop :206-211) and starts over whenever the run changes (:193-195). A fresh model session has a new run, so everything before it leaves the screen.
2. A handover looks like an end. On `planning.ended` the client store sets `planning` to null (packages/client/src/store/office-store.ts:889-893), and it does not read `planning.continued` (packages/contract/src/office.ts:1300-1315) at all, so between the end and the fresh session's `planning.started` the view shows the new-session form, then an empty transcript.
3. The maintainer's messages live only in the TUI's memory: the view adds them as `you>` lines to its own transcript (planning.tsx:13-15, :620-625; `YOU` in packages/tui/src/transcript.ts:17-18), so a TUI opened later, or the transcript after a handover, has none of them. `PlanningView` (packages/contract/src/work.ts:777-800) lists no earlier model sessions and no messages.

The fix, one transcript per planning session:
- `PlanningView` names the session (the run of its first model session, as the record does) and lists its model sessions in order, each with its run, start and how it ended, and the maintainer's messages from the record (DIPO-489), each with its run and output offset.
- The client store keeps the session through a handover: a `planning.ended` whose reason is `context-full` marks the view as continuing instead of clearing it, and `planning.continued` puts the fresh session's view. A session the maintainer ended, or one that ended for good, still clears.
- The TUI keys the transcript by the session, not the run: it reads each model session's stored output in order, places each maintainer message at its run and offset, and marks each handover with one dim line (`continued in a fresh model session at HH:MM`, with the reason). It starts over only for another session or office.

Replaces: the per-run transcript reset, the store's clearing of the view on a `context-full` end, and the TUI-only `you>` lines (the maintainer's messages now come from the engine). DIPO-491 restyles how a maintainer message looks; this story only changes where the messages come from.

Not a guard: no deny rule, sandbox setting or permission check changes (R30 does not apply).

ADR 0022 section 1, the line "**The decision record.**" (line 18): its last sentence, "The TUI says the session continued in a fresh session.", becomes: the TUI shows the session as one conversation across its model sessions, the maintainer's messages included, and marks where it continued. ADR 0009 section 3, the **Planning** line (line 50): "the streamed answers" becomes the session's whole conversation, across its model sessions.

Tier M: one contract view change, the store's handover rule and the transcript keyed by session.

```dipo
branch: "DIPO-490/planning-transcript-per-session"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, planning-world) a session that continued twice has a view naming the session, listing its three model sessions in order with how each ended, and the maintainer's messages with run and offset"
    - kind: "automated"
      check: "(unit, office-store) planning.ended with reason context-full keeps the planning view, marked continuing, and planning.continued replaces it with the fresh view; planning.ended with reason maintainer clears it"
    - kind: "automated"
      check: "(unit, planning.test) over a fake store whose session continued once, the transcript shows the first model session's output, the maintainer's messages at their places, one continued line, then the second model session's output; it never shows the new-session form during the handover"
    - kind: "automated"
      check: "(unit, planning.test) a TUI mounted after the handover shows the same transcript, the maintainer's messages included; a new session in the same office starts an empty transcript"
    - kind: "automated"
      check: "(unit, transcript) a model line that starts with 'you>' renders as the model's text, not as a maintainer message"
    - kind: "manual"
      check: "On the scratch repository, in a planning session send two messages, restart the daemon so the model session ends, send planning.continue from the view, then quit and reopen the TUI and press 5"
      expect: "The conversation before the restart stays on screen with both messages, one continued line marks the handover, and after reopening the TUI the whole conversation is there"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The planning view names the session and lists its model sessions in order, each with its run, start and how it ended, and the maintainer's messages from the record with run and output offset
- [ ] #2 A planning.ended with reason context-full keeps the session in the client store, marked continuing, and planning.continued replaces it with the fresh view; an end by the maintainer still clears it
- [ ] #3 The TUI keys the transcript by the session: it shows every model session's output in order, the maintainer's messages at their places and one continued line per handover, and starts over only for another session or office
- [ ] #4 A TUI opened after a handover shows the whole conversation, the maintainer's messages included
- [ ] #5 The TUI-only you> lines are removed; a model line that starts with you> renders as the model's text
- [ ] #6 ADR 0022's decision-record line and ADR 0009's Planning line describe one conversation per session across its model sessions
<!-- AC:END -->
