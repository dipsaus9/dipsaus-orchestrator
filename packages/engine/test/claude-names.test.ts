// Claude specifics stay in the adapter (0004, 0008; DIPO-318 AC #8): outside
// `packages/engine/src/workers/claude-cli/`, no source file of any package (code, comments, prompts,
// data) names a Claude Code tool or a Claude model alias. Code is read for quoted tool names and
// for the tool names that are no English word; prose (Markdown and comments) also for the
// capitalised tool names where they stand as tools: in a list of two or more, after `[tool] `, in
// backticks or before a permission rule's parenthesis. Full model ids such as `claude-sonnet-4-5`
// (the price catalogs, usage keys) are not aliases. One written exception: the office
// configuration's defaults (`OFFICE_DEFAULTS` in `config/schema.ts`) name the tier and scan
// models by alias, because the office writes its models in `.dipo/office.yaml` and Claude names
// stay in the office config for now (simplification audit of 2026-10-24, decision 4).

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = join(import.meta.dir, "..", "..");
const ADAPTER = "engine/src/workers/claude-cli/";

/** Claude Code's tool names; a quoted one is a tool name wherever it stands. */
const TOOLS = [
  "Agent",
  "Bash",
  "BashOutput",
  "Edit",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "LS",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "Read",
  "Skill",
  "SlashCommand",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
];
const NAME = `(?:${TOOLS.join("|")})`;
/** The tool names that are no English word, so they count unquoted too. */
const DISTINCT = TOOLS.filter((tool) => /[a-z][A-Z]/.test(tool));
const QUOTED_TOOL = new RegExp(`["'\`]${NAME}["'\`]`);
const BARE_TOOL = new RegExp(`\\b(?:${DISTINCT.join("|")})\\b`);
/** In prose: a list of tool names, a tool line, a backticked name or a permission rule. */
const PROSE_TOOL = new RegExp(
  `\\b${NAME}(?:, ${NAME})*,? (?:and|or) ${NAME}\\b|\\[tool\\] ${NAME}\\b|\`${NAME}\`|\\b${NAME}\\(`,
);
const MODEL_ALIAS = /(?<!claude-)\b(haiku|sonnet|opus)\b/i;

/** Every source file of every package (`<package>/src/...`), the adapter's own left out. */
function sources(): string[] {
  return readdirSync(PACKAGES)
    .flatMap((name) => {
      try {
        return readdirSync(join(PACKAGES, name, "src"), { recursive: true, encoding: "utf8" }).map(
          (path) => `${name}/src/${path}`,
        );
      } catch {
        return [];
      }
    })
    .filter((path) => /\.(tsx?|md|json|ya?ml)$/.test(path) && !/\.test\.tsx?$/.test(path))
    .filter((path) => !path.startsWith(ADAPTER))
    .toSorted();
}

/** The prose of a line: the whole line of Markdown, else its comment. */
function prose(path: string, line: string): string {
  if (path.endsWith(".md")) return line;
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return line;
  const comment = line.indexOf("// ");
  return comment === -1 ? "" : line.slice(comment);
}

/** The line numbers of `OFFICE_DEFAULTS`, the one place model aliases may stand. */
function defaultsBlock(text: string): { readonly from: number; readonly to: number } {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => line.startsWith("export const OFFICE_DEFAULTS"));
  const to = lines.findIndex((line, index) => index > from && line === "};");
  return { from: from + 1, to: to + 1 };
}

describe("Claude names outside the adapter (DIPO-318)", () => {
  it("finds every package's sources, and the adapter's own tool list", () => {
    const all = sources();
    expect(all.length).toBeGreaterThan(300);
    for (const name of ["contract", "client", "tui", "cli", "daemon", "testkit"]) {
      expect(all.some((path) => path.startsWith(`${name}/src/`))).toBe(true);
    }
    const adapter = readFileSync(join(PACKAGES, ADAPTER, "tools.ts"), "utf8");
    expect(QUOTED_TOOL.test(adapter)).toBe(true);
    expect(PROSE_TOOL.test("Your tools are Read, Grep and Glob")).toBe(true);
    expect(PROSE_TOOL.test("`[tool] Bash bun test`")).toBe(true);
    expect(PROSE_TOOL.test("Read the outcome first, then Write the tests")).toBe(false);
  });

  it("are neither tool names nor model aliases", () => {
    const found: string[] = [];
    for (const path of sources()) {
      const text = readFileSync(join(PACKAGES, path), "utf8");
      const defaults =
        path === "engine/src/config/schema.ts" ? defaultsBlock(text) : { from: 0, to: -1 };
      text.split("\n").forEach((line, index) => {
        const number = index + 1;
        const tool =
          QUOTED_TOOL.test(line) || BARE_TOOL.test(line) || PROSE_TOOL.test(prose(path, line));
        const inDefaults = number >= defaults.from && number <= defaults.to;
        const alias = MODEL_ALIAS.test(line) && !inDefaults;
        if (tool || alias) found.push(`${path}:${number}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
