// `dipo test` (DIPO-309, 0002): the maintainer tests a story's pushed head.
//
// - `dipo test <id>` sends `test.start` and prints the URL, the test box's name, the numbered manual
//   steps (with what to expect) and the test id, with the lines that record the result. The first
//   test of an office may build its box image, so it waits up to `TEST_START_TIMEOUT_MS`.
// - `dipo test pass <id> [--note <text>]` and `dipo test fail <id> --note <text>` send
//   `test.record` for the story's open test, read from `office.snapshot`; a fail without a note is
//   refused before anything is sent.
// - `dipo test shell <id>` opens an interactive shell in the story's test box, for a product with
//   nothing to start: the daemon-side `test-shell` form with the open test's box.
// A story with no open test gets "no open test" and exit 1.

import { storyRef } from "@dipsaus-orchestrator/client";
import {
  officeSnapshot,
  type OfficeId,
  type StoryRefValue,
  testRecord,
  testStart,
  type TestView,
} from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type Act, type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

/** The daemon session an office command gets. */
type Session = Parameters<Act>[0];

/** How long `dipo test` waits: a first test may build the office image and fill the cache. */
export const TEST_START_TIMEOUT_MS = 60 * 60_000;

/** How long recording waits: the box is deleted and a fail's fix round queued before it answers. */
export const TEST_RECORD_TIMEOUT_MS = 120_000;

export interface TestCommandDeps extends OfficeCommandDeps {
  /** Runs a daemon-side form (`test-shell`) with this terminal. */
  readonly runDaemon: (argv: readonly string[]) => Promise<number>;
}

interface Parsed {
  readonly story: StoryRefValue;
  readonly note: string | undefined;
  readonly office: OfficeId | null;
}

/** One story id, `--note` when allowed, and `--office`; else the usage exit code. */
function parseArgs(
  name: string,
  args: readonly string[],
  deps: OfficeCommandDeps,
  allowNote: boolean,
): Parsed | number {
  let story: StoryRefValue | null = null;
  let note: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--note" && allowNote) {
      const value = args[i + 1];
      if (value === undefined || value.trim() === "") {
        return usage(deps, `${name}: --note needs a text`);
      }
      note = value;
      i += 1;
    } else if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (!arg.startsWith("-")) {
      if (story !== null) return usage(deps, `${name} takes one story id`);
      story = storyRef(arg);
      if (story === null) return usage(deps, `${name}: ${JSON.stringify(arg)} is not a story id`);
    } else {
      rest.push(arg);
    }
  }
  if (story === null) return usage(deps, `${name} needs a story id`);
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `${name}: ${options}`);
  return { story, note, office: options.office };
}

/** The printed lines of a started test. */
export function testLines(
  story: string,
  test: {
    readonly test: string;
    readonly head: string;
    readonly checkout: string;
    readonly steps: readonly { readonly check: string; readonly expect?: string | undefined }[];
    readonly url?: string | undefined;
    readonly shell?: string | undefined;
  },
): string[] {
  return [
    `testing ${story} at ${test.head.slice(0, 12)} in the test box ${test.checkout}`,
    test.url === undefined ? "nothing to start; look around in the box:" : `open ${test.url}`,
    ...(test.shell === undefined ? [] : [`shell: ${test.shell}`]),
    "steps:",
    ...test.steps.flatMap((step, index) => [
      `  ${index + 1}. ${step.check}`,
      ...(step.expect === undefined ? [] : [`     expect: ${step.expect}`]),
    ]),
    `test: ${test.test}`,
    `record it: dipo test pass ${story} [--note <text>], or dipo test fail ${story} --note <what failed>`,
  ];
}

/** True when the open test `test` is the story `story` names (an id in any case, or a key). */
function isStory(test: TestView, story: StoryRefValue): boolean {
  return test.key === story || test.story.toUpperCase() === String(story).toUpperCase();
}

/** The story's open test from `office.snapshot`, or the exit code when it has none. */
async function openTest(
  deps: OfficeCommandDeps,
  parsed: Parsed,
  act: (session: Session, test: TestView, office: OfficeId) => Promise<number>,
  timeoutMs: number,
): Promise<number> {
  return withOffice(
    deps,
    parsed.office,
    async (session, office) => {
      const snapshot = await session.read(officeSnapshot, { office });
      if (!snapshot.ok) {
        return snapshot.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, snapshot.error);
      }
      const test = snapshot.result.tests.find((candidate) => isStory(candidate, parsed.story));
      if (test === undefined) {
        deps.writeLine(
          `${parsed.story} has no open test; start one with \`dipo test ${parsed.story}\``,
        );
        return 1;
      }
      return act(session, test, office);
    },
    undefined,
    timeoutMs,
  );
}

async function startCommand(args: readonly string[], deps: TestCommandDeps): Promise<number> {
  const parsed = parseArgs("test", args, deps, false);
  if (typeof parsed === "number") return parsed;
  deps.writeLine(`starting a test box for ${parsed.story}; a first test may build the box image`);
  return withOffice(
    deps,
    parsed.office,
    async (session, office) => {
      const outcome = await session.command(testStart, { story: parsed.story }, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      for (const line of testLines(String(parsed.story), outcome.result)) deps.writeLine(line);
      return 0;
    },
    undefined,
    TEST_START_TIMEOUT_MS,
  );
}

async function recordCommand(
  result: "pass" | "fail",
  args: readonly string[],
  deps: TestCommandDeps,
): Promise<number> {
  const parsed = parseArgs(`test ${result}`, args, deps, true);
  if (typeof parsed === "number") return parsed;
  if (result === "fail" && parsed.note === undefined) {
    return usage(deps, "test fail needs --note <what failed>");
  }
  const note = parsed.note;
  return openTest(
    deps,
    parsed,
    async (session, test, office) => {
      const outcome = await session.command(
        testRecord,
        { test: test.test, result, ...(note === undefined ? {} : { note }) },
        { office },
      );
      if (!outcome.ok) return engineFailure(deps, outcome.error);
      deps.writeLine(
        result === "pass"
          ? `recorded a pass for ${test.story} at ${test.head.slice(0, 12)}; its test box is deleted`
          : `recorded a fail for ${test.story}; your note goes to its worker, and its test box is deleted`,
      );
      return 0;
    },
    TEST_RECORD_TIMEOUT_MS,
  );
}

async function shellCommand(args: readonly string[], deps: TestCommandDeps): Promise<number> {
  const parsed = parseArgs("test shell", args, deps, false);
  if (typeof parsed === "number") return parsed;
  let box: string | null = null;
  const found = await openTest(
    deps,
    parsed,
    async (_session, test) => {
      box = test.checkout;
      return 0;
    },
    TEST_RECORD_TIMEOUT_MS,
  );
  if (found !== 0 || box === null) return found || 1;
  return deps.runDaemon(["test-shell", box]);
}

/** `dipo test …`: start, pass, fail or shell. */
export async function testCommand(args: readonly string[], deps: TestCommandDeps): Promise<number> {
  const [first, ...rest] = args;
  if (first === "pass" || first === "fail") return recordCommand(first, rest, deps);
  if (first === "shell") return shellCommand(rest, deps);
  return startCommand(args, deps);
}
