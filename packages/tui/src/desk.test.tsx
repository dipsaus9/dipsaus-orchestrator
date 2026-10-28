// Your desk in the TUI (DIPO-308 test plan): key `3` shows the rows of `office.desk` in the read's
// order with "Parked by you" apart, the empty desk, one-line rows below 80 columns; the desk is read
// again after desk-changing events and a stream reset, at most once a second, keeping the selected
// story; the key table offers only what a row lists and the flags allow; the prompts send the
// matching commands; closed prompts, read-your-writes and Ctrl-R; and Enter opens the story with
// its park record and review verdicts. Frames are asserted with ANSI stripped.

import { afterEach, describe, expect, it } from "bun:test";

import { DeskItem, type Event, Verdict } from "@dipsaus-orchestrator/contract";

import { DESK_READ_INTERVAL_MS, EMPTY_DESK } from "./desk";
import { OFFICES } from "./testing/fake-session";
import { mount } from "./testing/setup";

const mounted: { unmount(): Promise<void> }[] = [];
const STREAM = `office:${OFFICES.dipsaus}`;

const KEY_19 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C19";
const KEY_24 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C24";
const KEY_21 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C01";
const KEY_26 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C26";
const KEY_22 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C22";
const KEY_12 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C12";
const KEY_29 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C29";
const Q19 = "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0Q19";
const Q26 = "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0Q26";
const GATE_12 = "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0G12";
const GATE_24 = "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0G24";
const PROPOSAL = "ab".repeat(32);
const RUN_21 = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C01";
const RUN_19 = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C19";
const RUN_24 = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0C24";

/** Every flag the desk's keys need. */
const ALL_FLAGS = ["desk", "work.intervene", "review", "proposals", "evidence"];

/** The clock starts at 10:04; `ago(40)` is 40 minutes before. */
function ago(minutes: number): string {
  return new Date(Date.parse("2026-10-14T10:04:00.000Z") - minutes * 60_000).toISOString();
}

const question = DeskItem.parse({
  kind: "QUESTION",
  story: "DIPO-19",
  key: KEY_19,
  question: Q19,
  detail: '"Is a 404 on an empty office ok?" · worker waiting, 3 min left',
  since: ago(6),
  blocks: [],
  actions: [{ command: "work.answer", cli: `dipo answer ${Q19} --text "<answer>"` }],
});

const merge = DeskItem.parse({
  kind: "MERGE",
  story: "DIPO-12",
  key: KEY_12,
  gate: GATE_12,
  pr: { number: 7, url: "https://github.com/o/r/pull/7", state: "open" },
  detail: "reviewer passed, test passed",
  since: ago(60),
  blocks: ["DIPO-31"],
  actions: [
    { command: "gate.approve", cli: "dipo approve DIPO-12" },
    { command: "gate.reject", cli: 'dipo reject DIPO-12 --note "<why>"' },
  ],
});

const askedPark = DeskItem.parse({
  kind: "PARKED",
  story: "DIPO-26",
  key: KEY_26,
  question: Q26,
  reason: "ambiguous-spec",
  detail: "May the compose file start the database?",
  since: ago(40),
  blocks: [],
  actions: [
    { command: "work.answer", cli: `dipo answer ${Q26} --text "<answer>"` },
    { command: "work.resume", cli: 'dipo resume DIPO-26 --note "<answer>"' },
  ],
});

const reviewBlocked = DeskItem.parse({
  kind: "PARKED",
  story: "DIPO-24",
  key: KEY_24,
  gate: GATE_24,
  reason: "review-blocked",
  detail: "round 3 blocked: #2 not met",
  since: ago(90),
  blocks: [],
  actions: [
    { command: "work.resume", cli: 'dipo resume DIPO-24 --note "<direction>"' },
    { command: "gate.approve", cli: 'dipo approve DIPO-24 --note "<why>"' },
  ],
});

const budget = DeskItem.parse({
  kind: "PARKED",
  story: "DIPO-22",
  key: KEY_22,
  reason: "budget-exceeded",
  detail: "used 100k of 100k (M)",
  since: ago(9 * 60),
  blocks: [],
  actions: [
    { command: "work.resume", cli: 'dipo resume DIPO-22 --budget +50% --note "<why>"' },
    { command: "work.discard", cli: 'dipo discard DIPO-22 --note "<why>"' },
  ],
});

