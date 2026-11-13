// The queue (DIPO-54 and DIPO-460 test plans): the three groups with counts and the reason
// column, the preview with the gate, the chain and the pointer to the Desk, the ux-spec's S2b cell
// for cell, `.` for the Done stories, `R` on the selected story through `work.run`, started and
// skipped stories with reasons on one ticker line that clears on the next key, read-your-writes on
// the reply cursor, and errors with ^R retry.

import { afterEach, describe, expect, it } from "bun:test";

import type { Event, StoryView } from "@dipsaus-orchestrator/contract";

import { goldenSnapshots, OFFICES } from "../test/support/fake-session";
import { mockRows } from "../test/support/mock-screens";
import { mount } from "../test/support/setup";

const mounted: { unmount(): Promise<void> }[] = [];
const STREAM = `office:${OFFICES.dipsaus}`;
const KEY_30 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C02";
const KEY_31 = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C31";

async function openQueue(columns = 120) {
  const view = await mount({ columns, rows: 30 });
  mounted.push(view.ui);
  await view.ui.waitFor("daemon live");
  await view.ui.press("3");
  await view.ui.waitFor("READY");
  return view;
}

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

function storyEvent(seq: number, view: StoryView, from: string): Event {
  return {
    cursor: { stream: STREAM, seq },
    at: "2026-10-14T10:05:00.000Z",
    type: "story.state",
    data: { story: view.story, key: view.key, from, to: view.lifecycle, view },
  } as Event;
}

function golden(key: string): StoryView {
  const view = goldenSnapshots.get(OFFICES.dipsaus)?.stories.find((story) => story.key === key);
  if (view === undefined) throw new Error(`no story ${key}`);
  return view;
}

const queued = (n: number, title: string, column: string, extra: Record<string, unknown> = {}) =>
  ({
    key: `sto_01J9ZK5Q8W3V4X6Y7Z8A9B${String(n).padStart(3, "0")}`,
    story: `DIPO-${n}`,
    provisional: false,
    title,
    lifecycle: column === "ready" || column === "waiting" ? "Ready" : "Refined",
    tier: "M",
    column,
    ...extra,
  }) as unknown as StoryView;
const failure = (rule: string, text: string) => ({
  rule,
  text,
  message: `ready X failed ${rule}: ${text}`,
});
const level = (...ids: number[]) => ids.map((n) => `DIPO-${n}`);

/** The ux-spec's S2b scenario: DIPO-447 parked on the Desk, DIPO-452 next up, 418 Done. */
function queueScenario() {
  const base = goldenSnapshots.get(OFFICES.dipsaus)!;
  const stories = [
    queued(452, "File every idea as a draft", "ready"),
    queued(448, "Keep session decisions", "waiting", { waitingOn: ["DIPO-447"] }),
    queued(449, "Plan in the TUI", "waiting", { waitingOn: ["DIPO-447"] }),
    queued(450, "File confirmed stories", "waiting", { waitingOn: ["DIPO-449"] }),
    queued(453, "Retro view", "waiting", { waitingOn: ["DIPO-452"] }),
    queued(116, "Skills and plugins", "refined", {
      tier: "L",
      gateFailures: [failure("R15", "2 unknowns")],
    }),
    queued(288, "Yarn, bun.lockb, pnpm", "refined", {
      gateFailures: [failure("R09", "no test plan")],
    }),
    ...Array.from({ length: 418 }, (_, i) => queued(1000 + i, `Done ${i}`, "done")),
  ];
  const node = (n: number, state: string, unblocks: number[]) => ({
    story: `DIPO-${n}`,
    key: `sto_01J9ZK5Q8W3V4X6Y7Z8A9B${String(n).padStart(3, "0")}`,
    state,
    unblocks: level(...unblocks),
  });
  const chain = {
    rows: [
      { levels: [level(447), level(448, 449), level(450), level(451)], parked: "DIPO-447" },
      { levels: [level(452), level(453)] },
    ],
    nodes: [
      node(447, "parked", [448, 449]),
      node(448, "waiting", []),
      node(449, "waiting", [450]),
      node(450, "waiting", [451]),
      node(452, "moving", [453]),
      node(453, "waiting", []),
    ],
  };
  const gate = {
    story: "DIPO-452",
    key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B452",
    passed: true,
    failures: [],
    warnings: [{ rule: "R29", message: "ready DIPO-452 warning R29: no test file" }],
    rules: 31,
    touches: ["engine/src/backlog/", "contract/src/office.ts"],
  };
  return {
    snapshot: { ...base, work: [], stories, questions: [], gates: [] } as typeof base,
    chain,
    gates: new Map([["DIPO-452", gate]]),
  };
}

