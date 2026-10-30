// `dipo watch`: follows one story or the whole office from the terminal without the TUI and shows
// what the engine does, in plain text without Ink. Its state is the client's `OfficeStore`, the
// one the TUI renders (DIPO-320): the store reads `office.snapshot`, follows the office stream
// after its cursor, re-reads after a history gap and subscribes again after a stream the daemon
// ended while it may retry. Watch prints the state of each running story from the store (phase,
// health, loop, verify, criteria, budget share, usage), then one readable line per event the store
// applied: run start, phases, worker output, usage and turns, health changes and the watchdog
// facts behind them, notices, parks and story moves. A run's end comes from `story.detail`
// (`endedAt`, `outcome`), which it reads again after every event that may end a run and every
// `STREAM_MARK_MS` while idle, because a run can end without a closing work event (a failed host
// start ends it with only a notice). The percentage, the health words, the output-range codec and
// the story reference are the client's, the TUI's own.
//
// It runs until it is stopped (Ctrl-C) or the store's stream ends with an error that does not
// retry. The client reconnects on its own after a lost or hung connection.

import {
  healthLabel,
  healthMeaning,
  markerRule,
  OfficeStore,
  type OutputRange,
  outputPieces,
  percent,
  RELOADED_NOTICE,
  type StoreClient,
  storyRef,
  STREAM_MARK_MS,
  usageParts,
} from "@dipsaus-orchestrator/client";
import {
  type EngineError,
  type Event,
  engineNotice,
  gateDecided,
  gateReached,
  type OfficeId,
  questionAsked,
  questionClosed,
  type RunRecord,
  storyDetail,
  storyParked,
  type StoryRefValue,
  storyState,
  type TimerHandle,
  type Usage,
  usageUpdated,
  workAssigned,
  type WorkRef,
  type WorkView,
  workObserved,
  workOutput,
  workPhase,
  workProgress,
} from "@dipsaus-orchestrator/contract";

import { cleanedOutput, type DaemonSession, engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

/** How long `dipo watch` waits for a story's detail before it reconnects. */
export const WATCH_READ_DEADLINE_MS = 15_000;

/** The client name the store's `engine.hello` sends again after a history gap. */
const WATCH_CLIENT_NAME = "dipo-cli";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The wall-clock time of an event, `HH:MM:SS` in the local time zone. */
export function clockTime(at: string | number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** One health value: its label and what it means. */
function healthText(health: string): string {
  return `${healthLabel(health)} (${healthMeaning(health)})`;
}

/** What each watchdog fact means when it is raised: the evidence behind a health value (0009). */
const SIGNAL_MEANING: Readonly<Record<string, string>> = {
  "no-output": "no output line since then",
  "same-failure": "the same failure twice in a row",
  "host-lost": "the worker host died without an exit file",
};

/** One usage line: tokens counted against the budget, its share, the parts and the turns. */
export function usageLine(value: Usage): string {
  const run = value.run;
  const cost = run.estimatedCost === undefined ? "" : ` · ~$${run.estimatedCost.toFixed(2)}`;
  return `usage ${count(value.budget.used)} of ${count(value.budget.limit)} tokens (${percent(value.budgetShare)} of budget) · in ${count(run.inputTokens)} out ${count(run.outputTokens)} cache write ${count(run.cacheCreateTokens)} cache read ${count(run.cacheReadTokens)} · ${count(run.turns)} ${run.turns === 1 ? "turn" : "turns"}${cost}`;
}

/** The state of one run, as the lines under its story in the header. */
export function workLines(view: WorkView): string[] {
  const { work, progress } = view;
  return [
    `  run ${work.run} · ${work.role} · tier ${work.tier} · model ${work.model} · started ${clockTime(view.startedAt)}`,
    `  phase ${view.phase} · health ${healthLabel(view.health)} · loop ${progress.loop}/${progress.loopCap} · verify ${progress.verify} · criteria ${progress.criteriaMet}/${progress.criteriaTotal} · budget ${percent(view.usage.budgetShare)} of ${count(view.usage.budget.limit)} tokens`,
    `  ${usageLine(view.usage)}`,
    ...(view.lastOutputAt === undefined ? [] : [`  last output ${clockTime(view.lastOutputAt)}`]),
  ];
}

/** One run of a story's history. */
export function runLine(run: RunRecord): string {
  const end =
    run.inReviewSince !== undefined
      ? `at In Review since ${clockTime(run.inReviewSince)}`
      : run.endedAt === undefined
        ? "still running"
        : `ended ${clockTime(run.endedAt)} (${run.outcome ?? "no outcome recorded"})`;
  return `  run ${run.run} · started ${clockTime(run.startedAt)} · ${end} · ${count(run.usage.turns)} turns`;
}

/**
 * True when `text` names the story `id` as a whole id: the character after it is not a letter,
 * digit, or a dot and a digit, so `DIPO-5` does not match `DIPO-52` or `DIPO-5.1`.
 */
export function mentions(text: string, id: string): boolean {
  for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, at + 1)) {
    const before = at === 0 ? "" : (text[at - 1] ?? "");
    const after = text[at + id.length] ?? "";
    const next = text[at + id.length + 1] ?? "";
    // A dot ends a sentence unless a digit follows (`DIPO-5.1` is a sub-story).
    const continues = /[A-Za-z0-9]/.test(after) || (after === "." && /[0-9]/.test(next));
    if (!continues && !/[A-Za-z0-9-]/.test(before)) return true;
  }
  return false;
}

