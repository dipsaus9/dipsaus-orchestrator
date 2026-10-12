// The parser for Backlog.md 1.53 `--plain` output (0010 section 1, facts 1 to 3). One parser reads
// `task view`, `draft view`, `task list` and `draft list`; it is tested against output recorded
// from the pinned CLI (`test/fixtures/backlog-plain/`). Lines are LF-split and NFC-normalised.
//
// A view starts with `File: <path>` on line 1 and `Task <ID> - <title>` on line 2 (1.53 prints one
// blank line between them), then a rule of 50 `=` and `Key: value` header lines. Only known keys
// are read; lists split on `, `. A section starts only at a known name followed by a line of
// exactly 50 `-`. Each known section appears at most once and in a fixed order, so a description
// that prints a second, fake section (fact 2) is a parse error reported as R02. Unknown keys and
// unknown `Name:` plus rule lines are kept raw and logged, never guessed.

/** A line of exactly 50 `-`: the rule under a section name. */
export const SECTION_RULE = "-".repeat(50);
const TITLE_RULE = "=".repeat(50);

/** The Ready gate rule a parse failure is reported as (0010 section 1, 0012 R02). */
export const PARSE_RULE = "R02";

/** The sections of a view, in the order 1.53 prints them. */
export const KNOWN_SECTIONS = [
  "Dependency Graph",
  "Description",
  "Acceptance Criteria",
  "Definition of Done",
  "Implementation Plan",
  "Implementation Notes",
  "Comments",
  "Final Summary",
] as const;
export type KnownSection = (typeof KNOWN_SECTIONS)[number];

/** The header keys of a view, as 1.53 prints them. */
export const KNOWN_HEADER_KEYS = [
  "Status",
  "Priority",
  "Type",
  "Project",
  "Ordinal",
  "Assignee",
  "Reporter",
  "Created",
  "Updated",
  "Due",
  "Labels",
  "Milestone",
  "Parent",
  "Subtasks",
  "References",
  "Documentation",
] as const;
export type KnownHeaderKey = (typeof KNOWN_HEADER_KEYS)[number];

export class BacklogParseError extends Error {
  readonly rule = PARSE_RULE;
  constructor(
    readonly detail: string,
    /** 1-based line of the output, when the error has one. */
    readonly line?: number,
  ) {
    super(`structured fields are invalid: ${detail}${line === undefined ? "" : ` (line ${line})`}`);
    this.name = "BacklogParseError";
  }
}

/** Something the parser did not know, kept raw. */
export type UnknownItem =
  | { readonly kind: "header"; readonly line: number; readonly key: string; readonly value: string }
  | { readonly kind: "section"; readonly line: number; readonly name: string }
  | { readonly kind: "line"; readonly line: number; readonly text: string };

export interface ParseOptions {
  /** Called once for each unknown key, section or line. */
  readonly onUnknown?: (item: UnknownItem) => void;
}

export interface ChecklistItem {
  readonly index: number;
  readonly checked: boolean;
  readonly text: string;
}

export interface TaskRef {
  readonly id: string;
  readonly title: string;
}

/** A first-level entry of the dependency graph. */
export interface DependencyEntry {
  readonly id: string;
  /** `missing` and `ambiguous` are ids the CLI could not resolve. */
  readonly state: "resolved" | "missing" | "ambiguous";
  readonly title?: string;
  /** The status in brackets, `completed` for a task in `completed/`. */
  readonly status?: string;
}

export interface Comment {
  readonly index: number;
  /** The rest of the comment's first line after `#n - `, for example `@bob - 2026-10-12 21:17 (UTC)`. */
  readonly byline: string;
  readonly body: string;
}

