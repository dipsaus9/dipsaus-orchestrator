---
id: DIPO-499
title: >-
  dipo starts the next Ready story by itself when it shares no files with
  running stories
status: In Review
assignee: []
created_date: '2026-11-13 12:25'
updated_date: '2026-11-13 13:05'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/run/next-up.ts
  - packages/engine/test/run/next-up.test.ts
  - packages/engine/src/create/commands.ts
  - packages/engine/src/config/schema.ts
  - packages/engine/src/run/work-run.ts
  - packages/engine/src/run-state/places.ts
  - packages/engine/src/update/self-update.ts
  - packages/engine/src/overview/desk.ts
  - packages/engine/src/overview/desk-notify.ts
  - packages/cli/src/desk-command.ts
  - packages/cli/src/watch-command.ts
  - packages/tui/src/desk.tsx
  - docs/decisions/0010-backlog-and-git-integration.md
  - docs/decisions/0017-testing-strategy-and-configuration.md
  - docs/how-dipo-works.md
  - packages/engine/src/run/resumption.ts
  - packages/engine/src/commands/execute.ts
priority: high
type: feature
ordinal: 470000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to start the next Ready story by itself when a run slot is free and the story shares no files with the running stories, so that work goes on while I am away and I only decide on overlaps.

M3, a feature from the maintainer on 2026-11-13. Asked "Does dipo auto pick up stories now?" and told that nothing starts without a confirm, the maintainer chose "Auto, if no overlap". Today every start needs `dipo next confirm <ID>` (0010, DIPO-440), so dipo idles whenever nobody watches the desk.

What runs now: `NextUp` (packages/engine/src/run/next-up.ts) works out one NEXT UP item per free slot (`#slots`: zero while scheduling is off, the office config blocks runs, or starts are paused), in next-up order, and lists the files each shares with the references and changed files of the stories with a live claim (`sharedFiles`, `runningStories`). `confirm` starts the story through `deps.start`, which is `workRun.run(ctx, { stories: [key] })` (packages/engine/src/create/commands.ts:349-372). The shared files are for display only: a failed changed-files read is caught as "no changed files" (`#offersFor`, `.catch(() => new Map())`), and `gitChangedFiles` leaves out a branch it cannot read. A story whose start `work.run` decided but has no claim yet (`starting`) is not in `runningStories`.

