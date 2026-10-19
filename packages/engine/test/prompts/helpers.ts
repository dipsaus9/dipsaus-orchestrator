// Fixture story, dependencies and context pack for the prompt assembly tests, plus golden file
// comparison (`DIPO_UPDATE_GOLDEN=1` rewrites the files).

import { expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PlainTask } from "../../src/backlog/plain";
import type { ContextItem, ContextPack } from "../../src/context";
import { OFFICE_DEFAULTS } from "../../src/config";
import {
  taskBudgetsFor,
  promptStoryOf,
  type PromptStory,
  type TaskBudgets,
} from "../../src/prompts";

export const GOLDEN_DIR = join(import.meta.dir, "golden");

/** Compares `text` with the golden file `name`; `DIPO_UPDATE_GOLDEN=1` writes it instead. */
export async function expectGolden(name: string, text: string): Promise<void> {
  const path = join(GOLDEN_DIR, name);
  if (process.env["DIPO_UPDATE_GOLDEN"] === "1") await writeFile(path, text);
  expect(text).toBe(await readFile(path, "utf8"));
}

export function plainTask(overrides: Partial<PlainTask> = {}): PlainTask {
  return {
    file: "/repo/backlog/tasks/shop-12 - Add-a-greeting.md",
    id: "SHOP-12",
    title: "Add a greeting to the CLI",
    status: "Ready",
    type: "feature",
    assignee: [],
    created: "2026-10-12 09:00 (UTC)",
    labels: ["tier:M", "cli"],
    subtasks: [],
    references: ["src/greet.ts", "src/greet.test.ts"],
    documentation: ["docs/voice.md", "https://example.com/style"],
    dependencies: [{ id: "SHOP-3", state: "resolved", title: "Parse CLI flags", status: "Done" }],
    description: [
      "Outcome: `shop greet <name>` prints a friendly greeting in the shop's voice.",
      "",
      "Context: the greeting follows the tone guide. Customers asked for it in the last survey.",
      "",
      "```dipo",
      'branch: "SHOP-12/add-a-greeting"',
      "unknowns:",
      '  - q: "Should the greeting end with an exclamation mark?"',
      '    status: "resolved"',
      '    answer: "Yes, one."',
      '  - q: "Translate it?"',
      '    status: "open"',
      "test_plan:",
      "  entries:",
      '    - kind: "automated"',
      '      check: "(unit) greet returns the greeting for a name."',
      '    - kind: "manual"',
      '      check: "Run shop greet Ada."',
      '      expect: "It prints Hello, Ada!"',
      "```",
    ].join("\n"),
    acceptanceCriteria: [
      { index: 1, checked: false, text: "`shop greet Ada` prints `Hello, Ada!`." },
      { index: 2, checked: false, text: "An empty name exits with code 2 and a usage line." },
    ],
    definitionOfDone: [],
    implementationPlan: "Keep the greeting in one exported constant.",
    modifiedFiles: [],
    comments: [],
    unknown: [],
    ...overrides,
  };
}

export const DEPENDENCY: PlainTask = plainTask({
  id: "SHOP-3",
  title: "Parse CLI flags",
  description: "Outcome: the CLI reads its flags into one typed object.\n",
  dependencies: [],
});

export function fixtureStory(overrides: Partial<PlainTask> = {}): PromptStory {
  const task = plainTask(overrides);
  return promptStoryOf(task, {
    dependencies: [DEPENDENCY],
    fields: {
      unknowns: [
        {
          q: "Should the greeting end with an exclamation mark?",
          status: "resolved",
          answer: "Yes, one.",
        },
        { q: "Translate it?", status: "open" },
      ],
      test_plan: {
        entries: [
          { kind: "automated", check: "(unit) greet returns the greeting for a name." },
          { kind: "manual", check: "Run shop greet Ada.", expect: "It prints Hello, Ada!" },
        ],
      },
    },
    taskFile: "backlog/tasks/shop-12 - Add-a-greeting.md",
  });
}

const scopeFile: ContextItem = {
  path: "src/greet.ts",
  text: "export const greeting = (name: string) => `Hi ${name}`;\n",
  reason: { kind: "scope-file", scope: "src/greet.ts", content: "text", truncated: false },
};

export function fixturePack(extra: readonly ContextItem[] = []): ContextPack {
  return {
    items: [
      scopeFile,
      {
        path: "src/greet.test.ts",
        text: "src/cli.ts\nsrc/greet.ts\n",
        reason: {
          kind: "scope-new",
          scope: "src/greet.test.ts",
          parent: "src",
          shown: 2,
          total: 2,
        },
      },
      {
        path: "cli",
        text: "src/cli.ts\nsrc/greet.ts\n",
        reason: {
          kind: "component",
          name: "cli",
          purpose: "The command line.",
          via: "scope",
          shown: 2,
          total: 2,
        },
      },
      ...extra,
    ],
    usedChars: 0,
    truncated: false,
    provenance: {
      provider: "default",
      version: "2",
      indexState: "ready",
      staleFiles: [],
      notes: [],
    },
    inputs: {
      paths: ["docs/voice.md", "https://example.com/style"],
      items: [
        {
          path: "docs/voice.md",
          text: "# Voice\n\nWarm, short, one exclamation mark at most.\n",
          reason: { kind: "input-file", input: "docs/voice.md", content: "text", truncated: false },
        },
        {
          path: "https://example.com/style",
          text: "",
          reason: { kind: "input-url", input: "https://example.com/style" },
        },
      ],
      usedChars: 0,
      truncated: false,
    },
    blobIds: {},
  };
}

export const BUDGETS_M: TaskBudgets = taskBudgetsFor(OFFICE_DEFAULTS.prompt.budgets, "M");
