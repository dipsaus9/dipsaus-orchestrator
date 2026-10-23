// The evidence bundle of the scan fallback (0013 section 6 step 1, DIPO-310). Pure: the file list
// and the texts of dipo's base copy go in, the request and the bundle come out, within a size
// budget. Code decides every item; the model only reads them.
//
// The items, in the order they get the budget: the request (only the capabilities code left
// unresolved or in conflict, with the conflict's candidates), the manifests (the root and workspace
// package.json, pnpm-workspace.yaml and the manifests of other stacks), `.claude/backlog-workflow.json`,
// the Makefile or justfile, the CI workflows' `run:` steps, the install and run sections of README
// and CLAUDE.md, the env file names, and last the file tree to depth 2 without dependency, build
// and worktree folders. Env file contents are never read: `evidenceFiles` never names an env file,
// so the reader never opens one, and the bundle lists env files by name only.

import { posix } from "node:path";

import { shownSpec } from "./diff";
import type { CapabilityName, CommandSpec, EnvFile, Resolution } from "./detect";
import { CAPABILITIES } from "./detect";

/** The most characters the bundle's items may hold together. */
export const EVIDENCE_BUDGET_CHARS = 32_000;
/** The most characters of one item. */
export const EVIDENCE_ITEM_CHARS = 6_000;
/** The most characters of one README or CLAUDE.md section. */
export const EVIDENCE_SECTION_CHARS = 3_000;
/** The largest file the reader opens, in bytes; a larger one is left out. */
export const EVIDENCE_FILE_BYTES = 256 * 1024;

/** Folders the tree and the file choice leave out: dependencies, build output, worktrees. */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".venv",
  "venv",
  "__pycache__",
  ".worktrees",
  "worktrees",
  ".claude/worktrees",
]);

/** Manifests by file name, at the root or one folder down (workspace packages). */
const MANIFESTS: ReadonlySet<string> = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "deno.json",
  "deno.jsonc",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "mix.exs",
]);

const TASK_RUNNERS = ["Makefile", "makefile", "GNUmakefile", "justfile", "Justfile", ".justfile"];
const READMES = ["README.md", "README", "README.markdown", "readme.md", "Readme.md"];
const INSTRUCTION_FILES = ["CLAUDE.md", ".claude/CLAUDE.md"];
export const WORKFLOW_EVIDENCE = ".claude/backlog-workflow.json";
const CI_WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** A README or CLAUDE.md heading of a section about installing and running. */
const INSTALL_RUN =
  /\b(install|installation|installing|setup|set up|getting started|quick ?start|run|running|develop|development|usage|test|tests|testing|build|building|scripts|commands|prerequisites|requirements|local)\b/i;

/** True for a name that is or may be an env file; such a file is never read. */
export function isEnvName(path: string): boolean {
  const name = posix.basename(path);
  return (
    name.startsWith(".env") ||
    name.includes(".env.") ||
    name.endsWith(".env") ||
    name.includes(".example") ||
    name === ".dev.vars" ||
    name.startsWith(".dev.vars") ||
    name === ".npmrc" ||
    name === ".netrc"
  );
}

function excluded(path: string): boolean {
  const parts = path.split("/");
  return parts.some(
    (part, at) => EXCLUDED_DIRS.has(part) || EXCLUDED_DIRS.has(parts.slice(0, at + 1).join("/")),
  );
}

/** One capability the request names: unresolved, or in conflict with its candidates. */
export interface RequestItem {
  readonly capability: CapabilityName;
  readonly status: "unresolved" | "conflict";
  /** A conflict's candidates as one line each. */
  readonly candidates: readonly string[];
}

/**
 * The request (0013 section 6 step 2): the capabilities the effective profile leaves unresolved or
 * in conflict, never one code resolved or the maintainer confirmed, and not `dev` when the product
 * has nothing to start.
 */
export function requestItems(
  capabilities: Readonly<Record<CapabilityName, Resolution<CommandSpec>>>,
  nothingToStart: boolean,
): RequestItem[] {
  return CAPABILITIES.flatMap((capability): RequestItem[] => {
    const resolution = capabilities[capability];
    if (resolution.status === "resolved") return [];
    if (capability === "dev" && nothingToStart) return [];
    return [
      {
        capability,
        status: resolution.status,
        candidates:
          resolution.status === "conflict"
            ? resolution.candidates.map(
                (candidate) =>
                  `${shownSpec(candidate.value)} [${candidate.source}, ${candidate.evidence}]`,
              )
            : [],
      },
    ];
  });
}

/**
 * The files the reader opens for the bundle, from the base copy's file list: manifests, the
 * workflow file, task runners, CI workflows, README and CLAUDE.md. Never an env file, never one in
 * an excluded folder.
 */
export function evidenceFiles(files: readonly string[]): string[] {
  const listed = new Set(files);
  const chosen: string[] = [];
  const add = (path: string) => {
    if (listed.has(path) && !isEnvName(path) && !excluded(path) && !chosen.includes(path)) {
      chosen.push(path);
    }
  };
  for (const path of files) {
    const depth = path.split("/").length;
    if (depth <= 3 && MANIFESTS.has(posix.basename(path))) add(path);
  }
  add(WORKFLOW_EVIDENCE);
  for (const name of TASK_RUNNERS) add(name);
  for (const path of files) if (CI_WORKFLOW.test(path)) add(path);
  for (const name of READMES) add(name);
  for (const name of INSTRUCTION_FILES) add(name);
  return chosen;
}

