// The context provider interface (0014 section 9). A provider decides which code a worker sees
// and returns items: data with a structured reason, never prompt prose. The engine renders them
// (DIPO-47). Output is deterministic for the same inputs.

/** Project size class from the `git ls-files` count (0014 section 4). */
export type SizeClass = "S" | "M" | "L" | "XL";

/** What a provider reads: one checkout (a story worktree, or `_base`). */
export interface Workspace {
  /** Absolute path of the work tree. */
  readonly root: string;
  /** The commit `HEAD` points at. */
  headSha(): Promise<string>;
  /** `git ls-files`: tracked repo-relative POSIX paths, sorted. */
  trackedFiles(): Promise<readonly string[]>;
  /** Tracked plus untracked, not ignored, repo-relative paths, sorted. */
  files(): Promise<readonly string[]>;
  /** The bytes of a repo-relative file, or undefined when it is missing or not a file. */
  readFile(path: string): Promise<Uint8Array | undefined>;
}

export type ProviderState = "ready" | "stale" | "missing" | "error";

export interface ProviderStatus {
  readonly state: ProviderState;
  /** Why the provider is not ready; empty when it is. */
  readonly reasons: readonly string[];
}

export interface ContextRequest {
  /** F1, the Backlog.md id. */
  readonly storyId: string;
  /** F3. */
  readonly outcome: string;
  /** F4, in Backlog.md order. */
  readonly criteria: readonly string[];
  /** F8: repo-relative paths; a trailing `/` marks a directory. */
  readonly scope: readonly string[];
  /** F9: repo-relative paths or URLs the worker reads but does not write. */
  readonly inputs: readonly string[];
  /** Component names already matched by the engine, if any; providers may add their own. */
  readonly components: readonly string[];
  readonly baseSha: string;
  readonly headSha: string;
  readonly sizeClass: SizeClass;
  /** The `inputs` section budget in characters (0014 section 4). */
  readonly inputsBudget: number;
}

/**
 * `text` holds the file (or its head); `binary` and `unreadable` files have empty `text`. A
 * `secret` file (a 0008 secret name such as `.env*`) is listed only: never read, empty `text`.
 */
export type FileContent = "text" | "binary" | "unreadable" | "secret";

/** Why an item is in the pack. */
export type ContextReason =
  /** A scope file, in full or as its head with a truncation marker. */
  | {
      readonly kind: "scope-file";
      readonly scope: string;
      readonly content: FileContent;
      readonly truncated: boolean;
    }
  /** A scope directory: `text` is its breadth-first entry list, one path per line. */
  | {
      readonly kind: "scope-dir";
      readonly scope: string;
      readonly shown: number;
      readonly total: number;
    }
  /** A scope path that does not exist yet: `text` lists the entries of `parent`. */
  | {
      readonly kind: "scope-new";
      readonly scope: string;
      readonly parent: string;
      readonly shown: number;
      readonly total: number;
    }
  /** A declared component: `text` lists its files, one per line, capped. */
  | {
      readonly kind: "component";
      readonly name: string;
      readonly purpose: string | null;
      /** `scope` when its globs match the scope; otherwise the direct neighbour relation. */
      readonly via: "scope" | "depends-on" | "depended-on-by";
      readonly shown: number;
      readonly total: number;
    }
  /** A test next to a scope file by name; listed, never inlined (`text` is empty). */
  | { readonly kind: "test"; readonly of: string }
  /** An input file, pre-fetched within the inputs budget. */
  | {
      readonly kind: "input-file";
      readonly input: string;
      readonly content: FileContent;
      readonly truncated: boolean;
    }
  /** An input whose content did not fit the inputs budget: listed only. */
  | { readonly kind: "input-listed"; readonly input: string }
  /** An input URL: listed only, never fetched. */
  | { readonly kind: "input-url"; readonly input: string }
  /** An input path that does not exist. */
  | { readonly kind: "input-missing"; readonly input: string };

export interface ContextItem {
  /** Repo-relative path, component name for components, or URL for URL inputs. */
  readonly path: string;
  /** 1-based inclusive line range when `text` is part of a file. */
  readonly range?: { readonly from: number; readonly to: number };
  readonly text: string;
  readonly reason: ContextReason;
}

export interface ContextProvenance {
  readonly provider: string;
  readonly version: string;
  readonly indexState: ProviderState;
  readonly staleFiles: readonly string[];
  /** Why a backend was skipped, or component map problems; empty when there are none. */
  readonly notes: readonly string[];
}

/** The `inputs` section (0014 section 2): the full path list plus pre-fetched content. */
export interface InputsPart {
  /** Every declared input, in request order; never cut. */
  readonly paths: readonly string[];
  readonly items: readonly ContextItem[];
  readonly usedChars: number;
  readonly truncated: boolean;
}

export interface ContextPack {
  /** The `context` section items, in a deterministic order. */
  readonly items: readonly ContextItem[];
  /** Characters of the `context` items (path plus text of each). */
  readonly usedChars: number;
  /** True when any item was cut or dropped for the budget. */
  readonly truncated: boolean;
  readonly provenance: ContextProvenance;
  /** Filled by the default provider; a backend leaves it empty. */
  readonly inputs: InputsPart;
  /** Git blob ids of the scope and input files whose content was read, by path. */
  readonly blobIds: Readonly<Record<string, string>>;
}

export interface ContextProvider {
  /** `default`, `codegraph`. */
  readonly id: string;
  status(ws: Workspace): Promise<ProviderStatus>;
  /** Index or sync; runs before the worker, outside its budget. */
  prepare?(ws: Workspace): Promise<void>;
  gather(req: ContextRequest, budget: number): Promise<ContextPack>;
}