/** One task or draft as `task view --plain` or `draft view --plain` prints it. */
export interface PlainTask {
  readonly file: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority?: string;
  readonly type?: string;
  readonly project?: string;
  readonly ordinal?: number;
  readonly assignee: readonly string[];
  readonly reporter?: string;
  /** As printed, for example `2026-10-12 21:17 (UTC)`; minute precision. */
  readonly created: string;
  readonly updated?: string;
  readonly due?: string;
  readonly labels: readonly string[];
  readonly milestone?: string;
  readonly parent?: { readonly id: string; readonly title?: string };
  readonly subtasks: readonly TaskRef[];
  readonly references: readonly string[];
  readonly documentation: readonly string[];
  readonly dependencies: readonly DependencyEntry[];
  /** Empty when the CLI printed `No description provided`. */
  readonly description: string;
  readonly acceptanceCriteria: readonly ChecklistItem[];
  readonly definitionOfDone: readonly ChecklistItem[];
  readonly implementationPlan?: string;
  readonly implementationNotes?: string;
  readonly modifiedFiles: readonly string[];
  readonly comments: readonly Comment[];
  readonly finalSummary?: string;
  /** Unknown keys, sections and lines, kept raw. */
  readonly unknown: readonly UnknownItem[];
}

/** One line of `task list --plain` or `draft list --plain`. */
export interface PlainListEntry {
  readonly id: string;
  readonly title: string;
  /** The group the line is in: a status for `task list`, `Drafts` for `draft list`. */
  readonly group: string;
  readonly priority?: string;
  readonly type?: string;
  readonly project?: string;
  /** From the `(ac: n/m)` count; absent when the task has no criteria. */
  readonly ac?: { readonly checked: number; readonly total: number };
  readonly due?: string;
}

export interface PlainList {
  readonly entries: readonly PlainListEntry[];
  readonly unknown: readonly UnknownItem[];
}

