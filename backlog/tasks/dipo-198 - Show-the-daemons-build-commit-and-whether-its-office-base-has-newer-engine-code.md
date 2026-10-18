---
id: DIPO-198
title: >-
  Show the daemon's build commit and whether its office base has newer engine
  code
status: Done
assignee: []
created_date: '2026-10-17 23:16'
updated_date: '2026-10-18 13:10'
labels:
  - 'tier:M'
  - cutover
milestone: m-1
dependencies: []
references:
  - scripts/build.ts
  - packages/cli/src/version.ts
  - packages/cli/src/index.ts
  - packages/cli/src/daemon-commands.ts
  - packages/cli/src/daemon-commands.test.ts
  - packages/daemon/src/control.ts
  - packages/daemon/src/foreground.ts
  - packages/daemon/src/index.test.ts
  - packages/contract/src/software.ts
  - packages/contract/src/fixtures.ts
  - packages/contract/schema/
  - packages/engine/src/git/
  - packages/engine/test/git/
  - packages/daemon/src/io.ts
  - packages/daemon/src/index.ts
  - packages/contract/src/version.ts
  - packages/daemon/src/engine-behind.ts
  - packages/daemon/src/engine-behind.test.ts
priority: low
type: enhancement
ordinal: 187000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome: `dipo daemon status` shows the commit the daemon's binary was built from and, for an office whose repository holds that commit (dipo delivering dipo), how many commits on the office's base after it change engine code, so the maintainer sees when a merged prompt, plan or host change has not reached workers yet.

Context: tonight DIPO-184's prompt rule did not reach workers until the maintainer rebuilt and restarted the binary by hand. A merged change to prompts, plan or host code reaches workers only after the daemon's binary is rebuilt and restarted. The build commit is embedded today: buildDefines in scripts/build.ts passes DIPO_COMMIT (with a -dirty suffix for a dirty tree) and DIPO_COMMIT_DATE, and compiledStamp in packages/cli/src/version.ts reads them for dipo --version. The daemon gets only the version string (runDaemon(argv, { version }) in packages/cli/src/index.ts), and daemon.status (packages/contract/src/software.ts, built in packages/daemon/src/control.ts) has version and upgradePending, which says the binary on disk changed, not that the base moved past it. A dev build's version is <x>-dev for every commit, so versionHint never tells two dev builds apart. Every file in the binary lies under packages/ (ROOT in scripts/build.ts), so commits that change files under packages/ are the ones that need a rebuild. An office whose repository holds the build commit is detected with git, with no config.

ADR 0005 section 7 lists the daemon.status result and 0006 section 5 lists what dipo daemon status prints. Optional fields are an additive contract change, but each such change so far has a dated 0005 amendment line, so the maintainer decided: both notes were approved on 2026-10-18 and are in docs/decisions/0005-command-and-event-model.md and docs/decisions/0006-daemon-and-ipc.md (Amendments, 2026-10-18, DIPO-198). This story does not edit docs/decisions/.

```dipo
branch: "DIPO-198/daemon-build-commit-and-stale-base"
unknowns:
  - q: "Do you approve a dated amendment of 0005 section 7 (additive, contract minor) that gives daemon.status an optional build commit and, per loaded office whose repository holds that commit, the count of base commits after it that change files under packages/, and a 0006 section 5 note that dipo daemon status prints both?"
    status: "resolved"
    answer: "Approved by the maintainer on 2026-10-18: the 0005 section 7 amendment and the 0006 note of 2026-10-18 (DIPO-198)."
test_plan:
  entries:
    - kind: "automated"
      check: "(unit) daemon.status carries the build commit from the compiled stamp and none when run from source"
    - kind: "automated"
      check: "(integration, real git) with the base two commits past the build commit, one changing packages/ and one only docs/, the office's count is 1; an office whose repository lacks the commit gets no count"
    - kind: "automated"
      check: "(unit, cli) dipo daemon status prints the commit line and the rebuild line, and --json carries both fields"
    - kind: "manual"
      check: "(local) with a temp DIPO_HOME, build dipo at a commit one engine change behind origin/main, start its daemon with this repository as office, and run dipo daemon status"
      expect: "it prints the build commit and says the office base has 1 engine commit after this build, with the rebuild and dipo daemon restart hint"
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 daemon.status (packages/contract/src/software.ts) gains an optional build commit, filled from compiledStamp (packages/cli/src/version.ts) through runDaemon (packages/cli/src/index.ts) into controlFeature (packages/daemon/src/control.ts), with the -dirty suffix kept and the field absent when running from source; packages/contract/src/fixtures.ts and the JSON Schema under packages/contract/schema/ (bun run contract:schema) are updated; packages/contract/src/version.ts notes the minor addition
- [x] #2 daemon.status gains, for each loaded office whose repository holds the build commit, the number of commits on the office's base branch as last fetched after the build commit that change files under packages/; offices without the commit, and a daemon run from source, get none; the git reads go through packages/engine/src/git/
- [x] #3 dipo daemon status (formatRunning in packages/cli/src/daemon-commands.ts) prints a commit line, and for an office with a count above 0 a line naming the office and the count and saying to rebuild dipo and run dipo daemon restart; --json carries both fields; tests in packages/cli/src/daemon-commands.test.ts show both
- [x] #4 A test in packages/engine/test/git/build-commit.test.ts with a real git fixture shows a base two commits past the build commit, one changing packages/ and one changing only docs/, gives a count of 1, and an office whose repository lacks the commit gets no count
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Delivery: dipo run run_01M57GN5Z2QXZ7JZE90H6W0SDP (Sonnet medium, 31 turns, about $0.61, 3 min) reported done, In Review on DIPO-198/daemon-build-commit-and-stale-base. One sed -i was auto-denied (G7). daemon.status gains buildCommit (compiledStamp through runDaemon and DaemonIo) and engineBehind per office ({office, name, commits}; name is the main checkout's basename, a worker choice the review accepted as additive); the count is rev-list <build>..<remote>/<base> -- packages/ on the base as last fetched.

Review found a latency regression: every daemon.status call ran 3 to 4 git spawns per office through the office's serial GitQueue, which a fetch can hold for up to 60 s, while the client lifecycle gives status about 1 s. Fixed on top: daemon.status is synchronous again and reads EngineBehindCache (packages/daemon/src/engine-behind.ts, new, so it and its test were added to the References), which reads in the background after recovery and every 60 s, one read per office in flight, each git step bounded at 10 s, keeping the last count on a failed read. Tests now show the count reads the fetched ref and not HEAD, and none without the remote ref. Mutation checks: each of ten mutations fails a test. Verify: 3378 pass, 2 skip, 0 fail; DIPO_TEST_CI=1 on daemon, cli, engine/test/git and contract: 824 pass. Re-review passed apart from the scope, fixed here.

Not run: the manual live check (a binary built from an older commit shows the rebuild line); it goes into the maintainer's hand-test session.
<!-- SECTION:NOTES:END -->
