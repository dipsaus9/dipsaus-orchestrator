// `dipo run [ID...] [--box] [--office <id>]` (DIPO-48): sends `work.run` for the office of `--office`
// or of the current directory, with the main worktree it resolved as `from`, and prints each
// started story with its run and each skipped story with its reason. Exit 0 when a story started,
// else 1. Every run is a box run (DIPO-240, 0021): the developer always runs in the story's own box.
// `--box` (DIPO-271) is still accepted and sent, so scripts that pass it keep working, and changes
// nothing; with `--dry-run` it is ignored, since the dry run shows the box launch anyway.
//
// `dipo run --dry-run [ID...]` (DIPO-74) sends the read `work.preview` instead and prints, in
// sections, what `work.run` would do: the office checks that would refuse it, the skipped stories,
// the branch and worktree it would create, the full worker launch (program, arguments, model,
// effort, caps, run settings, environment variable names only) and the system file
// and task message the worker would get. It claims, creates and starts nothing. Exit 0 when it shows
// a launch, else 1.

import {
  type Clock,
  engineNotice,
  type Event,
  type OfficeId,
  StoryId,
  StoryKey,
  type StoryRefValue,
  StreamName,
  storyState,
  type WorkerLaunchPreview,
  workPreview,
  workRun,
} from "@dipsaus-orchestrator/contract";

import { cleanedOutput, type DaemonSession, engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

/**
 * How long `dipo run` waits for its claim: a fetch, a story index pass, the run profile, the Ready
 * gate and the claim with its push; each step that waits on something outside dipo is killed after
 * a minute. A claim took 5.5 minutes on a Mac (DIPO-325), so this is ten.
 */
export const RUN_TIMEOUT_MS = 600_000;

/** The outer deadline of `dipo run`: the claim's limit, then the subscription and explain wait. */
const RUN_DEADLINE_MS = RUN_TIMEOUT_MS + 60_000;

/** What each skip reason means, for people (0005 section 4). */
const REASONS: Readonly<Record<string, string>> = {
  notReady: "not Ready",
  parked: "parked",
  notRunnable:
    "not runnable (not on the base, already claimed or past Ready, or a backlog change for it is pending)",
  dependency: "a dependency is not Done",
  collision: "its branch is taken",
  capacity: "the office already runs a story",
  pickupCheckFailed:
    "it failed its pickup check (it goes back to Refined) or its setup, launch checks or worker start (it stays Ready)",
};

/** Skips whose reason the engine explains on the office stream (a notice or the gate output). */
const EXPLAINED: ReadonlySet<string> = new Set(["pickupCheckFailed", "collision"]);

/** The part of `story.state` that explains a move back to Refined. */
const StoryMove = storyState.data.pick({ story: true, to: true, detail: true });

/** How long `dipo run` waits after the reply for the office events that explain its skips. */
export const EXPLAIN_WAIT_MS = 3_000;

/** The story id a notice is about: the engine starts claim, setup and launch notices with it. */
const NOTICE_STORY = /^([A-Z][A-Z0-9]*-\d+(?:\.\d+)?) /;

/**
 * What the office stream says about stories, from the moment `dipo run` subscribed: each
 * `engine.notice` that names a story first, and the gate output of a move back to Refined.
 */
class StoryExplanations {
  readonly #lines = new Map<string, string[]>();
  #changed: (() => void) | null = null;

  onEvent(event: Event): void {
    if (event.type === engineNotice.type) {
      const data = engineNotice.data.safeParse(event.data);
      const story = data.success ? NOTICE_STORY.exec(data.data.text)?.[1] : undefined;
      if (data.success && story !== undefined) this.#add(story, [data.data.text]);
    } else if (event.type === storyState.type) {
      // Only the fields this needs, so a view this client does not know still explains.
      const data = StoryMove.safeParse(event.data);
      if (data.success && data.data.to === "Refined" && data.data.detail !== undefined) {
        this.#add(data.data.story, data.data.detail);
      }
    }
  }

  #add(story: string, lines: readonly string[]): void {
    this.#lines.set(story, [...(this.#lines.get(story) ?? []), ...lines]);
    this.#changed?.();
  }

  of(story: string): readonly string[] {
    return this.#lines.get(story) ?? [];
  }

  /** Resolves once every story in `stories` has a line, or after `ms` on `clock`. */
  async waitFor(stories: readonly string[], clock: Clock, ms: number): Promise<void> {
    const done = () => stories.every((story) => this.of(story).length > 0);
    if (done()) return;
    await new Promise<void>((resolve) => {
      const timer = clock.setTimeout(finish, ms);
      function finish(): void {
        clock.clearTimeout(timer);
        resolve();
      }
      this.#changed = () => {
        if (done()) finish();
      };
    });
    this.#changed = null;
  }
}

