// The single write path (DIPO-29; 0010 section 3) against a scripted CLI: view, parse, change,
// splice, re-read, `task edit --description`, read back and compare. A description changed since
// the read is parsed again and the change reapplied. Labels change only with --add-label and
// --remove-label.

import { describe, expect, it } from "bun:test";

import type { FieldBlock } from "@dipsaus-orchestrator/contract";

import { editLabels, FieldWriteError, writeFields, type StoryTarget } from "../../src/backlog";
import { FieldBlockError, parseFieldBlock, spliceFieldBlock } from "../../src/story-store";
import { scriptedSpawn, viewOutput } from "./helpers";

const ID = "TASK-4";
const BEFORE = "Outcome: the export reports how many rows it wrote.\n\nSome  context. ";
const BLOCK = '```dipo\nbranch: "TASK-4/count-rows"\nunknowns: []\n```';
const PARK = { reason: "on-hold", from: "Ready", note: "Waiting for Bun 1.4.3" } as const;

const park = (fields: FieldBlock): FieldBlock => ({ ...fields, park: PARK });

/** A fake CLI holding one task; `onView(n)` runs before the n-th view (1-based) is answered. */
function fakeCli(
  description: string,
  options: {
    labels?: string[];
    onView?: (n: number, store: { description: string }) => void;
    storeEdit?: (written: string) => string;
  } = {},
) {
  const store = { description, labels: [...(options.labels ?? [])] };
  const commands: string[][] = [];
  let views = 0;
  const stub = scriptedSpawn((args) => {
    commands.push([...args]);
    const [, sub] = args;
    if (sub === "view") {
      views++;
      options.onView?.(views, store);
      return { stdout: viewOutput(ID, store.description, store.labels) };
    }
    if (sub === "edit") {
      for (let i = 3; i < args.length; i += 2) {
        const [option, value = ""] = [args[i], args[i + 1]];
        if (option === "--description") {
          store.description = (options.storeEdit ?? ((text) => text.trim()))(value);
        } else if (option === "--add-label") store.labels.push(value);
        else if (option === "--remove-label") {
          store.labels = store.labels.filter((label) => label !== value);
        }
      }
      return {};
    }
    return { code: 1, stderr: "unexpected" };
  });
  const target: StoryTarget = { cli: { spawn: stub.spawn }, cwd: "/office", id: ID };
  return { store, commands, target };
}

const subs = (commands: readonly string[][]) => commands.map((args) => args[1]);

