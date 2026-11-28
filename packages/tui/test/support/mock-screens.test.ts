// The mock reader and the guard (DIPO-520 test plan): `mockCells` reads the roles, bold, underline
// and focus of a mock, `frameCells` reads them back from the ANSI Ink writes, `expectScreen` names
// a wrong cell, and the guard fails for a caption nobody holds.

import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";
import { createElement } from "react";

import { Colored, ROLES, type Role } from "../../src/colour";
import {
  expectScreen,
  frameCells,
  guardProblems,
  KNOWN_GAPS,
  mockCaptions,
  mockCells,
  screenCalls,
  type Screen,
} from "./mock-screens";
import { render } from "./harness";

const ESC = "\u001b[";

/** The SGR codes of a role on the dark ANSI theme. */
const CODES: Record<Role, string> = {
  bg: "",
  fg: "",
  hi: "97",
  dim: "90",
  faint: "90;2",
  acc: "33",
  ok: "32",
  err: "31",
  sel: "",
  shade: "30;2",
};

/** A screen as the ANSI the TUI would write: each cell its own SGR run. */
function paint(screen: Screen, change?: (row: number, col: number) => Role | undefined): string {
  return screen.cells
    .map(
      (row, r) =>
        row
          .map((cell, c) => {
            const role = change?.(r + 1, c + 1) ?? cell.role;
            const codes = [
              CODES[role],
              cell.bold ? "1" : "",
              cell.underline ? "4" : "",
              cell.sel ? "48;5;235" : "",
            ].filter((code) => code !== "");
            return `${ESC}0m${codes.length === 0 ? "" : `${ESC}${codes.join(";")}m`}${cell.ch}`;
          })
          .join("") + `${ESC}0m`,
    )
    .join("\n");
}

const at = (screen: Screen, row: number, col: number) => screen.cells[row - 1]![col - 1]!;

describe("mockCells", () => {
  it("reads roles, nested roles, bold, underline and the focus row of 02-floor.txt row 6", () => {
    const floor = mockCells("02-floor.txt");
    expect([floor.cols, floor.rows]).toEqual([112, 30]);
    expect(at(floor, 6, 1)).toEqual({
      ch: "▌",
      role: "acc",
      bold: false,
      underline: false,
      sel: true,
    });
    expect(at(floor, 6, 3)).toMatchObject({ ch: "●", role: "ok", sel: true });
    expect(at(floor, 6, 5)).toMatchObject({ ch: "D", role: "dim", sel: true });
    expect(at(floor, 6, 15)).toMatchObject({ ch: "R", role: "hi", sel: true });
    // Padding inside [sel] is on the focus background; the cells after it are not.
    expect(at(floor, 6, 112).sel).toBe(true);
    expect(at(floor, 5, 1).sel).toBe(false);
    // `[sel]` wraps nested roles: row 9 is dim, with an ok run inside it.
    expect(at(floor, 9, 15)).toMatchObject({ ch: "c", role: "dim" });
    expect(at(floor, 9, 24)).toMatchObject({ ch: "1", role: "ok" });
    expect(at(floor, 9, 32)).toMatchObject({ ch: "·", role: "dim" });
    // **bold** and __underline__, in the role's own colour.
    expect(at(floor, 1, 1)).toMatchObject({ ch: "d", role: "acc", bold: true, underline: false });
    expect(at(floor, 2, 21)).toMatchObject({ ch: "2", role: "hi", underline: true, bold: false });
    expect(at(floor, 2, 20)).toMatchObject({ ch: " ", underline: true });
    expect(at(floor, 2, 12)).toMatchObject({ ch: " ", underline: false });
    // An unmarked rule is faint; unmarked text is fg.
    expect(at(floor, 3, 1)).toMatchObject({ ch: "─", role: "faint" });
    expect(at(floor, 1, 6)).toMatchObject({ ch: "/", role: "dim" });
    expect(at(floor, 1, 8)).toMatchObject({ ch: "d", role: "fg" });
  });

  it("finds a caption of a file with several, from either folder, and refuses an unclear one", () => {
    expect(mockCells("12-states.txt", "Daemon stopped").rows).toBe(9);
    expect(mockCells("03-floor-background.txt").cols).toBe(112);
    expect(() => mockCells("12-states.txt", "S7")).toThrow("captions match");
    expect(() => mockCells("12-states.txt", "no such caption")).toThrow("0 captions");
  });

  it("parses every caption of both folders into a grid of its size", () => {
    const captions = mockCaptions();
    expect(captions.length).toBeGreaterThan(50);
    for (const caption of captions) {
      const screen = mockCells(caption.file, caption.title);
      expect(screen.cells).toHaveLength(screen.rows);
      for (const row of screen.cells) expect(row.length).toBeGreaterThanOrEqual(screen.cols);
    }
  });
});

