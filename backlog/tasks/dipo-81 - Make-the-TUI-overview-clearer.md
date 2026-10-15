---
id: DIPO-81
title: Make the TUI overview clearer
status: To Do
assignee: []
created_date: '2026-10-14 15:29'
updated_date: '2026-10-15 11:49'
labels:
  - 'tier:M'
milestone: m-0
dependencies:
  - DIPO-54
  - DIPO-55
references:
  - packages/tui/src/
  - docs/decisions/0009-tui.md
  - docs/decisions/0005-command-and-event-model.md
priority: medium
type: feature
ordinal: 72000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the maintainer can tell at a glance what the office is doing and what each running story is doing now, from the TUI overview and the office switcher.

Context: maintainer feedback from the DIPO-54 hand test (2026-10-14): "Ready 0 was not visible, only in the overview, but not in the office. I find it a bit confusing on what is happening and the layout feels a bit odd." The live output itself is DIPO-55 ("If a process is running I want to be able to view what is happening"); this story makes the overview and switcher clearer around it.

The layout is a design decision the maintainer makes: the story starts with a short written proposal (text mock of the overview and switcher at 120 and 80 columns) that the maintainer approves before any code changes. If the proposal changes the 0009 mock, the 0009 amendment needs the maintainer's approval too.

Inherited rules (M0 breakdown, DIPO-15): `bun run verify` is green on the branch and on `main` after merge, and CI `ci-ok` and `pr-title` pass. The TUI stays a pure client of the contract. Local `bun test` stays under about 60 seconds; slower tests are `*.ci.test.ts`. Tests create temp files and sockets only under `DIPO_TMP`.

```dipo
branch: "DIPO-81/make-tui-overview-clearer"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(tui) render tests of the approved overview and switcher layout at 120, 80 and 60 columns"
    - kind: "manual"
      check: "Run TASK-1 from the TUI on the scratch repo and watch the overview and the switcher"
      expect: "Ready, running and review counts match in both places, and each running story says what it is doing now in words"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A layout proposal (text mock of the overview and the office switcher at 120 and 80 columns) is approved by the maintainer before code changes
- [ ] #2 The office switcher shows the Ready count next to running, desk and held, matching the overview
- [ ] #3 Each running story's overview row says in words what it is doing now (for example the phase and the worker's last tool or step), not only codes and glyphs
- [ ] #4 The overview layout follows the approved proposal at every width tier, with [q] quit always visible
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Maintainer approved this layout proposal on 2026-10-15, with choice A option 1 (OfficeSummary.ready) and choice B option 1 (now line shows the stored line).

# DIPO-81 layout proposal: a clearer overview and office switcher

Status: proposal for the maintainer (AC #1). No code has changed. Current frames were captured from the
golden fixture (`packages/tui/src/testing`) at 24 rows.

## 1. Today

Switcher (`o`), the same at 120 and 80 columns:

```
 Offices · daemon running  12:04
 > dipsaus-orchestrator  3 running  desk 2  held 1  (open)
   couchcade  0 running  desk 0  held 0
   slaydoku  1 running  desk 1  held 0  day 84%  ALERT day usage
 [Enter] open  [n] open new repo path  [j/k] move  [Esc] back  [q] quit
```

- There is no Ready count, so "is anything about to run?" can only be answered from inside the office.
- The numbers don't line up between rows, and nothing says what "desk" means.

Overview (`1`) at 120:

```
 STORY   ROLE      T PHASE  HEALTH    AC  LOOP VERIFY  BUDGET         TIME MODEL         TURNS
