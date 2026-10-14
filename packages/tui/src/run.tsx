// `dipo tui` (0009 sections 1, 2 and 7): checks for a terminal, renders `starting…` while the
// client connects (the connect function starts the daemon when autostart allows, 0006), feeds an
// `OfficeStore` and opens the office of the current directory, else the first registered one,
// else the switcher. Quitting, Ctrl+C and SIGTERM unmount Ink, which leaves the alternate screen
// and raw mode, so the shell gets its terminal back.

import { type DipoClient, OfficeStore, type StoreClient } from "@dipsaus-orchestrator/client";
import {
  type Clock,
  daemonResumeScheduling,
  type OfficeId,
  officeOpen,
} from "@dipsaus-orchestrator/contract";
import { render, Text, useInput } from "ink";

import { App, type TuiActions } from "./app";
import { parseTuiArgs } from "./options";

/** What the TUI needs from a connected client. `DipoClient` is one. */
export type TuiSession = StoreClient & Pick<DipoClient, "command" | "close">;

/** The streams Ink reads and writes; `process.stdin` and `process.stdout` in the binary. */
export interface TuiStreams {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
}

export interface TuiDeps extends TuiStreams {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  /** Writes one line to stderr, outside Ink. */
  readonly writeError: (line: string) => void;
  /** Connects to the daemon, starting it first when autostart allows; throws a readable Error. */
  readonly connect: () => Promise<TuiSession>;
  /** The office of the current directory, when it is one. */
  readonly currentOffice: () => Promise<OfficeId | null>;
  /** An absolute path for what the maintainer typed (`~` and relative paths). */
  readonly resolvePath: (path: string) => string;
  /** Calls `handler` on the signal; returns a function that stops it. */
  readonly onSignal: (signal: "SIGTERM" | "SIGHUP", handler: () => void) => () => void;
  readonly clientInfo: { readonly name: string; readonly version: string };
}

/** The one line printed when stdin is not a terminal (0009 section 1 check 4). */
export const NO_TTY_MESSAGE =
  "dipo tui: needs an interactive terminal (stdin is not a TTY); use `dipo watch` for plain text";

/** True when Ink can put stdin in raw mode. */
export function isRawModeSupported(stdin: NodeJS.ReadStream): boolean {
  return stdin.isTTY === true && typeof stdin.setRawMode === "function";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs the TUI until the maintainer quits; resolves to the exit code. */
export async function runTui(args: readonly string[], deps: TuiDeps): Promise<number> {
  const options = parseTuiArgs(args, deps.env);
  if (typeof options === "string") {
    deps.writeError(`dipo: tui: ${options}\nRun \`dipo --help\` for usage.`);
    return 2;
  }
  if (!isRawModeSupported(deps.stdin)) {
    deps.writeError(NO_TTY_MESSAGE);
    return 1;
  }
  const display = { color: options.color, ascii: options.ascii };

  const finished = Promise.withResolvers<number>();
  let done = false;
  const end = (code: number) => {
    if (done) return;
    done = true;
    finished.resolve(code);
  };

  const instance = render(<Starting ascii={options.ascii} onQuit={() => end(0)} />, {
    stdin: deps.stdin,
    stdout: deps.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
    // Ink takes CI=true for a non-interactive terminal (no alternate screen, only the last frame);
    // stdin was checked to be a terminal above (DIPO-53 prototype).
    interactive: true,
    alternateScreen: !options.inline,
    // The prototype measured it as good as full redraws in CPU, with fewer bytes written.
    incrementalRendering: true,
  });
  const stopSignals = [
    deps.onSignal("SIGTERM", () => end(143)),
    deps.onSignal("SIGHUP", () => end(129)),
  ];

  let session: TuiSession | null = null;
  let store: OfficeStore | null = null;
  let failure: string | null = null;
  const started = (async () => {
    try {
      session = await deps.connect();
    } catch (error) {
      failure = `dipo: ${errorText(error)}`;
      end(1);
      return;
    }
    if (done) return;
    const connected = session;
    store = new OfficeStore({ client: connected, clock: deps.clock, clientInfo: deps.clientInfo });
    store.start();
    const offices = store.state.offices;
    const here = options.office ?? (await deps.currentOffice().catch(() => null));
    const first =
      offices.find((entry) => entry.office === here)?.office ?? offices[0]?.office ?? null;
    const actions: TuiActions = {
      openPath: async (path) => {
        const outcome = await connected.command(officeOpen, { path: deps.resolvePath(path) });
        if (!outcome.ok)
          return { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` };
        return { ok: true, value: outcome.result.office };
      },
      resumeScheduling: async () => {
        const outcome = await connected.command(daemonResumeScheduling, {});
        if (!outcome.ok)
          return { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` };
        return { ok: true, value: null };
      },
    };
    instance.rerender(
      <App
        store={store}
        clock={deps.clock}
        display={display}
        actions={actions}
        onQuit={() => end(0)}
        startInSwitcher={first === null}
      />,
    );
    if (first !== null) void store.open(first);
  })();

  const code = await finished.promise;
  instance.unmount();
  await instance.waitUntilExit().catch(() => undefined);
  for (const stop of stopSignals) stop();
  await started.catch(() => undefined);
  (store as OfficeStore | null)?.close();
  (session as TuiSession | null)?.close();
  if (failure !== null) deps.writeError(failure);
  return code;
}

/** Shown while the client connects and, when needed, starts the daemon. */
function Starting(props: { ascii: boolean; onQuit: () => void }) {
  useInput((input, key) => {
    if ((key.ctrl && input === "c") || input === "q") props.onQuit();
  });
  return <Text>{` dipo ${props.ascii ? "-" : "·"} starting${props.ascii ? "..." : "…"}`}</Text>;
}