describe("frameCells", () => {
  it("maps the SGR of every role in colour.tsx back to its role, faint and the sel background included", async () => {
    const display = { color: true, ascii: false };
    for (const role of ROLES.filter((name) => name !== "sel" && name !== "bg")) {
      const ui = render(createElement(Colored, { display, role, children: "x" }), { columns: 10 });
      await Bun.sleep(20);
      expect(at(frameCells(ui.rawFrame(), 10, 1), 1, 1)).toMatchObject({ ch: "x", role });
      await ui.unmount();
    }
    const ui = render(
      createElement(Colored, { display, role: "sel", bold: true, underline: true, children: "y" }),
      { columns: 10 },
    );
    await Bun.sleep(20);
    expect(at(frameCells(ui.rawFrame(), 10, 1), 1, 1)).toMatchObject({
      ch: "y",
      role: "fg",
      bold: true,
      underline: true,
      sel: true,
    });
    await ui.unmount();
  });

  it("reads plain text as fg and resets at the end of a row", () => {
    const screen = frameCells(`${ESC}91mnot a role${ESC}0m\n${ESC}33mA\n b`, 4, 3);
    expect(String(at(screen, 1, 1).role)).toBe("?91/false");
    expect(at(screen, 2, 1).role).toBe("acc");
    expect(at(screen, 3, 2)).toMatchObject({ ch: "b", role: "fg" });
  });
});

describe("expectScreen", () => {
  const file = "10-test-overlay.txt";

  it("passes a frame that is the mock in every cell", () => {
    expectScreen({ rawFrame: () => paint(mockCells(file)) }, file);
  });

  it("reports a single wrong role at row:col, with both rows", () => {
    const mock = mockCells(file);
    const row =
      mock.cells.findIndex((cells) => cells.some((cell) => cell.ch === "x" || cell.ch === "e")) + 1;
    const col = mock.cells[row - 1]!.findIndex((cell) => cell.ch === "x" || cell.ch === "e") + 1;
    const wanted = at(mock, row, col);
    const role = wanted.role === "err" ? "ok" : "err";
    const raw = paint(mock, (r, c) => (r === row && c === col ? role : undefined));
    let message = "";
    try {
      expectScreen({ rawFrame: () => raw }, file);
    } catch (error) {
      message = String(error instanceof Error ? error.message : error);
    }
    expect(message).toContain(`${row}:${col} expected <${wanted.ch} ${wanted.role}`);
    expect(message).toContain(`got <${wanted.ch} ${role}`);
    expect(message).toContain(`expected row ${row}:`);
    expect(message.match(/\d+:\d+ expected/g)).toHaveLength(1);
  });
});

describe("the guard", () => {
  const captions = [
    { file: "a.txt", title: "A one", key: "a.txt#A one" },
    { file: "a.txt", title: "A two", key: "a.txt#A two" },
    { file: "b.txt", title: "B", key: "b.txt#B" },
  ];

  it("fails for a caption with no expectScreen call", () => {
    const problems = guardProblems(
      captions,
      [
        ["a.txt", "A one"],
        ["a.txt", "A two"],
      ],
      {},
    );
    expect(problems).toEqual(["b.txt#B: no expectScreen call and no KNOWN_GAPS entry"]);
  });

  it("passes when the caption is in KNOWN_GAPS with a story, and not for a bad entry", () => {
    const calls: [string, string | undefined][] = [["a.txt", undefined]];
    expect(guardProblems(captions, calls, { "b.txt#B": { story: "DIPO-530" } })).toEqual([]);
    expect(guardProblems(captions, calls, { "b.txt#B": { story: "later" } })).toHaveLength(1);
    expect(
      guardProblems(captions, calls, {
        "b.txt#B": { story: "DIPO-1" },
        "c#C": { story: "DIPO-1" },
      }),
    ).toEqual(["c#C: no such caption"]);
    expect(
      guardProblems(captions, calls, {
        "a.txt#A one": { story: "DIPO-1" },
        "b.txt#B": { story: "DIPO-1" },
      }),
    ).toHaveLength(1);
  });

  it("reads the calls of test sources", () => {
    expect(
      screenCalls([
        `expectScreen(ui, "07-plan.txt");\nexpectScreen(\n  view.ui,\n  "12-states.txt",\n  "Daemon stopped",\n);`,
      ]),
    ).toEqual([
      ["07-plan.txt", undefined],
      ["12-states.txt", "Daemon stopped"],
    ]);
  });

  it("holds every caption of both folders: a call in the TUI's tests or a KNOWN_GAPS entry", () => {
    const dir = new URL("../../src/", import.meta.url);
    const sources = readdirSync(dir)
      .filter((name) => /\.test\.tsx?$/.test(name))
      .map((name) => readFileSync(new URL(name, dir), "utf8"));
    expect(guardProblems(mockCaptions(), screenCalls(sources), KNOWN_GAPS)).toEqual([]);
  });
});
