// Which actions confirm comes from the command definitions, as in the CLI (DIPO-320): `confirm`
// asks yes or no, `irreversible` and `irreversibleWhen` list what is lost and ask for the typed id.

import { describe, expect, it } from "bun:test";

import { findCommand, type OfficeId } from "@dipsaus-orchestrator/contract";

import { confirmSteps, startFlow } from "./actions";
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
      proposal: "prp_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D",
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
