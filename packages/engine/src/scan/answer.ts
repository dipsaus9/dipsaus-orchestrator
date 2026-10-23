// The fallback session's answer (0013 section 6 step 2, DIPO-310): the schema the session's
// structured output must follow, and the checks code runs on it before anything is stored. Pure.
//
// The answer passes the door first (size cap, every string cleaned of terminal control and other
// unsafe characters, `cleanDoorStrings`), then the strict schema. A schema failure drops the whole
// answer. Then each proposal is checked against the request (only a capability the request named)
// and against dipo's base copy (`existence`): the working directory must be a folder of the
// repository, a `<package manager> run <script>` must name a script of the package.json in that
// folder, a `make` or `just` target must be in the Makefile or justfile there, and a path the
// command names must be a file of the repository. A proposal that fails is dropped with the check
// named; the others are stored pending, confidence `low`. Nothing here runs a command.

import { posix } from "node:path";

import { z } from "zod";

import { cleanDoorStrings } from "../box/door";
import type { JsonSchema } from "../workers/types";

import { CAPABILITIES, type CapabilityName, type CommandSpec, type Confidence } from "./detect";
import type { RequestItem } from "./evidence";

/** The largest answer, as JSON characters, before any field is read. */
export const ANSWER_MAX_CHARS = 32_000;

const Text = (max: number) => z.string().min(1).max(max);

export const ScanProposalSchema = z.strictObject({
  capability: z.enum(CAPABILITIES).describe("one of the capabilities the request names"),
  commands: z
    .array(z.array(Text(500)).min(1).max(32))
    .min(1)
    .max(8)
    .describe("the commands in order, each a list of arguments with the program first, no shell"),
  cwd: Text(300).describe("the folder the commands run in, relative to the root; . is the root"),
  evidence: z
    .array(Text(500))
    .min(1)
    .max(8)
    .describe("one short line per fact relied on, each naming its file"),
  confidence: z.enum(["high", "medium", "low"]).describe("how sure the evidence makes you"),
});

export const ScanAnswerSchema = z.strictObject({
  proposals: z
    .array(ScanProposalSchema)
    .max(CAPABILITIES.length)
    .describe("one proposal per capability you found evidence for; leave the others out"),
});

export type ScanAnswer = z.infer<typeof ScanAnswerSchema>;

/** The JSON Schema the session's `--json-schema` gets (the structured output of its result). */
export const SCAN_ANSWER_JSON_SCHEMA: JsonSchema = z.toJSONSchema(ScanAnswerSchema, {
  io: "input",
}) as JsonSchema;

/** What the base copy holds, for the existence checks. */
export interface BaseFacts {
  /** Repo-relative POSIX paths of the base copy's files. */
  readonly files: readonly string[];
  /** Texts the checks read: package.json files, Makefile and justfile, by repo-relative path. */
  readonly texts: Readonly<Record<string, string>>;
}

/** A proposal that passed every check. */
export interface CheckedProposal {
  readonly capability: CapabilityName;
  readonly spec: CommandSpec;
  readonly modelConfidence: Confidence;
  readonly evidence: readonly string[];
}

/** A proposal dropped by a check, with the check's name and why. */
export interface DroppedProposal {
  readonly capability: string;
  /** `request`, `duplicate`, `cwd` or `existence`. */
  readonly check: string;
  readonly detail: string;
}

export type AnswerCheck =
  | {
      readonly ok: true;
      readonly accepted: readonly CheckedProposal[];
      readonly dropped: readonly DroppedProposal[];
    }
  /** The whole answer is dropped: `check` is `size` or `schema`. */
  | { readonly ok: false; readonly check: "size" | "schema"; readonly detail: string };

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const MAKE = new Set(["make", "gmake"]);
const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"];
const JUSTFILES = ["justfile", "Justfile", ".justfile"];
const SCRIPT_FILE = /\.(sh|bash|zsh|js|mjs|cjs|ts|mts|cts|py|rb|pl|php)$/;

/** A working directory as a repo-relative folder, or null when it leaves the repository. */
export function normalCwd(cwd: string): string | null {
  if (cwd.includes("\0") || posix.isAbsolute(cwd)) return null;
  const clean = posix.normalize(cwd).replace(/\/+$/, "");
  if (clean === "" || clean === ".") return ".";
  if (clean === ".." || clean.startsWith("../")) return null;
  return clean.replace(/^\.\//, "");
}

function join(cwd: string, path: string): string {
  return cwd === "." ? posix.normalize(path) : posix.normalize(`${cwd}/${path}`);
}

function isFolder(files: readonly string[], dir: string): boolean {
  return dir === "." || files.some((path) => path.startsWith(`${dir}/`));
}

function scriptsOf(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown };
    const scripts = parsed.scripts;
    return typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>)
      : {};
  } catch {
    return null;
  }
}

