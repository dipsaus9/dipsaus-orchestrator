// The test checklist in the TUI (DIPO-365 test plan, DIPO-458): `t` on a desk row shows the open
// test's manual steps, Space ticks one locally, `y` sends a pass, `n` pre-fills the note with the
// first unticked step and sends a fail, and Esc leaves the test open. While `test.start` runs the
// checklist names the story by its id, never its internal key, and the open test shows its
// `dipo test shell <ID>` line (DIPO-421). Frames are asserted with ANSI stripped.

import { afterEach, describe, expect, it } from "bun:test";

import { DeskItem, type Event, StreamName } from "@dipsaus-orchestrator/contract";

import { OFFICES } from "../test/support/fake-session";
import { BATCH_MS } from "./batch";
import { mount } from "../test/support/setup";

const mounted: { unmount(): Promise<void> }[] = [];
const STREAM = StreamName.parse(`office:${OFFICES.dipsaus}`);
const KEY_19 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C19";
const TEST_19 = "tst_01J9ZK5Q8W3V4X6Y7Z8A9B0T19";

const steps = [
  { check: "open the login page", expect: "the form shows" },
  { check: "submit a wrong password" },
  { check: "see the error" },
];

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

function event(seq: number, type: string, data: unknown): Event {
  return {
    cursor: { stream: STREAM, epoch: "e2", seq },
    at: "2026-10-14T10:05:00.000Z",
    type,
    data,
  } as Event;
}

/** The TUI with DIPO-19's test open in its office, as `test.started` carries it. */
async function openTest() {
  const view = await mount({
    columns: 120,
    rows: 30,
  });
  mounted.push(view.ui);
  await view.ui.waitFor("daemon live");
  view.session.active(STREAM)?.options.onEvent(
    event(20, "test.started", {
      test: TEST_19,
      story: "DIPO-19",
      key: KEY_19,
      checkout: "dipo-test-19",
      head: "9f8e7d6c5b4a3210",
      steps,
      url: "http://localhost:3000",
      startedAt: "2026-10-14T10:03:00.000Z",
    }),
  );
  // The TUI takes the store's state at most every 100 ms (`batch.ts`): let the test arrive.
  await Bun.sleep(BATCH_MS + 50);
  return view;
}

/** `t` on DIPO-19's desk row, which offers no new test: its open test's checklist. */
async function showChecklist(view: Awaited<ReturnType<typeof openTest>>) {
  view.session.desk = [
    DeskItem.parse({
      kind: "IN REVIEW",
      story: "DIPO-19",
      key: KEY_19,
      detail: "testing",
      since: "2026-10-14T10:00:00.000Z",
      blocks: [],
      actions: [],
    }),
  ];
  await view.ui.press("1");
  await view.ui.waitFor("▌ ○ DIPO-19");
  await view.ui.press("t");
}