const backlogPr = DeskItem.parse({
  kind: "BACKLOG PR",
  pr: { number: 9, url: "https://github.com/o/r/pull/9", state: "open" },
  detail: '#9 "Add stories" · its check failed: R15 2 unknowns open',
  since: ago(120),
  blocks: [],
  actions: [],
  hand: "fix the branch backlog/add of PR #9 by hand on GitHub (https://github.com/o/r/pull/9)",
});

const proposal = DeskItem.parse({
  kind: "PROPOSAL",
  story: "DIPO-21",
  key: KEY_21,
  proposal: { id: PROPOSAL, kind: "follow-up", title: "Split RunOutcomes", run: RUN_21 },
  detail: `follow-up "Split RunOutcomes" · the file is long · from ${RUN_21}`,
  since: ago(180),
  blocks: [],
  actions: [
    { command: "proposal.accept", cli: `dipo propose accept ${PROPOSAL}` },
    { command: "proposal.dismiss", cli: `dipo propose dismiss ${PROPOSAL}` },
  ],
});

const byYou = DeskItem.parse({
  kind: "PARKED BY YOU",
  story: "DIPO-29",
  key: KEY_29,
  reason: "by-maintainer",
  detail: "after M2",
  since: ago(3 * 24 * 60),
  blocks: [],
  actions: [{ command: "work.resume", cli: "dipo resume DIPO-29" }],
});

const DESK = [question, merge, askedPark, reviewBlocked, budget, byYou, backlogPr, proposal];

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

function event(seq: number, type: string, data: unknown): Event {
  return {
    cursor: { stream: STREAM, epoch: "e2", seq },
    at: "2026-10-14T10:05:00.000Z",
    type,
    data,
  } as Event;
}

async function openDesk(
  options: {
    columns?: number;
    rows?: number;
    desk?: readonly DeskItem[];
    capabilities?: readonly string[];
  } = {},
) {
  const view = await mount({
    columns: options.columns ?? 120,
    rows: options.rows ?? 30,
    capabilities: options.capabilities ?? ALL_FLAGS,
  });
  mounted.push(view.ui);
  view.session.desk = [...(options.desk ?? DESK)];
  await view.ui.waitFor("· live");
  await view.ui.press("3");
  await view.ui.waitFor("Your desk (");
  return view;
}

const deskReads = (session: { reads: readonly { name: string }[] }) =>
  session.reads.filter((read) => read.name === "office.desk").length;

/** The commands sent after the overview opened, without their options. */
function sent(session: {
  commands: readonly { name: string; args: unknown; options?: unknown }[];
}) {
  return session.commands.map((command) => ({ name: command.name, args: command.args }));
}

