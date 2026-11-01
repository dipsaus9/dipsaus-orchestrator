---
id: DIPO-410
title: Read the committed office config from the base at load and reload
status: Done
assignee: []
created_date: '2026-11-01 08:57'
updated_date: '2026-11-01 14:02'
labels:
  - 'tier:S'
  - 'slice:prune'
  - 'track:2'
milestone: m-1
dependencies: []
references:
  - packages/engine/src/office/manager.ts
  - packages/engine/src/config/load.ts
  - packages/engine/src/git/office.ts
  - packages/engine/test/office/
  - docs/decisions/0017-testing-strategy-and-configuration.md
modified_files:
  - docs/decisions/0017-testing-strategy-and-configuration.md
  - packages/engine/src/office/manager.ts
  - packages/engine/test/office/committed.test.ts
  - packages/engine/test/office/config.test.ts
  - packages/engine/test/office/forget.test.ts
priority: high
type: bug
ordinal: 388000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: one daemon always runs with the office config committed on the base, so a story's run and review use what main says, whatever commit the maintainer's checkout is on.

Gap G21, 2026-10-31: the office path is the maintainer's main checkout, detached at an old commit whose .dipo/office.yaml has no `review` block. Office load (packages/engine/src/office/manager.ts `#load` → `#readConfig`, about lines 339 and 386) and `office.reloadConfig` (`#reloadConfig`, about 787) read the checkout's working tree through `loadOfficeConfig(instance.path)` (config/load.ts about 288), while a successful poll fetch and `office.rescan` read the base commit through `readBaseOfficeFile` (manager.ts about 160, via `offices.reloadIfChanged`), and only on a change. So after a restart DIPO-400 ran with the checkout's defaults (reviewer opus at effort high) while main says effort medium and sonnet for tier:S; before it, a poll had read main's file. The box image already reads the base (box/image.ts about 494).

Design (maintainer, 2026-11-01): every read of the committed office.yaml takes it from the base commit, `refs/remotes/<remote>/<base>`, as `readBaseOfficeFile` does: office load, `office.reloadConfig`, the poll and rescan. One read path; the checkout read of office.yaml is removed (0001). `office.local.yaml` stays in the checkout. Only when the repository has no remote base ref yet (a new repository) does load read the checkout, with a notice. How load finds the base before it has the config: it builds the office git from what it knows without the committed file, the remote and base from office.local.yaml when it sets them, else `origin` and `refs/remotes/<remote>/HEAD` (as `resolveBaseIn` does with no configured base), reads office.yaml at that base, and when that file names another `base` or remote, reads once more at that one and stops. Remove `readOfficeText` (manager.ts about 140) and the branch of `#readConfig` that reads the checkout; `loadOfficeConfig(dir)` callers outside the manager (grep them) either pass the base text or say in the PR why they keep a checkout read. Load seeds the last base text it read (`seenOnBase`), so the first poll does not reload for nothing. `dipo config migrate` keeps writing the checkout file: the migrated file reaches the base through a PR, and the daemon reads it once that merges; ADR 0017 says so. ADR 0017 also gets one sentence naming the base as the source. 0017, 0007, 0010, 0001.