/** Waits until the command count reaches `count`, polling. */
async function until(check: () => boolean, what: string, ms = 2_000): Promise<void> {
  const limit = performance.now() + ms;
  while (!check()) {
    if (performance.now() > limit) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** The commands sent, without their options. */
function sent(session: {
  commands: readonly { name: string; args: unknown; options?: unknown }[];
}) {
  return session.commands.map((command) => ({ name: command.name, args: command.args }));
}

describe("the test checklist", () => {
  it("shows the open test's steps; Space ticks one locally; y passes and n fails with the note pre-filled", async () => {
    const view = await openTest();
    const { ui, session } = view;
    await showChecklist(view);
    await ui.waitFor("DIPO-19 at 9f8e7d6 · box dipo-test-19");
    expect(ui.frame()).toContain("open   http://localhost:3000");
    // The focus bar marks the focused step.
    expect(ui.frame()).toContain("▌ ○ 1 open the login page");
    expect(ui.frame()).toContain("  ○ 2 submit a wrong password");

    // The first step ticked locally: no command is sent for it.
    await ui.press(" ");
    await ui.waitFor("✓ 1 open the login page");
    expect(session.commands).toEqual([]);

    // n pre-fills the note with the first unticked step, which is step 2 now.
    await ui.press("n");
    await ui.waitFor("submit a wrong password▍");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "test.record");
    expect(sent(session)).toEqual([
      {
        name: "test.record",
        args: { test: TEST_19, result: "fail", note: "submit a wrong password" },
      },
    ]);

    // y sends a pass for the same open test.
    await ui.press("y");
    await until(() => session.commands.length === 2, "test.record pass");
    expect(sent(session)[1]).toEqual({
      name: "test.record",
      args: { test: TEST_19, result: "pass" },
    });
  });

  it("Esc leaves the view and sends nothing, so the test stays open", async () => {
    const view = await openTest();
    const { ui, session } = view;
    await showChecklist(view);
    await ui.waitFor("box dipo-test-19");
    await ui.press("escape");
    await until(() => !ui.frame().includes("box dipo-test-19"), "the checklist to close");
    expect(session.commands).toEqual([]);

    // Back in the checklist the test is still open, with its steps as they were.
    await ui.press("t");
    await ui.waitFor("box dipo-test-19");
    expect(session.commands).toEqual([]);
  });

  it("`t` on a desk row opens the checklist of that story and starts its test", async () => {
    const { ui, session } = await openTest();
    session.desk = [
      DeskItem.parse({
        kind: "IN REVIEW",
        story: "DIPO-19",
        key: KEY_19,
        detail: "pushed head ready to test",
        since: "2026-10-14T10:00:00.000Z",
        blocks: [],
        actions: [{ command: "test.start", cli: "dipo test DIPO-19" }],
      }),
    ];
    await ui.press("1");
    await ui.waitFor("NEEDS YOU");
    await ui.press("t");
    await until(() => session.commands.length === 1, "test.start");
    expect(sent(session)).toEqual([{ name: "test.start", args: { story: "DIPO-19" } }]);
    await ui.waitFor("box dipo-test-19");
  });

  it("names the story by its id until the test opens, then shows its shell line", async () => {
    const view = await mount({ columns: 120, rows: 30 });
    mounted.push(view.ui);
    const { ui, session } = view;
    await ui.waitFor("daemon live");
    session.desk = [
      DeskItem.parse({
        kind: "IN REVIEW",
        story: "DIPO-19",
        key: KEY_19,
        detail: "pushed head ready to test",
        since: "2026-10-14T10:00:00.000Z",
        blocks: [],
        actions: [{ command: "test.start", cli: "dipo test DIPO-19" }],
      }),
    ];
    await ui.press("1");
    await ui.waitFor("NEEDS YOU");
    await ui.press("t");
    await until(() => session.commands.length === 1, "test.start");
    const waiting = await ui.waitFor("No test is open for DIPO-19.");
    expect(waiting).not.toContain(KEY_19);

    // The test box is ready: `test.started` carries the view the `test.start` reply named.
    session.active(STREAM)?.options.onEvent(
      event(20, "test.started", {
        test: TEST_19,
        story: "DIPO-19",
        key: KEY_19,
        checkout: "dipo-test-19",
        head: "9f8e7d6c5b4a3210",
        steps,
        shell: "dipo test shell DIPO-19",
        startedAt: "2026-10-14T10:03:00.000Z",
      }),
    );
    const frame = await ui.waitFor("DIPO-19 at 9f8e7d6 · box dipo-test-19");
    expect(frame).toContain("shell  dipo test shell DIPO-19");
    expect(frame).not.toContain(KEY_19);
  });

  it("c copies the shell line; a test that ends says why it closed", async () => {
    const view = await openTest();
    const { ui, session } = view;
    session.active(STREAM)?.options.onEvent(
      event(21, "test.started", {
        test: TEST_19,
        story: "DIPO-19",
        key: KEY_19,
        checkout: "dipo-test-19",
        head: "9f8e7d6c5b4a3210",
        steps,
        shell: "dipo test shell DIPO-19",
        startedAt: "2026-10-14T10:03:00.000Z",
      }),
    );
    await Bun.sleep(BATCH_MS + 50);
    await showChecklist(view);
    await ui.waitFor("c copies");
    await ui.press("c");
    await ui.waitFor("copied dipo test shell DIPO-19");
    expect(view.copied).toEqual(["dipo test shell DIPO-19"]);

    // The test closes on a new head: the overlay stays and says why.
    session.active(STREAM)?.options.onEvent(
      event(22, "test.ended", {
        test: TEST_19,
        story: "DIPO-19",
        key: KEY_19,
        reason: "new-head",
      }),
    );
    await ui.waitFor("It closed because a new head was pushed.");
  });
});