const afterRule = (rows: string[]) => rows.findIndex((row) => row.startsWith("───")) + 1;

describe("queue view", () => {
  it("lists READY, WAITING ON A DEPENDENCY and REFINED with the reason column, and previews the first story", async () => {
    const { ui } = await openQueue();
    const frame = lines(ui.frame());
    expect(frame[0]).toMatch(
      /^dipo \/ dipsaus-orchestrator {3}\+1 elsewhere · O +● daemon live {4}\d\d:\d\d$/,
    );
    expect(frame.slice(1, 15)).toEqual([
      "1 Desk 2    2 Floor 3    3 Queue 2·1    4 Retro",
      "─".repeat(119),
      "READY                                                      2  │  READY · tier S · offered as next up",
      "▌ → DIPO-30   Add park reasons to digest      S  next up      │  DIPO-30 Add park reasons to digest",
      "  → DIPO-32   Desk sort order                 M  ready        │",
      "                                                              │  Gate     ✓ 28 rules",
      "WAITING ON A DEPENDENCY                                    1  │  Needs    all done",
      "  ○ DIPO-31   Cost view                       M  needs 21     │  Unblocks -",
      "                                                              │  Touches  -",
      "REFINED · not Ready yet                                    1  │",
      "  ✗ DIPO-33   Office forget flow              M  2 unknowns o…│",
      "                                                              │",
      "  . show done (1)                                             │",
      "                                                              │",
    ]);
    // Running, drafts and parked stories are not queued: the Floor and the Desk show them.
    expect(ui.frame()).not.toContain("DIPO-24");
    expect(ui.frame()).not.toContain("DRAFT");
    expect(frame.at(-1)).toBe(
      `p park   X drop   ↑↓ move   ⏎ story   r run   space mark   . show done${" ".repeat(7)}: commands   ? keys   O offices   q q quit`,
    );
  });

  it("matches the ux-spec's S2b: reasons, preview, chain picture and the pointer to the Desk", async () => {
    const { snapshot, chain, gates } = queueScenario();
    const view = await mount({
      columns: 113,
      rows: 30,
      snapshots: new Map([[OFFICES.dipsaus, snapshot]]),
      chain,
      gates,
    });
    mounted.push(view.ui);
    await view.ui.waitFor("daemon live");
    await view.ui.press("3");
    await view.ui.waitFor("Everything below 447 waits on the park");
    await view.ui.waitFor("1 warning");
    const shown = lines(view.ui.frame());
    const mock = mockRows("05-queue.txt");
    const ours = shown.slice(afterRule(shown), -2);
    const theirs = mock.slice(afterRule(mock), -2);
    const pane = 62;
    // The list, cell for cell: groups, counts, glyphs, tiers, reasons and the done toggle. (The
    // mock's DIPO-288 row is one cell longer than its pane, so the pane rule is checked apart.)
    expect(ours.map((row) => row.slice(0, pane).trimEnd())).toEqual(
      theirs.map((row) => row.slice(0, pane).trimEnd()),
    );
    expect(ours.every((row) => row[pane] === "│")).toBe(true);
    // The preview: the mock's title wraps in two lines, ours is one; everything else is the same.
    const preview = (rows: string[]) =>
      rows
        .map((row) =>
          row
            .slice(pane)
            .replace(/^\s*│\s*/, "")
            .trim(),
        )
        .filter((row) => row !== "");
    const wanted = preview(theirs).filter(
      (row) => !/^(DIPO-452 File every incoming|as a draft and)/.test(row),
    );
    expect(preview(ours).filter((row) => !row.startsWith("DIPO-452 File"))).toEqual(wanted);
  });

  it("prints Gate ✓ N rules from story.gate and reads it for each selected story", async () => {
    const { snapshot, chain, gates } = queueScenario();
    const view = await mount({
      columns: 120,
      rows: 30,
      snapshots: new Map([[OFFICES.dipsaus, snapshot]]),
      chain,
      gates,
    });
    mounted.push(view.ui);
    await view.ui.waitFor("daemon live");
    await view.ui.press("3");
    await view.ui.waitFor("Gate     ✓ 31 rules · 1 warning R29");
    expect(view.session.reads.filter((read) => read.name === "story.gate")).toEqual([
      { name: "story.gate", args: { office: OFFICES.dipsaus, story: "DIPO-452" } },
    ]);
    await view.ui.press("j");
    await view.ui.waitFor("▌ ○ DIPO-448");
    await view.ui.waitFor("WAITING ON A DEPENDENCY · tier M");
    expect(view.ui.frame()).toContain("Waiting on DIPO-447");
    expect(view.ui.frame()).toContain("Needs    447✗");
    expect(view.session.reads.filter((read) => read.name === "story.gate")).toHaveLength(2);
  });

  it("shows a failed gate rule with its text for a Refined story", async () => {
    const { snapshot, chain, gates } = queueScenario();
    const refined = new Map<string, unknown>([
      [
        "DIPO-116",
        {
          story: "DIPO-116",
          key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B116",
          passed: false,
          failures: [{ rule: "R15", message: "ready DIPO-116 failed R15: 2 unknowns" }],
          rules: 28,
        },
      ],
      ...gates,
    ]);
    const view = await mount({
      columns: 120,
      rows: 30,
      snapshots: new Map([[OFFICES.dipsaus, snapshot]]),
      chain,
      gates: refined,
    });
    mounted.push(view.ui);
    await view.ui.waitFor("daemon live");
    await view.ui.press("3");
    for (let i = 0; i < 5; i++) await view.ui.press("j");
    await view.ui.waitFor("▌ ✗ DIPO-116");
    await view.ui.waitFor("Gate     ✗ R15 2 unknowns");
  });

  it("shows a Refined dependency as Refined, not Ready yet with its first gate failure, in the needs column and the preview (DIPO-484)", async () => {
    const { snapshot, chain, gates } = queueScenario();
    const stories = [
      ...snapshot.stories,
      queued(454, "Show the spend", "waiting", { waitingOn: ["DIPO-116"] }),
    ];
    const refinedChain = {
      rows: [...chain.rows, { levels: [level(116), level(454)] }],
      nodes: [
        ...chain.nodes,
        {
          story: "DIPO-116",
          key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B116",
          state: "refined",
          reason: "2 unknowns",
          unblocks: level(454),
        },
      ],
    };
    const view = await mount({
      columns: 120,
      rows: 30,
      snapshots: new Map([[OFFICES.dipsaus, { ...snapshot, stories }]]),
      chain: refinedChain,
      gates,
    });
    mounted.push(view.ui);
    await view.ui.waitFor("daemon live");
    await view.ui.press("3");
    for (let i = 0; i < 5; i++) await view.ui.press("j");
    await view.ui.waitFor("▌ ○ DIPO-454");
    const frame = await view.ui.waitFor("Refined  DIPO-116");
    expect(frame).toMatch(/needs 116◌ Re/);
    expect(frame).toContain("Refined  DIPO-116 Refined, not Ready yet: 2 unknowns");
    expect(frame).toContain("116◌ → 454");
  });

  it("draws the arrows and marks of the chain with the ascii twins", async () => {
    const { snapshot, chain, gates } = queueScenario();
    const view = await mount({
      columns: 120,
      rows: 30,
      display: { color: false, ascii: true },
      snapshots: new Map([[OFFICES.dipsaus, snapshot]]),
      chain,
      gates,
    });
    mounted.push(view.ui);
    await view.ui.waitFor("daemon live");
    await view.ui.press("3");
    const frame = await view.ui.waitFor("CHAIN");
    expect(frame).toContain("447x -> 448 - 449 -> 450 -> 451");
    expect(frame).toContain("452  -> 453");
    expect(frame).toMatch(/needs 447x/);
    expect(frame).toMatch(/needs 452>/);
  });

  it("shows Done stories after ., with the count on the toggle", async () => {
    const { ui } = await openQueue();
    expect(ui.frame()).not.toContain("DIPO-12");
    expect(ui.frame()).toContain(". show done (1)");
    await ui.press(".");
    const frame = await ui.waitFor("DONE");
    expect(frame).toContain("✓ DIPO-12   Office registry");
    expect(frame).toContain(". hide done (1)");
    await ui.press(".");
    await ui.waitFor(". show done (1)");
    expect(ui.frame()).not.toContain("DIPO-12");
  });

  it("shows no preview below 100 columns and keeps every line in the terminal", async () => {
    for (const columns of [99, 80, 60]) {
      const { ui } = await openQueue(columns);
      const shown = lines(ui.frame());
      expect(ui.frame()).not.toContain("Gate ");
      for (const line of shown) expect(line.length).toBeLessThanOrEqual(columns);
      expect(shown.at(-1)).toContain("q q quit");
    }
  });
});

