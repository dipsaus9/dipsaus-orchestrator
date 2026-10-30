// Colour goes through one place (DIPO-320): with `NO_COLOR` set, or `--no-color`, no frame the TUI
// writes holds a colour or bold code, in any view that colours text; without them the same walk
// does colour. The walk runs in a child (`test/support/colour-main.ts`) with `FORCE_COLOR=3`, so Ink
// colours whatever the TUI asks for: Ink does not read `NO_COLOR` itself, the TUI must. A scan of
// the sources keeps every other file from setting Ink's style props past `Colored`.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "test", "support", "colour-main.ts");
const SRC = import.meta.dir;
/** An SGR sequence: a colour, bold or a reset of one. */
// oxlint-disable-next-line no-control-regex
const SGR = /\u001b\[[0-9;]*m/g;
const TIMEOUT_MS = 30_000;

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
        expect.arrayContaining(["\u001b[36m", "\u001b[1m", "\u001b[33m", "\u001b[31m"]),
      );
      for (const raw of [noColorEnv, noColorFlag]) {
        expect(raw).toContain("OFFLINE");
        expect(raw.match(SGR)).toBeNull();
      }
    },
    TIMEOUT_MS,
  );

  it("sets Ink's style props only in colour.tsx", () => {
    const style =
      /\b(color|backgroundColor|bold|dimColor|italic|underline|strikethrough|inverse)\b/;
    const offenders: string[] = [];
    for (const name of readdirSync(SRC)) {
      if (!/\.tsx?$/.test(name) || name.includes(".test.") || name === "colour.tsx") continue;
      const text = readFileSync(join(SRC, name), "utf8");
      for (const tag of text.matchAll(/<Text\b[^>]*>/g)) {
        if (style.test(tag[0])) offenders.push(`${name}: ${tag[0]}`);
      }
      if (/from "chalk"/.test(text)) offenders.push(`${name}: imports chalk`);
    }
    expect(offenders).toEqual([]);
  });
});
