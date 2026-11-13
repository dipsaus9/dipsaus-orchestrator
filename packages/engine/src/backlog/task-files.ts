// The Ready gate's other active tasks from one pass over the checkout's task files (DIPO-494,
// 0010): their id, status, dependencies and frozen branch, read as the CLI reads them without one
// CLI call per task. A `task view` loads the whole backlog, so a view per task costs a process per
// task (about 450 on this repository's backlog). The pass never writes.
//
// The files are the ones `scanBacklogFiles` checks before every CLI call: it runs first, and a file
// it refuses fails the read. The front matter is prepared and parsed as the runner does
// (`parseTaskFrontMatter`); the id, the dependency ids and the description are read as Backlog.md
// 1.53 prints them in `task view`: a task's id with the configured prefix in upper case, a dependency naming a task of tasks/ or
// completed/ in any case as that task's id and any other as written, a dependency list that is not a list read as
// none, duplicates dropped, dependencies in the order of the numbers their ids end with, and
// the description the text between its section markers, or under a `## Description` header, or
// none. Only `tasks/` of each story folder holds active tasks; `completed/`, `archive/` and
// `drafts/` do not. A task file that does not parse fails the read: it would hide a dependency or
// a branch from R13, R14 and R19 (a stricter rule than the one view per task, which counted it
// with no dependencies).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FieldBlockError, parseFieldBlock } from "../story-store/fields/block";
import { StoryParseError } from "../story-store/errors";
import type { TaskFacts } from "../story-store/story";
import { parseYamlDocument } from "../platform/yaml";

import { parseTaskFrontMatter, ROOT_CONFIG, scanBacklogFiles, storyFoldersOf } from "./runner";

/** The prefix of Backlog.md 1.53 when `task_prefix` is not configured. */
const DEFAULT_PREFIX = "task";

const DESCRIPTION_BEGIN = "<!-- SECTION:DESCRIPTION:BEGIN -->";
const DESCRIPTION_END = "<!-- SECTION:DESCRIPTION:END -->";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The `task_prefix` of the first configuration that sets one, root first, as the CLI reads it. */
function prefixOf(cwd: string, folders: readonly string[]): string {
  const configs = [ROOT_CONFIG, ...folders.map((folder) => `${folder}/config.yml`)];
  for (const path of configs) {
    const text = readText(join(cwd, path));
    if (text === null) continue;
    const parsed = parseYamlDocument(text);
    if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) continue;
    const prefix = (parsed.value as Record<string, unknown>)["task_prefix"];
    if (typeof prefix === "string" && prefix.trim() !== "") return prefix.trim();
  }
  return DEFAULT_PREFIX;
}

/** A task's own id as `task view` prints it: `<prefix>-<n>` in any case gets the prefix in upper case. */
export function normalizedId(raw: string, prefix: string): string {
  const id = raw.trim();
  const upper = prefix.toUpperCase();
  const parts = /^([^-\s]+)-(\d+(?:\.\d+)*)$/.exec(id);
  if (parts !== null && (parts[1] ?? "").toLowerCase() === prefix.toLowerCase()) {
    return `${upper}-${parts[2]}`;
  }
  return id;
}

/** The description `task view` prints for a task body; "" when it has none. */
export function descriptionOf(body: string): string {
  const begin = body.indexOf(DESCRIPTION_BEGIN);
  if (begin >= 0) {
    const from = begin + DESCRIPTION_BEGIN.length;
    const end = body.indexOf(DESCRIPTION_END, from);
    return body.slice(from, end < 0 ? undefined : end).trim();
  }
  const header = /^##[ \t]+Description[ \t]*$/im.exec(body);
  if (header === null) return "";
  const rest = body.slice(header.index + header[0].length);
  const next = /^##[ \t]/m.exec(rest);
  return rest.slice(0, next === null ? undefined : next.index).trim();
}

