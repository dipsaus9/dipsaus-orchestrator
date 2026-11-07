// The key table (DIPO-308; 0009): a desk row offers a key only for a command its
// `actions` lists and the engine's flags allow, `y` and `n` accept and dismiss an IDEA row and `n`
// dismisses a DECISION NOTE row (DIPO-454), a key an earlier action of the row took or a command no
// entry binds shows its command line, and the detail and the queue get steer, park and drop from
// the same table.

import { describe, expect, it } from "bun:test";

import type { DeskItem } from "@dipsaus-orchestrator/contract";

import { KEY_TABLE, rowKeys, viewKeys } from "./keys";

const CARD = {
  id: "ab".repeat(32),
  origin: "proposal",
  title: "t",
  found: "f",
  evidence: [{ file: "src/a.ts", line: 1 }],
  storyLine: "s",
  proposed: "p",
  why: "w",
  serves: "m-3",
};

function row(item: Partial<DeskItem>): DeskItem {
  return {
    kind: "PARKED",
    story: "DIPO-1",
    key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C01",
    question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0Q01",
    gate: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0G01",
    idea: CARD,
    note: {
      id: "cd".repeat(32),
      file: "docs/decisions/0020-park-and-resume.md",
      section: "s",
      text: "t",
    },
    detail: "d",
    since: "2026-10-14T10:00:00.000Z",
    blocks: [],
    actions: [],
    ...item,
  } as DeskItem;
}

/** The desk action that offers `command`. */
function actionFor(id: string, command: string) {
  if (id === "answer") return { command, cli: 'dipo answer q --text "<answer>"' };
  return { command, cli: `dipo ${command}` };
}

describe("the key table", () => {
  const desk = KEY_TABLE.filter((entry) => entry.views.includes("desk"));

  it("offers each desk command's key only on a row whose actions list it", () => {
    for (const entry of desk) {
      const listed = row({ actions: [actionFor(entry.id, entry.command)] });
      expect(rowKeys(listed).bound.map((bound) => bound.binding.id)).toEqual([entry.id]);
      const others = desk
        .filter((other) => other.command !== entry.command)
        .map((other) => actionFor(other.id, other.command));
      const without = rowKeys(row({ actions: others }));
      expect(without.bound.map((bound) => bound.binding.id)).not.toContain(entry.id);
    }
  });

  it("binds y to accept and n to dismiss on an IDEA row, and n to dismiss on a DECISION NOTE row", () => {
    const keys = rowKeys(
      row({
        kind: "IDEA",
        actions: [
          { command: "idea.accept", cli: "dipo idea accept ab" },
          { command: "idea.dismiss", cli: "dipo idea dismiss ab" },
        ],
      }),
    );
    expect(keys.bound.map((bound) => [bound.binding.key, bound.binding.id])).toEqual([
      ["y", "accept"],
      ["n", "dismiss"],
    ]);
    const note = rowKeys(
      row({
        kind: "DECISION NOTE",
        actions: [{ command: "note.dismiss", cli: "dipo note dismiss cd" }],
      }),
    );
    expect(note.bound.map((bound) => [bound.binding.key, bound.binding.id])).toEqual([
      ["n", "dismissNote"],
    ]);
    // The old proposal commands bind no key.
    expect(KEY_TABLE.some((entry) => entry.command.startsWith("proposal."))).toBe(false);
  });

  it("has i for the quick idea, sent with idea.quick (DIPO-454)", () => {
    expect(KEY_TABLE.find((entry) => entry.id === "idea")).toMatchObject({
      command: "idea.quick",
      key: "i",
    });
  });

  it("shows the command line of an action no entry binds, or whose key the row gave already", () => {
    const keys = rowKeys(
      row({
        actions: [
          { command: "work.run", cli: "dipo run DIPO-1" },
          { command: "gate.reject", cli: 'dipo reject DIPO-1 --note "<why>"' },
          { command: "idea.dismiss", cli: "dipo idea dismiss ab" },
        ],
      }),
    );
    // `n` rejects the merge; the dismiss that would take it too shows its command line.
    expect(keys.bound.map((bound) => bound.binding.id)).toEqual(["reject"]);
    expect(keys.unbound.map((action) => action.cli)).toEqual([
      "dipo run DIPO-1",
      "dipo idea dismiss ab",
    ]);
  });

  it("gives the detail steer and park and the queue park and drop", () => {
    expect(viewKeys("detail").map((entry) => entry.key)).toEqual(["P", "s"]);
    expect(viewKeys("queue").map((entry) => entry.key)).toEqual(["P", "d"]);
  });
});