What this story adds:
1. **The setting.** `nextUp.autoStart` in `.dipo/office.yaml`, `none` or `no-overlap`, default `none`, in the strict office schema (packages/engine/src/config/schema.ts) with its description. `none` keeps today's behaviour. No version bump: a new key with a default needs none (0017). Not allowlisted in `office.local.yaml`.
2. **Auto start, through the confirm.** With `no-overlap`, after each refresh that leaves offers, dipo takes the first offer in next-up order and starts it through the same code path as `nextUp.confirm` (the same `deps.start`, the same `state.signature = null` and refresh after it). There is no second start path. A start needs a `CommandContext`, which today exists only inside a client command's transaction (packages/engine/src/commands/execute.ts:146), so the engine builds its own request as `resumeLifted` does, with origin `"other"` (packages/engine/src/run/resumption.ts:137-160): the run records that dipo, not the maintainer, started it. Then the next offer, one at a time, while slots stay free. An offer starts by itself only when all of these hold: its shared files are empty and known (every running story's references and changed files were read without an error, and the office's git was there to read them: `gitChangedFiles` returns an empty map when `git(officeId)` is undefined, which counts as unknown); its references are not empty; no story is in `starting` whose references or changed files it overlaps (a start decided in this pass counts at once); the office is not paused (0020), not at a plan limit, not updating, and the desk does not offer `dipo update` (DIPO-485), so an idle office can still update; and `work.run`'s pickup checks pass at the start as for a confirm (capacity, budget caps, dependency Done, live claim, planning hold, merged PR). A declined story is never offered, so never started. If anything is unknown or a read fails, the offer stays a NEXT UP item and nothing starts. **No retry loop.** `work.run` can skip the story (`pickupCheckFailed`, `notRunnable`, packages/engine/src/run/work-run.ts:653-732), throw a `CommandError`, or fail later (`startFailure`); `confirm`'s refresh would then offer it again and `#compute` filters no skipped story, so an auto start would loop. dipo keeps the story's hash with the refusal: such an offer stays a NEXT UP item with the refusal in its why, and is not started by itself again until its signature (its task file hash, or the office's next-up signature) changes. The maintainer can still confirm it.
3. **Said plainly.** Each auto start logs at INFO (`next-up`, story, the why line, "shares no files with running stories") and puts an `engine.notice` (code `run.nextUpStarted`) "started DIPO-n by itself: it shares no files with the running stories". The desk notification posts that once, and no NEXT UP item is left for it. An offer that overlaps stays a NEXT UP item as today, and its why says "not started by itself: shares <files> with DIPO-m". `dipo desk` and the TUI desk head the next-up group with "Next up starts by itself when it shares no files (nextUp.autoStart: no-overlap)" while it is on. `dipo watch` prints the notice line.
4. **This office turns it on after the binary knows the key.** The story PR does not change this repository's `.dipo/office.yaml`: the dipo that merges it would read `nextUp` as an unknown key and start no new runs (0017). After merge, once dipo has updated itself to a build with the key (DIPO-485), a `chore(main)` PR sets `nextUp: { autoStart: no-overlap }`. The final summary says so.

ADR lines that change: 0010's "Next up: how a free slot gets its story" paragraph, where "Nothing starts without a confirm" becomes the setting and the auto start rule, plus a Replaced line ("Nothing starts without a confirm" (2026-11-04, DIPO-440), replaced by `nextUp.autoStart` (2026-11-13)). 0017 gets `nextUp: { autoStart: none }  # 0010` in the sample office.yaml. docs/how-dipo-works.md step 3 ("nothing starts until you confirm"). 0002 says only that next up is in 0010 (line 132), so it stays.

Replaces: the confirm as the only way a next-up story starts, for offices that set `no-overlap`. The confirm stays for overlaps and for `none`.

A barrier change (R30): this changes what may start a run without the maintainer. What the confirm caught, each with a test that it still never starts by itself: a story overlapping a running story's references or changed files; a declined story; a start while the office is paused, at a plan limit, while dipo updates or while the desk offers an update; a story whose dependency is not Done; a start beyond `caps.parallelRuns`. Bypass forms, each tested: two slots free at once with two stories that overlap each other (the second's overlap counts the first, just started and still in `starting`); a story that becomes Ready while a run ends (its changed files are read again before it starts); the reconcile at daemon start (the first refresh after scheduling turns on starts nothing until the running stories' changed files are read); a story with no references (unknown scope, never auto-started). Fail closed against the real path: with the real `gitChangedFiles` on a fixture repository whose running branch cannot be read, with `git(officeId)` undefined, and with a `changedFiles` that throws, the offer stays a NEXT UP item and `work.run` is not called.

Tier M: one setting, one rule in `NextUp` that reuses the confirm, one notice, three plain lines, two ADR edits. The barrier tests are most of the work.

No dependencies: DIPO-495 and DIPO-497 change planning, and DIPO-496 adds a desk item after NEXT UP without changing NEXT UP.

```dipo
branch: "DIPO-499/auto-start-next-up-without-overlap"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit, config) nextUp.autoStart parses none and no-overlap, defaults to none, refuses another value and an unknown key under nextUp"
    - kind: "automated"
      check: "(unit, next-up) with none a free slot and a non-overlapping offer start nothing; with no-overlap the start goes through the confirm's start once, logs at INFO and puts one run.nextUpStarted notice, and the offer leaves the desk"
    - kind: "automated"
      check: "(unit, next-up) never started by itself, one test each: overlap with a running story's references, overlap with its changed files, a declined story, a dependency not Done, no references, paused, plan limit, updating, update offered, no free slot"
    - kind: "automated"
      check: "(unit, next-up) bypass forms: two free slots with two mutually overlapping offers start only the first; a story Ready while a run ends waits for a fresh changed-files read; the first refresh after scheduling turns on starts nothing before the changed files are read"
    - kind: "automated"
      check: "(integration, next-up) fail closed: the real gitChangedFiles on a fixture repository with a running branch that cannot be read, git(officeId) undefined, and a changedFiles that throws, leave the offer a NEXT UP item and work.run uncalled"
    - kind: "automated"
      check: "(unit, cli and tui) dipo desk and the TUI desk show the auto start line while no-overlap is on and not with none; dipo watch prints the started by itself notice"
    - kind: "automated"
      check: "(unit, next-up) no retry loop: a story whose pickup check fails is tried by itself once, then stays a NEXT UP item with the refusal in its why and is not tried again until its task file or the next-up signature changes; the same for a start that throws and one that fails later (startFailure)"
    - kind: "automated"
      check: "(unit, next-up) an auto start goes through the confirm's start with an engine-made request of origin other, and the run records it was started by dipo"
    - kind: "manual"
      check: "On the scratch repository with nextUp.autoStart: no-overlap, one story running and two Ready stories, one sharing a file with it and one not, watch the desk when a slot is free"
      expect: "The story without shared files starts by itself with a notice; the overlapping one stays a NEXT UP item naming the shared files"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 office.yaml accepts nextUp.autoStart with none or no-overlap, defaults to none, refuses any other value, and none starts nothing without a confirm as today
- [x] #2 With no-overlap, a free slot and a first offer that shares no files with the running stories, dipo starts it through the same start as nextUp.confirm, logs it at INFO with the why, and puts one notice started DIPO-n by itself with no NEXT UP item left for it
- [x] #3 An offer whose references overlap a running story's references or changed files is never started by itself and stays a NEXT UP item whose why names the shared files and story
- [x] #4 A declined story, a story whose dependency is not Done, a story without references, and any start while the office is paused, at a plan limit, updating, offering an update or at caps.parallelRuns is never started by itself, each with its own test
- [x] #5 With two slots free and two offers that overlap each other, only the first starts by itself; the second's overlap counts the first while it is still starting
- [x] #6 A story that becomes Ready while a run ends, and the first refresh after the daemon starts, start nothing by themselves until the running stories' changed files were read again
- [x] #7 Fail closed on the real path: with the real gitChangedFiles on a fixture repository whose running branch cannot be read, with git(officeId) undefined, and with a changedFiles that throws, nothing starts and the offer stays a NEXT UP item
- [x] #8 dipo desk and the TUI desk say Next up starts by itself when it shares no files while the setting is on, and dipo watch prints each started by itself notice
- [x] #9 ADR 0010's next-up paragraph describes the setting and the rule with a Replaced line for nothing starts without a confirm, 0017's sample office.yaml has the key, and docs/how-dipo-works.md step 3 matches
- [x] #10 The story PR leaves this repository's .dipo/office.yaml unchanged, and the final summary names the chore(main) PR that turns no-overlap on after dipo updated to a build with the key
- [x] #11 An offer whose auto start was refused, skipped or failed stays a NEXT UP item with the refusal in its why and is not started by itself again until its signature changes; a story whose pickup check fails is tried once and then waits on the desk
- [x] #12 An auto start uses the confirm's start with an engine-made request of origin other, as resumeLifted does, and the run records that dipo started it
<!-- AC:END -->
