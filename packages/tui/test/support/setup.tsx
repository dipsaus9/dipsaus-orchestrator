// Mounts the TUI `App` over the fake session and the harness, for render tests.

import { OfficeStore } from "@dipsaus-orchestrator/client";
import { systemClock } from "@dipsaus-orchestrator/client/node";
import type {
  Clock,
  OfficeId,
  OfficeSnapshot,
  RequestId,
  TimerHandle,
} from "@dipsaus-orchestrator/contract";

import type { CommandOutcome, LossesOutcome } from "../../src/actions";
import { App, type RunOutcome, type StoryOutcome, type TuiActions } from "../../src/app";
import type { DeskOutcome } from "../../src/desk";
import type { PromptOutcome } from "../../src/detail";
import type { DigestOutcome } from "../../src/digest";
import type { Display } from "../../src/options";
import type { RangeOutcome } from "../../src/output";
import { FakeSession } from "./fake-session";
import { render, type RenderSize } from "./harness";

/** A clock the test moves by hand; the App and the store only read it. */
export class TestClock implements Clock {
  #now: number;

  constructor(start = Date.parse("2026-10-14T10:04:00.000Z")) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  /** Real timers: the event batching (100 ms) runs on them while `now` stays where the test put it. */
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    return systemClock.setTimeout(callback, delayMs);
  }

  clearTimeout(handle: TimerHandle): void {
    systemClock.clearTimeout(handle);
  }
}

export interface MountOptions extends RenderSize {
  readonly display?: Display;
  /** The office opened at start; null starts in the switcher. */
  readonly office?: OfficeId | null;
  /** Bytes an output pane keeps while following; small values make scroll-back read sooner. */
  readonly outputTailBytes?: number;
  /** Snapshots answered instead of the golden ones, by office (DIPO-81 board scenarios). */
  readonly snapshots?: ReadonlyMap<OfficeId, OfficeSnapshot>;
}

export async function mount(options: MountOptions = {}) {
  const session = new FakeSession();
  for (const [office, snapshot] of options.snapshots ?? [])
    session.nextSnapshots.set(office, snapshot);
  const clock = new TestClock();
  const store = new OfficeStore({
    client: session,
    clock,
    clientInfo: { name: "test", version: "0" },
  });
  store.start();
  const office =
    options.office === undefined ? (store.state.offices[0]?.office ?? null) : options.office;
  if (office !== null) await store.open(office);
  let quits = 0;
  let requests = 0;
  const actions: TuiActions = {
    openPath: async (path) => {
      const outcome = await session.command({ name: "office.open" } as never, { path } as never);
      return outcome.ok
        ? { ok: true, value: (outcome.result as { office: OfficeId }).office }
        : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` };
    },
    setPrivacy: async (request) => {
      const outcome = await session.command(
        { name: "office.setPrivacy" } as never,
        { office: request.office, key: request.key, value: request.value } as never,
        { requestId: request.requestId, confirmed: true },
      );
      return outcome.ok
        ? { ok: true, value: null }
        : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` };
    },
    runStories: async (request) =>
      (await session.command(
        { name: "work.run" } as never,
        (request.stories === undefined ? {} : { stories: [...request.stories] }) as never,
        { office: request.office, requestId: request.requestId },
      )) as RunOutcome,
    readOutput: async (request) =>
      (await session.read(
        { name: "work.outputRange" } as never,
        {
          office: request.office,
          run: request.run,
          source: request.source,
          from: request.from,
          ...(request.to === undefined ? {} : { to: request.to }),
        } as never,
      )) as RangeOutcome,
    readPrompt: async (request) =>
      (await session.read(
        { name: "work.prompt" } as never,
        { office: request.office, run: request.run, agent: request.agent } as never,
      )) as PromptOutcome,
    readStory: async (request) =>
      (await session.read(
        { name: "story.detail" } as never,
        { office: request.office, story: request.story } as never,
      )) as StoryOutcome,
    sendCommand: async (request) =>
      (await session.command({ name: request.command } as never, request.args as never, {
        office: request.office,
        requestId: request.requestId,
        confirmed: request.confirmed,
      })) as CommandOutcome,
    readLosses: async (request) =>
      (await session.read(
        { name: "story.losses" } as never,
        { office: request.office, story: request.story, command: request.command } as never,
      )) as LossesOutcome,
    readDesk: async (opened) =>
      (await session.read(
        { name: "office.desk" } as never,
        { office: opened } as never,
      )) as DeskOutcome,
    readDigest: async (opened) =>
      (await session.read(
        { name: "office.digest" } as never,
        { office: opened } as never,
      )) as DigestOutcome,
    newRequestId: () => {
      requests += 1;
      return `01J9ZK5Q8W3V4X6Y7Z8A9B0R${String(requests).padStart(2, "0")}` as RequestId;
    },
  };
  const ui = render(
    <App
      store={store}
      clock={clock}
      display={options.display ?? { color: true, ascii: false }}
      actions={actions}
      onQuit={() => {
        quits += 1;
      }}
      startInSwitcher={office === null}
      {...(options.outputTailBytes === undefined
        ? {}
        : { outputTailBytes: options.outputTailBytes })}
    />,
    options,
  );
  return {
    session,
    store,
    clock,
    ui,
    quits: () => quits,
  };
}