describe("writeFields", () => {
  it("views, re-reads, writes the spliced description and reads it back", async () => {
    const original = `${BEFORE}\n\n${BLOCK}`;
    const cli = fakeCli(original);
    const stored = await writeFields(cli.target, park);

    expect(stored).toEqual({ branch: "TASK-4/count-rows", unknowns: [], park: PARK });
    expect(subs(cli.commands)).toEqual(["view", "view", "edit", "view"]);
    const edit = cli.commands[2] ?? [];
    expect(edit.slice(0, 4)).toEqual(["task", "edit", ID, "--description"]);
    expect(edit[4]).toBe(spliceFieldBlock(original, stored));
    expect(cli.store.description.startsWith(`${BEFORE}\n\n\`\`\`dipo\n`)).toBe(true);
    expect(parseFieldBlock(cli.store.description).fields).toEqual(stored);
  });

  it("writes NFD text outside the block back unchanged", async () => {
    const nfd = `Outcome: the café export writes every röw.\n\n${BLOCK}`;
    const cli = fakeCli(nfd);
    await writeFields(cli.target, park);
    const written = cli.commands[2]?.[4] ?? "";
    expect(written.startsWith("Outcome: the café export writes every röw.\n\n```dipo\n")).toBe(
      true,
    );
    expect(written).toBe(spliceFieldBlock(nfd, { ...parseFieldBlock(nfd).fields, park: PARK }));
  });

  it("appends a block to a description without one", async () => {
    const cli = fakeCli(BEFORE.trim());
    await writeFields(cli.target, park);
    expect(cli.store.description).toBe(
      `${BEFORE.trim()}\n\n\`\`\`dipo\npark:\n  reason: "on-hold"\n  from: "Ready"\n  note: "Waiting for Bun 1.4.3"\n\`\`\``,
    );
  });

  it("parses again and reapplies the change when the description changed since the read", async () => {
    const original = `${BEFORE}\n\n${BLOCK}`;
    const changed = `${BEFORE}\n\nA line another writer added.\n\n${BLOCK.replace("unknowns: []", 'unknowns:\n  - q: "Why?"\n    status: "open"')}`;
    const cli = fakeCli(original, {
      onView: (n, store) => {
        if (n === 2) store.description = changed;
      },
    });
    const seen: FieldBlock[] = [];
    const stored = await writeFields(cli.target, (fields) => {
      seen.push(fields);
      return park(fields);
    });

    expect(seen).toEqual([
      { branch: "TASK-4/count-rows", unknowns: [] },
      { branch: "TASK-4/count-rows", unknowns: [{ q: "Why?", status: "open" }] },
    ]);
    expect(subs(cli.commands)).toEqual(["view", "view", "view", "edit", "view"]);
    expect(cli.commands[3]?.[4]).toBe(spliceFieldBlock(changed, stored));
    expect(stored.unknowns).toEqual([{ q: "Why?", status: "open" }]);
    expect(stored.park).toEqual(PARK);
  });

  it("gives up when the description keeps changing between reads", async () => {
    const cli = fakeCli(BEFORE, {
      onView: (n, store) => {
        store.description = `${BEFORE} ${n}`;
      },
    });
    await expect(writeFields(cli.target, park)).rejects.toThrow(FieldWriteError);
    expect(subs(cli.commands)).not.toContain("edit");
  });

  it("writes nothing when the value does not change", async () => {
    const cli = fakeCli(`${BEFORE}\n\n${BLOCK}`);
    expect(await writeFields(cli.target, (fields) => ({ ...fields }))).toEqual({
      branch: "TASK-4/count-rows",
      unknowns: [],
    });
    expect(subs(cli.commands)).toEqual(["view"]);
  });

  it("fails when the description read back differs from the one written", async () => {
    const cli = fakeCli(BEFORE, { storeEdit: (text) => text.replace("Some", "Same") });
    await expect(writeFields(cli.target, park)).rejects.toThrow("read back differs");
  });

  it("fails R02 without writing when the description's block does not parse", async () => {
    const cli = fakeCli(`${BEFORE}\n\n${BLOCK}\n\ntrailing text`);
    await expect(writeFields(cli.target, park)).rejects.toThrow(FieldBlockError);
    expect(subs(cli.commands)).toEqual(["view"]);
  });

  it("refuses a target value that fails the schema", async () => {
    const cli = fakeCli(BEFORE);
    await expect(writeFields(cli.target, () => ({ branch: "not a branch" }))).rejects.toThrow();
    expect(subs(cli.commands)).toEqual(["view"]);
  });

  it("writes a draft with `draft view` and `draft edit`", async () => {
    const cli = fakeCli(BEFORE);
    await writeFields({ ...cli.target, kind: "draft" }, park);
    expect(cli.commands.map((args) => args[0])).toEqual(["draft", "draft", "draft", "draft"]);
  });
});

describe("editLabels", () => {
  it("adds and removes labels with --add-label and --remove-label only, and reads them back", async () => {
    const cli = fakeCli(BEFORE, { labels: ["tier:S", "docs"] });
    const labels = await editLabels(cli.target, {
      add: ["tier:M", "test-before-merge"],
      remove: ["tier:S"],
    });
    expect(cli.commands[0]).toEqual([
      "task",
      "edit",
      ID,
      "--add-label",
      "tier:M",
      "--add-label",
      "test-before-merge",
      "--remove-label",
      "tier:S",
    ]);
    expect(labels).toMatchObject({ tiers: ["M"], testBeforeMerge: true, other: ["docs"] });
  });

  it("fails when the labels read back differ", async () => {
    const cli = fakeCli(BEFORE);
    cli.store.labels = [];
    const target: StoryTarget = {
      ...cli.target,
      cli: {
        spawn: scriptedSpawn((args) => ({
          stdout: args[1] === "view" ? viewOutput(ID, BEFORE, []) : "",
        })).spawn,
      },
    };
    await expect(editLabels(target, { add: ["tier:M"] })).rejects.toThrow(
      "labels read back differ",
    );
  });
});