/** True when `target` is a rule of the Makefile or recipe of the justfile `text`. */
function hasTarget(text: string, target: string, just: boolean): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = just
    ? new RegExp(`^@?${escaped}(\\s[^:=]*)?:(?!=)`, "m")
    : new RegExp(`^(?:[^:#=\\s]+\\s+)*${escaped}(?:\\s+[^:#=\\s]+)*\\s*::?(?!=)`, "m");
  return rule.test(text);
}

/** Why one command fails the existence check, or null when it passes. */
function commandProblem(argv: readonly string[], cwd: string, base: BaseFacts): string | null {
  const [program, ...args] = argv;
  if (program === undefined) return "an empty command";
  const files = new Set(base.files);
  const exists = (path: string) => files.has(path) || isFolder(base.files, path);
  // A program named by path must be a file of the repository.
  if (program.includes("/")) {
    if (posix.isAbsolute(program)) return `the program ${program} is outside the repository`;
    const path = join(cwd, program);
    if (path.startsWith("../") || !files.has(path))
      return `the file ${path} is not in the repository`;
  }
  if (PACKAGE_MANAGERS.has(program)) {
    const script =
      args[0] === "run" || args[0] === "run-script"
        ? args.find((arg, at) => at > 0 && !arg.startsWith("-"))
        : program === "npm" && (args[0] === "test" || args[0] === "start")
          ? args[0]
          : undefined;
    if (script !== undefined) {
      const manifest = join(cwd, "package.json");
      const scripts = scriptsOf(base.texts[manifest]);
      if (scripts === null) return `there is no package.json in ${cwd}`;
      if (!(script in scripts)) return `the script "${script}" is not in ${manifest}`;
    }
  }
  if (MAKE.has(program) || program === "just") {
    const just = program === "just";
    const names = (just ? JUSTFILES : MAKEFILES).map((name) => join(cwd, name));
    const file = names.find((name) => files.has(name));
    if (file === undefined) return `there is no ${just ? "justfile" : "Makefile"} in ${cwd}`;
    const text = base.texts[file];
    for (const target of args.filter((arg) => !arg.startsWith("-") && !arg.includes("="))) {
      if (text !== undefined && !hasTarget(text, target, just)) {
        return `the ${just ? "recipe" : "target"} "${target}" is not in ${file}`;
      }
    }
  }
  // A path argument (a script file or a path with a folder) must be in the repository.
  for (const arg of args) {
    if (arg.startsWith("-") || arg.includes("://") || arg.includes("=")) continue;
    if (!arg.includes("/") && !SCRIPT_FILE.test(arg)) continue;
    if (/[*?[\]{}$`]/.test(arg)) continue;
    if (posix.isAbsolute(arg)) return `the path ${arg} is outside the repository`;
    const path = join(cwd, arg);
    if (path.startsWith("../")) return `the path ${arg} leaves the repository`;
    if (!exists(path)) return `the file ${path} is not in the repository`;
  }
  return null;
}

/**
 * Checks the session's structured output against the schema, the request and the base copy.
 * Pure. `raw` is the structured output as the adapter read it.
 */
export function checkAnswer(
  raw: unknown,
  request: readonly RequestItem[],
  base: BaseFacts,
): AnswerCheck {
  let size: number;
  try {
    size = JSON.stringify(raw ?? null).length;
  } catch {
    return { ok: false, check: "schema", detail: "the answer is not JSON" };
  }
  if (size > ANSWER_MAX_CHARS) {
    return {
      ok: false,
      check: "size",
      detail: `the answer has ${size} characters; at most ${ANSWER_MAX_CHARS} are allowed`,
    };
  }
  const parsed = ScanAnswerSchema.safeParse(cleanDoorStrings(raw));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
    return {
      ok: false,
      check: "schema",
      detail: `the answer fails the schema: ${where}${issue?.message ?? "invalid"}`,
    };
  }
  const asked = new Set(request.map((item) => item.capability));
  const accepted: CheckedProposal[] = [];
  const dropped: DroppedProposal[] = [];
  for (const proposal of parsed.data.proposals) {
    const capability = proposal.capability;
    if (!asked.has(capability)) {
      dropped.push({ capability, check: "request", detail: `${capability} was not asked for` });
      continue;
    }
    if (accepted.some((p) => p.capability === capability)) {
      dropped.push({ capability, check: "duplicate", detail: `a second ${capability} proposal` });
      continue;
    }
    const cwd = normalCwd(proposal.cwd);
    if (cwd === null || !isFolder(base.files, cwd)) {
      dropped.push({
        capability,
        check: "cwd",
        detail: `the working directory ${JSON.stringify(proposal.cwd)} is not a folder of the repository`,
      });
      continue;
    }
    const problem = proposal.commands
      .map((argv) => commandProblem(argv, cwd, base))
      .find((found) => found !== null);
    if (problem !== undefined && problem !== null) {
      dropped.push({ capability, check: "existence", detail: problem });
      continue;
    }
    accepted.push({
      capability,
      spec: { commands: proposal.commands, cwd },
      modelConfidence: proposal.confidence,
      evidence: proposal.evidence,
    });
  }
  return { ok: true, accepted, dropped };
}
