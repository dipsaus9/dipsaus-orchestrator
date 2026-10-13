// Budgets (DIPO-47 AC #4 and #5, 0014 section 4): the story contract is never cut and over
// `prompt.contractMax` assembly fails with `prompt.contractTooLarge`; over the total cap sections
// drop in the order dependencies, background, context tail, inputs content, each with a marker.

import { describe, expect, it } from "bun:test";

import type { FieldBlock } from "@dipsaus-orchestrator/contract";

import type { ContextItem } from "../../src/context";
import { gateStoryFromView } from "../../src/gate";
import { contractCharacters } from "../../src/gate/rules";
import {
  assembleContract,
  assembleTaskMessage,
  CONTRACT_TOO_LARGE,
  contractSize,
  ContractTooLargeError,
  type PromptStory,
  type TaskBudgets,
} from "../../src/prompts";
import { BUDGETS_M, fixturePack, fixtureStory, plainTask } from "./helpers";

const FIELDS: FieldBlock = {
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
};

const lines = (count: number, prefix: string): string =>
  Array.from({ length: count }, (_, i) => `${prefix} line ${String(i + 1).padStart(4, "0")}`).join(
    "\n",
  );

function bigItem(index: number): ContextItem {
  const path = `src/big-${String(index).padStart(2, "0")}.ts`;
  return {
    path,
    text: `${lines(90, path)}\n`,
    reason: { kind: "scope-file", scope: path, content: "text", truncated: false },
  };
}

/** A story with long background and dependencies, a pack with many large items and inputs. */
function largeFixture(): { story: PromptStory; pack: ReturnType<typeof fixturePack> } {
  const base = fixtureStory();
  const story: PromptStory = {
    ...base,
    background: lines(80, "background"),
    dependencies: Array.from({ length: 40 }, (_, i) => ({
      id: `SHOP-${i + 100}`,
      title: `Dependency number ${i + 100}`,
      outcome: "it does a thing the story needs.",
    })),
  };
  const pack = fixturePack(Array.from({ length: 12 }, (_, i) => bigItem(i)));
  const inputItem = (n: number): ContextItem => ({
    path: `docs/input-${n}.md`,
    text: `${lines(60, `input ${n}`)}\n`,
    reason: { kind: "input-file", input: `docs/input-${n}.md`, content: "text", truncated: false },
  });
  return {
    story: { ...story, inputs: ["docs/input-1.md", "docs/input-2.md", "docs/input-3.md"] },
    pack: {
      ...pack,
      inputs: {
        paths: ["docs/input-1.md", "docs/input-2.md", "docs/input-3.md"],
        items: [inputItem(1), inputItem(2), inputItem(3)],
        usedChars: 0,
        truncated: false,
      },
    },
  };
}

const withCap = (taskMessage: number): TaskBudgets => ({ ...BUDGETS_M, taskMessage });