>DIPO-21 developer M build  busy >    4/7 2/5  passing [####----] 52% 38m  claude-sonnet 31
 DIPO-24 developer S verify looping @ 2/3 2/3  failing [######--] 78% 22m  claude-sonnet 22
 DIPO-19 reviewer  L review ASKING ?  9/9 1/8  passing [#-------] 18% 1h05 claude-opus   12
 Ready 2 · waiting 1 (on DIPO-21) · held 1 · desk 2
 [Enter] detail  [j/k] move  [2] queue  [o] offices  [q] quit
```

At 80 the same table drops MODEL and TURNS and shortens the role to `dev`/`rev`.

- Each row is all codes and glyphs: no title, and nothing about what the worker is doing now. You have to press Enter to find out.
- Parked, In Review and Ready stories show up only as counts in the bottom line, so you can't tell which story needs you.
- The counts sit at the bottom, after the table. With nothing running, the overview is one hint line.

## 2. Proposal

The overview becomes a board with short sections. A count line goes at the top, and each running story gets a `now` line.
Scenario: DIPO-24 running, DIPO-26 parked on a permission, DIPO-19 In Review, DIPO-30 Ready.

Switcher at 120 (at 80 the TODAY column drops the alert text and keeps `84% !`):

```
 Offices · daemon running  12:04
   OFFICE                RUNNING  NEEDS YOU  READY  HELD  TODAY
 > dipsaus-orchestrator  1        1          1      0     30%                   (open)
   couchcade             0        0          0      0     3%
   slaydoku              1        1          2      0     84%  ALERT day usage
 [Enter] open  [n] open new repo path  [j/k] move  [Esc] back  [q] quit
```

Overview at 120:

```
 dipsaus-orchestrator · daemon running · live
 1 running · 1 needs you · 1 in review · Ready 1 · waiting 0 · held 0 · today 1.2M of 4M tokens
 RUNNING (1)
>DIPO-24 Add verify retry            developer S  verify  looping @  AC 2/3  loop 2/3  [######--] 78% 22m claude-sonnet
     now: running verify · FAIL test/retry.test.ts > caps at 3 retries · 12s ago
 NEEDS YOU (1)
 DIPO-26 Compose dev stack           parked 40m · needs permission: Bash(docker compose up)       [3] desk
 IN REVIEW (1)
 DIPO-19 Review the merge slot       L  in review · no worker running
 READY (1)
 DIPO-30 Add park reasons to digest  S  next to run · [2] queue, then u
 [Enter] detail  [j/k] move  [2] queue  [3] desk  [o] offices  [q] quit
```

Overview at 80:

```
 dipsaus-orchestrator · daemon running · live
 1 running · 1 needs you · 1 in review · Ready 1 · waiting 0 · held 0
 RUNNING (1)
>DIPO-24 Add verify retry       verify looping @ AC 2/3 [######--] 78% 22m
     now: running verify · FAIL test/retry.test.ts > caps at 3… · 12s ago
 NEEDS YOU (1)
 DIPO-26 Compose dev stack      parked 40m · needs permission: Bash(docker…
 IN REVIEW (1)
 DIPO-19 Review the merge slot  in review · no worker running
 READY (1)
 DIPO-30 Add park reasons to…   next to run · [2] queue, then u
 [Enter] detail  [j/k] move  [2] queue  [o] offices  [q] quit
```

With nothing running, at 120 (this answers "Ready 0, what is happening?"):

```
 0 running · 0 needs you · 0 in review · Ready 0 · waiting 1 · held 1
 Nothing is running and nothing is Ready: DIPO-31 waits on DIPO-21, DIPO-33 is Refined (R15).
 [2] queue  [o] offices  [q] quit
```

How the `now` line reads: a phase word (`setting up`, `building`, `running verify`, `reviewing`,
`testing`, `merging`; an unknown phase shows as its own word), then the newest worker line (the newest
verify line in the verify phase), then its age. `ASKING ?` reads `now: asking you · [3] desk`, and no
output reads `no output yet`. The 60–79 card tier keeps its two lines and puts the `now` text on the
second line. Below 60 columns the TUI still shows the single narrow list.

## 3. Changes and what stays

Changes:
- Switcher: the rows line up under titles, with a READY column and NEEDS YOU in place of `desk`.
- Overview: the count line moves to the top and always shows Ready (also as `Ready 0`) and `in review`.
- Overview: sections RUNNING, NEEDS YOU, IN REVIEW and READY, each row with its story title. Empty sections are hidden.
- Running rows get a `now` line, built the same way as the detail's `nowLine` (shared code).
- An idle office says in one line why nothing runs: waiting dependencies and Refined gate rules.
- The 0009 overview and switcher mocks change, so 0009 needs a small amendment. That amendment needs your approval.

Unchanged:
- Keys: `1` `2` `o` `q`, `j/k` and Enter move over and open the running rows only, Esc goes back. `[q] quit` is always the last hint `fitHints` drops, at every width. The queue, the detail and the narrow list stay the same.
- The width tiers (120+, 80–119, 60–79 cards, under 60 narrow), health words with glyphs, ASCII mode, and colour as an extra only.
- Data: the contract already sends everything except one item:
  - Counts, titles, parked reason and detail, and In Review: `StoryView` (`column`, `title`, `parked`).
  - NEEDS YOU: `OfficeSummary.waitingOnMaintainer`. Today: `dayUsage`.
  - The `now` text: the store's `work.output` listener for every run of the open office. On open, a short `work.outputRange` tail per running run, as the detail already reads it.
- New engine data: the switcher's READY count for offices that are not open. `OfficeSummary` has `running`, `parked`, `onHold` and `waitingOnMaintainer`, but no Ready count (see choice A).

## 4. Open choices

A. Where the READY count comes from for offices that are not open.
   1. Add `ready: Count` to `OfficeSummary` (an additive contract minor change, engine-derived; a 0005/0009 amendment).
   2. The TUI shows `?` for offices that are not open and counts from stories only for the open one.
   Recommendation: option 1. AC #2 asks for "matching the overview", and option 2 shows `?` on most rows.

B. How the `now` line shows the worker's newest line.
   1. As stored, after the phase word (`building · [tool] Edit src/retry.ts`).
   2. Turn tool lines into words (`building · editing src/retry.ts`).
   Recommendation: option 1. Option 2 makes the TUI parse adapter output formats, which goes against
   "Claude specifics stay out" (CLAUDE.md). Plain verbs can come later from the engine as data.
<!-- SECTION:NOTES:END -->