describe("R runs stories", () => {
  it("shows a run's started and skipped stories once, on one ticker line, and clears it on the next key", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [
          { story: "DIPO-31", key: KEY_31, reason: "dependency" },
          { story: "DIPO-32", key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C32", reason: "starting" },
        ],
      },
      changed: false,
    });
    await ui.press("r");
    const done = await ui.waitFor("run DIPO-30: done");
    const ticker = lines(done).filter((line) => line.includes("skipped"));
    expect(ticker).toHaveLength(1);
    expect(ticker[0]).toStartWith(
      "run DIPO-30: done  ·  started DIPO-30  ·  skipped DIPO-31: a dependency is not Done (needs DIPO-21)  ·  skipp",
    );
    // The next key clears it: no skipped list stays under the view.
    await ui.press("j");
    await ui.waitFor("▌ → DIPO-32");
    expect(ui.frame()).not.toContain("skipped");
    expect(ui.frame()).not.toContain("run DIPO-30");
  });

  it("shows the decision at once and the story in setup from it: the answer's cursor is the decision's own entry (DIPO-456)", async () => {
    const { ui, session } = await openQueue();
    // work.run answers at its decision; its one change moves the story out of Ready.
    session.runReply = () => ({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [{ story: "DIPO-32", key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C32", reason: "starting" }],
      },
      changed: true,
      cursor: { stream: STREAM, seq: 9 },
    });
    await ui.press("r");
    await ui.waitFor("waiting for the office stream");
    const starting = { ...golden(KEY_30), column: "running" } as StoryView;
    session.active(STREAM)?.options.onEvent(storyEvent(9, starting, "Ready"));
    const done = await ui.waitFor("run DIPO-30: done");
    expect(done).toContain("started DIPO-30");
    expect(done).toContain("skipped DIPO-32: already starting");
    expect(done).not.toContain("→ DIPO-30");
    expect(done).not.toContain("wait for its reply");
    // A second u is sent at once: nothing waits for the first start's setup.
    await ui.press("r");
    expect(ui.frame()).not.toContain("wait for its reply");
    expect(session.commands).toHaveLength(2);
  });

  it("sends work.run with the selected story; done once the stream passes the reply cursor", async () => {
    const { ui, session } = await openQueue();
    const reply = Promise.withResolvers<unknown>();
    session.runReply = () => reply.promise;
    await ui.press("r");
    await ui.waitFor("run DIPO-30: sending");
    expect(session.commands).toEqual([
      {
        name: "work.run",
        args: { stories: [KEY_30] },
        options: { office: OFFICES.dipsaus, requestId: "01J9ZK5Q8W3V4X6Y7Z8A9B0R01" },
      },
    ]);

    reply.resolve({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [],
      },
      changed: true,
      cursor: { stream: STREAM, seq: 9 },
    });
    const syncing = await ui.waitFor("waiting for the office stream");
    expect(syncing).toContain("started DIPO-30");

    // Seq 8 is not yet the reply cursor; seq 9 is.
    const office = session.active(STREAM);
    const running = { ...golden(KEY_30), lifecycle: "In Progress", column: "running" } as StoryView;
    office?.options.onEvent(storyEvent(8, running, "Ready"));
    await ui.waitFor("▌ → DIPO-32");
    expect(ui.frame()).toContain("waiting for the office stream");
    // The story left the Ready group; the selection stays on the row now in its place.
    expect(ui.frame()).not.toContain("→ DIPO-30");
    office?.options.onEvent(storyEvent(9, running, "Ready"));
    const done = await ui.waitFor("run DIPO-30: done");
    expect(done).toContain("started DIPO-30");
  });

  it("counts a re-read after the reply as caught up", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [],
      },
      changed: true,
      cursor: { stream: STREAM, seq: 9 },
    });
    await ui.press("r");
    await ui.waitFor("waiting for the office stream");
    // A history gap: the store reads the snapshot again, at seq 2, before seq 9 came.
    const base = goldenSnapshots.get(OFFICES.dipsaus)!;
    session.nextSnapshots.set(OFFICES.dipsaus, {
      ...base,
      cursor: { stream: STREAM, seq: 2 },
    } as typeof base);
    const stream = session.active(STREAM)!;
    stream.active = false;
    stream.options.onEnded?.({ code: "stream.resetRequired", message: "gap", retryable: false });
    await ui.waitFor("run DIPO-30: done");
  });

  it("handles RR in one write: the first R sends, the second is refused, and the refusal clears when the run ends", async () => {
    const { ui, session } = await openQueue();
    const reply = Promise.withResolvers<unknown>();
    session.runReply = () => reply.promise;
    await ui.press("rr");
    await ui.waitFor("run DIPO-30 is being sent; wait for its reply");
    expect(session.commands).toHaveLength(1);
    reply.resolve({ ok: true, result: { started: [], skipped: [] }, changed: false });
    await ui.waitFor("run DIPO-30: done");
    expect(ui.frame()).not.toContain("wait for its reply");
  });

  it("clears a refusal on the next key", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => new Promise(() => {});
    await ui.press("r");
    await ui.press("r");
    await ui.waitFor("wait for its reply");
    await ui.press("j");
    await ui.waitFor("▌ → DIPO-32");
    expect(ui.frame()).not.toContain("wait for its reply");
  });

  it("refuses a second R while the first run waits for the office stream, and keeps its lines", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: true,
      result: {
        started: [{ story: "DIPO-30", key: KEY_30, run: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0R30" }],
        skipped: [],
      },
      changed: true,
      cursor: { stream: STREAM, seq: 9 },
    });
    await ui.press("r");
    await ui.waitFor("waiting for the office stream");
    await ui.press("r");
    await ui.waitFor("waits for the office stream; wait until it is done");
    expect(session.commands).toHaveLength(1);
  });

  it("sends the selected Ready story and shows a dependency skip with its reason", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: true,
      result: { started: [], skipped: [{ story: "DIPO-31", key: KEY_31, reason: "dependency" }] },
      changed: false,
    });
    await ui.press("r");
    const frame = await ui.waitFor("run DIPO-30: done");
    expect(frame).toContain("skipped DIPO-31: a dependency is not Done (needs DIPO-21)");
    expect(session.commands.map((command) => command.args)).toEqual([{ stories: [KEY_30] }]);
  });

  it("sends the waiting story when it is selected", async () => {
    const { ui, session } = await openQueue();
    for (let i = 0; i < 2; i++) await ui.press("down");
    await ui.waitFor("▌ ○ DIPO-31");
    await ui.press("r");
    await ui.waitFor("run DIPO-31: done");
    expect(session.commands.map((command) => command.args)).toEqual([{ stories: [KEY_31] }]);
  });

  it("shows an error in the footer and retries a retryable one with Ctrl-R and the same request id", async () => {
    const { ui, session } = await openQueue();
    let calls = 0;
    session.runReply = () => {
      calls += 1;
      return calls === 1
        ? {
            ok: false,
            error: { code: "engine.recovering", message: "the daemon recovers", retryable: true },
          }
        : { ok: true, result: { started: [], skipped: [] }, changed: false };
    };
    await ui.press("r");
    const failed = await ui.waitFor("engine.recovering: the daemon recovers");
    expect(failed).toContain("^R retry");
    await ui.press("ctrl-r");
    const retried = await ui.waitFor("no Ready story to start");
    expect(retried).not.toContain("^R retry");
    const ids = session.commands.map(
      (command) => (command.options as { requestId: string }).requestId,
    );
    expect(ids).toEqual(["01J9ZK5Q8W3V4X6Y7Z8A9B0R01", "01J9ZK5Q8W3V4X6Y7Z8A9B0R01"]);
  });

  it("offers no retry for an error that is not retryable", async () => {
    const { ui, session } = await openQueue();
    session.runReply = () => ({
      ok: false,
      error: { code: "daemon.draining", message: "scheduling is off", retryable: false },
    });
    await ui.press("r");
    expect(await ui.waitFor("daemon.draining: scheduling is off")).not.toContain("^R");
    await ui.press("ctrl-r");
    expect(session.commands).toHaveLength(1);
  });

  it("sends nothing while offline", async () => {
    const { ui, session } = await openQueue();
    session.setState("reconnecting");
    await ui.waitFor("offline since");
    await ui.press("r");
    await ui.waitFor("offline: actions are disabled");
    expect(session.commands).toEqual([]);
  });
});

