// The key table (DIPO-308; 0009 sections 5 and 6): a desk row offers a key only for a command its
// `actions` lists and the engine's flags allow, `y` and `n` accept and dismiss a PROPOSAL row, a
// key an earlier action of the row took or a command no entry binds shows its command line, and
// the detail and the queue get steer, pause, hold and drop from the same table.

import { describe, expect, it } from "bun:test";

import type { DeskItem } from "@dipsaus-orchestrator/contract";

import { KEY_TABLE, rowKeys, viewKeys } from "./keys";

const FLAGS = ["work.intervene", "review", "proposals", "test.sessions"];

function row(item: Partial<DeskItem>): DeskItem {
  return {
    kind: "PARKED",
    story: "DIPO-1",
    key: "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C01",
    question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0Q01",
    gate: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0G01",
    proposal: { id: "ab".repeat(32), kind: "follow-up", title: "t" },
    detail: "d",
    since: "2026-10-14T10:00:00.000Z",
    blocks: [],
    actions: [],
    ...item,
  } as DeskItem;
}

/** The desk action that offers `command`, with a command line of its answer form. */
function actionFor(id: string, command: string) {
  if (id === "allow") return { command, cli: "dipo answer q allow" };
  if (id === "deny") return { command, cli: 'dipo answer q deny "<reason>"' };
  if (id === "answer") return { command, cli: 'dipo answer q --text "<answer>"' };
  return { command, cli: `dipo ${command}` };
}

describe("the key table", () => {
  const desk = KEY_TABLE.filter((entry) => entry.views.includes("desk"));

  it("offers each desk command's key only on a row whose actions list it", () => {
    for (const entry of desk) {
      const listed = row({ actions: [actionFor(entry.id, entry.command)] });
      expect(rowKeys(listed, FLAGS).bound.map((bound) => bound.binding.id)).toEqual([entry.id]);
      const others = desk
        .filter((other) => other.command !== entry.command)
        .map((other) => actionFor(other.id, other.command));
      const without = rowKeys(row({ actions: others }), FLAGS);
      expect(without.bound.map((bound) => bound.binding.id)).not.toContain(entry.id);
    }
  });

  it("offers a key only while the engine reports its capability flag", () => {
    for (const entry of desk.filter((candidate) => candidate.flag !== null)) {
      const listed = row({ actions: [actionFor(entry.id, entry.command)] });
      const flags = FLAGS.filter((flag) => flag !== entry.flag);
      const keys = rowKeys(listed, flags);
      expect(keys.bound).toEqual([]);
      // Not offered as a key, it shows as the command line to type.
      expect(keys.unbound.map((action) => action.command)).toEqual([entry.command]);
    }
  });

  it("binds y to accept and n to dismiss on a PROPOSAL row", () => {
    const keys = rowKeys(
      row({
        kind: "PROPOSAL",
        actions: [
          { command: "proposal.accept", cli: "dipo propose accept ab" },
          { command: "proposal.dismiss", cli: "dipo propose dismiss ab" },
        ],
      }),
      FLAGS,
    );
    expect(keys.bound.map((bound) => [bound.binding.key, bound.binding.id])).toEqual([
      ["y", "accept"],
      ["n", "dismiss"],
    ]);
  });

  it("shows the command line of an action no entry binds, or whose key the row gave already", () => {
    const keys = rowKeys(
      row({
        actions: [
          { command: "work.reassign", cli: "dipo reassign DIPO-1" },
          { command: "gate.reject", cli: 'dipo reject DIPO-1 --note "<why>"' },
          { command: "work.answer", cli: 'dipo answer q deny "<reason>"' },
        ],
      }),
      FLAGS,
    );
    expect(keys.bound.map((bound) => bound.binding.id)).toEqual(["reject"]);
    expect(keys.unbound.map((action) => action.cli)).toEqual([
      "dipo reassign DIPO-1",
      'dipo answer q deny "<reason>"',
    ]);
  });

  it("gives the detail steer and pause and the queue hold and drop, behind their flags", () => {
    expect(viewKeys("detail", FLAGS).map((entry) => entry.key)).toEqual(["s", "p"]);
    expect(viewKeys("detail", [])).toEqual([]);
    expect(viewKeys("queue", []).map((entry) => entry.key)).toEqual(["h", "d"]);
  });
});
