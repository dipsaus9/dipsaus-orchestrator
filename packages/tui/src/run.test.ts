// `runTui` end to end over a fake terminal and the fake session (DIPO-53): no TTY, start, quit,
// SIGTERM, the alternate screen and `--inline`, and a failed connect.

import { describe, expect, it } from "bun:test";

import { NO_TTY_MESSAGE, runTui, type TuiDeps, type TuiSession } from "./run";
import { FakeSession, OFFICES } from "./testing/fake-session";
import { fakeTerminal, type FakeTerminal, stripAnsi } from "./testing/harness";
import { TestClock } from "./testing/setup";

const ENTER_ALT = "\u001b[?1049h";
const LEAVE_ALT = "\u001b[?1049l";

function setup(options: { connect?: TuiDeps["connect"]; terminal?: FakeTerminal } = {}) {
  const terminal = options.terminal ?? fakeTerminal();
  const session = new FakeSession();
  const errors: string[] = [];
  const signals = new Map<string, () => void>();
  let connects = 0;
  const deps: TuiDeps = {
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    env: {},
    clock: new TestClock(),
    writeError: (line) => errors.push(line),
    connect:
      options.connect ??
      (async () => {
        connects += 1;
        return session;
      }),
    currentOffice: async () => OFFICES.dipsaus,
    resolvePath: (path) => path,
    onSignal: (signal, handler) => {
      signals.set(signal, handler);
      return () => signals.delete(signal);
    },
    clientInfo: { name: "test", version: "0" },
  };
  const screen = () => stripAnsi(terminal.raw());
  const waitScreen = async (text: string) => {
    const limit = performance.now() + 1_000;
    while (!screen().includes(text)) {
      if (performance.now() > limit)
        throw new Error(`screen lacks ${JSON.stringify(text)}:\n${screen()}`);
      await Bun.sleep(5);
    }
  };
  return { terminal, session, errors, signals, deps, waitScreen, connects: () => connects };
}

describe("runTui", () => {
  it("exits non-zero with one line when stdin is not a terminal", async () => {
    const { deps, errors, connects } = setup();
    const piped = Object.assign(Object.create(deps.stdin) as object, { isTTY: false });
    const code = await runTui([], { ...deps, stdin: piped as NodeJS.ReadStream });
    expect(code).toBe(1);
    expect(errors).toEqual([NO_TTY_MESSAGE]);
    expect(NO_TTY_MESSAGE).not.toContain("\n");
    expect(connects()).toBe(0);
  });

  it("opens the office of the current directory and quits on q twice, restoring the terminal", async () => {
    const { terminal, session, deps, waitScreen } = setup();
    const running = runTui([], deps);
    await waitScreen("dipsaus-orchestrator · daemon running");
    await terminal.press("q");
    await terminal.press("q");
    expect(await running).toBe(0);
    const raw = terminal.raw();
    expect(raw).toContain(ENTER_ALT);
    expect(raw.lastIndexOf(LEAVE_ALT)).toBeGreaterThan(raw.lastIndexOf(ENTER_ALT));
    expect(terminal.rawMode.at(-1)).toBe(false);
    expect(session.closed).toBe(true);
  });

  it("restores the terminal on SIGTERM", async () => {
    const { terminal, session, signals, deps, waitScreen } = setup();
    const running = runTui([], deps);
    await waitScreen("dipsaus-orchestrator · daemon running");
    signals.get("SIGTERM")?.();
    expect(await running).toBe(143);
    expect(terminal.raw()).toContain(LEAVE_ALT);
    expect(terminal.rawMode.at(-1)).toBe(false);
    expect(session.closed).toBe(true);
    expect(signals.size).toBe(0);
  });

  it("restores the terminal on Ctrl+C", async () => {
    const { terminal, deps, waitScreen } = setup();
    const running = runTui([], deps);
    await waitScreen("dipsaus-orchestrator · daemon running");
    await terminal.press("ctrl-c");
    expect(await running).toBe(0);
    expect(terminal.raw()).toContain(LEAVE_ALT);
    expect(terminal.rawMode.at(-1)).toBe(false);
  });

  it("--inline stays out of the alternate screen", async () => {
    const { terminal, deps, waitScreen } = setup();
    const running = runTui(["--inline", "--ascii"], deps);
    await waitScreen("dipsaus-orchestrator - daemon running");
    await terminal.press("ctrl-c");
    expect(await running).toBe(0);
    expect(terminal.raw()).not.toContain(ENTER_ALT);
  });

  it("shows starting… while connecting and prints a failed connect after leaving the screen", async () => {
    const connecting = Promise.withResolvers<TuiSession>();
    const { terminal, deps, errors, waitScreen } = setup({ connect: () => connecting.promise });
    const running = runTui([], deps);
    await waitScreen("starting…");
    connecting.reject(new Error("autostart is off in config.yaml"));
    expect(await running).toBe(1);
    expect(errors).toEqual(["dipo: autostart is off in config.yaml"]);
    expect(terminal.raw()).toContain(LEAVE_ALT);
  });

  it("refuses unknown arguments", async () => {
    const { deps, errors } = setup();
    expect(await runTui(["--wide"], deps)).toBe(2);
    expect(errors[0]).toContain('unknown argument "--wide"');
  });

  it("needs q twice on the starting screen too", async () => {
    const connecting = Promise.withResolvers<TuiSession>();
    const { terminal, deps, waitScreen } = setup({ connect: () => connecting.promise });
    let code: number | null = null;
    const running = runTui([], deps).then((value) => (code = value));
    await waitScreen("starting…");
    await terminal.press("q");
    await waitScreen("press q again to quit");
    expect(code).toBeNull();
    await terminal.press("q");
    expect(await running).toBe(0);
    // A session that arrives after quitting is closed.
    const late = new FakeSession();
    connecting.resolve(late);
    await Bun.sleep(10);
    expect(late.closed).toBe(true);
  });

  it("renders and opens nothing when it quits while looking up the current office", async () => {
    const lookup = Promise.withResolvers<null>();
    const { terminal, session, signals, deps, waitScreen } = setup();
    const looking = Promise.withResolvers<void>();
    const running = runTui([], {
      ...deps,
      currentOffice: () => {
        looking.resolve();
        return lookup.promise;
      },
    });
    await waitScreen("starting…");
    await looking.promise;
    signals.get("SIGTERM")?.();
    expect(await running).toBe(143);
    lookup.resolve(null);
    await Bun.sleep(20);
    expect(session.reads.map((read) => read.name)).toEqual([]);
    expect(Bun.stripANSI(terminal.raw())).not.toContain("Offices");
  });
});