/** LF-split, NFC-normalised lines, without the empty line after a final newline. */
export function plainLines(output: string): string[] {
  const lines = output.normalize("NFC").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** True when `text` has a line of exactly 50 `-`, which would print a fake section (fact 2). */
export function hasSectionRule(text: string): boolean {
  return text
    .normalize("NFC")
    .split("\n")
    .some((line) => line === SECTION_RULE || line === `${SECTION_RULE}\r`);
}

function splitList(value: string): string[] {
  return value === "" ? [] : value.split(", ");
}

class Unknowns {
  readonly items: UnknownItem[] = [];
  constructor(readonly onUnknown: ((item: UnknownItem) => void) | undefined) {}
  add(item: UnknownItem): void {
    this.items.push(item);
    this.onUnknown?.(item);
  }
}

const KNOWN_SECTION_SET: ReadonlySet<string> = new Set(KNOWN_SECTIONS);
const KNOWN_KEY_SET: ReadonlySet<string> = new Set(KNOWN_HEADER_KEYS);

interface Section {
  readonly name: KnownSection;
  /** 0-based index of the name line. */
  readonly at: number;
  body: string[];
}

/** Drops leading and trailing blank lines. */
function trimBlank(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start++;
  while (end > start && lines[end - 1]?.trim() === "") end--;
  return lines.slice(start, end);
}

/** Reads `Status: ○ Ready`: the CLI prints one icon character and a space before the status. */
function readStatus(value: string): string {
  const space = value.indexOf(" ");
  return space > 0 && !/[\p{L}\p{N}]/u.test(value.slice(0, space)) ? value.slice(space + 1) : value;
}

const TASK_LINE = /^Task (\S+) - (.*)$/;
const HEADER_LINE = /^([A-Z][A-Za-z ]*?)(?: \((\d+)\))?:(?: (.*))?$/;
const REF_LINE = /^- (\S+) - (.*)$/;
const CHECK_LINE = /^- \[( |x)\] #(\d+) (.*)$/;
const GRAPH_ENTRY = /^[├└]─ (.*)$/;
const COMMENT_LINE = /^#(\d+)(?: - (.*))?$/;
const MODIFIED_FILES = "Modified files: ";

/** `{ [key]: value }`, or nothing when the value is absent (optional properties stay absent). */
function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** Parses `task view --plain` or `draft view --plain`. Throws `BacklogParseError`. */
export function parseView(output: string, options: ParseOptions = {}): PlainTask {
  const lines = plainLines(output);
  const unknown = new Unknowns(options.onUnknown);

  const fileLine = lines[0] ?? "";
  if (!fileLine.startsWith("File: ")) throw new BacklogParseError("line 1 is not `File:`", 1);
  const file = fileLine.slice("File: ".length);
  // 1.53 prints one blank line between `File:` and the task line.
  let i = lines[1] === "" ? 2 : 1;
  const task = TASK_LINE.exec(lines[i] ?? "");
  if (task === null) throw new BacklogParseError("line 2 is not `Task <ID> - <title>`", i + 1);
  const [, id = "", title = ""] = task;
  i++;
  if (lines[i] !== TITLE_RULE) throw new BacklogParseError("missing the `=` rule", i + 1);
  i++;
  if (lines[i] === "") i++;

  // Headers: up to the first blank line.
  const headers = new Map<KnownHeaderKey, string>();
  const subtasks: TaskRef[] = [];
  let subtaskList = false;
  for (; i < lines.length && lines[i] !== ""; i++) {
    const line = lines[i] ?? "";
    const ref = REF_LINE.exec(line);
    if (subtaskList && ref !== null) {
      subtasks.push({ id: ref[1] ?? "", title: ref[2] ?? "" });
      continue;
    }
    subtaskList = false;
    const header = HEADER_LINE.exec(line);
    if (header === null) {
      unknown.add({ kind: "line", line: i + 1, text: line });
      continue;
    }
    const [, key = "", count, value = ""] = header;
    if (!KNOWN_KEY_SET.has(key) || (count !== undefined && key !== "Subtasks")) {
      unknown.add({ kind: "header", line: i + 1, key, value });
      continue;
    }
    const known = key as KnownHeaderKey;
    if (headers.has(known)) throw new BacklogParseError(`header \`${key}\` appears twice`, i + 1);
    headers.set(known, value);
    if (known === "Subtasks" && count !== undefined) subtaskList = true;
  }

  // Sections: a known name followed by the rule, each at most once, in order.
  const sections: Section[] = [];
  const before: { line: number; text: string }[] = [];
  let order = -1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const startsSection = line.endsWith(":") && lines[i + 1] === SECTION_RULE;
    const name = line.slice(0, -1);
    if (startsSection && KNOWN_SECTION_SET.has(name)) {
      const known = name as KnownSection;
      const rank = KNOWN_SECTIONS.indexOf(known);
      if (sections.some((section) => section.name === known)) {
        throw new BacklogParseError(`section \`${name}\` appears twice`, i + 1);
      }
      if (rank < order) {
        throw new BacklogParseError(`section \`${name}\` is out of order`, i + 1);
      }
      order = rank;
      sections.push({ name: known, at: i, body: [] });
      i++;
      continue;
    }
    // An unknown name with a rule never starts a section: it stays in the text and is reported.
    if (startsSection && !line.startsWith(" ")) unknown.add({ kind: "section", line: i + 1, name });
    const current = sections.at(-1);
    if (current === undefined) before.push({ line: i + 1, text: line });
    else current.body.push(line);
  }
  for (const stray of before) {
    if (stray.text.trim() !== "") unknown.add({ kind: "line", ...stray });
  }

  // `Modified files: a, b` is printed after the notes (or the plan, or the definition of done),
  // followed by a blank line; it is the last line of whichever of those sections comes last.
  let modifiedFiles: string[] = [];
  const holder = sections
    .filter((section) =>
      ["Definition of Done", "Implementation Plan", "Implementation Notes"].includes(section.name),
    )
    .at(-1);
  if (holder !== undefined) {
    const body = trimBlank(holder.body);
    const last = body.at(-1);
    if (last?.startsWith(MODIFIED_FILES)) {
      modifiedFiles = splitList(last.slice(MODIFIED_FILES.length));
      holder.body = body.slice(0, -1);
    }
  }

  const sectionText = (name: KnownSection): string | undefined => {
    const section = sections.find((s) => s.name === name);
    return section === undefined ? undefined : trimBlank(section.body).join("\n");
  };
  const sectionLines = (name: KnownSection): { lines: string[]; at: number } => {
    const section = sections.find((s) => s.name === name);
    return section === undefined
      ? { lines: [], at: 0 }
      : { lines: trimBlank(section.body), at: section.at + 2 };
  };

  const description = sectionText("Description") ?? "";
  const status = headers.get("Status");
  const created = headers.get("Created");
  if (status === undefined) throw new BacklogParseError("missing the `Status` header");
  if (created === undefined) throw new BacklogParseError("missing the `Created` header");
  const ordinalText = headers.get("Ordinal");
  const ordinal = ordinalText === undefined ? undefined : Number(ordinalText);
  if (ordinal !== undefined && !Number.isFinite(ordinal)) {
    throw new BacklogParseError(`\`Ordinal\` is not a number: ${ordinalText}`);
  }
  const parentText = headers.get("Parent");
  const parent =
    parentText === undefined
      ? undefined
      : parentText.includes(" - ")
        ? {
            id: parentText.slice(0, parentText.indexOf(" - ")),
            title: parentText.slice(parentText.indexOf(" - ") + 3),
          }
        : { id: parentText };

  const plan = sectionText("Implementation Plan");
  const notes = sectionText("Implementation Notes");
  const summary = sectionText("Final Summary");

  return {
    file,
    id,
    title,
    status: readStatus(status),
    ...optional("priority", headers.get("Priority")),
    ...optional("type", headers.get("Type")),
    ...optional("project", headers.get("Project")),
    ...(ordinal === undefined ? {} : { ordinal }),
    assignee: splitList(headers.get("Assignee") ?? ""),
    ...optional("reporter", headers.get("Reporter")),
    created,
    ...optional("updated", headers.get("Updated")),
    ...optional("due", headers.get("Due")),
    labels: splitList(headers.get("Labels") ?? ""),
    ...optional("milestone", headers.get("Milestone")),
    ...(parent === undefined ? {} : { parent }),
    subtasks,
    references: splitList(headers.get("References") ?? ""),
    documentation: splitList(headers.get("Documentation") ?? ""),
    dependencies: readDependencies(sectionLines("Dependency Graph").lines),
    description: description === "No description provided" ? "" : description,
    acceptanceCriteria: readChecklist(
      sectionLines("Acceptance Criteria"),
      "No acceptance criteria defined",
      unknown,
    ),
    definitionOfDone: readChecklist(
      sectionLines("Definition of Done"),
      "No Definition of Done items defined",
      unknown,
    ),
    ...optional("implementationPlan", plan),
    ...optional("implementationNotes", notes),
    modifiedFiles,
    comments: readComments(sectionLines("Comments").lines),
    ...optional("finalSummary", summary),
    unknown: unknown.items,
  };
}

