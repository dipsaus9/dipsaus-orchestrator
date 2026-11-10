---
id: DIPO-485
title: dipo offers to update itself when it is behind
status: In Progress
assignee: []
created_date: '2026-11-10 15:36'
updated_date: '2026-11-10 16:35'
labels:
  - 'tier:M'
milestone: m-3
dependencies: []
references:
  - packages/engine/src/create/engine-behind.ts
  - packages/contract/src/software.ts
  - packages/cli/src/daemon-commands.ts
  - packages/cli/src/index.ts
  - packages/engine/src/overview/desk.ts
  - packages/daemon/src/upgrade.ts
  - packages/daemon/src/
  - scripts/build.ts
  - docs/decisions/0016-ci-release-and-versioning.md
  - docs/decisions/0005-command-and-event-model.md
  - docs/decisions/0004-language-and-runtime.md
priority: medium
type: feature
ordinal: 457000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Story: As maintainer I want dipo to offer, when it is idle and behind its base, to build itself from the base and restart on the new build, so that I stop re-pinning dipo by hand with a long command after every engine merge.

M3, because dipo builds its own M3 stories and each engine merge needs a re-pin before the next run. Today `dipo daemon status` says "the base has N engine commits after this build; rebuild dipo and run dipo daemon restart" (packages/cli/src/daemon-commands.ts:201-205, from `engineBehind`, packages/engine/src/create/engine-behind.ts and packages/contract/src/software.ts:282), and the maintainer re-pins by hand: build in a worktree, stop the daemon, copy the binary to a new file, move it over the old one (a new inode, since copying over a running binary kills it), start the daemon.

The change: when an office's base is N engine commits ahead of the running build and dipo is idle (no story run, no planning session, no audit), the desk shows one item "update dipo (N engine commits: their titles)". Its action, after one confirm: new starts pause at once (no story run, session or audit starts until the update ends; a start asked for meanwhile is refused with "dipo is updating", the way 0005's draining state refuses new work); dipo checks out the base commit in a dipo-owned worktree (never the maintainer's checkout, never a branch or PR head), runs `bun install --frozen-lockfile` there and then the repository's build script, checks the built binary runs and reports that commit, puts it beside the running binary and moves it over it (a new inode). Then the daemon restarts itself by running `dipo daemon restart` from the new binary as a detached process: the same command the maintainer runs today, which drains the daemon and starts the new binary (0005 section 19, Upgrades) and goes through launchctl when the launchd agent with KeepAlive is installed (0005 section 19, Autostart). No second restart path is added. The new daemon reports the new commit on the desk. Refused while anything runs, with what runs; a failed install, build or check keeps the old binary, lifts the pause and says why; nothing starts on its own, the maintainer confirms each update. A CLI verb `dipo update` sends the same command.

Decision lines that change (the maintainer approves the wording in this story's PR), each with one Replaced line:
- ADR 0016 section 5 (the install script, line 101): "There is no self-update." becomes "dipo updates itself only from the base commit of an office whose repository is dipo's source, when idle, on the maintainer's confirm; a release install updates with the install script."
- ADR 0005 section 19, Upgrades (line 192): "A running daemon keeps its old binary. It checks its executable every 60 s and reports \"upgrade pending\". `dipo daemon restart` drains it and starts the new binary." gains "An update from the desk (DIPO-485) pauses new starts, swaps the binary and runs `dipo daemon restart` itself."
- ADR 0005's Replaced list (line 211): "Auto-restart on upgrade (`daemon.autoRestartOnUpgrade`, default off). Removed; `dipo daemon restart` is the way (2026-10-24)." stays as history, and the new Replaced line says the daemon now restarts itself only after a confirmed update from the desk, through the same `dipo daemon restart`.
- The header of packages/daemon/src/upgrade.ts (:3-4, "The daemon never restarts itself.") is rewritten to match.
ADR 0004's build line (`bun build --compile --target=bun-darwin-arm64`) is unchanged; the update uses it.

This replaces the binary dipo runs, so (CLAUDE.md, R30): what the hand re-pin guarded is kept, each with a test: nothing is replaced while a run or session is open; a failed build leaves the old binary; the binary is copied to a new file, never written over the running one. Bypass forms to test: a base that moves during the build (the commit built is the one reported), a start asked for during the build (refused while the pause holds), a lockfile that does not match package.json (the frozen install fails and the old binary stays), a worktree path that is a link out of dipo's home, and a build output that is not an executable or reports another commit. The fail-closed test runs the real update command on a fixture-built office with a stand-in build script that fails, and shows the old binary unchanged and the daemon still on it.

```dipo
branch: "DIPO-485/update-dipo"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) an idle office with engineBehind 3 shows one desk item naming the 3 commits' titles; with a run or session open it shows none"
    - kind: "automated"
      check: "(unit, stand-in build) the update pauses new starts, runs bun install --frozen-lockfile and the build in a dipo-owned worktree at the base commit, checks the built binary reports that commit, moves a new file over the old binary (a new inode), spawns dipo daemon restart from the new binary detached, and the new daemon reports the commit"
    - kind: "automated"
      check: "(unit) refusals and bypass forms: an open run or session, a start asked for during the build (refused while the pause holds), a lockfile that does not match package.json (the frozen install fails), a base that moves during the build, a worktree path that links out of dipo's home, and a build output that is no executable or reports another commit each refuse the swap and keep the old binary"
    - kind: "automated"
      check: "(fail-closed) the real update command on a fixture-built office with a stand-in build script that fails leaves the old binary byte for byte and the daemon on it"
    - kind: "automated"
      check: "(unit) dipo update sends the same command and prints its result; ADR 0016's self-update line, ADR 0005's Upgrades line and their Replaced lines are present"
    - kind: "manual"
      check: "On the maintainer's machine, after an engine merge and with nothing running, accept the update item on the Desk"
      expect: "dipo builds, restarts on the new build, and dipo daemon status names the base commit with no engine commits behind"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When an office's base has engine commits after the running build and nothing runs, the desk shows one update item naming the commits; with anything running it shows none
- [ ] #2 Its action, after one confirm, pauses new starts, runs bun install --frozen-lockfile and the build from the base commit in a dipo-owned worktree, checks the built binary reports that commit, moves it over the running binary as a new file, restarts by running dipo daemon restart from the new binary, and reports the new commit
- [ ] #3 The update is refused while a run, session or audit is open; while it runs a start is refused as dipo is updating; a failed install, build or check keeps the old binary, lifts the pause and gives the reason
- [ ] #4 Bypass forms have tests: a base that moves during the build, a start asked for during it, a lockfile that does not match package.json, a worktree path linking out of dipo's home, and a build output that is no executable or reports another commit
- [ ] #5 A fail-closed test runs the real update command with a failing stand-in build and shows the old binary unchanged and the daemon still on it
- [ ] #6 dipo update sends the same command and prints its result
- [ ] #7 ADR 0016's self-update line (101) and ADR 0005's Upgrades line (192) describe the update from the base, each with one Replaced line beside 0005's auto-restart line (211), and upgrade.ts's header no longer says the daemon never restarts itself
<!-- AC:END -->
