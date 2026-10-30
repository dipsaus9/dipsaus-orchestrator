// `dipo tui` (0009 sections 1, 2 and 7): checks for a terminal, renders `starting…` while the
// client connects (the connect function starts the daemon when autostart allows, 0006), feeds an
// `OfficeStore` and opens the office of the current directory, else the first registered one,
// else the switcher. Quitting, Ctrl+C and SIGTERM unmount Ink, which leaves the alternate screen
// and raw mode, so the shell gets its terminal back.

import {
  type DipoClient,
  OfficeStore,
  type StoreClient,
  ulidRequestIds,
} from "@dipsaus-orchestrator/client";
import {
  type Clock,
  type EngineError,
  findCommand,
  officeDesk,
  officeDigest,
  type OfficeId,
  officeOpen,
  officeSetPrivacy,
  storyDetail,
  storyLosses,
  workOutputRange,
  workPrompt,
  workRun,
} from "@dipsaus-orchestrator/contract";
import { Box, render, Text, useInput } from "ink";
import { useState } from "react";

import { App, QUIT_WINDOW_MS, type TuiActions } from "./app";
import { parseTuiArgs } from "./options";
import { glyphs } from "./views";

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

function engineMessage(error: EngineError): string {
  return `${error.code}: ${error.message}`;
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

  const instance = render(
    <Starting ascii={options.ascii} clock={deps.clock} onQuit={() => end(0)} />,
    {
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
    },
  );
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
    // Quit or a signal while connecting: nothing waits for this session any more.
    if (done) {
      session.close();
      return;
    }
    const connected = session;
    const requestIds = ulidRequestIds(deps.clock);
    store = new OfficeStore({ client: connected, clock: deps.clock, clientInfo: deps.clientInfo });
    store.start();
    const here = options.office ?? (await deps.currentOffice().catch(() => null));
    // Quit or a signal during the lookup: Ink is unmounted, so render and open nothing.
    if (done) return;
    const offices = store.state.offices;
    const first =
      offices.find((entry) => entry.office === here)?.office ?? offices[0]?.office ?? null;
    // A command that fails on the client side (the client closed) is a message, never a rejection.
    const actions: TuiActions = {
      openPath: async (path) => {
        try {
          const outcome = await connected.command(officeOpen, { path: deps.resolvePath(path) });
          if (!outcome.ok) return { ok: false, message: engineMessage(outcome.error) };
          return { ok: true, value: outcome.result.office };
        } catch (error) {
          return { ok: false, message: errorText(error) };
        }
      },
      setPrivacy: async (request) => {
        try {
          const outcome = await connected.command(
            officeSetPrivacy,
            { office: request.office, key: request.key, value: request.value },
            // `office.setPrivacy` has `confirm: true`; the maintainer answered yes before this is sent.
            { requestId: request.requestId, confirmed: true },
          );
          if (!outcome.ok) return { ok: false, message: engineMessage(outcome.error) };
          if (!outcome.result.valid) {
            const errors = outcome.result.errors.map((error) => error.message).join("; ");
            return { ok: false, message: `written, but the configuration is invalid: ${errors}` };
          }
          return { ok: true, value: null };
        } catch (error) {
          return { ok: false, message: errorText(error) };
        }
      },
      runStories: async (request) => {
        try {
          // No deadline: `work.run` waits for a fetch, the gate and the claim (as `dipo run`).
          return await connected.command(
            workRun,
            request.stories === undefined ? {} : { stories: [...request.stories] },
            { office: request.office, requestId: request.requestId },
          );
        } catch (error) {
          return {
            ok: false,
            error: { code: "client.failed", message: errorText(error), retryable: false },
          };
        }
      },
      readOutput: async (request) => {
        try {
          const outcome = await connected.read(workOutputRange, {
            office: request.office,
            run: request.run,
            source: request.source,
            from: request.from,
            ...(request.to === undefined ? {} : { to: request.to }),
          });
          return outcome.ok ? { ok: true, result: outcome.result } : outcome;
        } catch (error) {
          return {
            ok: false,
            error: { code: "client.failed", message: errorText(error), retryable: false },
          };
        }
      },
      readPrompt: async (request) => {
        try {
          const outcome = await connected.read(workPrompt, {
            office: request.office,
            run: request.run,
            agent: request.agent,
          });
          return outcome.ok ? { ok: true, result: outcome.result } : outcome;
        } catch (error) {
          return {
            ok: false,
            error: { code: "client.failed", message: errorText(error), retryable: false },
          };
        }
      },
      readStory: async (request) => {
        try {
          const outcome = await connected.read(storyDetail, {
            office: request.office,
            story: request.story,
          });
          return outcome.ok
            ? {
                ok: true,
                result: {
                  view: outcome.result.view,
                  runs: outcome.result.runs,
                  verdicts: outcome.result.verdicts,
                },
              }
            : outcome;
        } catch (error) {
          return {
            ok: false,
            error: { code: "client.failed", message: errorText(error), retryable: false },
          };
        }
      },
      sendCommand: async (request) => {
        const definition = findCommand(request.command);
        if (definition === undefined) {
          return {
            ok: false,
            error: {
              code: "capability.missing",
              message: `This TUI knows no command ${request.command}.`,
              retryable: false,
            },
          };
        }
        try {
          // No deadline: `work.discard` and `work.resume` wait for git and the planning lane.
          return await connected.command(definition, request.args, {
            office: request.office,
            requestId: request.requestId,
            confirmed: request.confirmed,
          });
        } catch (error) {
          return {
            ok: false,
            error: { code: "client.failed", message: errorText(error), retryable: false },
          };
        }
      },
      readLosses: async (request) => {
        try {
          return await connected.read(storyLosses, {
            office: request.office,
            story: request.story,
            command: request.command,
          });
        } catch (error) {
          return {
            ok: false,
            error: { code: "client.failed", message: errorText(error), retryable: false },
          };
        }
      },
      readDesk: async (office) => {
        try {
          return await connected.read(officeDesk, { office });
        } catch (error) {
          return {
            ok: false,
            error: { code: "client.failed", message: errorText(error), retryable: false },
          };
        }
      },
      readDigest: async (office) => {
        try {
          return await connected.read(officeDigest, { office });
        } catch (error) {
          return {
            ok: false,
            error: { code: "client.failed", message: errorText(error), retryable: false },
          };
        }
      },
      newRequestId: requestIds,
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
  // A connect or lookup still running is not waited for; it closes its own session when it ends.
  void started;
  (store as OfficeStore | null)?.close();
  (session as TuiSession | null)?.close();
  if (failure !== null) deps.writeError(failure);
  return code;
}

/** Shown while the client connects and, when needed, starts the daemon. */
function Starting(props: { ascii: boolean; clock: Clock; onQuit: () => void }) {
  const [quitArmedAt, setQuitArmedAt] = useState<number | null>(null);
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      props.onQuit();
      return;
    }
    if (input !== "q") return;
    // The same rule as the App: a second `q` within 2 s quits (0009 section 6).
    const now = props.clock.now();
    if (quitArmedAt !== null && now - quitArmedAt <= QUIT_WINDOW_MS) props.onQuit();
    else setQuitArmedAt(now);
  });
  const { dot, ellipsis } = glyphs(props.ascii);
  return (
    <Box flexDirection="column">
      <Text>{` dipo ${dot} starting${ellipsis}`}</Text>
      {quitArmedAt === null ? null : <Text>{" press q again to quit"}</Text>}
    </Box>
  );
}
