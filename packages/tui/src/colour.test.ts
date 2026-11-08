// Colour goes through one place (DIPO-320): with `NO_COLOR` set, or `--no-color`, no frame the TUI
// writes holds a colour or bold code, in any view that colours text; without them the same walk
// does colour. The walk runs in a child (`test/support/colour-main.ts`) with `FORCE_COLOR=3`, so Ink
// colours whatever the TUI asks for: Ink does not read `NO_COLOR` itself, the TUI must. A scan of
// the sources keeps every other file from setting Ink's style props, on `<Text>` or `<Box>`, or
// writing an escape sequence past `Colored`.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ansiPaint, ROLES, roleStyle, TRUECOLOR, type Role } from "./colour";

const MAIN = join(import.meta.dir, "..", "test", "support", "colour-main.ts");
const SRC = import.meta.dir;
/** An SGR sequence: a colour, bold or a reset of one. */
// oxlint-disable-next-line no-control-regex
const SGR = /\u001b\[[0-9;]*m/g;
const TIMEOUT_MS = 30_000;

/** Ink props that colour or style text, on `<Text>` and `<Box>` alike. */
const STYLE_PROP =
  /\b(color|backgroundColor|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor|borderDimColor|bold|dimColor|italic|underline|strikethrough|inverse)\b/;
/** The escape character, raw or spelt in the source as `\u001b`, `\x1b`, `\u{1b}` or `\033`. */
// oxlint-disable-next-line no-control-regex
const ESCAPE = /\u001b|\\u001b|\\x1b|\\u\{1b\}|\\033/i;

/** What in `text`, the source of `name`, styles text past `Colored`. */
function styleOffenders(name: string, text: string): string[] {
  const found: string[] = [];
  for (const tag of text.matchAll(/<(?:Text|Box)\b[^>]*>/g)) {
    if (STYLE_PROP.test(tag[0])) found.push(`${name}: ${tag[0]}`);
  }
  if (ESCAPE.test(text)) found.push(`${name}: writes an escape sequence`);
  if (/from "chalk"/.test(text)) found.push(`${name}: imports chalk`);
  return found;
}

async function walk(env: Record<string, string>, args: readonly string[] = []): Promise<string> {
  const { NO_COLOR: _inherited, ...base } = process.env;
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    env: { ...base, FORCE_COLOR: "3", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`colour-main exited with ${code}: ${err}`);
  return JSON.parse(out) as string;
}

describe("colour", () => {
  it(
    "colours the views without NO_COLOR, and writes no colour code with NO_COLOR or --no-color",
    async () => {
      const [coloured, noColorEnv, noColorFlag] = await Promise.all([
        walk({}),
        walk({ NO_COLOR: "1" }),
        walk({}, ["--no-color"]),
      ]);
      // The control: the same walk colours the selection, the titles, messages and the offline header.
      expect(coloured.match(SGR)).toEqual(
        expect.arrayContaining(["\u001b[48;5;235m", "\u001b[1m", "\u001b[33m", "\u001b[31m"]),
      );
      // Without colour only bold and underline stay (roles.json, noColor).
      for (const raw of [noColorEnv, noColorFlag]) {
        expect(raw).toContain("offline since");
        const codes = new Set(raw.match(SGR) ?? []);
        for (const code of codes)
          expect(["\u001b[1m", "\u001b[22m", "\u001b[4m", "\u001b[24m"]).toContain(code);
      }
    },
    TIMEOUT_MS,
  );

  it("sets Ink's style props and writes escapes only in colour.tsx", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SRC)) {
      if (!/\.tsx?$/.test(name) || name.includes(".test.") || name === "colour.tsx") continue;
      offenders.push(...styleOffenders(name, readFileSync(join(SRC, name), "utf8")));
    }
    expect(offenders).toEqual([]);
  });

  it("finds every form the scan guards against", () => {
    const samples = [
      '<Text color="cyan">x</Text>',
      "<Text {...(on ? { bold: true } : {})}>x</Text>",
      '<Box borderStyle="round" borderColor="red">',
      '<Box backgroundColor="blue">',
      'const red = "\\u001b[31m";',
      'const red = "\\x1b[31m";',
      'const red = "\\u{1b}[31m";',
      'const red = "\\033[31m";',
      'const red = "\u001b[31m";',
      'import chalk from "chalk";',
    ];
    for (const sample of samples) expect(styleOffenders("x.tsx", sample)).toHaveLength(1);
    expect(styleOffenders("x.tsx", '<Text wrap="truncate-end">x</Text>')).toEqual([]);
  });
});

const ROLES_JSON = JSON.parse(
  readFileSync(join(SRC, "..", "..", "..", "docs", "design", "tui-v2", "roles.json"), "utf8"),
) as { roles: Record<string, { truecolor: { dark: string; light: string } }> };

describe("colour roles", () => {
  it("are the ten roles of roles.json with its truecolor values", () => {
    expect(Object.keys(ROLES_JSON.roles).toSorted()).toEqual([...ROLES].toSorted());
    for (const role of ROLES)
      expect(TRUECOLOR[role]).toEqual(ROLES_JSON.roles[role]?.truecolor as never);
  });

  it("map to ANSI slots by theme, with hi brighter than fg and dim apart from faint", () => {
    const on = { color: true, ascii: false } as const;
    expect(roleStyle("acc", on)).toEqual({ color: "yellow" });
    expect(roleStyle("ok", on)).toEqual({ color: "green" });
    expect(roleStyle("err", on)).toEqual({ color: "red" });
    expect(roleStyle("fg", on)).toEqual({});
    expect(roleStyle("bg", on)).toEqual({});
    expect(roleStyle("hi", on)).toEqual({ color: "whiteBright" });
    expect(roleStyle("hi", { ...on, tone: "light" })).toEqual({ color: "black" });
    expect(roleStyle("sel", on)).toEqual({ backgroundColor: "ansi256(235)" });
    expect(roleStyle("sel", { ...on, tone: "light" })).toEqual({ backgroundColor: "ansi256(255)" });
    expect(roleStyle("dim", on)).toEqual({ color: "blackBright" });
    expect(roleStyle("faint", on)).toEqual({ color: "blackBright", dimColor: true });
    expect(roleStyle("shade", on)).toEqual({ color: "black", dimColor: true });
    expect(roleStyle("shade", { ...on, tone: "light" })).toEqual({
      color: "white",
      dimColor: true,
    });
    expect(ansiPaint("hi", "dark").faint).toBeUndefined();
  });

  it("use the previews' truecolor values on the opt-in Classical theme", () => {
    const classical = { color: true, ascii: false, classical: true } as const;
    expect(roleStyle("acc", classical)).toEqual({ color: "#e1ad66" });
    expect(roleStyle("acc", { ...classical, tone: "light" })).toEqual({ color: "#7d5411" });
    expect(roleStyle("sel", classical)).toEqual({ backgroundColor: "#2a2824" });
  });

  it("drop under NO_COLOR, so sel equals bg", () => {
    const off = { color: false, ascii: false } as const;
    for (const role of ROLES as readonly Role[]) expect(roleStyle(role, off)).toEqual({});
  });
});
