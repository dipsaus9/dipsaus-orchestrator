// The maintainer reads a refusal through `dipo` (DIPO-418, 0005): no message text of a
// `CommandError`, a `LaneError` or an `engineError` in packages/engine/src names a contract command
// (`work.*`, `story.*`, `office.*`, `daemon.*`), and a refusal that asks to send again names the
// `dipo` command. The scan reads each such call in the source, takes its message argument (the
// second) and checks the string and template literal text in it, nested literals too; interpolated
// code such as `${office.officeId}` and code comments are not text, so comments may name commands.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
/** A contract command such as `work.resume`; a file such as `.dipo/office.yaml` is none. */
const COMMAND = /(?<![/\w.-])(?:work|story|office|daemon)\.[a-z]/;
const CALL = /\b(?:new CommandError|new LaneError|engineError)\(/g;

interface Refusal {
  readonly file: string;
  readonly line: number;
  /** The literal text of the message argument, its interpolated code left out, spaces as one. */
  readonly text: string;
}

/**
 * The literal text of each argument of the call whose argument list starts at `from` (just after
 * its opening parenthesis). Strings, templates (with their `${...}` code), comments and brackets
 * are followed, so a comma inside them splits nothing.
 */
function argumentsAt(source: string, from: number): string[] {
  const args: string[] = [""];
  let at = from;
  /** A quoted string or a template from `at` (on its quote); its text, escapes read as the char. */
  const literal = (quote: string): string => {
    let text = "";
    at += 1;
    while (at < source.length && source[at] !== quote) {
      if (source[at] === "\\") {
        text += source[at + 1] ?? "";
        at += 2;
      } else if (quote === "`" && source.startsWith("${", at)) {
        at += 2;
        text += ` ${code("}")} `;
      } else {
        text += source[at];
        at += 1;
      }
    }
    at += 1;
    return text;
  };
  /** Code up to its closing `end`: only the literal text in it. */
  const code = (end: string | null): string => {
    let text = "";
    let level = 0;
    while (at < source.length) {
      const char = source[at] ?? "";
      if (source.startsWith("//", at)) {
        at = source.indexOf("\n", at);
        if (at < 0) at = source.length;
      } else if (source.startsWith("/*", at)) {
        at = source.indexOf("*/", at) + 2;
      } else if (char === '"' || char === "'" || char === "`") {
        text += ` ${literal(char)} `;
      } else if ("([{".includes(char)) {
        level += 1;
        at += 1;
      } else if (level === 0 && (char === end || (end === null && char === ")"))) {
        at += 1;
        return text;
      } else if (")]}".includes(char)) {
        level -= 1;
        at += 1;
      } else if (end === null && level === 0 && char === ",") {
        // The next argument of the call.
        args[args.length - 1] += text;
        args.push("");
        text = "";
        at += 1;
      } else {
        at += 1;
      }
    }
    return text;
  };
  // The last argument: `code` pushes one entry per comma, so the index is read after it ran.
  const last = code(null);
  args[args.length - 1] += last;
  return args;
}

/** Every `CommandError`, `LaneError` and `engineError` message in packages/engine/src. */
function refusals(): Refusal[] {
  const found: Refusal[] = [];
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((path) =>
    path.endsWith(".ts"),
  );
  for (const file of files) {
    const source = readFileSync(join(SRC, file), "utf8");
    for (const match of source.matchAll(CALL)) {
      const message = argumentsAt(source, match.index + match[0].length)[1] ?? "";
      const text = message.replace(/\s+/g, " ").trim();
      const line = source.slice(0, match.index).split("\n").length;
      found.push({ file, line, text });
    }
  }
  return found;
}

describe("engine refusal texts (DIPO-418)", () => {
  it("reads the refusals of the engine's source", () => {
    const all = refusals();
    // The scan finds the calls and their texts: a scan that found none would pass anything.
    expect(all.length).toBeGreaterThan(100);
    const discard = all.filter((refusal) => refusal.file === join("run", "discard.ts"));
    expect(discard.some((refusal) => refusal.text.includes("so its box is in use"))).toBe(true);
  });

  it("names no contract command in a refusal text", () => {
    const naming = refusals()
      .filter((refusal) => COMMAND.test(refusal.text))
      .map((refusal) => `${refusal.file}:${refusal.line}: ${refusal.text}`);
    expect(naming).toEqual([]);
  });

  it("names the dipo command in every refusal that asks to send again", () => {
    const texts = refusals().map((refusal) => refusal.text);
    const has = (part: string) => texts.some((text) => text.includes(part));
    expect(has("send `dipo resume ` again once scheduling is back on")).toBe(true);
    expect(has("send `dipo resume --budget <amount> --yes` again")).toBe(true);
    expect(has("send `dipo park --note <text>` again")).toBe(true);
    expect(has("Send `dipo discard --note <text>` again")).toBe(true);
    const sendAgain = texts.filter((text) => /\bsend\b[^.;]*\bagain\b/i.test(text));
    expect(sendAgain.length).toBeGreaterThan(5);
    for (const text of sendAgain) expect(text).toMatch(/\bsend `dipo [^`]+` again/i);
  });

  it("would catch a refusal that names a contract command", () => {
    const source = [
      'new CommandError("x", `send work.resume again for ${office.officeId}`, { a: "story.park" })',
      'new LaneError("x", "office.open needs a path")',
      "new CommandError(CODE, `${story.id} waits` /* work.run */)",
      'new CommandError(CODE, f("a", "b"), "story.park")',
    ].join("\n");
    const texts = [...source.matchAll(CALL)].map(
      (match) => argumentsAt(source, match.index + match[0].length)[1] ?? "",
    );
    expect(texts.map((text) => COMMAND.test(text))).toEqual([true, true, false, false]);
    expect(texts[3]?.replace(/\s+/g, " ").trim()).toBe("a b");
  });
});
