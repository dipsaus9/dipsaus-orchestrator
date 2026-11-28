---
id: DIPO-530
title: 'TUI v2: close the gaps between the shipped screens and the mocks'
status: In Progress
assignee: []
created_date: '2026-11-28 14:11'
updated_date: '2026-11-28 19:35'
labels:
  - 'tier:M'
  - 'role:developer'
milestone: m-6
dependencies:
  - DIPO-520
references:
  - packages/tui/src/keys.ts
  - packages/tui/src/footer.ts
  - packages/tui/src/frame.tsx
  - packages/tui/src/detail.tsx
  - packages/tui/src/planning.tsx
  - packages/tui/src/story-card.tsx
  - packages/tui/src/views.tsx
  - packages/tui/src/queue.tsx
  - docs/design/tui-v2/keymap.json
  - docs/design/tui-v2/screens/02-floor.txt
  - docs/design/tui-v2/screens/03-run.txt
  - docs/design/tui-v2/screens/04-story-reader.txt
priority: high
type: bug
ordinal: 491000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want the shipped TUI to match the TUI v2 mocks and the key registry exactly, so that every screen reads and behaves the way the design decided.

Found on 2026-11-27 by comparing a screen recording of v26.13.1 and origin/main (ebde2136) with docs/design/tui-v2 (its 30 decisions included). Each item is a cell difference DIPO-520 will report; this story removes them, or changes a mock where the maintainer says the code is right. Retro (S2c) is DIPO-531's and the Queue's footer and views are DIPO-532's (its `plan` view replaces 05-queue.txt's three groups), so neither is in here.

1. Footers differ from the mocks (keymap.json order and labels, and the right side):
   - Floor: mock `↑↓ move   ⏎ watch run   s steer   p park` | `: commands   ? keys`; built `↑↓ move   ⏎open   c copy id` | `5 plan   : commands   ? keys   O offices   q q quit`. `s` and `p` are not bound on the Floor in keys.ts (keymap.json binds steer and park to floor).
   - Run: mock `s steer   p park   v stream   ↑↓ scroll   G follow   c copy id` | `esc back   ? keys`; built adds `z expand`, swaps s and p, right `esc back   q q quit`.
   - Story reader: mock right `esc back   ? keys`; built `esc back   q q quit`.
2. A hint whose key is ⏎ or ⌥⏎ has no space before its label: `⏎story`, `⏎open`, `⏎expand round`, `⏎send`, `⌥⏎new line`. Mock: `⏎ story`. Likely the width of ⏎ counted as 2.
3. Two rules are not faint: under the Run header (detail.tsx:724) and under the Plan head (planning.tsx:1095) render in the default colour.
4. The Frame does not fill the terminal: on the Floor and in the story reader the ticker, rule and keys sit under the content instead of on the last three rows (frame.tsx has no height).
5. The ticker shows one message with no time ("start DIPO-519: done", the run result) for minutes. Mock: the latest events, each with HH:MM, `  ·  ` between; a run result goes to it as an event (tui-v2 migration step 2).
6. Story reader head: the mock has no rooms row; it shows the path `dipo / <office> / <room> / ` dim then the id, `● live` and the time, the bold hi title, then a dim status line (`✓ Done · merged 10:21 · …`, or for a park `✗ Parked · by-maintainer · 23h ago · 0 runs`). Built: rooms row, no path, `Parked · 0 runs`.
7. The underline of the current room, filter tab, reader tab and Retro period: the maintainer decided on 2026-11-28 that it takes the text's colour, as built (no SGR 58); the backlog PR that filed this story changed the reading rule in tui-v2 spec.md and roles.json. Nothing to build; the cell test holds it.
8. Keys keymap.json has and the TUI lacks: `/` filter (desk, queue, floor, offices), `n N` while a filter is open, `g G` top and bottom, `f` raise an advisory as a proposal (story).
9. The Queue row of a Refined story says `gate not checked yet` while its preview shows a gate failure from an earlier decision (`✗ R15 …`). The preview must say the result is for older content, or both must show the same state.
10. MODEL and the Floor's criteria line print the raw model id (`claude-sonnet-5-5`); the mocks show the short name (`opus-5.5`, `sonnet-5.5`).
11. The rooms row shows `5 Plan` and `6 Roles`; no mock has them. The maintainer decided on 2026-11-28: the rooms row shows `1 Desk` to `4 Retro` only; `5` (the chat, today the Plan view) and `6` (Roles) keep their keys and their palette rows.

```dipo
branch: "DIPO-530/tui-v2-mock-gaps"
unknowns:
  - q: "Item 7: SGR 58 underline colour, or mocks change to underline in the text colour"
    status: "resolved"
    answer: "The underline takes the text's colour; the mocks' reading rule changed (maintainer, 2026-11-28)."
  - q: "Item 11: rooms 5 and 6 in the rooms row or not"
    status: "resolved"
    answer: "Not in the rooms row: it shows rooms 1 to 4 only; 5 and 6 keep their keys and palette rows (maintainer, 2026-11-28)."
test_plan:
  entries:
    - kind: "automated"
      check: "(integration) 02-floor, 03-run and 04-story-reader pass expectScreen whole"
    - kind: "automated"
      check: "(unit) every footer hint has one space between key and label, ⏎ and ⌥⏎ included"
    - kind: "automated"
      check: "(unit) on a 40-row terminal the keys are on row 40 for every room and level"
    - kind: "automated"
      check: "(unit) / filters the Floor list and n N move between matches"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The footers of the Floor, Run and story reader match their mocks in order, labels and right side, and steer and park work on the Floor
- [ ] #2 Every key hint has one space between key and label
- [ ] #3 Every rule is faint, the Run and Plan rules included
- [ ] #4 The Frame fills the terminal height in every room and level
- [ ] #5 The ticker shows the latest events with their times and the run result is one of them
- [ ] #6 The story reader's head matches 04-story-reader.txt, with a status line for every story state
- [ ] #7 / filter, n N, g G and f work as keymap.json binds them
- [ ] #8 A Refined row and its preview never show different gate states
- [ ] #9 Model names show in the short form of the mocks
- [ ] #10 The rooms row shows rooms 1 to 4 only, and every underline takes its text's colour
<!-- AC:END -->
