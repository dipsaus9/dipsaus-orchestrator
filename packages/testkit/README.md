# Test guidance

`@dipsaus-orchestrator/testkit` holds the shared test helpers. The testing rules come from decision 0017; this page is the short version of where a test goes.

## Local suite or CI only

Local `bun test` stays under about 60 seconds (0017). Aim for about 45, so new stories have room.

### Per-test budget

These numbers trigger a move to a `*.ci.test.ts` sibling (with a fast local version kept), measured with the junit report below on the maintainer's machine:

- any single local test over about **1 second**;
- any local test file over about **4 seconds**;
- any story that adds more than about **1 second** to the whole local run. Time the run before and after, and put both numbers in the PR body.

The suite grew from about 40 to about 55 seconds over seven stories between DIPO-77 and DIPO-79, at about 2 seconds a story, with single tests up to 2.2 seconds and files up to 6 seconds. These limits would have held it near 45.

A few local tests are still over 1 second because each is the only local test of its rule: the backlog PR that opens and updates (`backlog/pr/pr.test.ts`), the Ready gate read with its contract codes (`gate/story-gate.test.ts`), the two planning-lane commits (`backlog/lane/lane.test.ts`), and the client against a real daemon (`client/test/integration/daemon.test.ts`). Do not add to them. A new case for one of these rules goes into the CI sibling, or into the same test when it needs no setup of its own.

Correctness rules never go CI only (0017). Every rule the engine enforces keeps at least one local test. What can move to a `*.ci.test.ts` sibling, which registers its `describe` only when `DIPO_TEST_CI=1`, is:

- the slow full version of a rule's test, once a fast local version of the same rule exists: real git with a bare remote, a second clone, a real release before a reclaim, several Backlog CLI calls or office loads in one test;
- a process lifecycle that is timing sensitive (a detached daemon, kill and restart);
- a case that needs a platform matrix (the sandbox).

A fast local version checks the same outcome with less setup:

- no remote, so the base is the local `main` and a change "on the base" is a commit in the main checkout;
- a status line written into the task file by hand instead of a second clone and a CLI edit;
- state the rule starts from made directly (for example a released branch made with git and one row in `released_branches`) instead of by running the steps before it;
- the injected manual clock for timeouts and polling;
- one test that checks two related outcomes instead of two tests that each pay the same setup;
- a file removed with `git rm` instead of a Backlog CLI call such as `backlog task archive`;
- a process that has already exited instead of one the test waits for in real time.

Unit tests always stay local. Moving a case is not deleting it: CI runs the sibling, so `DIPO_TEST_CI=1 bun test` must still pass with every test that ran before the move.

A CI-only sibling starts with a comment that says what it covers and why it is CI only, and wraps its `describe` blocks:

```ts
if (process.env["DIPO_TEST_CI"] === "1") {
  describe("...", () => {
    // ...
  });
}
```

The lint rule `dipo(ci-test-guard)` refuses a `*.ci.test.ts` file with a `describe`, `it` or `test` outside that guard (DIPO-316).

## Tests that start a daemon

A daemon removes the `dipo.sock` it finds in the runtime directory it chooses, and its last candidate is the real `/tmp/dipo-<uid>` (0006 decision 3). A test daemon must never get there (DIPO-109):

- The test runner's setup file (`src/test-env.ts`, DIPO-316) gives every test process the test marker `DIPO_TEST=1` and fresh `DIPO_HOME` and `DIPO_RUNTIME_DIR` folders under `DIPO_TMP`. With the marker, dipo refuses the real home's state and runtime folders, and an override it cannot use stops it instead of falling through to another folder.

- Start it with `daemonTestEnv(dir)` for a process, or `isolatedDaemonEnv(dir)` in process. Both put `DIPO_HOME`, `DIPO_RUNTIME_DIR`, `TMPDIR`, `XDG_RUNTIME_DIR` and `DIPO_TMP` under the test's temp directory.
- Wrap the test in `withDaemonTempDir`, or call `assertTestRuntimeDir(dir)`: the test fails when the daemon log names a runtime directory other than `<dir>/run` from `DIPO_RUNTIME_DIR`.
- `DIPO_TMP` may be at most 37 bytes after symlinks (`MAX_TEMP_ROOT_BYTES`). `tempRoot()`, and so every testkit temp directory, refuses a longer one, because a test daemon's socket paths under it would pass the 100-byte limit and the daemon would refuse to start. A path such as `/tmp/dt` is fine; macOS `$TMPDIR` is too long.

testkit keeps its own copy of the engine's `RUNTIME_PATH_LIMIT` and `LONGEST_RUNTIME_ENTRY`, since it may not import engine; `packages/daemon/test/unit/runtime-isolation.test.ts` keeps them equal and checks that every daemon and client test that starts a daemon follows the rules above.

## Finding slow tests

```sh
DIPO_TMP=$(mktemp -d /tmp/dt.XXXX) bun test --reporter=junit --reporter-outfile=/tmp/junit.xml
```

Each `<testcase>` in the report has a `time` in seconds. Sort by it to find the slowest cases, and time the whole local run before and after a move.
