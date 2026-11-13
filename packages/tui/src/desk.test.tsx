// The Desk in the TUI (DIPO-308, DIPO-459): key `1` shows `office.desk` as a list grouped by kind
// in the engine's order with a preview of the focused item at 100 columns or wider, one list below
// 100 where Enter opens the preview; the empty Desk; the desk is read again after desk-changing
// events and a stream reset, at most once a second, keeping the selected story; the key table
// offers only what an item lists, y and n acting on what it asks; the prompts (the Composer, the
// top-up, discard and drop) send the matching commands; pending rows, closed prompts,
// read-your-writes and Ctrl-R; and Enter opens the story with its park record and review verdicts.
// Frames are asserted with ANSI stripped.

import { afterEach, describe, expect, it } from "bun:test";

import { DeskItem, type Event, Verdict } from "@dipsaus-orchestrator/contract";

import {
  DESK_LIST_COLUMNS,
  DESK_READ_INTERVAL_MS,
  deskGroups,
  EMPTY_DESK,
  previewRows,
  rowFacts,
} from "./desk";
import { OFFICES } from "../test/support/fake-session";
import { mount } from "../test/support/setup";

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

/** The clock starts at 10:04; `ago(40)` is 40 minutes before. */
function ago(minutes: number): string {
  return new Date(Date.parse("2026-10-14T10:04:00.000Z") - minutes * 60_000).toISOString();
}

