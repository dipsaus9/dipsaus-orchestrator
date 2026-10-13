# Test guidance

`@dipsaus-orchestrator/testkit` holds the shared test helpers. The testing rules come from decision 0017; this page is the short version of where a test goes.

## Local suite or CI only

Local `bun test` stays under about 60 seconds (0017). Aim for about 45, so new stories have room.

Correctness rules never go CI only (0017). Every rule the engine enforces keeps at least one local test. What can move to a `*.ci.test.ts` sibling, which registers its `describe` only when `DIPO_TEST_CI=1`, is:

- the slow full version of a rule's test, once a fast local version of the same rule exists: real git with a bare remote, a second clone, a real release before a reclaim, several Backlog CLI calls or office loads in one test;
- a process lifecycle that is timing sensitive (a detached daemon, kill and restart);
- a case that needs a platform matrix (the sandbox).

A fast local version checks the same outcome with less setup:

- no remote, so the base is the local `main` and a change "on the base" is a commit in the main checkout;
- a status line written into the task file by hand instead of a second clone and a CLI edit;
- state the rule starts from made directly (for example a released branch made with git and one row in `released_branches`) instead of by running the steps before it;
- the injected manual clock for timeouts and polling;
- one test that checks two related outcomes instead of two tests that each pay the same setup.

Unit tests always stay local. Moving a case is not deleting it: CI runs the sibling, so `DIPO_TEST_CI=1 bun test` must still pass with every test that ran before the move.

A CI-only sibling starts with a comment that says what it covers and why it is CI only, and wraps its `describe` blocks:

```ts
if (process.env["DIPO_TEST_CI"] === "1") {
  describe("...", () => {
    // ...
  });
}
```

## Finding slow tests

```sh
DIPO_TMP=$(mktemp -d /tmp/dt.XXXX) bun test --reporter=junit --reporter-outfile=/tmp/junit.xml
```

Each `<testcase>` in the report has a `time` in seconds. Sort by it to find the slowest cases, and time the whole local run before and after a move.
