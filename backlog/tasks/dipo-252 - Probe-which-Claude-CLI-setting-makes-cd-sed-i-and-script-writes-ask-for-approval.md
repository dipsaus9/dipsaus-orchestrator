---
id: DIPO-252
title: >-
  Probe which Claude CLI setting makes cd, sed -i and script writes ask for
  approval
status: Refined
assignee: []
created_date: '2026-10-20 20:20'
updated_date: '2026-10-20 20:44'
labels:
  - 'tier:S'
  - cutover
milestone: m-1
dependencies: []
references:
  - docs/decisions/0008-worker-adapter.md
  - docs/research/
priority: high
type: spike
ordinal: 136050
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: the facts that decide D1 are known: which Claude CLI setting makes a worker's `cd`, `sed -i` and scripted file writes ask for approval inside the sandbox, and whether, with that setting off, the Read and Edit tools are still refused outside the worktree and the toolchain while Bash stays fenced by the OS sandbox.

Type: spike. Why planning cannot settle it: the CLI's approval logic is not documented for these forms and changes between versions, so only live sessions on the pinned CLI with a real worker's settings can show it.

Context: the maintainer's decision D1 of 2026-10-20 (answer B, "container without narrowing"): isolate the worker in its sandbox and let it `cd` and use bash freely inside, gated on this probe; the write list is not narrowed to the References (scope stays checked at the end of the run). In the M1 runs about 418 Bash commands started with `cd` although the contract forbids it, and 44 of 86 run logs had a denied call (docs/research/2026-10-20-dipo-run-gaps.md, section 3.4). The 2026-10-20 DIPO-231 probe found that `cd .; ls` asks 4 of 4 times under the run settings, because the permission layer cannot check a `cd` target against the read block that `blockReadsOutsideWorkingDirectories` sets (packages/engine/src/workers/claude-cli/plan.ts writes it true); the CLI's own write-target checks are the other suspect for `sed -i` and scripted writes. The probe starts live Claude sessions, so it runs only on the scratch repository (dipsaus9/dipo-scratch-backlog) with Haiku, a worker's claude-settings.json and argv from a plan built under a temp DIPO_HOME (never the real dipo state), never in a dipo worker. The maintainer starts it by hand; never set it Ready for dipo. A read probe uses a canary file planted for the probe in a home directory outside the sandbox's read paths, never a real credential file. If both questions hold, D1 approves a dated 0008 section 2 note that switches the duplicate CLI checks off; if the second fails, the answer is explicit Read deny rules or keeping the setting, and the facts go back to the maintainer.

```dipo
branch: "DIPO-252/probe-cli-approval-setting"
unknowns: []
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A facts file in docs/research/ names the pinned Claude CLI version, the run settings used and, for each probed setting change, whether `cd <dir>; ls`, `sed -i` on a worktree file and a scripted file write (a heredoc or a redirect into a worktree file) asked for approval, ran, or were denied, with the session and its result
- [ ] #2 The same facts file shows, with the setting that stops those prompts switched off, whether the Read and Edit tools are refused for a canary file outside the worktree and the toolchain read paths, and whether a Bash command that reads or writes that canary is refused by the OS sandbox
- [ ] #3 When both hold, docs/decisions/0008-worker-adapter.md gains a dated section 2 note (D1, 2026-10-20) that names the setting dipo switches off and the facts it rests on; when either fails, no note is added and the facts file names what failed and the options left (explicit Read deny rules, or keeping the setting)
<!-- AC:END -->
