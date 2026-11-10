// A planning proposal as text the maintainer edits in the planning view's input (DIPO-450), and
// back. One field per line as `name: value`; a list as `name:` followed by `- item` lines; the
// context as `context:` followed by lines indented two spaces; the test plan as
// `- automated: <check>` and `- manual: <check> => <expected>` lines, or `testPlan: not applicable:
// <reason>`. A split's fields carry the prefix `edit.` or `story.`. Lines starting with `#` are
// notes. The kind and the edited story's id (or the refined or dropped draft's) are kept from the
// proposal, never edited. The engine
// checks the result as it checks the session's (`planning.edit`), so the form checks only its own
// syntax.

import type { PlanningProposal, PlanningTestPlan } from "@dipsaus-orchestrator/contract";

const LIST_FIELDS: ReadonlySet<string> = new Set(["criteria", "references", "dependencies"]);
const NOT_APPLICABLE = "not applicable: ";
const EXPECT = " => ";

type Fields = Readonly<Record<string, unknown>>;

/** The lines of one object's fields, each name with `prefix`. */
function fieldLines(fields: Fields, prefix: string): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const key = `${prefix}${name}`;
    if (name === "testPlan") {
      const plan = value as PlanningTestPlan;
      if ("notApplicable" in plan) {
        lines.push(`${key}: ${NOT_APPLICABLE}${plan.notApplicable}`);
      } else {
        lines.push(`${key}:`);
        for (const entry of plan.entries) {
          lines.push(
            `- ${entry.kind}: ${entry.check}${entry.expect === undefined ? "" : `${EXPECT}${entry.expect}`}`,
          );
        }
      }
    } else if (Array.isArray(value)) {
      lines.push(`${key}:`, ...value.map((item) => `- ${String(item)}`));
    } else if (name === "context") {
      lines.push(
        `${key}:`,
        ...String(value)
          .split("\n")
          .map((line) => `  ${line}`),
      );
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines;
}

/** The proposal's own subject, kept from the form: the task an edit or split names, the draft a refine or drop names (DIPO-454). */
function subjectOf(
  proposal: PlanningProposal,
): { readonly key: "id" | "draft"; readonly value: string } | null {
  switch (proposal.kind) {
    case "edit":
    case "split":
      return { key: "id", value: proposal.id };
    case "refine":
    case "drop":
      return { key: "draft", value: proposal.draft };
    default:
      return null;
  }
}

/** Pure: `proposal` as the form the maintainer edits. */
export function proposalForm(proposal: PlanningProposal): string {
  const subject = subjectOf(proposal);
  const head = [
    `# ${proposal.kind}${subject === null ? "" : ` ${subject.value}`}: edit the fields, then Enter`,
  ];
  if (proposal.kind === "split") {
    const { kind: _kind, id: _id, edit, story, ...rest } = proposal;
    return [
      ...head,
      ...fieldLines(rest, ""),
      ...fieldLines(edit, "edit."),
      ...fieldLines(story, "story."),
    ].join("\n");
  }
  const { kind: _kind, ...rest } = proposal;
  const fields: Record<string, unknown> = { ...rest };
  delete fields.id;
  delete fields.draft;
  return [...head, ...fieldLines(fields, "")].join("\n");
}

/** The test plan a form's lines give, or why they give none. */
function testPlanOf(scalar: string | null, items: readonly string[]): PlanningTestPlan | string {
  if (scalar !== null) {
    if (!scalar.startsWith(NOT_APPLICABLE)) {
      return `testPlan: write "${NOT_APPLICABLE}<reason>", or one "- automated: ..." line per entry`;
    }
    return { notApplicable: scalar.slice(NOT_APPLICABLE.length).trim() };
  }
  const entries: { kind: "automated" | "manual"; check: string; expect?: string }[] = [];
  for (const item of items) {
    const match = /^(automated|manual):\s*(.*)$/.exec(item);
    if (match === null) return `testPlan: "${item}" is neither "automated: ..." nor "manual: ..."`;
    const kind = match[1] === "manual" ? "manual" : "automated";
    const [check = "", expect] = (match[2] ?? "").split(EXPECT);
    entries.push({
      kind,
      check: check.trim(),
      ...(expect === undefined ? {} : { expect: expect.trim() }),
    });
  }
  return { entries };
}

