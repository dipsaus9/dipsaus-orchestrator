// Claude specifics stay in the adapter (0004, 0008; DIPO-318 AC #8): outside
// `packages/engine/src/workers/claude-cli/`, no engine source file (code, comments, prompts,
// data) names a Claude Code tool or a Claude model alias. Full model ids such as
// `claude-sonnet-4-5` (the price catalogs, usage keys) are not aliases. One written exception: the
// office configuration's defaults name the tier and scan models by alias, because the office
// writes its models in `.dipo/office.yaml` and Claude names stay in the office config for now
// (simplification audit of 2026-10-24, decision 4).

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const ADAPTER = "workers/claude-cli/";

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
/** The tool names that are no English word, so they count unquoted too. */
const DISTINCT = TOOLS.filter((tool) => /[a-z][A-Z]/.test(tool));
const QUOTED_TOOL = new RegExp(`["'\`](${TOOLS.join("|")})["'\`]`);
const BARE_TOOL = new RegExp(`\\b(${DISTINCT.join("|")})\\b`);
const MODEL_ALIAS = /(?<!claude-)\b(haiku|sonnet|opus)\b/i;
/** Files that may name model aliases, and why (above). */
const ALIAS_EXCEPTIONS = new Set(["config/schema.ts"]);

function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(ts|md|json|ya?ml)$/.test(path) && !path.endsWith(".test.ts"))
    .filter((path) => !path.startsWith(ADAPTER))
    .toSorted();
}

describe("Claude names outside the adapter (DIPO-318)", () => {
  it("finds the engine's sources and the adapter's own tool list", () => {
    expect(sources().length).toBeGreaterThan(100);
    const adapter = readFileSync(join(SRC, ADAPTER, "tools.ts"), "utf8");
    expect(QUOTED_TOOL.test(adapter)).toBe(true);
  });

  it("are neither tool names nor model aliases", () => {
    const found: string[] = [];
    for (const path of sources()) {
      readFileSync(join(SRC, path), "utf8")
        .split("\n")
        .forEach((line, index) => {
          const tool = QUOTED_TOOL.test(line) || BARE_TOOL.test(line);
          const alias = MODEL_ALIAS.test(line) && !ALIAS_EXCEPTIONS.has(path);
          if (tool || alias) found.push(`${path}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });
});