/** Waits until `check` holds, polling the frame. */
async function until(check: () => boolean, what: string, ms = 2_000): Promise<void> {
  const limit = performance.now() + ms;
  while (!check()) {
    if (performance.now() > limit) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

async function selectRow(
  ui: { press(key: string): Promise<void>; frame(): string },
  story: string,
) {
  for (let i = 0; i < 12; i++) {
    const rows = lines(ui.frame()).filter((line) => /^ [> ] [A-Z]/.test(line));
    const at = rows.findIndex((line) => line.startsWith(" > "));
    const want = rows.findIndex((line) => line.includes(` ${story} `));
    if (want === -1) break;
    if (at === want) return;
    await ui.press(at < want ? "j" : "k");
  }
  throw new Error(`no row of ${story} could be selected:\n${ui.frame()}`);
}

/** The queue with DIPO-30 selected. */
async function openQueue() {
  const view = await mount({ columns: 120, rows: 30, capabilities: ALL_FLAGS });
  mounted.push(view.ui);
  await view.ui.waitFor("· live");
  await view.ui.press("2");
  await view.ui.waitFor("next Ready story");
  await view.ui.press("j");
  await view.ui.waitFor("> READY (2)   DIPO-30");
  return view;
}

/** A question of `run` the engine asked, as the office stream carries it. */
function asked(seq: number, run: string, story: string, key: string, kind = "question") {
  return event(seq, "question.asked", {
    question: Q19,
    work: {
      story,
      key,
      run,
      agent: "agt_01J9ZK5Q8W3V4X6Y7Z8A9B0A01",
      role: "developer",
      tier: "L",
      model: "claude-opus",
    },
    kind,
    text: kind === "permission" ? "Bash(docker compose up)" : "Is a 404 ok?",
    askedAt: "2026-10-14T10:03:00.000Z",
  });
}

describe("key 3 shows Your desk", () => {
  it("lists the rows of office.desk in the read's order, with Parked by you apart", async () => {
    const { ui } = await openDesk();
    const frame = await ui.waitFor("Parked by you (1)");
    const shown = lines(frame);
    const start = shown.indexOf(" Your desk (7)");
    expect(start).toBeGreaterThan(0);
    const rows = shown.slice(start + 1).filter((line) => /^ [> ] [A-Z]/.test(line));
    const kinds = ["PARKED BY YOU", "BACKLOG PR", "QUESTION", "PROPOSAL", "PARKED", "MERGE"];
    expect(rows.map((row) => kinds.find((kind) => row.slice(3).startsWith(kind)))).toEqual([
      "QUESTION",
      "MERGE",
      "PARKED",
      "PARKED",
      "PARKED",
      "BACKLOG PR",
      "PROPOSAL",
      "PARKED BY YOU",
    ]);
    // Kind, story, reason, detail, age and the row's keys.
    expect(rows[0]).toMatch(
      /^ > QUESTION +DIPO-19 +"Is a 404 on an empty office ok\?" · worker waiting, 3 min left +6m {2}\[a\]nswer$/,
    );
    expect(rows[2]).toMatch(
      /^ {3}PARKED +DIPO-26 +ambiguous-spec · May the compose file start the database\? +40m {2}\[a\]nswer \[r\]esume$/,
    );
    expect(rows[7]).toMatch(
      /^ {3}PARKED BY YOU +DIPO-29 +by-maintainer · after M2 +3d {2}\[r\]esume$/,
    );
    // "Parked by you" comes after every other row and before the stories it lists.
    expect(shown.indexOf(" Parked by you (1)")).toBe(shown.indexOf(rows[7]!) - 1);
    // At 80 columns and wider an item's hand action and blocked stories get a second line.
    expect(frame).toContain("by hand: fix the branch backlog/add of PR #9");
    expect(frame).toContain("blocks DIPO-31");
  });

  it("says Nothing waits on you. for an empty desk", async () => {
    const { ui } = await openDesk({ desk: [] });
    const frame = await ui.waitFor(EMPTY_DESK);
    expect(lines(frame)).toContain(" Your desk (0)");
    expect(lines(frame)).toContain(` ${EMPTY_DESK}`);
  });

  it("shows each row on one line below 80 columns", async () => {
    const { ui } = await openDesk({ columns: 70 });
    const frame = await ui.waitFor("Parked by you (1)");
    const shown = lines(frame);
    const start = shown.indexOf(" Your desk (7)");
    const body = shown.slice(start + 1, shown.indexOf(" Parked by you (1)") + 2);
    // Seven waiting rows, the title and the parked row: nothing else between them.
    expect(body).toHaveLength(9);
    expect(frame).not.toContain("blocks DIPO-31");
    for (const line of body) expect(line.length).toBeLessThanOrEqual(70);
    // The row's keys move to the footer.
    expect(shown.at(-1)).toContain("[a]nswer");
  });
});

describe("the desk stays current", () => {
  it("reads office.desk again after a desk-changing event, at most once a second", async () => {
    const { ui, session } = await openDesk();
    await until(() => deskReads(session) === 1, "the first desk read");
    const office = session.active(STREAM)?.options;
    // Within the second after the read: three changes make one more read, at its end.
    office?.onEvent(event(8, "question.asked", { question: Q19 }));
    office?.onEvent(event(9, "proposal.filed", { proposal: PROPOSAL }));
    office?.onEvent(event(10, "gate.decided", { gate: GATE_12 }));
    await Bun.sleep(DESK_READ_INTERVAL_MS / 2);
    expect(deskReads(session)).toBe(1);
    await until(() => deskReads(session) === 2, "the paced desk read");
    // An event that cannot change the desk reads nothing.
    await Bun.sleep(DESK_READ_INTERVAL_MS + 100);
    office?.onEvent(event(11, "work.progress", { work: { run: RUN_21 } }));
    await Bun.sleep(100);
    expect(deskReads(session)).toBe(2);
    // A story leaving Parked does, at once once the second has passed.
    office?.onEvent(
      event(12, "story.state", { story: "DIPO-29", key: KEY_29, from: "Parked", to: "Ready" }),
    );
    await until(() => deskReads(session) === 3, "the read after a story left Parked");
    expect(ui.frame()).toContain("Your desk (7)");
  });

  it("reads it again when the office's starts pause or lift, and not for another notice (0020)", async () => {
    const { session } = await openDesk();
    await until(() => deskReads(session) === 1, "the first desk read");
    const office = session.active(STREAM)?.options;
    await Bun.sleep(DESK_READ_INTERVAL_MS + 50);
    office?.onEvent(event(8, "engine.notice", { level: "warn", code: "run.queued", text: "x" }));
    await Bun.sleep(100);
    expect(deskReads(session)).toBe(1);
    office?.onEvent(
      event(9, "engine.notice", { level: "warn", code: "office.startsPaused", text: "paused" }),
    );
    await until(() => deskReads(session) === 2, "the read after the starts paused");
    await Bun.sleep(DESK_READ_INTERVAL_MS + 50);
    office?.onEvent(
      event(10, "engine.notice", { level: "info", code: "office.startsLifted", text: "lifted" }),
    );
    await until(() => deskReads(session) === 3, "the read after the lift");
  });

  it("reads it again after a stream reset and keeps the selected story", async () => {
    const { ui, session } = await openDesk();
    await selectRow(ui, "DIPO-26");
    await until(() => deskReads(session) === 1, "the first desk read");
    // The next read has a new row first; the selection stays on DIPO-26.
    session.desk = [proposal, ...DESK.filter((item) => item !== proposal)];
    await Bun.sleep(DESK_READ_INTERVAL_MS + 50);
    session.active(STREAM)?.options.onEnded?.({
      code: "stream.resetRequired",
      message: "history gap",
      retryable: false,
    });
    await until(() => deskReads(session) === 2, "the desk read after the reset");
    await until(
      () =>
        lines(ui.frame()).some((line) => line.startsWith(" > PARKED") && line.includes("DIPO-26")),
      `DIPO-26 still selected:\n${ui.frame()}`,
    );
    const rows = lines(ui.frame()).filter((line) => /^ [> ] [A-Z]/.test(line));
    expect(rows[0]).toContain("PROPOSAL");
  });
});

describe("the key table on desk rows", () => {
  it("accepts a PROPOSAL row with y and dismisses one with n", async () => {
    const { ui, session } = await openDesk();
    await selectRow(ui, "DIPO-21");
    expect(lines(ui.frame()).at(-1)).toContain("[y] accept [n] dismiss");
    await ui.press("y");
    await until(() => session.commands.length === 1, "proposal.accept");
    await ui.press("n");
    await until(() => session.commands.length === 2, "proposal.dismiss");
    expect(sent(session)).toEqual([
      { name: "proposal.accept", args: { proposal: PROPOSAL } },
      { name: "proposal.dismiss", args: { proposal: PROPOSAL } },
    ]);
  });

  it("offers a key only for what the row lists and the flags allow; the rest shows its cli line", async () => {
    // Without the `proposals` flag a PROPOSAL row offers no key and shows its command lines.
    const { ui, session } = await openDesk({ capabilities: ["desk", "work.intervene", "review"] });
    await selectRow(ui, "DIPO-21");
    const frame = ui.frame();
    expect(frame).not.toContain("[y] accept");
    expect(frame).toContain(`type: dipo propose accept ${PROPOSAL}`);
    expect(frame).toContain(`type: dipo propose dismiss ${PROPOSAL}`);
    await ui.press("y");
    // The QUESTION row lists no resume: `r` sends nothing.
    await selectRow(ui, "DIPO-19");
    await ui.press("r");
    await Bun.sleep(50);
    expect(session.commands).toEqual([]);
    // Every action of the QUESTION row has its key: no command line to type.
    expect(ui.frame()).not.toContain("type:");
  });

  it("shows the office's starts paused first, with what lifts it and its command line (0020)", async () => {
    const paused = DeskItem.parse({
      kind: "STARTS PAUSED",
      detail: "no new session starts · plan limit until 2026-10-14T12:00:00.000Z",
      since: ago(4),
      blocks: [],
      actions: [{ command: "daemon.resumeScheduling", cli: "dipo daemon resume-scheduling" }],
      hand: "It lifts by itself at 2026-10-14T12:02:00.000Z, or with `dipo daemon resume-scheduling`.",
    });
    const { ui } = await openDesk({ desk: [paused, byYou] });
    const frame = await ui.waitFor("type: dipo daemon resume-scheduling");
    const rows = lines(frame).filter((line) => /^ [> ] [A-Z]/.test(line));
    expect(rows[0]).toMatch(/^ > STARTS PAUSED +no new session starts · plan limit until/);
    expect(frame).toContain("by hand: It lifts by itself at 2026-10-14T12:02:00.000Z");
  });

  it("shows the command line of an action the table does not bind", async () => {
    const unbound = DeskItem.parse({
      ...byYou,
      kind: "PARKED",
      reason: "worker-failed",
      actions: [
        { command: "work.run", cli: "dipo run DIPO-29" },
        { command: "work.resume", cli: "dipo resume DIPO-29" },
      ],
    });
    const { ui } = await openDesk({ desk: [unbound] });
    const frame = await ui.waitFor("type: dipo run DIPO-29");
    expect(frame).toContain("[r]esume");
  });

  it("approves a merge with y, and answers a parked question with a text", async () => {
    const { ui, session } = await openDesk();
    await selectRow(ui, "DIPO-12");
    await ui.press("y");
    await until(() => session.commands.length === 1, "gate.approve");
    await selectRow(ui, "DIPO-26");
    await ui.press("a");
    await ui.waitFor("answer: _");
    await ui.press("allow");
    await ui.press("enter");
    await until(() => session.commands.length === 2, "the answer");
    // An answer that reads "allow" is text, never a decision (0020).
    expect(sent(session)).toEqual([
      { name: "gate.approve", args: { gate: GATE_12 } },
      { name: "work.answer", args: { question: Q26, text: "allow" } },
    ]);
  });
});

describe("prompts", () => {
  it("answers a question with the typed text: Enter sends, Esc cancels", async () => {
    const { ui, session } = await openDesk();
    await ui.press("a");
    await ui.waitFor("answer: _");
    expect(lines(ui.frame()).at(-1)).toContain("[Enter] send  [Esc] cancel");
    await ui.press("escape");
    await ui.waitFor("answer DIPO-19: nothing sent");
    await ui.press("a");
    await ui.waitFor("answer: _");
    // A paste goes in whole.
    await ui.press("Yes, a 404 is fine");
    await ui.waitFor("answer: Yes, a 404 is fine_");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "work.answer");
    expect(sent(session)).toEqual([
      { name: "work.answer", args: { question: Q19, text: "Yes, a 404 is fine" } },
    ]);
  });

  it("keeps a typed draft while offline and sends it once back online", async () => {
    const { ui, session } = await openDesk();
    await ui.press("a");
    await ui.press("later");
    session.setState("reconnecting");
    await ui.waitFor("OFFLINE");
    await ui.press("enter");
    await ui.waitFor("offline: the prompt is kept");
    expect(ui.frame()).toContain("answer: later_");
    expect(session.commands).toEqual([]);
    session.setState("open");
    await until(() => !ui.frame().includes("OFFLINE"), "back online");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "work.answer");
    expect(sent(session)).toEqual([
      { name: "work.answer", args: { question: Q19, text: "later" } },
    ]);
  });

  it("asks yes or no before a reject, then its note, and sends it confirmed", async () => {
    const { ui, session } = await openDesk();
    await selectRow(ui, "DIPO-12");
    await ui.press("n");
    await ui.waitFor("Reject the merge of DIPO-12?");
    await ui.press("x");
    await ui.waitFor("reject DIPO-12: nothing sent");
    await ui.press("n");
    await ui.press("y");
    await ui.waitFor("reject note: _");
    await ui.press("Handle the empty office");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "gate.reject");
    expect(session.commands[0]).toMatchObject({
      name: "gate.reject",
      args: { gate: GATE_12, note: "Handle the empty office" },
      options: { confirmed: true },
    });
  });

  it("asks the note of a review-blocked approve and of its resume", async () => {
    const { ui, session } = await openDesk();
    await selectRow(ui, "DIPO-24");
    await ui.press("y");
    await ui.waitFor("approve note");
    await ui.press("Ship it");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "gate.approve");
    await ui.press("r");
    await ui.waitFor("resume note: _");
    await ui.press("Try the other parser");
    await ui.press("enter");
    await until(() => session.commands.length === 2, "work.resume");
    expect(sent(session)).toEqual([
      { name: "gate.approve", args: { gate: GATE_24, note: "Ship it" } },
      { name: "work.resume", args: { story: "DIPO-24", note: "Try the other parser" } },
    ]);
  });

  it("shows the caps before and after a budget resume and sends it confirmed after a yes", async () => {
    const { ui, session } = await openDesk();
    session.commandReply = (name, _args, options) => {
      if (name !== "work.resume") return undefined;
      if ((options as { confirmed?: boolean }).confirmed === true) {
        return {
          ok: true,
          result: { story: "DIPO-22", key: KEY_22, to: "In Progress" },
          changed: true,
        };
      }
      return {
        ok: false,
        error: {
          code: "confirmation.required",
          message: "A top-up needs confirmation.",
          retryable: false,
          details: {
            before: { budgetTokens: 100_000, maxTurns: 80, maxMinutes: 60 },
            after: { budgetTokens: 150_000, maxTurns: 120, maxMinutes: 90 },
          },
        },
      };
    };
    await selectRow(ui, "DIPO-22");
    await ui.press("r");
    await ui.press("More room");
    await ui.press("enter");
    const frame = await ui.waitFor("Raise DIPO-22's caps and resume it? [y/N]");
    expect(lines(frame)).toContain("   tokens  100000 -> 150000");
    expect(lines(frame)).toContain("   turns   80 -> 120");
    expect(lines(frame)).toContain("   minutes 60 -> 90");
    await ui.press("y");
    await until(() => session.commands.length === 2, "the confirmed resume");
    expect(session.commands.map((command) => command.options)).toMatchObject([
      { confirmed: false },
      { confirmed: true },
    ]);
    expect(session.commands[1]?.args).toEqual({
      story: "DIPO-22",
      note: "More room",
      budget: { share: 50 },
    });
    await ui.waitFor("resume DIPO-22: done");
  });

  it("lists what a discard loses and needs the story id typed out", async () => {
    const { ui, session } = await openDesk();
    session.losses.set("DIPO-22", {
      commits: [{ sha: "4f2a9c1", subject: "Cap the retries" }],
      files: ["src/retry.ts"],
    });
    await selectRow(ui, "DIPO-22");
    await ui.press("D");
    await ui.waitFor("discard note: _");
    await ui.press("Wrong approach");
    await ui.press("enter");
    const frame = await ui.waitFor("type DIPO-22 to confirm: _");
    expect(lines(frame)).toContain(
      " Discard DIPO-22: ends the run, deletes the worktree and branch, closes the PR and returns the story to Refined.",
    );
    expect(lines(frame)).toContain("     commit 4f2a9c1 Cap the retries");
    expect(lines(frame)).toContain("     file src/retry.ts");
    await ui.press("DIPO-2");
    await ui.press("enter");
    await ui.waitFor("type DIPO-22 to confirm, or Esc to cancel");
    expect(session.commands).toEqual([]);
    await ui.press("2");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "work.discard");
    expect(session.commands[0]).toMatchObject({
      name: "work.discard",
      args: { story: "DIPO-22", note: "Wrong approach" },
      options: { confirmed: true },
    });
    expect(session.reads.find((read) => read.name === "story.losses")?.args).toMatchObject({
      story: "DIPO-22",
      command: "work.discard",
    });
  });
});

