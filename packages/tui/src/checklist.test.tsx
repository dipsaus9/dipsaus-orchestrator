// The test checklist in the TUI (DIPO-365 test plan): `4` and `t` on a desk row show the open
// test's manual steps, Space ticks one locally, `P` sends a pass, `F` pre-fills the note with the
// first unticked step and sends a fail, and Esc leaves the test open. Frames are asserted with
// ANSI stripped.

import { afterEach, describe, expect, it } from "bun:test";

import { DeskItem, type Event } from "@dipsaus-orchestrator/contract";

import { OFFICES } from "../test/support/fake-session";
import { mount } from "../test/support/setup";

const mounted: { unmount(): Promise<void> }[] = [];
const STREAM = `office:${OFFICES.dipsaus}`;
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
    capabilities: ["desk", "test.sessions"],
  });
  mounted.push(view.ui);
  await view.ui.waitFor("· live");
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
  return view;
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
  it("shows the open test's steps; Space ticks one locally; P passes and F fails with the note pre-filled", async () => {
    const { ui, session } = await openTest();
    await ui.press("4");
    await ui.waitFor("Test of DIPO-19: dipo-test-19 at 9f8e7d6");
    expect(ui.frame()).toContain("open http://localhost:3000");
    expect(ui.frame()).toContain("[ ] 1. open the login page -> the form shows");
    expect(ui.frame()).toContain("[ ] 2. submit a wrong password");

    // The first step ticked locally: no command is sent for it.
    await ui.press(" ");
    await ui.waitFor("[x] 1. open the login page");
    expect(session.commands).toEqual([]);

    // F pre-fills the note with the first unticked step, which is step 2 now.
    await ui.press("F");
    await ui.waitFor("fail note: submit a wrong password_");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "test.record");
    expect(sent(session)).toEqual([
      {
        name: "test.record",
        args: { test: TEST_19, result: "fail", note: "submit a wrong password" },
      },
    ]);

    // P sends a pass for the same open test.
    await ui.press("P");
    await until(() => session.commands.length === 2, "test.record pass");
    expect(sent(session)[1]).toEqual({
      name: "test.record",
      args: { test: TEST_19, result: "pass" },
    });
  });

  it("Esc leaves the view and sends nothing, so the test stays open", async () => {
    const { ui, session } = await openTest();
    await ui.press("4");
    await ui.waitFor("Test of DIPO-19");
    await ui.press("escape");
    await until(() => !ui.frame().includes("Test of DIPO-19"), "the checklist to close");
    expect(session.commands).toEqual([]);

    // Back in the checklist the test is still open, with its steps as they were.
    await ui.press("4");
    await ui.waitFor("Test of DIPO-19");
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
    await ui.press("3");
    await ui.waitFor("Your desk (");
    await ui.press("t");
    await until(() => session.commands.length === 1, "test.start");
    expect(sent(session)).toEqual([{ name: "test.start", args: { story: "DIPO-19" } }]);
    await ui.waitFor("Test of DIPO-19");
  });
});
