# Test guidance

`@dipsaus-orchestrator/testkit` holds the shared test helpers. The testing rules come from decision 0017; this page is the short version of where a test goes.

## Local suite or CI only

Local `bun test` stays under about 60 seconds (0017). Aim for about 40, so new stories have room. A test goes into a `*.ci.test.ts` sibling, which registers its `describe` only when `DIPO_TEST_CI=1`, when it is:

- a slow integration case: real git repositories with a bare remote and several Backlog CLI calls, such as a release and a reclaim of a branch, a rebuild after a conflicting base change, a commit or push killed after a timeout, or several office loads in one test;
- a process lifecycle that is timing sensitive (a detached daemon, kill and restart);
- a case that needs a platform matrix (the sandbox).

The local file keeps unit tests and at least one fast case of each behavior. Correctness rules never go CI only. Moving a case is not deleting it: CI runs the sibling, so `DIPO_TEST_CI=1 bun test` must still pass with the same number of tests.

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
