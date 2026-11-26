// `runTui` end to end over a fake terminal and the fake session (DIPO-53): no TTY, start, quit,
// SIGTERM, the alternate screen and `--inline`, and a failed connect.

import { describe, expect, it } from "bun:test";

import { NO_TTY_MESSAGE, runTui, type TuiDeps, type TuiSession } from "./run";
import { FakeSession, OFFICES } from "../test/support/fake-session";
import { fakeTerminal, type FakeTerminal, stripAnsi } from "../test/support/harness";
import { TestClock } from "../test/support/setup";

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
    await waitScreen("dipo / dipsaus-orchestrator");
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
    await waitScreen("dipo / dipsaus-orchestrator");
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
    await waitScreen("dipo / dipsaus-orchestrator");
    await terminal.press("ctrl-c");
    expect(await running).toBe(0);
    expect(terminal.raw()).toContain(LEAVE_ALT);
    expect(terminal.rawMode.at(-1)).toBe(false);
  });

  it("--inline stays out of the alternate screen", async () => {
    const { terminal, deps, waitScreen } = setup();
    const running = runTui(["--inline", "--ascii"], deps);
    await waitScreen("dipo / dipsaus-orchestrator");
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

describe("runTui mouse reporting (DIPO-515)", () => {
  const ON = "\u001b[?1000h\u001b[?1006h";
  const OFF = "\u001b[?1006l\u001b[?1000l";

  it("turns SGR press and wheel reporting on at start and off after q twice", async () => {
    const { terminal, deps, waitScreen } = setup();
    const running = runTui([], deps);
    await waitScreen("dipo / dipsaus-orchestrator");
    expect(terminal.raw()).toContain(ON);
    expect(terminal.raw()).not.toContain(OFF);
    await terminal.press("q");
    await terminal.press("q");
    expect(await running).toBe(0);
    expect(terminal.raw().lastIndexOf(OFF)).toBeGreaterThan(terminal.raw().lastIndexOf(ON));
  });

  it("turns it off on Ctrl+C and on SIGTERM", async () => {
    const first = setup();
    const ctrlC = runTui([], first.deps);
    await first.waitScreen("dipo / dipsaus-orchestrator");
    await first.terminal.press("ctrl-c");
    await ctrlC;
    expect(first.terminal.raw()).toContain(OFF);
    const second = setup();
    const term = runTui([], second.deps);
    await second.waitScreen("dipo / dipsaus-orchestrator");
    second.signals.get("SIGTERM")?.();
    await term;
    expect(second.terminal.raw()).toContain(OFF);
  });

  it("turns it off on a crash (the process exit event) and takes the handler away after", async () => {
    const { terminal, deps, waitScreen } = setup();
    const exits = new Set<() => void>();
    const running = runTui([], {
      ...deps,
      onExit: (handler) => {
        exits.add(handler);
        return () => exits.delete(handler);
      },
    });
    await waitScreen("dipo / dipsaus-orchestrator");
    expect(exits.size).toBe(1);
    for (const handler of exits) handler();
    expect(terminal.raw()).toContain(OFF);
    await terminal.press("ctrl-c");
    await running;
    expect(exits.size).toBe(0);
  });

  it("turns it off before a suspend and on again after the process continues", async () => {
    const { terminal, signals, deps, waitScreen } = setup();
    let suspended = 0;
    const running = runTui([], {
      ...deps,
      suspend: () => {
        suspended += 1;
      },
    });
    await waitScreen("dipo / dipsaus-orchestrator");
    const count = (text: string) => terminal.raw().split(text).length - 1;
    expect(count(ON)).toBe(1);
    signals.get("SIGTSTP")?.();
    expect(suspended).toBe(1);
    expect(count(OFF)).toBe(1);
    // The stop handler is gone, so the next stop is the default one until the process continues.
    expect(signals.has("SIGTSTP")).toBe(false);
    signals.get("SIGCONT")?.();
    expect(count(ON)).toBe(2);
    expect(signals.has("SIGTSTP")).toBe(true);
    await terminal.press("ctrl-c");
    await running;
  });

  it("never turns it on with --no-mouse or --inline", async () => {
    for (const flag of ["--no-mouse", "--inline"]) {
      const { terminal, signals, deps, waitScreen } = setup();
      const running = runTui([flag], deps);
      await waitScreen("dipo / dipsaus-orchestrator");
      expect(signals.has("SIGTSTP")).toBe(false);
      await terminal.press("ctrl-c");
      await running;
      expect(terminal.raw()).not.toContain("\u001b[?1000h");
      expect(terminal.raw()).not.toContain("\u001b[?1006h");
      expect(terminal.raw()).not.toContain(OFF);
    }
  });
});
