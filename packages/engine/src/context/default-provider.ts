// The default context provider (0014 section 9, M0): no external tool, no model.
//
// 1. Scope: an existing file in full when under the per-item cap, else its head with a marker; a
//    directory as its file count and the 15 files changed most recently on the base sha (none at
//    all for the recording data and the decision records unless the story names a path in them);
//    a path that does not exist yet is marked new, with that summary of its parent directory.
// 2. Inputs: every declared input listed; files pre-fetched within the `inputs` budget; URLs
//    listed only.
// 3. Component map, when `.dipo/components.yaml` exists: the components whose globs match the
//    scope and their direct neighbours, with name, purpose line and a capped file list.
// 4. Tests next to scope files by name (`x.ts` to `x.test.ts`), listed, not inlined.
//
// A scope or input file named like a secret (`.env*`, `.npmrc`, `*.pem`, ...; see `secrets.ts`) is
// never read: it is listed with content `secret`, empty text and no blob id.
//
// Every list is sorted and newlines are normalised, so the same checkout and request give the same
// pack bytes.

import {
  COMPONENT_MAP_PATH,
  componentFiles,
  matchComponents,
  type ScopeKind,
  validateComponentMap,
} from "./components";
import { gitBlobId } from "./pack";
import {
  COMPONENT_FILES_MAX,
  CONTEXT_ITEM_MAX,
  DIRECTORY_ENTRIES_MAX,
  DIRECTORY_RECENT_MAX,
  INPUT_FILE_MAX,
} from "./size";
import { isSecretPath } from "./secrets";
import { truncateHead, truncateListing } from "./truncate";
import type {
  ContextItem,
  ContextPack,
  ContextProvider,
  ContextRequest,
  FileContent,
  ProviderStatus,
  Workspace,
} from "./types";

export const DEFAULT_PROVIDER_ID = "default";
/** Changes whenever the default provider's output for the same inputs changes. */
export const DEFAULT_PROVIDER_VERSION = "2";