/** The numbers an id ends with, `DIPO-12.3` giving [12, 3]; none for an id that ends in none. */
function numbersOf(id: string): number[] {
  const tail = /(\d+(?:\.\d+)*)\s*$/.exec(id)?.[1];
  return tail === undefined ? [] : tail.split(".").map(Number);
}

/** `task view` prints dependencies by the number their id ends with; equal numbers keep their order. */
function byNumber(a: string, b: string): number {
  const [x, y] = [numbersOf(a), numbersOf(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The dependency ids as `task view` prints them: one that names a task in `tasks/` or `completed/` in any case is
 * that task's id, any other stays as written; duplicates dropped.
 */
function dependenciesOf(value: unknown, known: ReadonlyMap<string, string>): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" && typeof item !== "number") continue;
    const written = String(item).trim();
    const id = known.get(written.toLowerCase()) ?? written;
    if (id !== "" && !ids.includes(id)) ids.push(id);
  }
  return ids.toSorted(byNumber);
}

/** The ids of the tasks in the `completed/` folders that have one; a file that does not parse has none. */
function completedIds(cwd: string, folders: readonly string[], prefix: string): string[] {
  const ids: string[] = [];
  for (const folder of folders) {
    let names: string[];
    try {
      names = readdirSync(join(cwd, `${folder}/completed`));
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.toLowerCase().endsWith(".md"))) {
      const text = readText(join(cwd, `${folder}/completed/${name}`));
      const parsed = text === null ? undefined : parseTaskFrontMatter(text);
      const id = parsed?.ok === true ? parsed.fields["id"] : undefined;
      if (typeof id === "string" && id.trim() !== "") ids.push(normalizedId(id, prefix));
    }
  }
  return ids;
}

/**
 * The facts of every active task of the checkout `cwd`, in file order. Throws a `StoryParseError`
 * when the Backlog files do not pass the runner's scan or a task file does not parse.
 */
export function readTaskFacts(cwd: string): TaskFacts[] {
  const scan = scanBacklogFiles(cwd);
  const refused = scan.refused[0];
  if (refused !== undefined) {
    throw new StoryParseError(`${refused.path} ${refused.reason}`);
  }
  const rootText = readText(join(cwd, ROOT_CONFIG));
  const folders = storyFoldersOf(rootText);
  const prefix = prefixOf(cwd, folders);
  const read: { id: string; status: string; dependencies: unknown; branch?: string }[] = [];
  for (const folder of folders) {
    const dir = `${folder}/tasks`;
    let names: string[];
    try {
      names = readdirSync(join(cwd, dir));
    } catch {
      continue;
    }
    for (const name of names.toSorted()) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      const path = `${dir}/${name}`;
      const text = readText(join(cwd, path));
      if (text === null) throw new StoryParseError(`${path} cannot be read`);
      const parsed = parseTaskFrontMatter(text);
      if (!parsed.ok) throw new StoryParseError(`${path}: ${parsed.reason}`);
      const { id, status, dependencies } = parsed.fields;
      if ((typeof id !== "string" && typeof id !== "number") || String(id).trim() === "") {
        throw new StoryParseError(`${path}: its front matter has no id`);
      }
      let branch: string | undefined;
      try {
        branch = parseFieldBlock(descriptionOf(parsed.body)).fields.branch;
      } catch (error) {
        if (!(error instanceof FieldBlockError)) throw error;
        throw new StoryParseError(`${path}: its field block does not parse (${error.message})`);
      }
      read.push({
        id: normalizedId(String(id), prefix),
        status: typeof status === "string" ? status : "",
        dependencies,
        ...(branch === undefined ? {} : { branch }),
      });
    }
  }
  // `task view` also resolves a dependency on a completed task, which is not an active one.
  const known = new Map(read.map((task) => [task.id.toLowerCase(), task.id]));
  for (const id of completedIds(cwd, folders, prefix)) known.set(id.toLowerCase(), id);
  return read.map((task) => ({ ...task, dependencies: dependenciesOf(task.dependencies, known) }));
}