describe("the queue and the detail use the same table", () => {
  it("parks a story with P and its note", async () => {
    const { ui, session } = await openQueue();
    expect(lines(ui.frame()).at(-1)).toContain("[P]ark  [d]rop");
    await ui.press("P");
    await ui.waitFor("park note for DIPO-30: _");
    await ui.press("after M2");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "story.park");
    expect(sent(session)).toEqual([
      { name: "story.park", args: { story: "DIPO-30", note: "after M2" } },
    ]);
  });

  it("drops with the branch kept after y, and after D lists the losses and needs the typed id", async () => {
    const { ui, session } = await openQueue();
    await ui.press("d");
    await ui.waitFor("Drop DIPO-30: archive it and release its claim?");
    await ui.press("y");
    await until(() => session.commands.length === 1, "story.drop");
    await ui.press("d");
    await ui.press("D");
    await ui.waitFor("type DIPO-30 to confirm: _");
    expect(ui.frame()).toContain("lost: nothing");
    await ui.press("DIPO-30");
    await ui.press("enter");
    await until(() => session.commands.length === 2, "story.drop with deleteBranch");
    expect(sent(session)).toEqual([
      { name: "story.drop", args: { story: "DIPO-30", deleteBranch: false } },
      { name: "story.drop", args: { story: "DIPO-30", deleteBranch: true } },
    ]);
    expect(session.commands.map((command) => command.options)).toMatchObject([
      { confirmed: true },
      { confirmed: true },
    ]);
    expect(session.reads.find((read) => read.name === "story.losses")?.args).toMatchObject({
      command: "story.drop",
    });
  });

  it("steers with s and parks with P in the live agent detail", async () => {
    const view = await mount({ columns: 120, rows: 30, capabilities: ALL_FLAGS });
    mounted.push(view.ui);
    const { ui, session } = view;
    await ui.waitFor("· live");
    await ui.press("enter");
    await ui.waitFor("following the tail");
    expect(lines(ui.frame()).at(-1)).toContain("[s]teer");
    await ui.press("s");
    await ui.waitFor("steer text: _");
    await ui.press("Keep the old flag");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "work.steer");
    await ui.press("P");
    await ui.waitFor("park note for DIPO-21: _");
    await ui.press("after the release");
    await ui.press("enter");
    await until(() => session.commands.length === 2, "story.park");
    expect(sent(session)).toEqual([
      { name: "work.steer", args: { story: "DIPO-21", text: "Keep the old flag" } },
      { name: "story.park", args: { story: "DIPO-21", note: "after the release" } },
    ]);
  });
});