const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A repo-relative path without `./`, duplicate or trailing slashes; `""` is the root. */
export function normalisePath(path: string): string {
  return path
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Per directory (`""` is the root): its direct entries, files as paths, directories with `/`. */
type DirectoryIndex = ReadonlyMap<string, readonly string[]>;

function indexDirectories(files: readonly string[]): DirectoryIndex {
  const entries = new Map<string, Set<string>>([["", new Set()]]);
  for (const file of files) {
    const parts = file.split("/");
    let dir = "";
    for (let i = 0; i < parts.length; i += 1) {
      const name = parts.slice(0, i + 1).join("/");
      const last = i === parts.length - 1;
      let set = entries.get(dir);
      if (set === undefined) {
        set = new Set();
        entries.set(dir, set);
      }
      set.add(last ? name : `${name}/`);
      dir = name;
    }
  }
  return new Map([...entries].map(([dir, set]) => [dir, [...set].toSorted()]));
}

/** Files under `dir` (all files for the root), sorted. */
function filesUnder(files: readonly string[], dir: string): string[] {
  if (dir === "") return [...files];
  const prefix = `${dir}/`;
  return files.filter((file) => file.startsWith(prefix));
}

/** Directories whose files are data, not code: no item unless the story names a path in them. */
const HIDDEN_DIRECTORIES = ["docs/decisions", "packages/engine/test/recordings"] as const;

const isHidden = (dir: string): boolean =>
  HIDDEN_DIRECTORIES.some((hidden) => dir === hidden || dir.startsWith(`${hidden}/`));

/** True when the outcome or a criterion names a path inside `dir`. */
function namesPathIn(req: ContextRequest, dir: string): boolean {
  const pattern = new RegExp(`(^|[^\\w./-])${escapeRegExp(dir)}/[^\\s]`);
  return [req.outcome, ...req.criteria].some((text) => pattern.test(text));
}

/**
 * The files of `dir` changed most recently on `baseSha` first, the rest in name order. A git
 * error (an unknown sha, a timeout) leaves the name order and adds a provenance note.
 */
async function filesByRecentChange(
  ws: Workspace,
  baseSha: string,
  dir: string,
  files: readonly string[],
  notes: string[],
): Promise<string[]> {
  const present = new Set(files);
  const ordered = await ws.filesByLastCommit?.(baseSha, dir).catch((error: unknown) => {
    const why = error instanceof Error ? error.message : String(error);
    notes.push(
      `scope directory ${dir === "" ? "./" : `${dir}/`}: no commit order on ${baseSha} (${why}), files in name order`,
    );
    return [];
  });
  const first = [...new Set(ordered ?? [])].filter((file) => present.has(file));
  const done = new Set(first);
  return [...first, ...files.filter((file) => !done.has(file)).toSorted()];
}

function classify(
  path: string,
  fileSet: ReadonlySet<string>,
  files: readonly string[],
  index: DirectoryIndex,
): ScopeKind {
  if (fileSet.has(path)) return { kind: "file", path };
  if (path === "" || index.has(path)) {
    return { kind: "dir", path, files: filesUnder(files, path) };
  }
  return { kind: "new", path };
}

const decoder = new TextDecoder("utf-8");

interface FileText {
  readonly content: FileContent;
  readonly text: string;
  readonly bytes: Uint8Array | undefined;
  readonly refusal?: string;
}

async function readText(ws: Workspace, path: string): Promise<FileText> {
  if (isSecretPath(path)) return { content: "secret", text: "", bytes: undefined };
  const bytes = await ws.readFile(path);
  if (bytes === undefined) return { content: "unreadable", text: "", bytes };
  if (!(bytes instanceof Uint8Array)) {
    return { content: "refused", text: "", bytes: undefined, refusal: bytes.refused };
  }
  if (bytes.includes(0)) return { content: "binary", text: "", bytes };
  return { content: "text", text: decoder.decode(bytes).replaceAll("\r\n", "\n"), bytes };
}

/** A listing: `entries` capped at `max`, one per line, then cut to `limit` characters. */
function listing(entries: readonly string[], max: number, limit: number, label: string) {
  const capped = entries.slice(0, max);
  const cut = truncateListing(capped.join("\n"), limit, label);
  return {
    text: cut.text,
    shown: cut.truncated ? cut.lines : capped.length,
    total: entries.length,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tests in the same directory named after `file`: `x.ts` gives `x.test.ts`, `x.ci.test.ts`, `x.spec.ts`. */
function testsNextTo(file: string, fileSet: ReadonlySet<string>, index: DirectoryIndex): string[] {
  const dir = parentOf(file);
  const base = file.slice(dir === "" ? 0 : dir.length + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const pattern = new RegExp(`^${escapeRegExp(stem)}(\\.[A-Za-z0-9_-]+)*\\.(test|spec)\\.[^./]+$`);
  return (index.get(dir) ?? []).filter((entry) => {
    if (entry.endsWith("/") || entry === file || !fileSet.has(entry)) return false;
    return pattern.test(entry.slice(dir === "" ? 0 : dir.length + 1));
  });
}

/** What an item costs against the `context` budget: its path plus its text. */
export const itemCostOf = (item: ContextItem): number => item.path.length + item.text.length;

/** A candidate with the full text it may be cut from when the budget runs short. */
interface Candidate {
  readonly item: ContextItem;
  readonly full?: string;
}

export interface DefaultProviderOptions {
  readonly workspace: Workspace;
}

export function createDefaultProvider(options: DefaultProviderOptions): ContextProvider {
  const ws = options.workspace;
  return {
    id: DEFAULT_PROVIDER_ID,
    async status(): Promise<ProviderStatus> {
      return { state: "ready", reasons: [] };
    },
    gather: (req, budget) => gatherDefault(ws, req, budget),
  };
}

async function gatherDefault(
  ws: Workspace,
  req: ContextRequest,
  budget: number,
): Promise<ContextPack> {
  const [files, tracked] = await Promise.all([ws.files(), ws.trackedFiles()]);
  const sortedFiles = [...files].toSorted();
  const sortedTracked = [...tracked].toSorted();
  const fileSet = new Set(sortedFiles);
  const index = indexDirectories(sortedFiles);
  const blobIds: Record<string, string> = {};
  const notes: string[] = [];
  const candidates: Candidate[] = [];

  // 1. Scope
  const scopePaths = [...new Set(req.scope.map(normalisePath))].toSorted();
  const scope = scopePaths.map((path) => classify(path, fileSet, sortedFiles, index));
  for (const entry of scope) {
    if (entry.kind === "file") {
      const file = await readText(ws, entry.path);
      if (file.bytes !== undefined) blobIds[entry.path] = gitBlobId(file.bytes);
      const cut = truncateHead(file.text, CONTEXT_ITEM_MAX, entry.path);
      candidates.push({
        item: {
          path: entry.path,
          ...(cut.truncated ? { range: { from: 1, to: cut.lines } } : {}),
          text: cut.text,
          reason: {
            kind: "scope-file",
            scope: entry.path,
            content: file.content,
            truncated: cut.truncated,
            ...(file.refusal === undefined ? {} : { refusal: file.refusal }),
          },
        },
        full: file.text,
      });
    } else if (entry.kind === "dir") {
      if (isHidden(entry.path) && !namesPathIn(req, entry.path)) continue;
      const label = entry.path === "" ? "./" : `${entry.path}/`;
      const recent = await filesByRecentChange(ws, req.baseSha, entry.path, entry.files, notes);
      const list = listing(recent, DIRECTORY_RECENT_MAX, CONTEXT_ITEM_MAX, label);
      candidates.push({
        item: {
          path: label,
          text: list.text,
          reason: { kind: "scope-dir", scope: label, shown: list.shown, total: entry.files.length },
        },
      });
    } else {
      let parent = parentOf(entry.path);
      while (parent !== "" && !index.has(parent)) parent = parentOf(parent);
      const label = parent === "" ? "./" : `${parent}/`;
      const under = filesUnder(sortedFiles, parent);
      const recent = await filesByRecentChange(ws, req.baseSha, parent, under, notes);
      const list = listing(recent, DIRECTORY_RECENT_MAX, CONTEXT_ITEM_MAX, label);
      candidates.push({
        item: {
          path: entry.path,
          text: list.text,
          reason: {
            kind: "scope-new",
            scope: entry.path,
            parent: label,
            shown: list.shown,
            total: under.length,
          },
        },
      });
    }
  }

  // 3. Component map
  const mapText = fileSet.has(COMPONENT_MAP_PATH)
    ? await readText(ws, COMPONENT_MAP_PATH)
    : undefined;
  if (mapText !== undefined) {
    const map = validateComponentMap(mapText.text, sortedTracked);
    notes.push(...map.warnings);
    if (map.state === "invalid") {
      notes.push(...map.errors.map((error) => `component map not used: ${error}`));
    } else {
      for (const match of matchComponents(map.components, scope, req.components)) {
        const owned = componentFiles(match.component, sortedTracked);
        const list = listing(owned, COMPONENT_FILES_MAX, CONTEXT_ITEM_MAX, match.component.name);
        candidates.push({
          item: {
            path: match.component.name,
            text: list.text,
            reason: {
              kind: "component",
              name: match.component.name,
              purpose: match.component.purpose,
              via: match.via,
              shown: list.shown,
              total: list.total,
            },
          },
        });
      }
    }
  }

  // 4. Tests next to scope files
  const scopeFiles = new Set(scope.filter((e) => e.kind !== "dir").map((e) => e.path));
  const tests = new Map<string, string>();
  for (const path of [...scopeFiles].toSorted()) {
    for (const test of testsNextTo(path, fileSet, index)) {
      if (!scopeFiles.has(test) && !tests.has(test)) tests.set(test, path);
    }
  }
  for (const [test, of] of [...tests].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    candidates.push({ item: { path: test, text: "", reason: { kind: "test", of } } });
  }

  // Budget: items in order; one that does not fit is cut to the room left, or dropped.
  const items: ContextItem[] = [];
  let used = 0;
  let truncated = candidates.some(
    (c) => "truncated" in c.item.reason && c.item.reason.truncated === true,
  );
  for (const candidate of candidates) {
    const cost = itemCostOf(candidate.item);
    if (used + cost <= budget) {
      items.push(candidate.item);
      used += cost;
      continue;
    }
    truncated = true;
    const { full } = candidate;
    const room = budget - used - candidate.item.path.length;
    if (full === undefined || room <= 0 || candidate.item.reason.kind !== "scope-file") continue;
    const cut = truncateHead(full, Math.min(room, CONTEXT_ITEM_MAX), candidate.item.path);
    if (cut.shown === 0 || cut.text.length > room) continue;
    const item: ContextItem = {
      path: candidate.item.path,
      range: { from: 1, to: cut.lines },
      text: cut.text,
      reason: { ...candidate.item.reason, truncated: true },
    };
    items.push(item);
    used += itemCostOf(item);
  }

  // 2. Inputs
  const inputs = await gatherInputs(ws, req, sortedFiles, fileSet, index, blobIds);

  return {
    items,
    usedChars: used,
    truncated,
    provenance: {
      provider: DEFAULT_PROVIDER_ID,
      version: DEFAULT_PROVIDER_VERSION,
      indexState: "ready",
      staleFiles: [],
      notes,
    },
    inputs,
    blobIds: Object.fromEntries(Object.entries(blobIds).toSorted(([a], [b]) => (a < b ? -1 : 1))),
  };
}

async function gatherInputs(
  ws: Workspace,
  req: ContextRequest,
  files: readonly string[],
  fileSet: ReadonlySet<string>,
  index: DirectoryIndex,
  blobIds: Record<string, string>,
): Promise<ContextPack["inputs"]> {
  const items: ContextItem[] = [];
  let used = 0;
  let truncated = false;
  const budget = req.inputsBudget;
  for (const input of req.inputs) {
    if (URL_PATTERN.test(input)) {
      items.push({ path: input, text: "", reason: { kind: "input-url", input } });
      continue;
    }
    const path = normalisePath(input);
    const kind = classify(path, fileSet, files, index);
    if (kind.kind === "new") {
      items.push({ path, text: "", reason: { kind: "input-missing", input } });
      continue;
    }
    const paths = kind.kind === "file" ? [path] : kind.files.slice(0, DIRECTORY_ENTRIES_MAX);
    if (kind.kind === "dir" && kind.files.length > paths.length) truncated = true;
    for (const file of paths) {
      const read = await readText(ws, file);
      if (read.bytes !== undefined) blobIds[file] = gitBlobId(read.bytes);
      const room = Math.min(INPUT_FILE_MAX, budget - used);
      const cut = truncateHead(read.text, room, file);
      if (room <= 0 || (cut.truncated && (cut.shown === 0 || cut.text.length > room))) {
        truncated = true;
        items.push({ path: file, text: "", reason: { kind: "input-listed", input } });
        continue;
      }
      if (cut.truncated) truncated = true;
      items.push({
        path: file,
        ...(cut.truncated ? { range: { from: 1, to: cut.lines } } : {}),
        text: cut.text,
        reason: {
          kind: "input-file",
          input,
          content: read.content,
          truncated: cut.truncated,
          ...(read.refusal === undefined ? {} : { refusal: read.refusal }),
        },
      });
      used += cut.text.length;
    }
  }
  return { paths: [...req.inputs], items, usedChars: used, truncated };
}
