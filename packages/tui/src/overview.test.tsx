// The office overview (DIPO-54 test plan): frames from the golden event log at 120, 80 and 70
// columns, the summary line, and no line wider than the terminal.

import { afterEach, describe, expect, it } from "bun:test";

import { goldenSnapshots, OFFICES } from "./testing/fake-session";
import { mount } from "./testing/setup";

const mounted: { unmount(): Promise<void> }[] = [];

async function open(columns: number, rows = 30) {
  const view = await mount({ columns, rows });
  mounted.push(view.ui);
  await view.ui.waitFor("· live");
  return view;
}

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

describe("office overview", () => {
  it("shows every column at 120 columns", async () => {
    const { ui } = await open(120);
    expect(lines(ui.frame())).toEqual([
      " dipsaus-orchestrator · daemon running · live",
      " STORY   ROLE      T PHASE  HEALTH    AC  LOOP VERIFY  BUDGET         TIME MODEL         TURNS",
      " DIPO-21 developer M build  busy >    4/7 2/5  passing [####----] 52% 38m  claude-sonnet 31",
      " DIPO-24 developer S verify looping @ 2/3 2/3  failing [######--] 78% 22m  claude-sonnet 22",
      " DIPO-19 reviewer  L review ASKING ?  9/9 1/8  passing [#-------] 18% 1h05 claude-opus   12",
      " Ready 2 · waiting 1 (on DIPO-21) · held 1 · desk 2",
      " [2] queue  [o] offices  [q] quit",
    ]);
  });

  it("drops model and turns and shortens the role from 80 to 119 columns", async () => {
    const { ui } = await open(80);
    expect(lines(ui.frame())).toEqual([
      " dipsaus-orchestrator · daemon running · live",
      " STORY   ROLE T PHASE  HEALTH    AC  LOOP VERIFY  BUDGET         TIME",
      " DIPO-21 dev  M build  busy >    4/7 2/5  passing [####----] 52% 38m",
      " DIPO-24 dev  S verify looping @ 2/3 2/3  failing [######--] 78% 22m",
      " DIPO-19 rev  L review ASKING ?  9/9 1/8  passing [#-------] 18% 1h05",
      " Ready 2 · waiting 1 (on DIPO-21) · held 1 · desk 2",
      " [2] queue  [o] offices  [q] quit",
    ]);
  });

  it("marks claimed values and shows the legend with the evidence capability", async () => {
    const view = await mount({ columns: 120, rows: 30, capabilities: ["evidence"] });
    mounted.push(view.ui);
    const frame = await view.ui.waitFor("· live");
    expect(frame).toContain(
      " DIPO-24 developer S verify looping @ 2/3* 2/3  failing [######--]78%* 22m",
    );
    expect(frame).toContain("* claimed ~ estimated ? none");
  });

  it("shows two-line cards from 60 to 79 columns", async () => {
    const { ui } = await open(70);
    const frame = ui.frame();
    expect(frame).toContain(" DIPO-24  looping @  verify\n   AC 2/3  loop 2/3  budget 78%");
    expect(frame).not.toContain("STORY");
  });

  it("never writes a line wider than the terminal", async () => {
    for (const columns of [120, 100, 80, 79, 60]) {
      const { ui } = await open(columns);
      await ui.press("2");
      await ui.waitFor("next Ready story");
      for (const line of lines(ui.frame())) expect(line.length).toBeLessThanOrEqual(columns);
      await ui.press("1");
      await ui.waitFor("[2] queue");
      for (const line of lines(ui.frame())) expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("follows a work event with a new view", async () => {
    const { ui, session } = await open(120);
    const stream = session.active(`office:${OFFICES.dipsaus}`);
    const before = goldenSnapshots.get(OFFICES.dipsaus)!.work[1]!;
    const view = { ...before, phase: "review", health: "busy" };
    stream?.options.onEvent({
      cursor: { stream: `office:${OFFICES.dipsaus}`, epoch: "e2", seq: 8 },
      at: "2026-10-14T10:05:00.000Z",
      type: "work.phase",
      data: { work: view.work, phase: "review", progress: view.progress, view },
    } as never);
    expect(await ui.waitFor("DIPO-24 developer S review busy >")).not.toContain("looping @");
  });
});