describe("answers, closed prompts, read-your-writes and retry", () => {
  it("answers from an overview row whose run asks and from the live agent detail", async () => {
    const view = await mount({ columns: 120, rows: 30, capabilities: ALL_FLAGS });
    mounted.push(view.ui);
    const { ui, session } = view;
    await ui.waitFor("· live");
    session.active(STREAM)?.options.onEvent(asked(8, RUN_19, "DIPO-19", KEY_19));
    // DIPO-19 is the third running row.
    await ui.press("j");
    await ui.press("j");
    await ui.waitFor(">DIPO-19");
    await until(() => lines(ui.frame()).at(-1)?.includes("[a]nswer") === true, "[a]nswer");
    await ui.press("a");
    await ui.waitFor('answer DIPO-19: "Is a 404 ok?"');
    await ui.press("yes");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "the overview answer");
    await ui.press("enter");
    await ui.waitFor("following the tail");
    await ui.press("a");
    await ui.waitFor("answer: _");
    await ui.press("still yes");
    await ui.press("enter");
    await until(() => session.commands.length === 2, "the detail answer");
    expect(sent(session)).toEqual([
      { name: "work.answer", args: { question: Q19, text: "yes" } },
      { name: "work.answer", args: { question: Q19, text: "still yes" } },
    ]);
  });

  it("answers a permission question from the detail with a text, never a decision", async () => {
    const view = await mount({ columns: 120, rows: 30, capabilities: ALL_FLAGS });
    mounted.push(view.ui);
    const { ui, session } = view;
    await ui.waitFor("· live");
    session.active(STREAM)?.options.onEvent(asked(8, RUN_24, "DIPO-24", KEY_24, "permission"));
    await ui.press("j");
    await ui.waitFor(">DIPO-24");
    await ui.press("enter");
    await ui.waitFor("following the tail");
    await ui.waitFor("[a]nswer");
    await ui.press("a");
    await ui.waitFor("answer: _");
    await ui.press("deny");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "the answer");
    expect(sent(session)).toEqual([{ name: "work.answer", args: { question: Q19, text: "deny" } }]);
  });

  it("closes a prompt whose question closed with the engine's message", async () => {
    const { ui, session } = await openDesk();
    session.commandReply = (name) =>
      name === "work.answer"
        ? {
            ok: false,
            error: {
              code: "question.closed",
              message: "This question is no longer waiting.",
              retryable: false,
            },
          }
        : undefined;
    await ui.press("a");
    await ui.press("yes");
    await ui.press("enter");
    const frame = await ui.waitFor(
      "answer DIPO-19: question.closed: This question is no longer waiting.",
    );
    expect(frame).not.toContain("answer: yes_");
    expect(lines(frame).at(-1)).not.toContain("[Ctrl-R] retry");
  });

  it("is done only once the office stream passes the reply cursor", async () => {
    const { ui, session } = await openDesk();
    session.commandReply = (name) =>
      name === "proposal.accept"
        ? {
            ok: true,
            result: { proposal: PROPOSAL, state: "accepted" },
            changed: true,
            cursor: { stream: STREAM, epoch: "e2", seq: 20 },
          }
        : undefined;
    await selectRow(ui, "DIPO-21");
    await ui.press("y");
    await ui.waitFor("accept proposal: answered, waiting for the office stream");
    session.active(STREAM)?.options.onEvent(event(19, "work.progress", { work: { run: RUN_21 } }));
    await Bun.sleep(150);
    expect(ui.frame()).toContain("accept proposal: answered, waiting for the office stream");
    session
      .active(STREAM)
      ?.options.onEvent(
        event(20, "proposal.closed", { proposal: PROPOSAL, key: KEY_21, state: "accepted" }),
      );
    await ui.waitFor("accept proposal: done");
  });

  it("offers Ctrl-R after a retryable error and sends the same request id again", async () => {
    const { ui, session } = await openDesk();
    let calls = 0;
    session.commandReply = (name) => {
      if (name !== "gate.approve") return undefined;
      calls += 1;
      return calls === 1
        ? {
            ok: false,
            error: {
              code: "engine.recovering",
              message: "The daemon is recovering.",
              retryable: true,
            },
          }
        : { ok: true, result: { gate: GATE_12, decision: "approved" }, changed: true };
    };
    await selectRow(ui, "DIPO-12");
    await ui.press("y");
    const frame = await ui.waitFor("approve DIPO-12: engine.recovering: The daemon is recovering.");
    expect(lines(frame).at(-1)).toContain("[Ctrl-R] retry");
    await ui.press("ctrl-r");
    await until(() => session.commands.length === 2, "the retry");
    const ids = session.commands.map(
      (command) => (command.options as { requestId: string }).requestId,
    );
    expect(ids[1]).toBe(ids[0]);
    await ui.waitFor("approve DIPO-12: done");
  });
});