/** The story an event is about, by key; null for one that names none. */
function keyOf(event: Event): string | null {
  const data = event.data as { key?: unknown; work?: { key?: unknown } } | null;
  if (data === null || typeof data !== "object") return null;
  if (typeof data.key === "string") return data.key;
  if (typeof data.work?.key === "string") return data.work.key;
  return null;
}

/**
 * The store's client from the CLI's session. The session already waits out a recovering daemon
 * and its client reconnects and subscribes again by itself, so the store sees one open connection.
 */
function storeClientOf(session: DaemonSession): StoreClient {
  return {
    state: "open",
    hello: session.hello ?? null,
    onState: () => () => undefined,
    read: session.read.bind(session),
    subscribe: session.subscribe.bind(session),
  };
}

/** Follows one office from its `OfficeStore`: the stories' runs, their health and their output. */
class Watch {
  readonly #deps: OfficeCommandDeps;
  readonly #session: DaemonSession;
  readonly #store: OfficeStore;
  readonly #office: OfficeId;
  /** The story watched, by key and id; null watches the whole office. */
  readonly #story: { readonly key: string; readonly id: string } | null;
  /** Questions this watch printed, so their close is printed too (DIPO-59). */
  readonly #questions = new Set<string>();
  /** The last health printed per run, so only a change is printed. */
  readonly #health = new Map<string, string>();
  /** The last usage line printed per run, so an unchanged one is not repeated. */
  readonly #usage = new Map<string, string>();
  /** Runs seen running whose end is not printed yet, with their story key. */
  readonly #running = new Map<string, string>();
  /** A partial output line per run, until its newline arrives. */
  readonly #partial = new Map<string, string>();
  /** Events the store applied while the header was still being printed. */
  #held: Event[] | null = [];
  /** The store snapshots the header was printed for. */
  #snapshots = 0;
  /** A history gap made the store read the office again; a failed re-read ends the watch. */
  #reloading = false;
  /** A check of run ends is running; `#recheck` asks for one more after it. */
  #checking = false;
  #recheck = false;
  #idle: TimerHandle | null = null;
  readonly #stops: (() => void)[] = [];
  #finish: ((code: number) => void) | null = null;