/** The first-level entries under `Depends on (…)`; `Dependents (…)` is not read. */
function readDependencies(lines: readonly string[]): DependencyEntry[] {
  const entries: DependencyEntry[] = [];
  let inDepends = false;
  for (const line of lines) {
    if (line.startsWith("Depends on (")) {
      inDepends = true;
      continue;
    }
    if (line === "" || line.startsWith("Dependents (")) {
      inDepends = false;
      continue;
    }
    if (!inDepends) continue;
    const entry = GRAPH_ENTRY.exec(line);
    if (entry === null) continue; // a deeper level, indented
    const text = (entry[1] ?? "").replace(/ \((?:cycle|shown above)\)$/, "");
    const dash = text.indexOf(" - ");
    if (dash < 0) {
      entries.push({ id: text, state: "resolved" });
      continue;
    }
    const entryId = text.slice(0, dash);
    const rest = text.slice(dash + 3);
    if (rest === "unknown task ID" || rest === "ambiguous task ID") {
      entries.push({ id: entryId, state: rest === "unknown task ID" ? "missing" : "ambiguous" });
      continue;
    }
    const status = / \[([^\]]+)\]$/.exec(rest);
    entries.push(
      status === null
        ? { id: entryId, state: "resolved", title: rest }
        : {
            id: entryId,
            state: "resolved",
            title: rest.slice(0, status.index),
            status: status[1] ?? "",
          },
    );
  }
  return entries;
}

