---
id: DIPO-346
title: Give each box its own git repository and run verify in it at done
status: Done
assignee: []
created_date: '2026-10-25 09:51'
updated_date: '2026-10-28 10:10'
labels:
  - 'tier:L'
  - 'slice:prune'
  - 'track:1'
milestone: m-1
dependencies:
  - DIPO-345
references:
  - packages/engine/src/box/
  - packages/engine/src/run/
  - packages/engine/src/prompts/
  - packages/engine/src/workers/claude-cli/
priority: high
type: feature
ordinal: 326000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: each box holds a local git repository made by git init of its code copy, dipo runs the office's verify in the box when a done report passes the report gate, a red verify goes back as a fix round, and the worker contract is one short page without setup explanations.

Part of the prune toward the simplified architecture: docs/research/2026-10-24-simplification-audit.md and the Current state of 0003. Maintainer decisions of 2026-10-24 (audit section 12, items 2 and 5; 0002, 0008, 0014). This story replaces a barrier, so its criteria name what the old barrier caught, the bypass forms and a fail-closed test against the real path (CLAUDE.md, R30).

```dipo
branch: "DIPO-346/box-git-and-verify"
unknowns: []
test_plan:
  entries:
    - kind: "automated"
      check: "(box) a test suite that needs git passes in the box, and dipo's verify result reaches the run"
    - kind: "automated"
      check: "(box) each bypass form and the changed .git/config part are refused"
    - kind: "automated"
      check: "(prompts) the L1 golden file matches the one-page contract"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Box creation runs git init in /work and commits the start state as the box user, and parts leave the box without its .git
- [x] #2 What the old barrier caught still fails, each with a test: no git command runs on the Mac in a box folder, a part holding a .git path, git config or hook file is refused, and the Mac's repository config, refs and hooks stay out of reach
- [x] #3 The bypass forms are tested: a symlink in a part that points at .git, a .git file instead of a folder, a nested repository, and core.hooksPath or a gitdir pointer set inside the box
- [x] #4 A fail-closed test against the real path: a part carrying a changed .git/config is refused and nothing is committed
- [x] #5 At done dipo runs the office's verify in the box with a deadline, a red result becomes a fix round with its output as evidence, and the reading of the worker's tool calls for a verify run is removed
- [x] #6 The box worker's L1 is one page about what to deliver and the five door messages, golden-tested, without the no-git explanation
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Each box runs a fixed git init and start commit in /work as the box user (box/box-git.ts, no system or global config, no hooks), and every image has git. Parts leave the box without .git, and the Mac side refuses any .git path (case, NFD and look-alikes folded), links, and changed git config. Real-git tests show no dipo git call uses a box or stage folder and the Mac repository's config, refs and hooks stay unchanged; each bypass form (symlinks to .git, a .git file, a nested repo, a root gitdir, core.hooksPath) is refused for its own reason, and a part carrying a changed .git/config is refused with no commit. At done dipo runs the office's verify in the box with a deadline; red becomes feedback with bounded evidence and a loop step shared with the report gate, a verify that cannot run parks worker-failed, and with no verify command CI is the only check. The tool-trail verify nudge is removed. The worker contract is one page (golden-tested, 4,200-character cap). Real-box test (DIPO_TEST_BOX=1) and probe.sh passed on 2026-10-28.
<!-- SECTION:FINAL_SUMMARY:END -->