describe("story contract", () => {
  it("measures the contract on its own, the way R26 does", () => {
    const task = plainTask();
    const story = fixtureStory();
    expect(contractSize(story)).toBe(contractCharacters(gateStoryFromView(task, []), FIELDS));
    const big = fixtureStory({ references: Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`) });
    expect(contractSize(big)).toBeGreaterThan(contractSize(story));
  });

  it("fails with prompt.contractTooLarge naming the size and the limit", () => {
    const story = fixtureStory();
    const size = contractSize(story);
    expect(() => assembleContract(story, size)).not.toThrow();
    let thrown: unknown;
    try {
      assembleContract(story, size - 1);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContractTooLargeError);
    const error = thrown as ContractTooLargeError;
    expect(error.code).toBe(CONTRACT_TOO_LARGE);
    expect(error.code).toBe("prompt.contractTooLarge");
    expect(error.size).toBe(size);
    expect(error.limit).toBe(size - 1);
    expect(error.message).toBe(`story contract is ${size} characters; the limit is ${size - 1}`);
    expect(() =>
      assembleTaskMessage({
        story,
        pack: fixturePack(),
        budgets: BUDGETS_M,
        contractMax: size - 1,
      }),
    ).toThrow(ContractTooLargeError);
  });

  it("uses the 12,000 default for contractMax", () => {
    const long = fixtureStory({ implementationPlan: "x".repeat(12_001) });
    expect(() => assembleContract(long)).toThrow("the limit is 12000");
  });

  it("never cuts a contract section, even when the total cap is tiny", () => {
    const { story, pack } = largeFixture();
    const contract = assembleContract(story);
    const message = assembleTaskMessage({ story, pack, budgets: withCap(1_000) });
    expect(message.overCap).toBe(true);
    for (const section of contract) expect(message.text).toContain(section.text);
  });
});

describe("total cap", () => {
  it("fits without drops when the message is under the cap", () => {
    const { story, pack } = largeFixture();
    const message = assembleTaskMessage({ story, pack, budgets: withCap(1_000_000) });
    expect(message.dropped).toEqual([]);
    expect(message.text).toContain("SHOP-100 Dependency number 100");
  });

  it("drops dependencies first, then background, then the context tail, then inputs content", () => {
    const { story, pack } = largeFixture();
    const full = assembleTaskMessage({ story, pack, budgets: withCap(1_000_000) }).text.length;
    const sizes: number[] = [];
    const drops: string[] = [];
    // Shrink the cap step by step and record which drop each step needed first.
    for (let cap = full; cap > 0; cap -= 250) {
      const message = assembleTaskMessage({ story, pack, budgets: withCap(cap) });
      const last = message.dropped.at(-1);
      if (last !== undefined && drops.at(-1) !== last.section) drops.push(last.section);
      sizes.push(message.text.length);
      if (!message.overCap) expect(message.text.length).toBeLessThanOrEqual(cap);
    }
    expect(drops).toEqual(["dependencies", "background", "context", "inputs"]);
  });

  it("leaves a marker for each drop and keeps the input path list", () => {
    const { story, pack } = largeFixture();
    const message = assembleTaskMessage({ story, pack, budgets: withCap(3_000) });
    expect(message.dropped.map((drop) => drop.section)).toEqual([
      "dependencies",
      "background",
      "context",
      "inputs",
    ]);
    const text = message.text;
    expect(text).toContain(
      "[dipo: the dependency list was left out to keep the task message within its size limit; backlog/tasks/shop-12 - Add-a-greeting.md names them.]",
    );
    expect(text).toContain(
      "[dipo: the background was left out to keep the task message within its size limit; read it in backlog/tasks/shop-12 - Add-a-greeting.md only if you need it.]",
    );
    expect(text).toMatch(
      /\[dipo: the last \d+ context items? (was|were) left out to keep the task message within its size limit\.\]/,
    );
    expect(text).toMatch(
      /\[dipo: the last \d+ input files? (was|were) left out to keep the task message within its size limit\.\]/,
    );
    for (const input of ["docs/input-1.md", "docs/input-2.md", "docs/input-3.md"]) {
      expect(text).toContain(`- ${input}`);
    }
    expect(text).toContain("not shown for size; read it if you need it");
    expect(message.overCap).toBe(false);
    expect(text.length).toBeLessThanOrEqual(3_000);
  });

  it("drops context items from the tail, keeping the head", () => {
    const { story, pack } = largeFixture();
    const message = assembleTaskMessage({ story, pack, budgets: withCap(20_000) });
    const drop = message.dropped.find((step) => step.section === "context");
    expect(drop).toBeDefined();
    expect(message.text).toContain('<item path="src/greet.ts"');
    expect(message.text).not.toContain('<item path="src/big-11.ts"');
  });

  it("cuts background and dependencies within their own budgets with a marker", () => {
    const { story, pack } = largeFixture();
    const budgets = { ...withCap(1_000_000), background: 500, dependencies: 400 };
    const { text } = assembleTaskMessage({ story, pack, budgets });
    expect(text).toMatch(
      /\[dipo: truncated, showing [\d,]+ of [\d,]+ characters\. The full text is in backlog\/tasks\/shop-12 - Add-a-greeting\.md; read it only if the shown part is not enough\.\]/,
    );
    expect(text).toMatch(
      /\[dipo: list cut, showing [\d,]+ of [\d,]+ characters; .* names every dependency\.\]/,
    );
    const background = /<background>\n([\s\S]*?)\n<\/background>/.exec(text)?.[1] ?? "";
    expect(background.length).toBeLessThanOrEqual(500);
  });
});