  constructor(
    deps: OfficeCommandDeps,
    session: DaemonSession,
    office: OfficeId,
    story: { readonly key: string; readonly id: string } | null,
  ) {
    this.#deps = deps;
    this.#session = session;
    this.#office = office;
    this.#story = story;
    this.#store = new OfficeStore({
      client: storeClientOf(session),
      clock: deps.clock,
      clientInfo: { name: WATCH_CLIENT_NAME, version: deps.version },
    });
  }

  #line(text: string): void {
    this.#deps.writeLine(text);
  }

  #event(event: Event, story: string, kind: string, text: string): void {
    this.#line(`${clockTime(event.at)} ${story} ${kind.padEnd(6)} ${text}`);
  }

  #watches(key: string | null): boolean {
    return this.#story === null || key === this.#story.key;
  }

  /** Opens the office in the store, prints its state, then follows it until its stream ends. */
  async run(): Promise<number> {
    const done = new Promise<number>((resolve) => {
      this.#finish = resolve;
    });
    this.#store.start();
    this.#stops.push(this.#store.onOfficeEvent((event) => this.#take(event)));
    const failed = await this.#open();
    if (failed !== null) {
      this.#end(engineFailure(this.#deps, failed));
      return done;
    }
    this.#snapshots = this.#store.state.snapshots;
    await this.#header();
    this.#stops.push(this.#store.subscribe(() => this.#changed()));
    this.#armIdle();
    this.#changed();
    return done;
  }

  /**
   * Opens the office: null once the store applied its snapshot, else the error that ends the
   * watch. A daemon still recovering is waited for; the store reads again on its own.
   */
  async #open(): Promise<EngineError | null> {
    const first = await this.#store.open(this.#office);
    if (first.ok) return null;
    if (first.error.code !== "engine.recovering") return first.error;
    return new Promise((resolve) => {
      const stop = this.#store.subscribe(() => {
        const { snapshots, error } = this.#store.state;
        if (snapshots > 0) resolve(null);
        else if (error !== null && error.code !== "engine.recovering") resolve(error);
        else return;
        stop();
      });
    });
  }

  /** Prints the state of the watched runs from the store, ended by `--`. */
  async #header(): Promise<void> {
    this.#held ??= [];
    const state = this.#store.state;
    const target = this.#story;
    const watched =
      target === null ? state.stories : state.stories.filter((view) => view.key === target.key);
    const running = state.work.filter((view) => this.#watches(view.work.key));
    this.#line(
      target === null
        ? `dipo watch: office ${this.#office} · ${running.length} running · Ctrl-C to stop`
        : `dipo watch: ${target.id} in office ${this.#office} · Ctrl-C to stop`,
    );
    const usageText = usageParts(
      state.offices.find((entry) => entry.office === this.#office)?.summary,
      this.#deps.clock.now(),
    );
    if (usageText.length > 0) this.#line(`  usage ${usageText.join(" · ")}`);
    for (const view of running) {
      const story = watched.find((candidate) => candidate.key === view.work.key);
      this.#line(
        `${view.work.story} ${story === undefined ? "" : `"${story.title}" · ${story.lifecycle} (${story.column})`}`.trimEnd(),
      );
      for (const line of workLines(view)) this.#line(line);
      this.#health.set(view.work.run, view.health);
      this.#running.set(view.work.run, view.work.key);
    }
    if (target !== null && running.length === 0) {
      const story = watched[0];
      const where = story === undefined ? "" : ` is ${story.lifecycle} (${story.column})`;
      this.#line(`${target.id}${where}; no run is active. Waiting for one to start.`);
      if (story?.waitingOn !== undefined) this.#line(`  waiting on ${story.waitingOn.join(", ")}`);
      for (const message of story?.gateMessages ?? []) this.#line(`  ${message}`);
      if (story?.parked !== undefined) {
        this.#line(
          `  parked ${story.parked.reason} since ${clockTime(story.parked.since)}: ${story.parked.detail}`,
        );
      }
      const detail = await this.#detail(target.key);
      const last = detail?.runs.at(-1);
      if (last !== undefined) this.#line(`  last ${runLine(last).trimStart()}`);
    }
    if (target === null && running.length === 0) {
      this.#line("no story is running. Waiting for a run to start (dipo run).");
    }
    for (const question of state.questions) {
      if (!this.#watches(question.work.key)) continue;
      this.#questions.add(question.question);
      this.#line(
        `${question.work.story} asks ${question.kind} ${question.question}: ${question.text} (answer with dipo answer ${question.question} ${question.kind === "permission" ? "allow|deny" : "<text>"})`,
      );
    }
    this.#line("--");
    const held = this.#held;
    this.#held = null;
    for (const event of held) this.#onEvent(event);
  }

  async #detail(key: string) {
    const detail = await this.#session.read(
      storyDetail,
      { office: this.#office, story: key as StoryRefValue },
      { deadlineMs: WATCH_READ_DEADLINE_MS },
    );
    return detail.ok ? detail.result : null;
  }

  /** The store changed: a history gap, a new snapshot, or a stream that ended for good. */
  #changed(): void {
    if (this.#finish === null) return;
    const state = this.#store.state;
    if (state.notice === RELOADED_NOTICE) {
      this.#reloading = true;
      this.#store.dismissNotice();
      this.#line("-- view reloaded (history gap) --");
      return;
    }
    if (state.snapshots > this.#snapshots) {
      this.#snapshots = state.snapshots;
      this.#reloading = false;
      void this.#header();
      return;
    }
    const failed =
      state.streamError ??
      (this.#reloading && !state.loading && state.error?.code !== "engine.recovering"
        ? state.error
        : null);
    if (failed !== null) this.#end(engineFailure(this.#deps, failed));
  }

  /** Ends the watch with `code`: it stops listening and closes the store. */
  #end(code: number): void {
    const finish = this.#finish;
    if (finish === null) return;
    this.#finish = null;
    if (this.#idle !== null) this.#deps.clock.clearTimeout(this.#idle);
    this.#idle = null;
    for (const stop of this.#stops.splice(0)) stop();
    this.#store.close();
    finish(code);
  }

  /** While idle, a run may end without an event (a failed start, a release): look every mark. */
  #armIdle(): void {
    if (this.#finish === null) return;
    this.#idle = this.#deps.clock.setTimeout(() => {
      this.#idle = null;
      void this.#checkEnds();
      this.#armIdle();
    }, STREAM_MARK_MS);
  }

  /** An event the store applied: printed now, or after the header that is being printed. */
  #take(event: Event): void {
    if (this.#held !== null) this.#held.push(event);
    else this.#onEvent(event);
  }

  #onEvent(event: Event): void {
    if (event.type === engineNotice.type) {
      this.#notice(event);
      return;
    }
    if (event.type === questionClosed.type) {
      // It names only the question: printed when this watch printed the question (DIPO-59).
      const data = questionClosed.data.safeParse(event.data);
      if (!data.success || !this.#questions.delete(data.data.question)) return;
      const answer = data.data.answer;
      this.#line(
        `${clockTime(event.at)} question ${data.data.question} closed${answer === undefined ? " without an answer" : `: ${answer}`}`,
      );
      return;
    }
    const key = keyOf(event);
    if (!this.#watches(key)) return;
    switch (event.type) {
      case questionAsked.type: {
        const data = questionAsked.data.safeParse(event.data);
        if (!data.success) break;
        const question = data.data;
        this.#questions.add(question.question);
        this.#event(
          event,
          question.work.story,
          "asks",
          `${question.kind} ${question.question}: ${question.text} (answer with dipo answer ${question.question} ${question.kind === "permission" ? "allow|deny" : "<text>"})`,
        );
        break;
      }
      case workAssigned.type: {
        const data = workAssigned.data.safeParse(event.data);
        if (!data.success) break;
        const { work } = data.data;
        this.#running.set(work.run, work.key);
        this.#event(
          event,
          work.story,
          "run",
          `started ${work.run} · ${work.role} · tier ${work.tier} · model ${work.model}`,
        );
        this.#view(event, work);
        break;
      }
      case workPhase.type: {
        const data = workPhase.data.safeParse(event.data);
        if (!data.success) break;
        const { work, phase, progress } = data.data;
        this.#event(
          event,
          work.story,
          "phase",
          `${phase} · loop ${progress.loop}/${progress.loopCap} · verify ${progress.verify} · criteria ${progress.criteriaMet}/${progress.criteriaTotal}`,
        );
        this.#view(event, work);
        break;
      }
      case workProgress.type: {
        const data = workProgress.data.safeParse(event.data);
        if (!data.success) break;
        const { work, progress } = data.data;
        this.#event(
          event,
          work.story,
          "prog",
          `loop ${progress.loop}/${progress.loopCap} · verify ${progress.verify} · criteria ${progress.criteriaMet}/${progress.criteriaTotal} · review round ${progress.reviewRound}`,
        );
        this.#view(event, work);
        break;
      }
      case workOutput.type: {
        const data = workOutput.data.safeParse(event.data);
        if (!data.success) break;
        this.#output(event, data.data.work, data.data.source, data.data);
        this.#view(event, data.data.work);
        break;
      }
      case usageUpdated.type: {
        const data = usageUpdated.data.safeParse(event.data);
        if (!data.success) break;
        const { work } = data.data;
        const text = usageLine(data.data.usage);
        if (this.#usage.get(work.run) !== text) {
          this.#usage.set(work.run, text);
          this.#event(event, work.story, "usage", text.slice("usage ".length));
        }
        this.#view(event, work);
        break;
      }
      case workObserved.type: {
        const data = workObserved.data.safeParse(event.data);
        if (!data.success) break;
        const { work, signal, since, clearedAt, view } = data.data;
        // The same `no-output` fact is observed again once it is stuck; the carried view says so.
        const stuck = signal === "no-output" && view?.health === "stuck";
        this.#event(
          event,
          work.story,
          "signal",
          clearedAt !== undefined
            ? `${signal} cleared: output resumed (it began ${clockTime(since)})`
            : stuck
              ? `${signal} since ${clockTime(since)}, stuck: no output line past timeouts.workerStallMinutes`
              : `${signal} since ${clockTime(since)}: ${SIGNAL_MEANING[signal] ?? signal}`,
        );
        this.#view(event, work);
        break;
      }
      case storyParked.type: {
        const data = storyParked.data.safeParse(event.data);
        if (!data.success) break;
        const park = data.data;
        this.#event(
          event,
          park.story,
          "parked",
          `${park.reason} (from ${park.from}): ${park.detail}`,
        );
        if (park.actions.length > 0) {
          this.#event(event, park.story, "parked", `you can: ${park.actions.join(", ")}`);
        }
        void this.#checkEnds();
        break;
      }
      case storyState.type: {
        const data = storyState.data.safeParse(event.data);
        if (!data.success) break;
        const move = data.data;
        this.#event(event, move.story, "state", `${move.from} -> ${move.to} (${move.view.column})`);
        for (const line of move.detail ?? []) this.#event(event, move.story, "state", `  ${line}`);
        void this.#checkEnds();
        break;
      }
      case gateReached.type: {
        const data = gateReached.data.safeParse(event.data);
        if (!data.success) break;
        const gate = data.data;
        this.#event(
          event,
          gate.work.story,
          "gate",
          `${gate.kind} gate ${gate.gate} waits on ${gate.waitingOn}: ${gate.summary}`,
        );
        break;
      }
      case gateDecided.type: {
        const data = gateDecided.data.safeParse(event.data);
        if (!data.success) break;
        const gate = data.data;
        this.#line(
          `${clockTime(event.at)} gate ${gate.gate} ${gate.decision} by ${gate.by}${gate.note === undefined ? "" : `: ${gate.note}`}`,
        );
        break;
      }
      default:
        break;
    }
  }

  /**
   * Worker output, one line per output line; a partial line waits for its newline. The range is
   * cut at its flagged engine markers (DIPO-95) with the client's codec; a marker ends the partial
   * line and prints as the TUI's rule with its local time, in ASCII when the output is not a
   * terminal. Worker text that reads like a marker has no flag and prints as text.
   */
  #output(event: Event, work: WorkRef, source: string, range: OutputRange): void {
    const tag = source === "worker" ? "out" : source;
    for (const piece of outputPieces(range.text, range.from, range.markers ?? [])) {
      if (typeof piece === "string") {
        this.#text(event, work, tag, piece);
        continue;
      }
      const partial = this.#partial.get(work.run);
      this.#partial.delete(work.run);
      if (partial !== undefined) this.#event(event, work.story, tag, partial);
      this.#event(event, work.story, tag, markerRule(piece, !this.#deps.workspace.interactive));
    }
  }

  /** Output text, one line per output line; a partial line waits for its newline. */
  #text(event: Event, work: WorkRef, tag: string, text: string): void {
    if (text === "") return;
    const pending = (this.#partial.get(work.run) ?? "") + text;
    const lines = pending.split("\n");
    const rest = lines.pop() ?? "";
    if (rest === "") this.#partial.delete(work.run);
    else this.#partial.set(work.run, rest);
    for (const line of lines) this.#event(event, work.story, tag, line);
  }

  /** Prints the run's health when the store's view of the run changed it. */
  #view(event: Event, work: WorkRef): void {
    const view = this.#store.state.work.find((candidate) => candidate.work.run === work.run);
    if (view === undefined || this.#health.get(work.run) === view.health) return;
    this.#health.set(work.run, view.health);
    this.#event(event, work.story, "health", healthText(view.health));
  }

  #notice(event: Event): void {
    const data = engineNotice.data.safeParse(event.data);
    if (!data.success) return;
    const notice = data.data;
    if (this.#story !== null && !mentions(notice.text, this.#story.id)) return;
    this.#line(`${clockTime(event.at)} notice ${notice.level} ${notice.code}: ${notice.text}`);
    void this.#checkEnds();
  }

  /** Prints the end of every run seen running that has ended since (`runs.ended_at`). */
  async #checkEnds(): Promise<void> {
    if (this.#checking) {
      this.#recheck = true;
      return;
    }
    this.#checking = true;
    try {
      do {
        this.#recheck = false;
        await this.#checkEndsOnce();
      } while (this.#recheck);
    } finally {
      this.#checking = false;
    }
  }

  /** One pass: the end of every run seen running that has ended since. */
  async #checkEndsOnce(): Promise<void> {
    const keys = new Set(this.#running.values());
    if (this.#story !== null) keys.add(this.#story.key);
    for (const key of keys) {
      const detail = await this.#detail(key);
      if (detail === null) continue;
      for (const run of detail.runs) {
        if (run.inReviewSince !== undefined) {
          // At In Review the run's session period is over (0020): told once, with its done report,
          // when it gets there; a fix round or a review that follows is a run seen running again.
          if (!this.#running.has(run.run)) continue;
          this.#running.delete(run.run);
          this.#line(
            `${clockTime(run.inReviewSince)} ${detail.view.story} end    run ${run.run} at In Review · ${count(run.usage.turns)} turns`,
          );
          for (const line of doneReportLines(run)) this.#line(line);
          continue;
        }
        if (run.endedAt === undefined) {
          // A run of the watched story that started while the stream was away.
          if (this.#story !== null && !this.#running.has(run.run)) this.#running.set(run.run, key);
          continue;
        }
        if (!this.#running.has(run.run)) continue;
        this.#running.delete(run.run);
        this.#line(
          `${clockTime(run.endedAt)} ${detail.view.story} end    run ${run.run} ended: ${run.outcome ?? "no outcome recorded"} · ${count(run.usage.turns)} turns`,
        );
        for (const line of doneReportLines(run)) this.#line(line);
      }
    }
  }
}

export async function watchCommand(
  args: readonly string[],
  plainDeps: OfficeCommandDeps,
): Promise<number> {
  const deps = cleanedOutput(plainDeps);
  const rest: string[] = [];
  let story: StoryRefValue | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--office") {
      rest.push(arg, ...(i + 1 < args.length ? [args[i + 1] ?? ""] : []));
      i += 1;
    } else if (!arg.startsWith("-")) {
      if (story !== null) return usage(deps, "watch takes at most one story id");
      const ref = storyRef(arg);
      if (ref === null) return usage(deps, `watch: ${JSON.stringify(arg)} is not a story id`);
      story = ref;
    } else {
      rest.push(arg);
    }
  }
  const options = parseOptions(rest, false);
  if (typeof options === "string") return usage(deps, `watch: ${options}`);
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      let target: { key: string; id: string } | null = null;
      if (story !== null) {
        const detail = await session.read(
          storyDetail,
          { office, story },
          { deadlineMs: WATCH_READ_DEADLINE_MS },
        );
        if (!detail.ok) {
          return detail.error.code === "office.unknown"
            ? "unknown"
            : engineFailure(deps, detail.error);
        }
        target = { key: detail.result.view.key, id: detail.result.view.story };
      }
      return new Watch(deps, session, office, target).run();
    },
    undefined,
    Number.POSITIVE_INFINITY,
    "running",
  );
}

/** The done report's notes and proposals of an ended run, marked as the worker's words (DIPO-152). */
export function doneReportLines(run: RunRecord): string[] {
  const report = run.doneReport;
  if (report === undefined) return [];
  return [
    "  worker's done report (the worker's words, not checked by dipo):",
    ...(report.notes === undefined
      ? []
      : report.notes.split("\n").map((line) => `    ${line}`.trimEnd())),
    ...(report.proposals ?? []).map(
      (proposal) => `    proposal (${proposal.kind}): ${proposal.title} — ${proposal.outcome}`,
    ),
  ];
}