```dipo
branch: "DIPO-410/office-config-from-base"
unknowns:
  - q: "Criterion 5 asks me to write the base-commit sentence into docs/decisions/0017 and to say that `dipo config migrate` writes the checkout file that reaches the base through a PR. The worker contract says I never write decision records. Should dipo apply decisionNotes[0] to section \"5. Format and files\" of 0017, or may I edit that ADR directly?"
    status: "resolved"
    answer: "Write it yourself in this PR: the maintainer approved this design on 2026-11-01 (the story's Design paragraph), and dipo's merge gate (DIPO-399) shows the maintainer the ADR 0017 wording before it merges. Keep it to the base-commit sentence and the config migrate sentence. Do not edit anything under backlog/."
  - q: "The macOS verify fails only on 'keeps every refusal as unknown when the box's clock cannot be read or moved (DIPO-396)' in packages/engine/test/box/safe-chain-log.test.ts, and the feedback lacks the assertion diff. Can you paste the macOS failure output for that test (the expected and received values at line 450), or confirm it is a known flake to rerun? Without it I cannot fix it without weakening the test."
    status: "resolved"
    answer: "That failure is not yours: it is the Safe-Chain clock flake that DIPO-408 (#515) fixed; #515 is now on main. Change nothing in safe-chain-log.test.ts; take main into your branch so CI runs with the fix. One more item for this story (criterion 6): when the base office.yaml names base X and the re-read at X finds a file that names no base, keep X for the configuration and the poll instead of falling back to origin/HEAD (gitSettings(config) in the re-read path); add a test. Do not edit anything under backlog/."
test_plan:
  entries:
    - kind: "automated"
      check: "(engine) office load and reload-config read .dipo/office.yaml from the base commit, not the checkout, and a fetch reads the same source"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Office load and `office.reloadConfig` read .dipo/office.yaml from the base commit (`refs/remotes/<remote>/<base>`) through the same function the poll and rescan use, shown by a test with a real git remote whose checkout is on an older commit with a different office.yaml: the loaded config and its hash are the base's
- [x] #2 The checkout read of office.yaml is removed; office.local.yaml is still read from the checkout, shown by a test
- [x] #3 A repository with no remote base ref loads the checkout's office.yaml with a named notice (for example `config.fromCheckout`), and switches to the base on the first fetch that creates the ref, shown by a test
- [x] #4 An invalid office.yaml on the base still blocks new runs with config.invalid as now, and a reload after a fixed base clears it, shown by a test
- [x] #5 ADR 0017 names the base commit as the one source of the committed office config at start, reload and fetch, and says `dipo config migrate` writes the checkout file that reaches the base through a PR
- [x] #6 When the base office.yaml names a `base` or remote other than the one load started from, load reads the file again at that base once, shown by a test; the first poll after load does not reload when the base is unchanged
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Parked 2026-11-01 12:29 UTC: ambiguous-spec
- Detail: Criterion 5 asks me to write the base-commit sentence into docs/decisions/0017 and to say that `dipo config migrate` writes the checkout file that reaches the base through a PR. The worker contract s…
- Run: run_01M6BGXNG9Y50SFRQHF58RJ5DD
- Criteria met: 5 of 6 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 0 of 2
- Review rounds: 0, failed 0 of 3
- Budget used: 200,678 of 300,000 tokens; 49 of 90 turns; 8 of 45 minutes
- Last good commit: bc45e49270ebb97a39b25820593c831654300c3b

Resumed 2026-11-01 12:30 UTC; grants: none; note: Write it yourself in this PR: the maintainer approved this design on 2026-11-01 (the story's Design paragraph), and dipo's merge gate (DIPO-399) shows the maintainer the ADR 0017 wording before it me…

Parked 2026-11-01 12:51 UTC: ambiguous-spec
- Detail: The macOS verify fails only on 'keeps every refusal as unknown when the box's clock cannot be read or moved (DIPO-396)' in packages/engine/test/box/safe-chain-log.test.ts, and the feedback lacks the…
- Run: run_01M6BGXNG9Y50SFRQHF58RJ5DD
- Criteria met: 6 of 6 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 1 of 2
- Review rounds: 1, failed 0 of 3
- Budget used: 264,622 of 300,000 tokens; 71 of 90 turns; 15 of 45 minutes
- Last good commit: a5563b57a2a1c718ba2f23e85643d4db7376abec

Resumed 2026-11-01 13:25 UTC; grants: none; note: That failure is not yours: it is the Safe-Chain clock flake that DIPO-408 (#515) fixed; #515 is now on main. Change nothing in safe-chain-log.test.ts; take main into your branch so CI runs with the f…

Parked 2026-11-01 13:26 UTC: budget-exceeded
- Detail: token budget reached: 300,277 of 300,000 budget tokens (input, output and cache creation)
- Run: run_01M6BGXNG9Y50SFRQHF58RJ5DD
- Criteria met: 6 of 6 (as the worker reported them)
- Loops: 0 of 3; CI attempts: 1 of 2
- Review rounds: 1, failed 0 of 3
- Budget used: 303,248 of 300,000 tokens; 81 of 90 turns; 15 of 45 minutes
- Last good commit: 63e78f45e869b64d82963bd0228c1ea4d155d578

Resumed 2026-11-01 13:30 UTC; grants: budget +150,000 tokens, +45 turns, +23 minutes; note: Maintainer approved a 50% top-up on 2026-11-01. Finish the criterion 6 edge case and its test, take main into the branch for the clock-flake fix, then hand off.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed 2026-11-01 14:02 UTC
- Criteria met: 6 of 6 (as the worker reported them)
- Loops: 0; CI attempts: 1 (red heads, reviewed or closed out, before this close-out)
- Review rounds: 2, failed 0
- Budget used: 351,493 of 450,000 tokens
- Runs: 1; resumes: 3
- Parks: 3
  - 2026-11-01 12:29 UTC ambiguous-spec: Criterion 5 asks me to write the base-commit sentence into docs/decisions/0017 and to say that `dipo config migrate` writes the checkout file that reaches the base through a PR. The worker contract s…
  - 2026-11-01 12:51 UTC ambiguous-spec: The macOS verify fails only on 'keeps every refusal as unknown when the box's clock cannot be read or moved (DIPO-396)' in packages/engine/test/box/safe-chain-log.test.ts, and the feedback lacks the…
  - 2026-11-01 13:26 UTC budget-exceeded: token budget reached: 300,277 of 300,000 budget tokens (input, output and cache creation)
- Grants: 1
  - 2026-11-01 13:30 UTC budget +150,000 tokens, +45 turns, +23 minutes
- Web calls: 0 searches, 0 fetches
- Proposals filed: 2
<!-- SECTION:FINAL_SUMMARY:END -->