describe("run now on r (DIPO-479)", () => {
  it("does nothing on R in the queue", async () => {
    const { ui, session } = await openQueue();
    await ui.press("R");
    await Bun.sleep(100);
    expect(session.commands.some((c) => c.name === "work.run")).toBe(false);
  });
});

async function openRefined(columns = 120) {
  const base = goldenSnapshots.get(OFFICES.dipsaus)!;
  const stories = [
    queued(501, "Passing story", "refined", { gatePasses: true }),
    queued(502, "Failing story", "refined", {
      gateFailures: [failure("R09", "no test plan")],
    }),
    queued(503, "Second passing", "refined", { gatePasses: true }),
    queued(504, "Ready already", "ready"),
  ];
  const view = await mount({
    columns,
    rows: 30,
    snapshots: new Map([[OFFICES.dipsaus, { ...base, work: [], stories } as typeof base]]),
  });
  mounted.push(view.ui);
  await view.ui.waitFor("daemon live");
  await view.ui.press("3");
  await view.ui.waitFor("REFINED");
  return view;
}

describe("setting Refined stories Ready from the Queue (DIPO-482)", () => {
  const PR = "https://github.com/o/r/pull/8";

  it("shows on each Refined row that the gate passes, or its first failure", async () => {
    const { ui } = await openRefined();
    const frame = ui.frame();
    expect(frame).toMatch(/✓ DIPO-501 +Passing story +M +gate passes/);
    expect(frame).toMatch(/✗ DIPO-502 +Failing story +M +no test plan/);
    expect(frame).toMatch(/✓ DIPO-503 +Second passing +M +gate passes/);
  });

  it("marks with space, lists the marked ones in one confirm on Y, and shows the result per story", async () => {
    const { ui, session } = await openRefined();
    // Ready is the first group; move down onto the Refined rows.
    await ui.press("j");
    await ui.press(" ");
    await ui.press("j");
    await ui.press(" ");
    await ui.press("j");
    await ui.press(" ");
    expect(ui.frame()).toMatch(/ ●✗ DIPO-502/);
    expect(ui.frame()).toMatch(/▌●✓ DIPO-503/);
    session.commandReply = (name) =>
      name === "story.ready"
        ? {
            ok: true,
            changed: true,
            result: {
              queued: ["DIPO-501", "DIPO-503"],
              refused: [{ story: "DIPO-502", messages: ["R09: no test plan"] }],
              flush: { state: "opened", branch: "dipo/backlog-1", pr: PR },
            },
            cursor: { stream: STREAM, seq: 9 },
          }
        : undefined;
    expect(session.commands.filter((sent) => sent.name === "story.ready")).toEqual([]);
    await ui.press("Y");
    const asked = await ui.waitFor("Ready?");
    expect(asked).toContain("Set DIPO-501, DIPO-502, DIPO-503 Ready?");
    expect(session.commands.filter((sent) => sent.name === "story.ready")).toEqual([]);
    await ui.press("y");
    const shown = await ui.waitFor("SET READY");
    expect(session.commands.find((sent) => sent.name === "story.ready")).toMatchObject({
      args: { stories: ["DIPO-501", "DIPO-502", "DIPO-503"] },
    });
    expect(shown).toContain(`DIPO-501  waiting for the backlog PR ${PR}`);
    expect(shown).toContain(`DIPO-503  waiting for the backlog PR ${PR}`);
    expect(shown).toContain("DIPO-502  refused: R09: no test plan");
    // The marks were used up.
    expect(shown).not.toMatch(/●[✓✗] DIPO/);
  });

  it("sets the focused story when none is marked, and marks only Refined rows", async () => {
    const { ui, session } = await openRefined();
    // The first row is a Ready story: it cannot be marked, and Y has nothing to set.
    await ui.press(" ");
    await ui.waitFor("only a Refined story can be marked");
    await ui.press("Y");
    await ui.waitFor("select a Refined story first");
    await ui.press("j");
    await ui.press("Y");
    const asked = await ui.waitFor("Ready?");
    expect(asked).toContain("Set DIPO-501 Ready?");
    await ui.press("n");
    expect(session.commands.filter((sent) => sent.name === "story.ready")).toEqual([]);
  });
});
