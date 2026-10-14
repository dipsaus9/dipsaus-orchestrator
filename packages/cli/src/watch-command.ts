// `dipo watch [ID] [--office <id>]` (DIPO-52; 0009 section 9): follows an office, or one story of
// it, in plain text without Ink. It reads `office.snapshot` (and `story.detail` for a story), prints
// the state of each running story (phase, health, loop, verify, criteria, budget share, usage),
// then subscribes after the snapshot's cursor and prints one readable line per event as it comes:
// run start, phases, worker output, usage and turns, health changes and watchdog signals, notices,
// parks and story moves. A run's end comes from `story.detail` (`endedAt`, `outcome`), which it
// reads again after every event that may end a run and on idle stream marks, because a run can end
// without a closing work event (a failed host start ends it with only a notice).
//
// It runs until it is stopped (Ctrl-C). A history gap (`stream.resetRequired`) reads the snapshot
// again and says so. The client reconnects on its own after a lost or hung connection.

import {
  type Event,
  engineNotice,
  gateDecided,
  gateReached,
  type OfficeId,
  officeSnapshot,
  type RunRecord,
  storyDetail,
  storyParked,
  type StoryRefValue,
  storyState,
  StreamName,
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

import { type DaemonSession, engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";
import { storyRef } from "./run-command";

/** How long `dipo watch` waits for a snapshot or a story's detail before it reconnects. */
export const WATCH_READ_DEADLINE_MS = 15_000;

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

function percent(share: number): string {
  const value = share * 100;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

/** What each health state means, for people (0009 section 3). */
const HEALTH_MEANING: Readonly<Record<string, string>> = {
  busy: "the worker is producing output",
  quiet: "no output for a few minutes (timeouts.workerQuietMinutes)",
  stuck: "no output for a long time (timeouts.workerStallMinutes); the worker may hang",
  looping: "the same failure repeats, or the worker is on its last allowed loop",
  paused: "paused by you",
  limited: "waiting for the plan limit to reset",
  asking: "waiting for your answer",
  lost: "the worker exited or its host is gone, and dipo has not processed that yet",
};

/** What each watchdog signal means when it is raised. */
const SIGNAL_MEANING: Readonly<Record<string, string>> = {
  quiet: "no output line for timeouts.workerQuietMinutes",
  "no-output": "no output line for timeouts.workerStallMinutes",
  "same-failure": "the same failure twice in a row",
  "input-wait": "the worker waits for a permission or input",
  "plan-limit": "the plan limit was hit; the run waits for the reset",
  "host-lost": "the worker host died without an exit file",
  "follow-only": "the worker can be followed but not steered",
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
  const signals =
    view.signals.length === 0
      ? []
      : [
          `  signals: ${view.signals.map((s) => `${s.signal} since ${clockTime(s.since)}`).join(", ")}`,
        ];
  return [
    `  run ${work.run} · ${work.role} · tier ${work.tier} · model ${work.model} · started ${clockTime(view.startedAt)}`,
    `  phase ${view.phase} · health ${view.health} · loop ${progress.loop}/${progress.loopCap} · verify ${progress.verify} · criteria ${progress.criteriaMet}/${progress.criteriaTotal} · budget ${percent(view.usage.budgetShare)} of ${count(view.usage.budget.limit)} tokens`,
    `  ${usageLine(view.usage)}`,
    ...signals,
    ...(view.lastOutputAt === undefined ? [] : [`  last output ${clockTime(view.lastOutputAt)}`]),
  ];
}

/** One run of a story's history. */
export function runLine(run: RunRecord): string {
  const end =
    run.endedAt === undefined
      ? "still running"
      : `ended ${clockTime(run.endedAt)} (${run.outcome ?? "no outcome recorded"})`;
  return `  run ${run.run} · started ${clockTime(run.startedAt)} · ${end} · ${count(run.usage.turns)} turns`;
}

/** The story an event is about, by key; null for one that names none. */
function keyOf(event: Event): string | null {
  const data = event.data as { key?: unknown; work?: { key?: unknown } } | null;
  if (data === null || typeof data !== "object") return null;
  if (typeof data.key === "string") return data.key;
  if (typeof data.work?.key === "string") return data.work.key;
  return null;
}

/** Follows one office: its stories' runs, their health and their output, as plain lines. */
class Watch {
  readonly #deps: OfficeCommandDeps;
  readonly #session: DaemonSession;
  readonly #office: OfficeId;
  /** The story watched, by key and id; null watches the whole office. */
  readonly #story: { readonly key: string; readonly id: string } | null;
  /** The last health printed per run, so only a change is printed. */
  readonly #health = new Map<string, string>();
  /** The last usage line printed per run, so an unchanged one is not repeated. */
  readonly #usage = new Map<string, string>();
  /** Runs seen running whose end is not printed yet, with their story key. */
  readonly #running = new Map<string, string>();
  /** A partial output line per run, until its newline arrives. */
  readonly #partial = new Map<string, string>();
  /** A check of run ends is running; `#recheck` asks for one more after it. */
  #checking = false;
  #recheck = false;

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

  /** Reads the snapshot, prints the state, and returns its cursor; null when the read failed. */
  async start(): Promise<number> {
    const snapshot = await this.#session.read(
      officeSnapshot,
      { office: this.#office },
      { deadlineMs: WATCH_READ_DEADLINE_MS },
    );
    if (!snapshot.ok) return engineFailure(this.#deps, snapshot.error);
    const { stories, work } = snapshot.result;
    const target = this.#story;
    const watched = target === null ? stories : stories.filter((view) => view.key === target.key);
    const running = work.filter((view) => this.#watches(view.work.key));
    this.#line(
      target === null
        ? `dipo watch: office ${this.#office} · ${running.length} running · Ctrl-C to stop`
        : `dipo watch: ${target.id} in office ${this.#office} · Ctrl-C to stop`,
    );
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
      const state = story === undefined ? "" : ` is ${story.lifecycle} (${story.column})`;
      this.#line(`${target.id}${state}; no run is active. Waiting for one to start.`);
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
    this.#line("--");
    return this.#subscribe(snapshot.result.cursor);
  }

  async #detail(key: string) {
    const detail = await this.#session.read(
      storyDetail,
      { office: this.#office, story: key as StoryRefValue },
      { deadlineMs: WATCH_READ_DEADLINE_MS },
    );
    return detail.ok ? detail.result : null;
  }

  /** Subscribes after `cursor` and resolves only when the subscription cannot go on. */
  #subscribe(cursor: Parameters<DaemonSession["subscribe"]>[1]["after"]): Promise<number> {
    return new Promise<number>((resolve) => {
      this.#session.subscribe(StreamName.parse(`office:${this.#office}`), {
        ...(cursor === undefined ? {} : { after: cursor }),
        onEvent: (event) => this.#onEvent(event),
        onEnded: (error) => {
          if (error.code !== "stream.resetRequired") {
            resolve(engineFailure(this.#deps, error));
            return;
          }
          this.#line("-- view reloaded (history gap) --");
          void this.start().then(resolve);
        },
      });
    });
  }

  #onEvent(event: Event): void {
    if (event.type === "stream.mark") {
      // Idle: a run may have ended without an event (a failed start, a release).
      void this.#checkEnds();
      return;
    }
    if (event.type === engineNotice.type) {
      this.#notice(event);
      return;
    }
    const key = keyOf(event);
    if (!this.#watches(key)) return;
    switch (event.type) {
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
        this.#view(event, work, data.data.view);
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
        this.#view(event, work, data.data.view);
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
        this.#view(event, work, data.data.view);
        break;
      }
      case workOutput.type: {
        const data = workOutput.data.safeParse(event.data);
        if (!data.success) break;
        this.#output(event, data.data.work, data.data.source, data.data.text);
        this.#view(event, data.data.work, data.data.view);
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
        this.#view(event, work, data.data.view);
        break;
      }
      case workObserved.type: {
        const data = workObserved.data.safeParse(event.data);
        if (!data.success) break;
        const { work, signal, since, clearedAt } = data.data;
        this.#event(
          event,
          work.story,
          "signal",
          clearedAt === undefined
            ? `${signal} since ${clockTime(since)}: ${SIGNAL_MEANING[signal] ?? signal}`
            : `${signal} cleared: output resumed (it began ${clockTime(since)})`,
        );
        this.#view(event, work, data.data.view);
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

  /** Worker output, one line per output line; a partial line waits for its newline. */
  #output(event: Event, work: WorkRef, source: string, text: string): void {
    const tag = source === "worker" ? "out" : source;
    const pending = (this.#partial.get(work.run) ?? "") + text;
    const lines = pending.split("\n");
    const rest = lines.pop() ?? "";
    if (rest === "") this.#partial.delete(work.run);
    else this.#partial.set(work.run, rest);
    for (const line of lines) this.#event(event, work.story, tag, line);
  }

  /** Prints the run's health when the view the event carries changed it. */
  #view(event: Event, work: WorkRef, view: WorkView | undefined): void {
    if (view === undefined) return;
    if (this.#health.get(work.run) === view.health) return;
    this.#health.set(work.run, view.health);
    this.#event(
      event,
      work.story,
      "health",
      `${view.health}: ${HEALTH_MEANING[view.health] ?? view.health}`,
    );
  }

  #notice(event: Event): void {
    const data = engineNotice.data.safeParse(event.data);
    if (!data.success) return;
    const notice = data.data;
    if (this.#story !== null && !notice.text.includes(this.#story.id)) return;
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
      }
    }
  }
}

export async function watchCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
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
      return new Watch(deps, session, office, target).start();
    },
    undefined,
    Number.POSITIVE_INFINITY,
  );
}