/** Subscribes to the office stream's live events; resolves once the subscription is live. */
async function explainOffice(
  session: DaemonSession,
  office: OfficeId,
  explanations: StoryExplanations,
): Promise<{ unsubscribe(): void }> {
  const live = Promise.withResolvers<void>();
  // No `filter`: it names the event type prefixes the daemon leaves out (0005 section 5).
  const subscription = session.subscribe(StreamName.parse(`office:${office}`), {
    onEvent: (event) => explanations.onEvent(event),
    onCaughtUp: () => live.resolve(),
    // Without the stream the skips are still printed, only without their explanation.
    onEnded: () => live.resolve(),
  });
  await live.promise;
  return subscription;
}

/** Resolves with `work`'s outcome, or with `null` once `ms` on `clock` has passed first. */
async function withinLimit<T>(work: Promise<T>, clock: Clock, ms: number): Promise<T | null> {
  let timer: ReturnType<Clock["setTimeout"]> | null = null;
  const limit = new Promise<null>((resolve) => {
    timer = clock.setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    if (timer !== null) clock.clearTimeout(timer);
  }
}

/** The file holding the report schema the `--json-schema` argument carries. */
const REPORT_SCHEMA_FILE = "report-schema.json";

/** A section header of the dry run. */
function section(title: string): string {
  return `\n== ${title} ==`;
}

/** Text as it is, without its final newline; an empty text says so. */
function block(text: string): string[] {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body === "" ? ["(empty)"] : body.split("\n");
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * The arguments after the program, one flag per line with its value. The `--json-schema` value
 * is the report schema file's JSON on one line, so it is named rather than repeated.
 */
function argumentLines(launch: WorkerLaunchPreview): string[] {
  const schema = launch.files.find((file) => file.name === REPORT_SCHEMA_FILE);
  const compactSchema = schema === undefined ? null : JSON.stringify(JSON.parse(schema.content));
  const args = launch.argv.slice(1);
  const lines: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const next = args[i + 1];
    if (arg.startsWith("-") && next !== undefined && !next.startsWith("-")) {
      const value =
        arg === "--json-schema" && next === compactSchema
          ? `<the JSON of ${REPORT_SCHEMA_FILE} below, on one line>`
          : next;
      lines.push(`  ${arg} ${value}`);
      i += 1;
    } else {
      lines.push(`  ${arg}`);
    }
  }
  return lines;
}

/** The dry run's launch sections. */
function launchLines(launch: WorkerLaunchPreview): string[] {
  const [program] = launch.argv;
  return [
    section("Branch it would create"),
    `branch:        ${launch.branch}`,
    `run directory: ${launch.runDir}`,
    section(`Worker launch (${launch.adapter})`),
    `program:           ${program ?? ""}`,
    `working directory: ${launch.cwd}`,
    `model:             ${launch.model}`,
    `effort:            ${launch.effort}`,
    `caps:              ${count(launch.caps.budgetTokens)} tokens, ${count(launch.caps.maxTurns)} turns, ${count(launch.caps.maxMinutes)} minutes, ${count(launch.caps.loops)} loops`,
    "arguments:",
    ...argumentLines(launch),
    "environment (names only, values are not shown):",
    ...launch.envNames.map((name) => `  ${name}`),
    ...launch.files.flatMap((file) => [
      section(
        `Run directory file ${file.name}${file.name === "claude-settings.json" ? " (permissions and sandbox settings)" : ""}`,
      ),
      ...block(file.content),
    ]),
    section(`System file ${launch.systemFile.path}`),
    ...block(launch.systemFile.text),
    section("Task message (the first user message, on stdin)"),
    ...block(launch.taskMessage),
  ];
}

async function dryRun(
  deps: OfficeCommandDeps,
  office: Parameters<typeof withOffice>[1],
  stories: readonly StoryRefValue[],
): Promise<number> {
  return withOffice(
    deps,
    office,
    async (session, target) => {
      const outcome = await session.read(workPreview, {
        office: target,
        ...(stories.length === 0 ? {} : { stories: [...stories] }),
      });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      const preview = outcome.result;
      const lines: string[] = [
        "dipo run --dry-run: what `dipo run` would do now, from the base as last fetched. Nothing is claimed, created, stored or started.",
        section("Office checks"),
        ...(preview.refusals.length === 0
          ? ["none refuse the run"]
          : preview.refusals.map((refusal) => `refused (${refusal.check}): ${refusal.message}`)),
        ...(preview.notes ?? []).map((note) => `note: ${note}`),
        section("Story"),
        preview.story === null
          ? "no story would start"
          : `would start ${preview.story.story} (${preview.story.key})`,
        ...preview.skipped.flatMap((story) => [
          `skipped ${story.story}: ${REASONS[story.reason] ?? story.reason}`,
          ...(story.detail ?? []).map((line) => `  ${line}`),
        ]),
      ];
      if (preview.problem !== null) lines.push(`no launch: ${preview.problem}`);
      if (preview.launch !== null) lines.push(...launchLines(preview.launch));
      for (const line of lines) deps.writeLine(line);
      return preview.launch === null ? 1 : 0;
    },
    undefined,
    RUN_TIMEOUT_MS,
    "running",
  );
}

/** A story id as typed (Backlog.md prints ids upper-cased), or a story key as is. */
export function storyRef(text: string): StoryRefValue | null {
  const key = StoryKey.safeParse(text);
  if (key.success) return key.data;
  const id = StoryId.safeParse(text.toUpperCase());
  return id.success ? id.data : null;
}

export async function runCommand(
  args: readonly string[],
  plainDeps: OfficeCommandDeps,
): Promise<number> {
  const deps = cleanedOutput(plainDeps);
  const stories: StoryRefValue[] = [];
  const rest: string[] = [];
  let preview = false;
  let box = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--dry-run") {
      preview = true;
    } else if (arg === "--box") {
      box = true;
    } else if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (!arg.startsWith("-")) {
      const ref = storyRef(arg);
      if (ref === null) return usage(deps, `run: ${JSON.stringify(arg)} is not a story id`);
      stories.push(ref);
    } else {
      rest.push(arg);
    }
  }
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `run: ${options}`);
  if (preview) return dryRun(deps, options.office, stories);
  return withOffice(
    deps,
    options.office,
    async (session, office, from) => {
      // Subscribed before the command, so the notices that explain a skip cannot be missed.
      const explanations = new StoryExplanations();
      const subscription = await explainOffice(session, office, explanations);
      let outcome;
      try {
        outcome = await withinLimit(
          session.command(
            workRun,
            {
              ...(stories.length === 0 ? {} : { stories }),
              ...(from === undefined ? {} : { from }),
              ...(box ? { box: true } : {}),
            },
            { office },
          ),
          deps.clock,
          RUN_TIMEOUT_MS,
        );
        // Still claiming at the limit: the run may yet start, so it is followed, not reported as failed.
        if (outcome === null) {
          deps.writeError(
            `dipo: the claim is still going after ${RUN_TIMEOUT_MS / 1000} s; it may still start a story. Follow it with \`dipo watch\` or \`dipo daemon status\`.`,
          );
          return 1;
        }
        if (outcome.ok) {
          const explained = outcome.result.skipped
            .filter((story) => EXPLAINED.has(story.reason))
            .map((story) => story.story);
          await explanations.waitFor(explained, deps.clock, EXPLAIN_WAIT_MS);
        }
      } finally {
        subscription.unsubscribe();
      }
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      const { started, skipped } = outcome.result;
      for (const story of started) deps.writeLine(`started ${story.story} (run ${story.run})`);
      for (const story of skipped) {
        deps.writeLine(`skipped ${story.story}: ${REASONS[story.reason] ?? story.reason}`);
        for (const line of explanations.of(story.story)) deps.writeLine(`  ${line}`);
      }
      if (started.length > 0) return 0;
      if (skipped.length === 0) deps.writeLine("no Ready story to start");
      return 1;
    },
    undefined,
    RUN_DEADLINE_MS,
  );
}