describe("Enter on a desk row", () => {
  const verdicts = Verdict.array().parse([
    {
      gate: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0R01",
      run: RUN_24,
      kind: "review",
      decision: "rejected",
      by: "rule",
      at: "2026-10-14T09:00:00.000Z",
      review: {
        round: 1,
        commit: "4f2a9c1e5d6b7a8c",
        codeTreeKey: "tree1",
        verdict: "blocked",
        criteria: [
          { n: 1, status: "met", evidence: "test/retry.test.ts passes" },
          { n: 2, status: "unmet", evidence: "no notice on the cap" },
        ],
        findings: [
          {
            severity: "blocking",
            kind: "correctness",
            criterion: 2,
            file: "src/retry.ts",
            line: 41,
            quote: "if (tries > cap)",
            text: "the cap is off by one",
          },
          {
            severity: "advisory",
            kind: "maintainability",
            quote: "let x",
            text: "name the variable",
            unverified: true,
          },
        ],
        summary: "blocked on #2",
        model: "claude-opus",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          turns: 1,
          elapsedMs: 1,
        },
        commentUrl: "https://github.com/o/r/pull/7#issuecomment-1",
        override: { note: "the cap is fine as is", at: "2026-10-14T09:30:00.000Z" },
      },
    },
  ]);

  it("opens the story with its park record and every review verdict; Esc returns to the same row", async () => {
    const { ui, session } = await openDesk();
    session.verdicts.set(KEY_24, verdicts);
    await selectRow(ui, "DIPO-24");
    await ui.press("enter");
    const frame = await ui.waitFor("review verdicts (1)");
    const shown = lines(frame);
    expect(shown).toContain(" DIPO-24 Add verify retry · In Progress");
    expect(shown).toContain(" park: review-blocked · 1h ago");
    expect(shown).toContain("   round 3 blocked: #2 not met");
    expect(shown.some((line) => line.startsWith(" round 1 · 4f2a9c1e5d6b · blocked · "))).toBe(
      true,
    );
    // Per-criterion results and findings are the reviewer's word: claimed, `*`.
    expect(shown).toContain("   criteria: #1 met*  #2 unmet*");
    expect(shown).toContain("     #2 no notice on the cap*");
    expect(shown).toContain(
      "   finding blocking correctness #2 src/retry.ts:41: the cap is off by one*",
    );
    expect(shown).toContain('     quote (checked): "if (tries > cap)"');
    expect(shown).toContain('     quote (unverified): "let x"');
    expect(
      shown.some(
        (line) => line.includes("overridden by you") && line.includes('"the cap is fine as is"'),
      ),
    ).toBe(true);
    expect(shown).toContain("   comment: https://github.com/o/r/pull/7#issuecomment-1");
    expect(session.reads.find((read) => read.name === "story.detail")?.args).toMatchObject({
      story: KEY_24,
    });
    await ui.press("escape");
    await ui.waitFor("Your desk (7)");
    const row = lines(ui.frame()).find((line) => line.startsWith(" > "));
    expect(row).toContain("DIPO-24");
  });
});
