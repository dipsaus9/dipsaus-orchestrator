// Which actions confirm comes from the command definitions, as in the CLI (DIPO-320): `confirm`
// asks yes or no, `irreversible` and `irreversibleWhen` list what is lost and ask for the typed id.

import { describe, expect, it } from "bun:test";

import { findCommand, type OfficeId } from "@dipsaus-orchestrator/contract";

import { confirmSteps, requestOf, shareChosen, startFlow, TOP_UPS } from "./actions";
import { KEY_TABLE } from "./keys";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;
/** Definition lookups that mark every command as asking first, and as irreversible. */
const confirming = () => ({ confirm: true, irreversible: false });
const irreversible = () => ({ confirm: true, irreversible: true });

const kinds = (steps: readonly { readonly kind: string }[]) => steps.map((step) => step.kind);

describe("confirmations from the command definitions", () => {
  it("ask for every action what its command's definition asks for", () => {
    for (const binding of KEY_TABLE) {
      const definition = findCommand(binding.command);
      if (definition === undefined) throw new Error(`no definition of ${binding.command}`);
      const expected = definition.irreversible
        ? ["losses", "typed"]
        : definition.confirm
          ? ["yesno"]
          : [];
      expect({ action: binding.id, steps: kinds(confirmSteps(binding.id, "DIPO-7")) }).toEqual({
        action: binding.id,
        steps: expected,
      });
    }
  });

  it("make drop irreversible only with deleteBranch, as irreversibleWhen says", () => {
    expect(findCommand("story.drop")?.irreversibleWhen).toEqual(["deleteBranch"]);
    expect(kinds(confirmSteps("drop", "DIPO-7", { deleteBranch: true }))).toEqual([
      "losses",
      "typed",
    ]);
    expect(kinds(confirmSteps("drop", "DIPO-7", { deleteBranch: false }))).toEqual(["yesno"]);
  });

  it("put the confirmations in the flows: reject before its note, discard after it", () => {
    const target = { story: "DIPO-7", gate: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" };
    const reject = startFlow("reject", OFFICE, target);
    expect(kinds(reject.steps)).toEqual(["yesno", "text"]);
    expect(reject.steps[0]).toEqual({
      kind: "yesno",
      question: "Reject the merge of DIPO-7? Its note goes to the worker as a fix item.",
    });
    expect(kinds(startFlow("discard", OFFICE, target).steps)).toEqual(["text", "losses", "typed"]);
    // `story.park` has no `confirm`: its flow asks only for the note.
    expect(kinds(startFlow("park", OFFICE, target).steps)).toEqual(["text"]);
  });

  it("asks in every flow once a definition gains confirm or irreversible", () => {
    const target = {
      story: "DIPO-7",
      gate: "gat_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
      question: "qst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
      note: "cd".repeat(32),
      idea: "ab".repeat(32),
      test: "tst_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
    };
    for (const binding of KEY_TABLE) {
      const asked = kinds(startFlow(binding.id, OFFICE, target, confirming).steps);
      // Drop's keep-or-delete prompt is its yes or no.
      expect({
        action: binding.id,
        asks: asked.includes("yesno") || asked.includes("drop"),
      }).toEqual({ action: binding.id, asks: true });
      const typed = kinds(startFlow(binding.id, OFFICE, target, irreversible).steps);
      expect({ action: binding.id, last: typed.at(-1) }).toEqual({
        action: binding.id,
        last: "typed",
      });
    }
  });
});

/** A resume flow for the engine's command line of a park reason (0020's table, `desk.ts`). */
function resume(cli: string) {
  return startFlow("resume", OFFICE, { story: "DIPO-7", cli });
}

describe("the resume prompt asks only for what the park reason needs (spec.md, PARKED)", () => {
  it("is the top-up of +25% +50% +100% with its note for budget-exceeded, at the line's share", () => {
    const flow = resume('dipo resume DIPO-7 --budget +50% --note "<why>"');
    expect(flow.steps).toEqual([{ kind: "topup", noteRequired: true }]);
    expect(TOP_UPS).toEqual([25, 50, 100]);
    expect(shareChosen(flow)).toBe(50);
    expect(flow.caps).toBeNull();
  });

  it("is a required direction for review-blocked, and the answer for ambiguous-spec", () => {
    expect(resume('dipo resume DIPO-7 --note "<direction>"').steps).toEqual([
      { kind: "text", field: "note", label: "direction" },
    ]);
    expect(resume('dipo resume DIPO-7 --note "<answer>"').steps).toEqual([
      { kind: "text", field: "note", label: "answer" },
    ]);
  });

  it("is an optional note, prefilled with the failing check, for verify-failing and the like", () => {
    const flow = startFlow("resume", OFFICE, {
      story: "DIPO-7",
      cli: "dipo resume DIPO-7",
      prefill: "bun run verify → 2 shards failed",
    });
    expect(flow.steps).toEqual([{ kind: "text", field: "note", label: "note", optional: true }]);
    expect(flow.draft).toBe("bun run verify → 2 shards failed");
  });

  it("sends the top-up unconfirmed until its caps showed, then confirmed", () => {
    const flow = resume('dipo resume DIPO-7 --budget +50% --note "<why>"');
    const asked = requestOf({ ...flow, values: { ...flow.values, note: "room" } }, "r1" as never);
    expect(asked).toMatchObject({
      command: "work.resume",
      args: { story: "DIPO-7", note: "room", budget: { share: 50 } },
      confirmed: false,
    });
    const confirmed = requestOf(
      { ...flow, values: { ...flow.values, note: "room", confirmed: true } },
      "r2" as never,
    );
    expect(confirmed.confirmed).toBe(true);
  });

  it("reads a drop's losses first, then asks keep or delete the branch", () => {
    expect(kinds(startFlow("drop", OFFICE, { story: "DIPO-7" }).steps)).toEqual(["losses", "drop"]);
  });
});