/** The sections of a Markdown text whose heading is about installing or running. */
export function installRunSections(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: string[] = [];
  let open: { level: number; lines: string[] } | null = null;
  let fence = false;
  const close = () => {
    if (open !== null) sections.push(cut(open.lines.join("\n").trim(), EVIDENCE_SECTION_CHARS));
    open = null;
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      if (open !== null && level <= open.level) close();
      if (open === null && INSTALL_RUN.test(heading[2] ?? "")) {
        open = { level, lines: [line] };
        continue;
      }
    }
    if (open !== null) (open as { lines: string[] }).lines.push(line);
  }
  close();
  return sections;
}

/** The `run:` steps of a GitHub Actions workflow text, one command block each. */
export function ciRunSteps(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const steps: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i] ?? "");
    if (match === null) continue;
    const indent = (match[1] ?? "").length;
    const value = (match[2] ?? "").trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? "";
        const nextIndent = /^(\s*)/.exec(next)?.[1]?.length ?? 0;
        if (next.trim() !== "" && nextIndent <= indent) break;
        block.push(next.trim());
        i += 1;
      }
      const joined = block.filter((line) => line !== "").join("\n");
      if (joined !== "") steps.push(joined);
    } else if (value !== "") {
      steps.push(value.replace(/^["']|["']$/g, ""));
    }
  }
  return steps;
}

/** The file tree to depth 2, folders with a slash, without excluded folders. */
export function fileTree(files: readonly string[]): string[] {
  const entries = new Set<string>();
  for (const path of files) {
    if (excluded(path)) continue;
    const parts = path.split("/");
    if (parts.length === 1) entries.add(path);
    else if (parts.length === 2) {
      entries.add(`${parts[0]}/`);
      entries.add(path);
    } else {
      entries.add(`${parts[0]}/`);
      entries.add(`${parts[0]}/${parts[1]}/`);
    }
  }
  return [...entries].toSorted();
}

/** At most `max` characters; a longer text ends in a cut marker. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 7))}\n[cut]`;
}

/** One item of the bundle: what it is, the file it came from, and its text. */
export interface EvidenceItem {
  readonly kind: "manifest" | "workflow" | "task-runner" | "ci" | "readme" | "env-files" | "tree";
  /** The repo-relative file, or null for an item code put together (env names, tree). */
  readonly path: string | null;
  readonly text: string;
}

export interface EvidenceBundle {
  readonly request: readonly RequestItem[];
  readonly items: readonly EvidenceItem[];
  /** The characters of the items together; at most `EVIDENCE_BUDGET_CHARS`. */
  readonly chars: number;
  /** The items cut or left out for the budget, by path or kind. */
  readonly cut: readonly string[];
}

/** What the bundle is built from: the base copy's file list and the texts the reader read. */
export interface EvidenceSource {
  readonly files: readonly string[];
  /** The texts of `evidenceFiles(files)` the reader could read; never an env file. */
  readonly texts: Readonly<Record<string, string>>;
  /** The profile's env files, by path only. */
  readonly envFiles: readonly EnvFile[];
}

function envNames(source: EvidenceSource): string[] {
  const names = new Set<string>();
  for (const file of source.envFiles) {
    names.add(file.example === null ? file.path : `${file.path} (example ${file.example})`);
  }
  for (const path of source.files) {
    if (isEnvName(path) && !excluded(path)) names.add(path);
  }
  return [...names].toSorted();
}

/** Builds the bundle within `budget` characters. Pure. */
export function buildEvidence(
  source: EvidenceSource,
  request: readonly RequestItem[],
  budget: number = EVIDENCE_BUDGET_CHARS,
): EvidenceBundle {
  const candidates: EvidenceItem[] = [];
  const text = (path: string): string | undefined =>
    isEnvName(path) ? undefined : source.texts[path];
  const chosen = evidenceFiles(source.files);
  for (const path of chosen) {
    const body = text(path);
    if (body === undefined) continue;
    const name = posix.basename(path);
    if (MANIFESTS.has(name)) candidates.push({ kind: "manifest", path, text: body });
  }
  const workflow = text(WORKFLOW_EVIDENCE);
  if (workflow !== undefined) {
    candidates.push({ kind: "workflow", path: WORKFLOW_EVIDENCE, text: workflow });
  }
  for (const name of TASK_RUNNERS) {
    const body = chosen.includes(name) ? text(name) : undefined;
    if (body !== undefined) candidates.push({ kind: "task-runner", path: name, text: body });
  }
  for (const path of chosen.filter((p) => CI_WORKFLOW.test(p))) {
    const steps = ciRunSteps(text(path) ?? "");
    if (steps.length > 0) {
      candidates.push({ kind: "ci", path, text: steps.map((s) => `run: ${s}`).join("\n") });
    }
  }
  for (const path of [...READMES, ...INSTRUCTION_FILES]) {
    const body = chosen.includes(path) ? text(path) : undefined;
    if (body === undefined) continue;
    const sections = installRunSections(body);
    if (sections.length > 0) {
      candidates.push({ kind: "readme", path, text: sections.join("\n\n") });
    }
  }
  const env = envNames(source);
  if (env.length > 0) {
    candidates.push({
      kind: "env-files",
      path: null,
      text: `Env files by name only; their contents are never read:\n${env.join("\n")}`,
    });
  }
  candidates.push({ kind: "tree", path: null, text: fileTree(source.files).join("\n") });

  const items: EvidenceItem[] = [];
  const cutItems: string[] = [];
  let used = 0;
  for (const item of candidates) {
    const label = item.path ?? item.kind;
    const room = Math.min(EVIDENCE_ITEM_CHARS, budget - used);
    if (room < 200) {
      cutItems.push(label);
      continue;
    }
    const body = cut(item.text, room);
    if (body.length < item.text.length) cutItems.push(label);
    items.push({ ...item, text: body });
    used += body.length;
  }
  return { request, items, chars: used, cut: cutItems };
}