/** One field of the form as it was read: a value after the name, list items or context lines. */
interface ReadField {
  scalar: string | null;
  readonly items: string[];
  readonly block: string[];
}

/** The fields of the form's lines by name, or the first line it cannot read. */
function readFields(text: string): Map<string, ReadField> | string {
  const fields = new Map<string, ReadField>();
  let current: ReadField | null = null;
  for (const [index, line] of text.replace(/\r\n?/g, "\n").split("\n").entries()) {
    if (line.startsWith("#") || (line.trim() === "" && current?.block.length === 0)) continue;
    const field = /^([A-Za-z][A-Za-z.]*):(?: (.*))?$/.exec(line);
    if (field !== null) {
      const value = (field[2] ?? "").trim();
      current = { scalar: value === "" ? null : value, items: [], block: [] };
      fields.set(field[1] ?? "", current);
    } else if (current !== null && line.startsWith("- ") && current.block.length === 0) {
      current.items.push(line.slice(2).trim());
    } else if (current !== null && (line.startsWith("  ") || line.trim() === "")) {
      current.block.push(line.slice(2));
    } else {
      return `line ${index + 1} is no "name: value", "- item" or indented context line`;
    }
  }
  return fields;
}

/** The value one read field gives its field `name`, or the problem with it. */
function valueOf(name: string, field: ReadField): { readonly value: unknown } | string {
  if (name === "testPlan") {
    const plan = testPlanOf(field.scalar, field.items);
    return typeof plan === "string" ? plan : { value: plan };
  }
  if (LIST_FIELDS.has(name)) {
    return {
      value:
        field.scalar === null ? field.items : field.scalar.split(",").map((item) => item.trim()),
    };
  }
  if (name === "context") return { value: [field.scalar ?? "", ...field.block].join("\n").trim() };
  return { value: field.scalar ?? "" };
}

/** The object a field named `key` goes into: the proposal's, or a split's `edit` or `story`. */
function targetOf(
  result: Record<string, unknown>,
  original: PlanningProposal,
  key: string,
): Record<string, unknown> | null {
  const parts = key.split(".");
  if (parts.length === 1) return result;
  const [group] = parts;
  if (parts.length > 2 || original.kind !== "split" || (group !== "edit" && group !== "story")) {
    return null;
  }
  const nested = (result[group] ?? {}) as Record<string, unknown>;
  result[group] = nested;
  return nested;
}

/**
 * Pure: the form `text` read back over `original`, keeping its kind and id: the proposal to send
 * with `planning.edit`, or the problem that stops it.
 */
export function readProposalForm(
  original: PlanningProposal,
  text: string,
):
  | { readonly ok: true; readonly proposal: unknown }
  | { readonly ok: false; readonly error: string } {
  const read = readFields(text);
  if (typeof read === "string") return { ok: false, error: read };
  const result: Record<string, unknown> = { kind: original.kind };
  const subject = subjectOf(original);
  if (subject !== null) result[subject.key] = subject.value;
  for (const [key, field] of read) {
    // The kind, the id and the draft are the proposal's own.
    if (key === "kind" || key === "id" || key === "draft") continue;
    const name = key.split(".").at(-1) ?? "";
    const value = valueOf(name, field);
    if (typeof value === "string") return { ok: false, error: value };
    const target = targetOf(result, original, key);
    if (target === null) return { ok: false, error: `${key} is not a field of this proposal` };
    const empty = value.value === "" || (Array.isArray(value.value) && value.value.length === 0);
    if (!empty) target[name] = value.value;
  }
  return { ok: true, proposal: result };
}