function readChecklist(
  section: { lines: string[]; at: number },
  none: string,
  unknown: Unknowns,
): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const [offset, line] of section.lines.entries()) {
    if (line === none && section.lines.length === 1) break;
    const item = CHECK_LINE.exec(line);
    if (item === null) {
      unknown.add({ kind: "line", line: section.at + offset + 1, text: line });
      continue;
    }
    items.push({ index: Number(item[2]), checked: item[1] === "x", text: item[3] ?? "" });
  }
  return items;
}

/** Comments: `#n - <byline>` then the body; a new comment starts after a blank line at `#n+1`. */
function readComments(lines: readonly string[]): Comment[] {
  const comments: { index: number; byline: string; body: string[] }[] = [];
  for (const [offset, line] of lines.entries()) {
    const header = COMMENT_LINE.exec(line);
    const last = comments.at(-1);
    const next =
      header !== null &&
      (last === undefined ||
        (Number(header[1]) === last.index + 1 && (lines[offset - 1] ?? "") === ""));
    if (next && header !== null) {
      comments.push({ index: Number(header[1]), byline: header[2] ?? "", body: [] });
    } else if (last !== undefined) {
      last.body.push(line);
    }
  }
  return comments.map((comment) => ({
    index: comment.index,
    byline: comment.byline,
    body: trimBlank(comment.body).join("\n"),
  }));
}

const LIST_EMPTY = new Set(["No tasks found.", "No drafts found."]);
const LIST_ENTRY = /^([A-Za-z][A-Za-z0-9]*-\d+(?:\.\d+)*) - (.*)$/;

/** Parses `task list --plain` or `draft list --plain`. Throws `BacklogParseError`. */
export function parseList(output: string, options: ParseOptions = {}): PlainList {
  const lines = plainLines(output);
  const unknown = new Unknowns(options.onUnknown);
  const entries: PlainListEntry[] = [];
  let group: string | undefined;
  for (const [offset, line] of lines.entries()) {
    if (line.trim() === "" || LIST_EMPTY.has(line)) continue;
    if (!line.startsWith(" ") && line.endsWith(":")) {
      group = line.slice(0, -1);
      continue;
    }
    if (!line.startsWith("  ")) {
      unknown.add({ kind: "line", line: offset + 1, text: line });
      continue;
    }
    if (group === undefined) {
      throw new BacklogParseError("a list entry before any group", offset + 1);
    }
    const entry = readListEntry(line.slice(2), group);
    if (entry === null) unknown.add({ kind: "line", line: offset + 1, text: line });
    else entries.push(entry);
  }
  return { entries, unknown: unknown.items };
}

/** `[HIGH] [feature] TASK-1 - Title (ac: 1/2) (due 2026-12-01)`; the brackets are optional. */
function readListEntry(text: string, group: string): PlainListEntry | null {
  const tags: string[] = [];
  let rest = text;
  for (let tag = /^\[([^\]]+)\] /.exec(rest); tag !== null; tag = /^\[([^\]]+)\] /.exec(rest)) {
    tags.push(tag[1] ?? "");
    rest = rest.slice(tag[0].length);
  }
  const entry = LIST_ENTRY.exec(rest);
  if (entry === null) return null;
  let title = entry[2] ?? "";
  const due = / \(due ([^()]+)\)$/.exec(title);
  if (due !== null) title = title.slice(0, due.index);
  const ac = / \(ac: (\d+)\/(\d+)\)$/.exec(title);
  if (ac !== null) title = title.slice(0, ac.index);
  // The priority is printed upper-cased and first; the type and the project follow.
  const first = tags[0];
  const priority =
    first !== undefined && first === first.toUpperCase() && /\p{L}/u.test(first)
      ? tags.shift()
      : undefined;
  const [type, project] = tags;
  return {
    id: entry[1] ?? "",
    title,
    group,
    ...(priority === undefined ? {} : { priority }),
    ...(type === undefined ? {} : { type }),
    ...(project === undefined ? {} : { project }),
    ...(ac === null ? {} : { ac: { checked: Number(ac[1]), total: Number(ac[2]) } }),
    ...(due === null ? {} : { due: due[1] ?? "" }),
  };
}
