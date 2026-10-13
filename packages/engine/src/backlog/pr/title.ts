// The title and body of a backlog PR (0016 rule 1): `chore(backlog): <summary>`, where the summary
// names the operations on the branch in journal order, at most 100 characters, with no trailing
// full stop, so the `pr-title` check passes.

/** The subject limit of 0016 rule 1. */
export const MAX_SUBJECT = 100;
export const TITLE_PREFIX = "chore(backlog): ";

export interface TitleOp {
  readonly kind: string;
  readonly subject: string;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The summary: every operation when they fit, else a count and as many subjects as fit. */
export function prSummary(ops: readonly TitleOp[]): string {
  const parts = ops.map((op) => clean(`${op.kind} ${op.subject}`));
  if (parts.length === 0) return "update the backlog";
  const all = parts.join(", ");
  if ([...all].length <= MAX_SUBJECT) return all.replace(/\.+$/, "");
  const subjects = [...new Set(ops.map((op) => clean(op.subject)))];
  const head = `${ops.length} backlog operations on `;
  let shown = 0;
  let text = `${ops.length} backlog operations`;
  for (let n = 1; n <= subjects.length; n++) {
    const rest = subjects.length - n;
    const candidate = `${head}${subjects.slice(0, n).join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
    if ([...candidate].length > MAX_SUBJECT) break;
    text = candidate;
    shown = n;
  }
  if (shown === 0) text = [...text].slice(0, MAX_SUBJECT).join("");
  return text.replace(/\.+$/, "");
}

export function prTitle(ops: readonly TitleOp[]): string {
  return `${TITLE_PREFIX}${prSummary(ops)}`;
}

export function prBody(ops: readonly TitleOp[]): string {
  return [
    "Planning changes from dipo's backlog lane (0010 section 2, lane b). This PR changes only `backlog/`.",
    "",
    ...ops.map((op) => `- \`backlog: ${clean(op.kind)} ${clean(op.subject)}\``),
    "",
    "dipo checks it structurally (backlog paths only, every task parses, allowed status changes, a stored Ready gate decision for each new Ready, no claimed task) when it opens or updates it and again after it merges.",
  ].join("\n");
}
