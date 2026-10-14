// Mounts the TUI `App` over the fake session and the harness, for render tests.

import { OfficeStore } from "@dipsaus-orchestrator/client";
import type { Clock, OfficeId, TimerHandle } from "@dipsaus-orchestrator/contract";

import { App, type TuiActions } from "../app";
import type { Display } from "../options";
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

  setTimeout(): TimerHandle {
    throw new Error("the TUI arms no timers in these tests");
  }

  clearTimeout(): void {}
}

export interface MountOptions extends RenderSize {
  readonly display?: Display;
  /** The office opened at start; null starts in the switcher. */
  readonly office?: OfficeId | null;
}

export async function mount(options: MountOptions = {}) {
  const session = new FakeSession();
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
  const actions: TuiActions = {
    openPath: async (path) => {
      const outcome = await session.command({ name: "office.open" } as never, { path } as never);
      return outcome.ok
        ? { ok: true, value: (outcome.result as { office: OfficeId }).office }
        : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` };
    },
    resumeScheduling: async () => {
      await session.command({ name: "daemon.resumeScheduling" } as never, {} as never);
      return { ok: true, value: null };
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