const question = DeskItem.parse({
  kind: "QUESTION",
  story: "DIPO-19",
  key: KEY_19,
  question: Q19,
  detail: '"Is a 404 on an empty office ok?"',
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

// A proposed story (DIPO-454): its card holds the proposed user story in full.
const FOUND = `RunOutcomes holds the end of a run and its retro rows in one class. ${"It keeps growing past what one reader holds. ".repeat(4)}The end of the finding.`;
const proposal = DeskItem.parse({
  kind: "PROPOSED STORY",
  story: "DIPO-21",
  idea: {
    id: PROPOSAL,
    origin: "proposal",
    title: "Split RunOutcomes",
    run: RUN_21,
    story: {
      found: FOUND,
      evidence: [
        { file: "packages/engine/src/run/outcomes.ts", line: 12, quote: "class RunOutcomes" },
      ],
      sourceStory: "DIPO-21",
      storyLine:
        "As maintainer I want the run outcomes split into two modules so that each module stays small enough to read.",
      proposed: "Split it into an end module and a retro module.",
      why: "It grew.",
      serves: "m-3",
    },
  },
  detail: `"Split RunOutcomes" · milestone m-3 · from a worker's proposal`,
  since: ago(180),
  blocks: [],
  actions: [
    { command: "idea.accept", cli: `dipo idea accept ${PROPOSAL}` },
    { command: "idea.dismiss", cli: `dipo idea dismiss ${PROPOSAL}` },
  ],
});

const NOTE = "cd".repeat(32);
const note = DeskItem.parse({
  kind: "DECISION NOTE",
  story: "DIPO-31",
  key: KEY_21,
  note: { id: NOTE, title: "Decision note for docs/x.md", run: RUN_21 },
  detail: 'decision note · docs/x.md, section "4": Note.',
  since: ago(200),
  blocks: [],
  actions: [{ command: "note.dismiss", cli: `dipo note dismiss ${NOTE}` }],
  hand: "dipo never writes decision records: add the note by hand if you agree",
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

// The engine's order (DIPO-459): the stories the maintainer parked come last.
const DESK = [question, merge, askedPark, reviewBlocked, budget, backlogPr, proposal, byYou];

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

/** The list's side of each body line: the part before the pane rule when the Desk is split. */
function listSide(frame: string): string[] {
  return lines(frame).map((line) =>
    line.charAt(DESK_LIST_COLUMNS) === "│" ? line.slice(0, DESK_LIST_COLUMNS).trimEnd() : line,
  );
}

/** The preview's side of each body line. */
function previewSide(frame: string): string[] {
  return lines(frame)
    .filter((line) => line.charAt(DESK_LIST_COLUMNS) === "│")
    .map((line) => line.slice(DESK_LIST_COLUMNS + 3));
}

/** The list's item rows: the focus column, a kind glyph, the title. */
function itemRows(frame: string): string[] {
  return listSide(frame).filter((line) => /^[▌ ] [!?○✗◆→◌] /.test(line));
}

/** The text of the open prompt's box, its border cells stripped. */
function boxText(frame: string): string {
  const split = lines(frame).some((line) => line.charAt(DESK_LIST_COLUMNS) === "│");
  return (split ? previewSide(frame) : lines(frame))
    .flatMap((line) => {
      const at = line.indexOf("│ ");
      const end = line.lastIndexOf("│");
      return at === -1 || end <= at ? [] : [line.slice(at + 1, end).trim()];
    })
    .join("\n");
}

function event(seq: number, type: string, data: unknown): Event {
  return {
    cursor: { stream: STREAM, seq },
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
  } = {},
) {
  const view = await mount({
    columns: options.columns ?? 120,
    rows: options.rows ?? 34,
  });
  mounted.push(view.ui);
  view.session.desk = [...(options.desk ?? DESK)];
  await view.ui.waitFor("daemon live");
  await view.ui.press("1");
  const desk = options.desk ?? DESK;
  await view.ui.waitFor(
    desk.length === 0 ? EMPTY_DESK : desk[0]?.kind === "PROFILE" ? "SETUP" : String(desk[0]?.kind),
  );
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

/** Moves the focus to the row whose title holds `text`. */
async function selectRow(ui: { press(key: string): Promise<void>; frame(): string }, text: string) {
  for (let i = 0; i < 12; i++) {
    const rows = itemRows(ui.frame());
    const at = rows.findIndex((line) => line.startsWith("▌ "));
    const want = rows.findIndex((line) => line.includes(text));
    if (at === want) return;
    // A row below the window comes into view as the focus moves down.
    await ui.press(want === -1 || at < want ? "j" : "k");
    await until(
      () => itemRows(ui.frame()).findIndex((line) => line.startsWith("▌ ")) !== at,
      "the focus to move",
    );
  }
  throw new Error(`no row of ${text} could be selected:\n${ui.frame()}`);
}

/** The queue with DIPO-30 selected. */
async function openQueue() {
  const view = await mount({ columns: 120, rows: 30 });
  mounted.push(view.ui);
  await view.ui.waitFor("daemon live");
  await view.ui.press("3");
  await view.ui.waitFor("▌ → DIPO-30");
  return view;
}

/** A question of `run` the engine asked, as the office stream carries it. */
function asked(seq: number, run: string, story: string, key: string) {
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
    kind: "question",
    text: "Is a 404 ok?",
    askedAt: "2026-10-14T10:03:00.000Z",
  });
}

/** `lane.progress` data: `ops` open on backlog PR #656, whose CI runs (DIPO-481). */
const laneOn656 = (ops: unknown[]) => ({
  lane: {
    ops,
    pr: {
      number: 656,
      url: "https://github.com/o/r/pull/656",
      ci: "running",
      autoMerge: true,
      merged: false,
    },
  },
});

describe("the desk's groups", () => {
  it("groups the items by kind where each kind first comes, keeping the engine's order", () => {
    const later = DeskItem.parse({ ...question, story: "DIPO-40", question: undefined });
    const { groups, all } = deskGroups([question, merge, later, byYou]);
    expect(groups.map((group) => group.kind)).toEqual(["QUESTION", "MERGE", "PARKED BY YOU"]);
    expect(all.map((item) => String(item.story))).toEqual([
      "DIPO-19",
      "DIPO-40",
      "DIPO-12",
      "DIPO-29",
    ]);
    // The engine's order is KNOWN_DESK_KINDS' with setup first: grouping changes nothing in it.
    const profile = DeskItem.parse({ ...backlogPr, kind: "PROFILE", pr: undefined });
    expect(deskGroups([profile, ...DESK]).all).toEqual([profile, ...DESK]);
  });
});

describe("key 1 shows the Desk", () => {
  it("lists the items by kind in the engine's order under NEEDS YOU, with the focused item's preview", async () => {
    const { ui } = await openDesk();
    const frame = await ui.waitFor("NEEDS YOU");
    const list = listSide(frame);
    const heading = list.findIndex((line) => line.startsWith("NEEDS YOU"));
    // The count leaves out the stories the maintainer parked; the count sits at the list's right.
    expect(list[heading]).toMatch(/^NEEDS YOU +7$/);
    expect(lines(frame)[heading]?.slice(0, DESK_LIST_COLUMNS)).toMatch(/7 {2}$/);
    const headers = list.filter((line) => /^[A-Z]/.test(line) && !line.startsWith("NEEDS"));
    expect(headers).toEqual([
      "QUESTION",
      "MERGE",
      "PARKED",
      "BACKLOG PR",
      "PROPOSALS · from your AI team",
      "PARKED BY YOU",
    ]);
    const rows = itemRows(frame);
    // The story with its title from the snapshot, else what the item says; the age at the right.
    expect(rows[0]).toMatch(/^▌ \? DIPO-19 Review the merge slot +6m$/);
    expect(rows[2]).toMatch(/^ {2}\? DIPO-26 May the compose file start … 40m$/);
    expect(rows.at(-1)).toMatch(/^ {2}○ DIPO-29 Web client shell +3d$/);
    // A second dim row: the reason and what it blocks.
    expect(list).toContain('    "Is a 404 on an empty office ok?"');
    expect(list).toContain("    ambiguous-spec");
    expect(list.some((line) => /^ {4}reviewer passed, test passed · blocks 1/.test(line))).toBe(
      true,
    );
    // A blank row between groups; no verbs on the rows.
    expect(list[list.indexOf("MERGE") - 1]).toBe("");
    expect(rows.join("\n")).not.toContain("a answer");
    // The focused QUESTION in the preview: its question in full, its button and the cli line.
    const preview = previewSide(frame);
    expect(preview[0]).toBe("QUESTION · worker waiting 6m");
    expect(preview).toContain('"Is a 404 on an empty office ok?"');
    expect(preview).toContain("⟦ a Answer… ⟧");
    expect(preview).toContain('$ dipo answer qst_01J9ZK5Q8W3V4X6Y7Z8A9B0Q19 --text "<answer>"');
    expect(preview).toContain("The worker gets it on resume, and the run continues.");
  });

  it("shows a story whose PR merged while it was parked as its own group after the decision notes, with no action (DIPO-468)", async () => {
    const merged = DeskItem.parse({
      kind: "MERGED WHILE PARKED",
      story: "DIPO-22",
      key: KEY_22,
      detail:
        "its PR #634 merged while it was parked; dipo ended its run and sets it Done through its backlog PR",
      since: ago(5),
      blocks: [],
      actions: [],
    });
    const { ui } = await openDesk({ desk: [question, note, merged] });
    const frame = await ui.waitFor("MERGED WHILE PARKED");
    const list = listSide(frame);
    const headers = list.filter((line) => /^[A-Z]/.test(line) && !line.startsWith("NEEDS"));
    expect(headers).toEqual(["QUESTION", "DECISION NOTE", "MERGED WHILE PARKED"]);
    // Its row says what happened; it offers no key of its own.
    expect(itemRows(frame).some((row) => /DIPO-22 its PR #634 merged while it/.test(row))).toBe(
      true,
    );
  });

  it("says Nothing needs you. and what the team does for an empty desk", async () => {
    const { ui } = await openDesk({ desk: [] });
    const frame = await ui.waitFor(EMPTY_DESK);
    expect(lines(frame)).toContain(`    ✓ ${EMPTY_DESK}`);
    expect(frame).toMatch(/The team is on it: \d+ running, \d+ in review\./);
    expect(lines(frame)).toContain("      2 watch the floor");
  });

  it("is one list below 100 columns: no heading, short group names, Enter opens the preview", async () => {
    const { ui, session } = await openDesk({ columns: 80 });
    const frame = await ui.waitFor("PROPOSALS");
    const shown = lines(frame);
    expect(frame).not.toContain("NEEDS YOU");
    expect(frame).not.toContain("│  QUESTION ·");
    expect(shown).toContain("PROPOSALS");
    for (const line of shown) expect(line.length).toBeLessThanOrEqual(80);
    // Each row keeps its second row.
    expect(shown).toContain("    ambiguous-spec");
    expect(lines(frame).at(-1)).toContain("⏎ read");
    await ui.press("enter");
    const preview = await ui.waitFor("QUESTION · worker waiting 6m");
    expect(preview).toContain("⟦ a Answer… ⟧");
    expect(session.reads.filter((read) => read.name === "story.detail")).toEqual([]);
    await ui.press("escape");
    await ui.waitFor("PROPOSALS");
    // In the preview a second Enter opens the story.
    await ui.press("enter");
    await ui.waitFor("QUESTION · worker waiting 6m");
    await ui.press("enter");
    await until(() => session.reads.some((read) => read.name === "story.detail"), "story.detail");
  });
});

describe("the desk stays current", () => {
  it("reads office.desk again after a desk-changing event, at most once a second", async () => {
    const { ui, session } = await openDesk();
    await until(() => deskReads(session) === 1, "the first desk read");
    const office = session.active(STREAM)?.options;
    // Within the second after the read: three changes make one more read, at its end.
    office?.onEvent(event(8, "question.asked", { question: Q19 }));
    office?.onEvent(event(9, "idea.passed", { idea: PROPOSAL, origin: "proposal", title: "t" }));
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
    expect(ui.frame()).toContain("NEEDS YOU");
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
      event(10, "engine.notice", { level: "info", code: "office.startsResumed", text: "lifted" }),
    );
    await until(() => deskReads(session) === 3, "the read after the lift");
    await Bun.sleep(DESK_READ_INTERVAL_MS + 50);
    // A story newly offered as next up (0010).
    office?.onEvent(
      event(11, "engine.notice", { level: "info", code: "run.nextUp", text: "Next up" }),
    );
    await until(() => deskReads(session) === 4, "the read after a next-up offer");
  });

  it("reads it again after a stream reset and keeps the selected story", async () => {
    const { ui, session, store } = await openDesk();
    await selectRow(ui, "DIPO-26");
    await until(() => deskReads(session) === 1, "the first desk read");
    // The next read has a new row first; the selection stays on DIPO-26.
    session.desk = [proposal, ...DESK.filter((item) => item !== proposal)];
    const snapshots = store.state.snapshots;
    // A snapshot the store applied reads the desk at once, whatever the pacing (DIPO-327): the
    // test waits on the store and the frame, never on time.
    session.active(STREAM)?.options.onEnded?.({
      code: "stream.resetRequired",
      message: "history gap",
      retryable: false,
    });
    await until(() => store.state.snapshots === snapshots + 1, "the snapshot after the reset");
    await until(() => deskReads(session) === 2, "the desk read after the reset");
    await until(
      () => itemRows(ui.frame())[0]?.includes("Split RunOutcomes") === true,
      `the desk read after the reset on screen:\n${ui.frame()}`,
    );
    const selected = itemRows(ui.frame()).filter((line) => line.startsWith("▌ "));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain("DIPO-26");
  });
});

/** One NEXT UP item, with the office's `nextUp.autoStart` on or not. */
const nextUpItem = (autoStart: boolean) =>
  DeskItem.parse({
    kind: "NEXT UP",
    story: "DIPO-29",
    key: KEY_29,
    ...(autoStart ? { autoStart: "no-overlap" } : {}),
    detail: '"Story 29" · m-2 is the earliest milestone; priority high',
    since: ago(1),
    blocks: [],
    actions: [{ command: "nextUp.confirm", cli: "dipo next confirm DIPO-29" }],
  });

describe("the key table on desk items", () => {
  it("accepts a PROPOSED STORY with y and dismisses one with n (DIPO-454)", async () => {
    const { ui, session } = await openDesk();
    await selectRow(ui, "Split RunOutcomes");
    expect(lines(ui.frame()).at(-1)).toContain("y accept   n dismiss");
    expect(previewSide(ui.frame())).toContain("⟦ y Accept ⟧  ⟦ n Dismiss ⟧");
    await ui.press("y");
    await until(() => session.commands.length === 1, "idea.accept");
    await ui.press("n");
    await until(() => session.commands.length === 2, "idea.dismiss");
    expect(sent(session)).toEqual([
      { name: "idea.accept", args: { idea: PROPOSAL } },
      { name: "idea.dismiss", args: { idea: PROPOSAL } },
    ]);
  });

  it("opens a PROPOSED STORY's card with Enter, its proposed user story in full", async () => {
    const { ui, session } = await openDesk();
    await selectRow(ui, "Split RunOutcomes");
    await ui.press("enter");
    const frame = await ui.waitFor("proposed story");
    // Wrapped, never cut: the end of the long finding and every part are on screen.
    const text = lines(frame)
      .map((line) => line.trim())
      .join(" ");
    expect(text).toContain("The end of the finding.");
    expect(text).toContain('Evidence: packages/engine/src/run/outcomes.ts:12 "class RunOutcomes"');
    expect(text).toContain("Source story: DIPO-21");
    expect(text).toContain("Story: As maintainer I want the run outcomes split into two modules");
    expect(text).toContain("Proposed: Split it into an end module and a retro module.");
    expect(text).toContain("Why: It grew.");
    expect(text).toContain("Serves: milestone m-3");
    expect(text).toContain("from a worker's proposal");
    // No story read: the card is the desk item.
    expect(session.reads.filter((read) => read.name === "story.detail")).toEqual([]);
  });

  it("dismisses a DECISION NOTE with n through note.dismiss", async () => {
    const { ui, session } = await openDesk({ desk: [...DESK, note] });
    await selectRow(ui, "Decision note for docs/x.md");
    await ui.press("n");
    await until(() => session.commands.length === 1, "note.dismiss");
    expect(sent(session)).toEqual([{ name: "note.dismiss", args: { note: NOTE } }]);
  });

  it("starts a NEXT UP story with y and declines one with n (0010)", async () => {
    const nextUp = DeskItem.parse({
      kind: "NEXT UP",
      story: "DIPO-29",
      key: KEY_29,
      detail:
        '"Story 29" · m-2 is the earliest milestone with a Ready story that can start; priority high · its references share no files with running stories',
      since: ago(1),
      blocks: [],
      actions: [
        { command: "nextUp.confirm", cli: "dipo next confirm DIPO-29" },
        { command: "nextUp.decline", cli: "dipo next decline DIPO-29" },
      ],
    });
    const { ui, session } = await openDesk({ desk: [nextUp] });
    const frame = await ui.waitFor("⟦ y Start it ⟧");
    expect(frame).toContain("⟦ n Offer the next one ⟧");
    expect(frame).toContain("m-2 is the earliest milestone");
    expect(frame).toContain("$ dipo next confirm DIPO-29");
    expect(lines(frame).at(-1)).toContain("y start it   n offer the next one");
    await ui.press("y");
    await until(() => session.commands.length === 1, "nextUp.confirm");
    await ui.press("n");
    await until(() => session.commands.length === 2, "nextUp.decline");
    expect(sent(session)).toEqual([
      { name: "nextUp.confirm", args: { story: "DIPO-29" } },
      { name: "nextUp.decline", args: { story: "DIPO-29" } },
    ]);
  });

  it("heads the NEXT UP group while the office starts those stories by itself, and not otherwise (0010)", async () => {
    const head = "Next up starts by itself";
    await (await openDesk({ desk: [nextUpItem(true)] })).ui.waitFor(head);
    const off = await openDesk({ desk: [nextUpItem(false)] });
    await off.ui.waitFor("Story 29");
    expect(off.ui.frame()).not.toContain(head);
  });

  it("hands a quick idea to the audit with i on any item (criterion 5)", async () => {
    const { ui, session } = await openDesk();
    await selectRow(ui, "DIPO-26");
    expect(lines(ui.frame()).at(-1)).toContain("i idea…");
    await ui.press("i");
    await ui.waitFor("idea (its first words are its title)");
    await ui.press("Show the spend per tier");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "idea.add");
    expect(sent(session)).toEqual([
      { name: "idea.add", args: { text: "Show the spend per tier" } },
    ]);
  });

  it("offers a key only for what the item lists", async () => {
    const { ui, session } = await openDesk();
    // The QUESTION lists no resume: `r` sends nothing, and opens nothing.
    await selectRow(ui, "DIPO-19");
    await ui.press("r");
    await Bun.sleep(50);
    expect(session.commands).toEqual([]);
    expect(ui.frame()).not.toContain("⏎ send");
  });

  it("shows the office's starts paused first, what lifts it and the command line of the lift (0020)", async () => {
    const paused = DeskItem.parse({
      kind: "STARTS PAUSED",
      detail: "no new session starts · plan limit until 2026-10-14T12:00:00.000Z",
      since: ago(4),
      blocks: [],
      actions: [{ command: "daemon.resumeStarts", cli: "dipo daemon resume-starts" }],
      hand: "It lifts by itself at 2026-10-14T12:02:00.000Z, or with `dipo daemon resume-starts`.",
    });
    const { ui } = await openDesk({ desk: [paused, byYou] });
    const frame = await ui.waitFor("$ dipo daemon resume-starts");
    expect(itemRows(frame)[0]).toMatch(/^▌ ! no new session starts · plan limit u… 4m$/);
    const preview = previewSide(frame);
    expect(preview[1]).toBe("No new sessions start in this office");
    expect(preview.join(" ")).toContain("Lifts   It lifts by itself at 2026-10-14T12:02:00.000Z");
    expect(preview).toContain("✓ Nothing to do. Look away until it lifts.");
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
    const frame = await ui.waitFor("$ dipo run DIPO-29");
    expect(frame).toContain("r start again   s start again with a hint   ⏎ open run");
    expect(lines(frame).at(-1)).toContain("r start again");
  });

  it("approves a merge with y, and answers a parked question with r as with a", async () => {
    const { ui, session } = await openDesk();
    await selectRow(ui, "DIPO-12");
    await ui.press("y");
    await until(() => session.commands.length === 1, "gate.approve");
    await selectRow(ui, "DIPO-26");
    await ui.press("r");
    await ui.waitFor("⏎ send");
    expect(boxText(ui.frame())).toContain("answer");
    await ui.press("allow");
    await ui.press("enter");
    await until(() => session.commands.length === 2, "the answer");
    // An answer that reads "allow" is text, never a decision (0020).
    expect(sent(session)).toEqual([
      { name: "gate.approve", args: { gate: GATE_12 } },
      { name: "work.answer", args: { question: Q26, text: "allow" } },
    ]);
  });

  it("opens a merge's PR with o", async () => {
    const view = await openDesk();
    await selectRow(view.ui, "DIPO-12");
    expect(previewSide(view.ui.frame()).some((line) => line.includes("⟦ o PR ⟧"))).toBe(true);
    await view.ui.press("o");
    await until(() => view.daemonRequests.length === 1, "the PR to open");
    expect(view.daemonRequests).toEqual(["open https://github.com/o/r/pull/7"]);
  });
});

describe("prompts", () => {
  it("answers a question in the Composer under it: Enter sends, Option+Enter adds a line, Ctrl-S does nothing, Esc cancels", async () => {
    const { ui, session } = await openDesk();
    await ui.press("a");
    await ui.waitFor("⏎ send");
    expect(lines(ui.frame()).at(-1)).toContain("⏎ send   ⌥⏎ new line   esc cancel");
    // The Composer is in the preview, under the question.
    const preview = previewSide(ui.frame());
    expect(preview.findIndex((line) => line.startsWith("┌"))).toBeGreaterThan(
      preview.indexOf('"Is a 404 on an empty office ok?"'),
    );
    await ui.press("escape");
    await ui.waitFor("answer DIPO-19: nothing sent");
    await ui.press("a");
    await ui.waitFor("⏎ send");
    // A paste goes in whole; Option+Enter and a trailing backslash add a line; Ctrl-S sends nothing.
    await ui.press("Yes, a 404 is fine");
    await ui.press("\u001b\r");
    await ui.press("for now\\");
    await ui.press("enter");
    await ui.press("ok");
    await ui.waitFor("ok▍");
    expect(boxText(ui.frame())).toContain("answer\nYes, a 404 is fine\nfor now\nok▍");
    await ui.press("ctrl-s");
    await Bun.sleep(50);
    expect(session.commands).toHaveLength(0);
    await ui.press("enter");
    await until(() => session.commands.length === 1, "work.answer");
    expect(sent(session)).toEqual([
      { name: "work.answer", args: { question: Q19, text: "Yes, a 404 is fine\nfor now\nok" } },
    ]);
  });

  it("keeps a typed draft while offline and sends it once back online", async () => {
    const { ui, session } = await openDesk();
    await ui.press("a");
    await ui.press("later");
    session.setState("reconnecting");
    await ui.waitFor("offline since");
    await ui.press("enter");
    await ui.waitFor("offline: the prompt is kept");
    expect(ui.frame()).toContain("later▍");
    expect(session.commands).toEqual([]);
    session.setState("open");
    await until(() => !ui.frame().includes("offline since"), "back online");
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
    await ui.waitFor("reject note");
    await ui.press("Handle the empty office");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "gate.reject");
    expect(session.commands[0]).toMatchObject({
      name: "gate.reject",
      args: { gate: GATE_12, note: "Handle the empty office" },
      options: { confirmed: true },
    });
  });

  it("asks the note of a review-blocked overrule and the direction of its resume", async () => {
    const { ui, session } = await openDesk();
    await selectRow(ui, "DIPO-24");
    expect(previewSide(ui.frame())).toContain("⟦ r Start again ⟧  ⟦ y Overrule… ⟧");
    await ui.press("y");
    await ui.waitFor("approve note");
    await ui.press("Ship it");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "gate.approve");
    await ui.press("r");
    await ui.waitFor("direction");
    // A required note: an empty one is not sent.
    await ui.press("enter");
    await ui.waitFor("the direction is empty");
    await ui.press("Try the other parser");
    await ui.press("enter");
    await until(() => session.commands.length === 2, "work.resume");
    expect(sent(session)).toEqual([
      { name: "gate.approve", args: { gate: GATE_24, note: "Ship it" } },
      { name: "work.resume", args: { story: "DIPO-24", note: "Try the other parser" } },
    ]);
  });

  it("starts a failed run again with its note prefilled from the failing check, or with a hint", async () => {
    const failed = DeskItem.parse({
      ...byYou,
      kind: "PARKED",
      reason: "verify-failing",
      detail: "bun run verify → 2 shards failed",
      actions: [{ command: "work.resume", cli: "dipo resume DIPO-29" }],
    });
    const { ui, session } = await openDesk({ desk: [failed] });
    await ui.press("r");
    await ui.waitFor("bun run verify → 2 shards failed▍");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "work.resume");
    await ui.press("s");
    await ui.waitFor("⏎ send");
    expect(ui.frame()).not.toContain("2 shards failed▍");
    await ui.press("Skip the flaky shard");
    await ui.press("enter");
    await until(() => session.commands.length === 2, "the resume with a hint");
    expect(sent(session)).toEqual([
      { name: "work.resume", args: { story: "DIPO-29", note: "bun run verify → 2 shards failed" } },
      { name: "work.resume", args: { story: "DIPO-29", note: "Skip the flaky shard" } },
    ]);
  });

  it("says a resume changed nothing when the engine answers changed: false (0005)", async () => {
    const { ui, session } = await openDesk();
    session.commandReply = (name) =>
      name === "work.resume"
        ? {
            ok: true,
            result: { story: "DIPO-24", key: KEY_24, to: "In Progress" },
            changed: false,
          }
        : undefined;
    await selectRow(ui, "DIPO-24");
    await ui.press("r");
    await ui.waitFor("direction");
    await ui.press("It runs already");
    await ui.press("enter");
    const frame = await ui.waitFor("resume DIPO-24: already so; nothing changed");
    expect(frame).not.toContain("resume DIPO-24: done");
  });

  it("offers the top-ups of a budget park, shows the caps before and after, and then resumes", async () => {
    const { ui, session } = await openDesk();
    session.commandReply = (name, args, options) => {
      if (name !== "work.resume") return undefined;
      if ((options as { confirmed?: boolean }).confirmed === true) {
        return {
          ok: true,
          result: { story: "DIPO-22", key: KEY_22, to: "In Progress" },
          changed: true,
        };
      }
      const share = (args as { budget: { share: number } }).budget.share;
      return {
        ok: false,
        error: {
          code: "confirmation.required",
          message: "A top-up needs confirmation.",
          retryable: false,
          details: {
            before: { budgetTokens: 2_000_000, maxTurns: 400, maxMinutes: 60 },
            after: {
              budgetTokens: 2_000_000 * (1 + share / 100),
              maxTurns: 400 * (1 + share / 100),
              maxMinutes: 90,
            },
          },
        },
      };
    };
    await selectRow(ui, "DIPO-22");
    expect(previewSide(ui.frame())).toContain(
      "r start again with a top-up: +25% · +50% · +100%   ⏎ inspect",
    );
    await ui.press("r");
    await ui.waitFor("top up");
    // The share the engine's line names is chosen; ←→ choose another.
    expect(boxText(ui.frame())).toContain("top up    +25%  ⟦ +50% ⟧  +100%");
    await ui.press("right");
    await ui.waitFor("⟦ +100% ⟧");
    await ui.press("tab");
    await ui.press("More room");
    await ui.press("enter");
    // The first Enter asks the engine for the caps; seeing them is the confirmation.
    const frame = await ui.waitFor("2.0M → 4.0M tokens · 400 → 800 turns");
    expect(lines(frame).at(-1)).toContain("⏎ resume");
    expect(session.commands).toHaveLength(1);
    // A changed share asks for its caps again: Enter sends unconfirmed once more.
    await ui.press("tab");
    await ui.press("left");
    await ui.waitFor("⟦ +50% ⟧");
    await ui.press("enter");
    await until(() => session.commands.length === 2, "the caps of the other share");
    expect(session.commands[1]?.options).toMatchObject({ confirmed: false });
    await ui.press("right");
    await ui.waitFor("⟦ +100% ⟧");
    await ui.press("enter");
    await until(() => session.commands.length === 3, "the caps of the first share again");
    expect(session.commands[2]?.options).toMatchObject({ confirmed: false });
    await ui.press("enter");
    await until(() => session.commands.length === 4, "the confirmed resume");
    expect(session.commands.map((command) => command.options)).toMatchObject([
      { confirmed: false },
      { confirmed: false },
      { confirmed: false },
      { confirmed: true },
    ]);
    expect(session.commands[3]?.args).toEqual({
      story: "DIPO-22",
      note: "More room",
      budget: { share: 100 },
    });
    await ui.waitFor("resume DIPO-22: done");
  });

  it("lists what a discard loses in a red box and needs the story id typed out", async () => {
    const { ui, session } = await openDesk();
    session.losses.set("DIPO-22", {
      commits: [{ sha: "4f2a9c1", subject: "Cap the retries" }],
    });
    await selectRow(ui, "DIPO-22");
    await ui.press("D");
    await ui.waitFor("Discard DIPO-22?");
    await ui.press("Wrong approach");
    await ui.press("enter");
    const frame = await ui.waitFor("to confirm");
    const box = boxText(frame);
    expect(box).toContain("✗ Discard DIPO-22?");
    expect(box).toContain("Lost: 1 commit not on the base");
    expect(box).toContain("4f2a9c1 Cap the retries");
    expect(box).toContain("note  Wrong approach");
    expect(lines(frame).at(-1)).toContain("⏎ discard (when the id matches)   esc keep it");
    await ui.press("DIPO-2");
    await ui.press("enter");
    await ui.waitFor("type DIPO-22 to confirm, or Esc to keep it");
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
  it("parks a story with p and its note", async () => {
    const { ui, session } = await openQueue();
    expect(lines(ui.frame()).at(-1)).toContain("p park   X drop");
    await ui.press("p");
    await ui.waitFor("park note for DIPO-30");
    await ui.press("after M2");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "story.park");
    expect(sent(session)).toEqual([
      { name: "story.park", args: { story: "DIPO-30", note: "after M2" } },
    ]);
  });

  it("drops with the branch kept after y, and with it deleted after space, the losses and the typed id", async () => {
    const { ui, session } = await openQueue();
    await ui.press("X");
    await ui.waitFor("Drop DIPO-30 from the backlog?");
    expect(boxText(ui.frame())).toContain("[ ] also delete its branch (space)");
    expect(boxText(ui.frame())).toContain("keeps 0 commits if left unticked");
    await ui.press("y");
    await until(() => session.commands.length === 1, "story.drop");
    await ui.press("X");
    await ui.waitFor("Drop DIPO-30 from the backlog?");
    await ui.press(" ");
    await ui.waitFor("[x] also delete its branch");
    expect(boxText(ui.frame())).toContain("Lost: nothing");
    await ui.press("y");
    await ui.waitFor("to confirm");
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

  it("copies the focused story's id with c on the desk, the queue and the floor, and the run id in the detail", async () => {
    const view = await mount({ columns: 120, rows: 30 });
    mounted.push(view.ui);
    const { ui, copied } = view;
    await ui.waitFor("daemon live");
    // The Floor: the focused row's story.
    await ui.press("c");
    await ui.waitFor("copied DIPO-21");
    // The run detail: its run id.
    await ui.press("enter");
    await ui.waitFor("following");
    await ui.press("c");
    await ui.waitFor("copied run_");
    await ui.press("escape");
    // The queue: the focused story row.
    await ui.press("3");
    await ui.waitFor("READY");
    await ui.press("c");
    await ui.waitFor("copied DIPO-30");
    expect(copied).toEqual(["DIPO-21", expect.stringMatching(/^run_/), "DIPO-30"]);
  });

  it("steers with s and parks with p in the live agent detail", async () => {
    const view = await mount({ columns: 120, rows: 30 });
    mounted.push(view.ui);
    const { ui, session } = view;
    await ui.waitFor("daemon live");
    await ui.press("enter");
    await ui.waitFor("following");
    expect(lines(ui.frame()).at(-1)).toContain("s steer");
    session.commandReply = (name) =>
      name === "work.steer"
        ? { ok: true, result: { run: RUN_21, delivered: "next-turn" }, changed: true }
        : undefined;
    // The Composer opens in the stream, and the sent text stays there as a `you` line.
    await ui.press("s");
    await ui.waitFor("steer DIPO-21 · arrives at its next turn");
    await ui.press("Keep the old flag");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "work.steer");
    await ui.waitFor("Keep the old flag · delivered next turn");
    expect(ui.frame()).not.toContain("steer DIPO-21");
    await ui.press("p");
    await ui.waitFor("park note for DIPO-21");
    await ui.press("after the release");
    await ui.press("enter");
    await until(() => session.commands.length === 2, "story.park");
    expect(sent(session)).toEqual([
      { name: "work.steer", args: { story: "DIPO-21", text: "Keep the old flag" } },
      { name: "story.park", args: { story: "DIPO-21", note: "after the release" } },
    ]);
  });
});

describe("answers, pending rows, closed prompts, read-your-writes and retry", () => {
  it("answers from an overview row whose run asks and from the live agent detail", async () => {
    const view = await mount({ columns: 120, rows: 30 });
    mounted.push(view.ui);
    const { ui, session } = view;
    await ui.waitFor("daemon live");
    session.active(STREAM)?.options.onEvent(asked(8, RUN_19, "DIPO-19", KEY_19));
    // DIPO-19 is the third running row.
    await ui.press("j");
    await ui.press("j");
    await ui.waitFor("▌ ● DIPO-19");
    await until(() => lines(ui.frame()).at(-1)?.includes("a answer") === true, "a answer");
    await ui.press("a");
    // Outside the Desk the Composer sits under the body, with what it answers above it.
    await ui.waitFor('answer DIPO-19: "Is a 404 ok?"');
    await ui.press("yes");
    await ui.press("enter");
    await until(() => session.commands.length === 1, "the overview answer");
    await ui.press("enter");
    await ui.waitFor("following");
    await ui.press("a");
    await ui.waitFor("⏎ send");
    await ui.press("still yes");
    await ui.press("enter");
    await until(() => session.commands.length === 2, "the detail answer");
    expect(sent(session)).toEqual([
      { name: "work.answer", args: { question: Q19, text: "yes" } },
      { name: "work.answer", args: { question: Q19, text: "still yes" } },
    ]);
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
    expect(frame).not.toContain("yes▍");
    expect(lines(frame).at(-1)).not.toContain("^R retry");
    // The row says it failed, in place.
    expect(listSide(frame)).toContain("  ✗ answer failed: question.closed");
  });

  it("shows the item pending on its row until the office stream passes the reply cursor, then the result", async () => {
    const { ui, session } = await openDesk();
    session.commandReply = (name) =>
      name === "idea.accept"
        ? {
            ok: true,
            result: {
              idea: PROPOSAL,
              state: "accepted",
              draft: "draft-31",
              flush: {
                state: "opened",
                branch: "backlog/x",
                pr: "https://github.com/o/r/pull/612",
              },
            },
            changed: true,
            cursor: { stream: STREAM, seq: 20 },
          }
        : undefined;
    await selectRow(ui, "Split RunOutcomes");
    await ui.press("y");
    await ui.waitFor("accept proposed story: answered, waiting for the office stream");
    expect(itemRows(ui.frame()).find((row) => row.includes("Split RunOutcomes"))).toMatch(
      /^▌ ◌ Split RunOutcomes +accepting…$/,
    );
    session.active(STREAM)?.options.onEvent(event(19, "work.progress", { work: { run: RUN_21 } }));
    await Bun.sleep(150);
    expect(ui.frame()).toContain("accept proposed story: answered, waiting for the office stream");
    session
      .active(STREAM)
      ?.options.onEvent(event(20, "idea.answered", { idea: PROPOSAL, state: "accepted" }));
    await ui.waitFor("accept proposed story: done; draft-31 in backlog PR #612");
    expect(listSide(ui.frame())).toContain("  ✓ accepted · draft-31 in backlog PR #612");
  });

  it("says an accept whose flush was held is queued and for which backlog PR, until the snapshot says filed (DIPO-481)", async () => {
    const { ui, session } = await openDesk();
    session.commandReply = (name) =>
      name === "idea.accept"
        ? {
            ok: true,
            result: {
              idea: PROPOSAL,
              state: "accepted",
              flush: { state: "held", branch: "dipo/backlog-x", reason: "auto-merge is on" },
            },
            changed: true,
            cursor: { stream: STREAM, seq: 20 },
          }
        : undefined;
    const op = {
      op: 9,
      what: "an accepted idea filed as a draft",
      subject: "an idea",
      state: "queued",
      since: "2026-10-14T10:05:00.000Z",
    };
    // The lane journals the accept before it answers: the store has the backlog PR already.
    session.active(STREAM)?.options.onEvent(event(19, "lane.progress", laneOn656([op])));
    await selectRow(ui, "Split RunOutcomes");
    await ui.press("y");
    await ui.waitFor("accept proposed story: answered, waiting for the office stream");
    session
      .active(STREAM)
      ?.options.onEvent(event(20, "idea.answered", { idea: PROPOSAL, state: "accepted" }));
    await ui.waitFor("accept proposed story: done; queued: waits for backlog PR #656");
    // The idea has left the desk; the queued line stands until the lane has nothing open.
    session.desk = DESK.filter((item) => item.idea === undefined);
    session.active(STREAM)?.options.onEvent(event(21, "story.state", { story: "DIPO-1" }));
    const queued = await ui.waitFor(
      "◌ queued: Split RunOutcomes · waits for backlog PR #656, CI running",
    );
    expect(queued).not.toContain("filed");
    session.active(STREAM)?.options.onEvent(event(22, "lane.progress", { lane: { ops: [] } }));
    await Bun.sleep(150);
    expect(ui.frame()).not.toContain("◌ queued:");
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
    expect(lines(frame).at(-1)).toContain("^R retry");
    // On the row too, with its ^R.
    expect(listSide(frame)).toContain("  ✗ approve failed: engine.recovering");
    expect(
      listSide(frame).some((line) => /^ {4}The daemon is recovering\. · \^R retry$/.test(line)),
    ).toBe(true);
    await ui.press("ctrl-r");
    await until(() => session.commands.length === 2, "the retry");
    const ids = session.commands.map(
      (command) => (command.options as { requestId: string }).requestId,
    );
    expect(ids[1]).toBe(ids[0]);
    await ui.waitFor("approve DIPO-12: done");
  });
});

describe("Enter on a desk item", () => {
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

  it("opens the story reader: the park record, then the Reviews section with the round in full; Esc returns to the same item", async () => {
    const { ui, session } = await openDesk();
    session.verdicts.set(KEY_24, verdicts);
    await selectRow(ui, "DIPO-24");
    expect(lines(ui.frame()).at(-1)).toContain("⏎ open story");
    await ui.press("enter");
    const frame = await ui.waitFor("Reviews 1");
    const shown = lines(frame);
    expect(shown).toContain(" DIPO-24 Add verify retry");
    expect(
      shown.some(
        (line) => line.includes("park: review-blocked") || line.includes("review-blocked"),
      ),
    ).toBe(true);
    expect(session.reads.find((read) => read.name === "story.detail")?.args).toMatchObject({
      story: KEY_24,
    });
    await ui.press("right");
    await ui.press("right");
    await ui.waitFor("ROUND 1 · 4f2a9c1 ·");
    const reviews = lines(ui.frame());
    // Criteria, findings and the quote show, indented under the 84-column measure.
    expect(reviews.some((line) => line.includes("✗ 2  no notice on the cap"))).toBe(true);
    expect(
      reviews.some(
        (line) =>
          line.includes("! ") && line.includes("blocking · correctness · #2 src/retry.ts:41"),
      ),
    ).toBe(true);
    expect(reviews.some((line) => line.includes("the cap is off by one"))).toBe(true);
    expect(reviews.some((line) => line.includes("│  if (tries > cap)"))).toBe(true);
    expect(reviews.some((line) => line.includes("advisory · maintainability · unverified"))).toBe(
      true,
    );
    expect(
      reviews.some(
        (line) => line.includes("overridden by you") && line.includes('"the cap is fine as is"'),
      ),
    ).toBe(true);
    expect(reviews.some((line) => line.includes("o open comment on GitHub"))).toBe(true);
    await ui.press("escape");
    await ui.waitFor("NEEDS YOU");
    const row = itemRows(ui.frame()).find((line) => line.startsWith("▌ "));
    expect(row).toContain("DIPO-24");
  });

  it("the Diff section reads the story's branch diff and shows it", async () => {
    const { ui, session } = await openDesk();
    session.verdicts.set(KEY_24, verdicts);
    session.diffs.set(KEY_24, {
      branch: "DIPO-24/retry",
      base: "main",
      diff: "diff --git a/src/retry.ts b/src/retry.ts\n@@ -1 +1 @@\n-const cap = 3;\n+const cap = 4;\n",
      truncated: false,
    });
    await selectRow(ui, "DIPO-24");
    await ui.press("enter");
    await ui.waitFor("Reviews 1");
    for (let i = 0; i < 4; i++) await ui.press("right");
    await ui.waitFor("+const cap = 4;");
    const shown = lines(ui.frame());
    expect(shown.some((line) => line.includes("DIPO-24/retry against main"))).toBe(true);
    expect(shown.some((line) => line.includes("-const cap = 3;"))).toBe(true);
    expect(session.reads.find((read) => read.name === "story.diff")?.args).toMatchObject({
      story: KEY_24,
    });
  });
});

describe("a row's second line with Refined dependents (DIPO-484)", () => {
  it("counts blocked stories and Refined ones apart, so a story that waits for Ready never reads as blocked", () => {
    const item = DeskItem.parse({
      kind: "PARKED",
      story: "DIPO-447",
      reason: "budget-exceeded",
      detail: "d",
      since: "2026-11-10T10:00:00.000Z",
      blocks: ["DIPO-448"],
      refined: [{ story: "DIPO-449", reason: "no test plan" }],
      actions: [],
    });
    expect(rowFacts(item, "Title", "·").second).toBe(
      "budget-exceeded · blocks 1 · 1 Refined, not Ready yet",
    );
    const only = DeskItem.parse({ ...item, blocks: [] });
    expect(rowFacts(only, "Title", "·").second).toBe("budget-exceeded · 1 Refined, not Ready yet");
  });
});

describe("the desk preview scrolls (DIPO-483)", () => {
  it("shows the rows from the scroll offset down, and the last rows past the end", () => {
    const rows = Array.from({ length: 30 }, (_, i) => [{ text: `row ${i}` }]);
    expect(previewRows(rows, 10, 0)).toEqual(rows.slice(0, 10));
    expect(previewRows(rows, 10, 8)).toEqual(rows.slice(8, 18));
    expect(previewRows(rows, 10, 500)).toEqual(rows.slice(20, 30));
  });
});
