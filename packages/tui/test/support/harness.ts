// The TUI test harness (0009 section 1 check 3): Ink 8 `render` over PassThrough streams with a
// fixed terminal size and a stdin that passes for a TTY, so `useInput` works under `bun test`.
// `press` types keys, `frame` is the last frame with ANSI stripped, so tests assert on meaning
// that survives monochrome. The prototype found ink-testing-library 4.0.0 working with Ink 8 too,
// but it is built against Ink 5 and has no terminal size or TTY stdin, so the TUI keeps this.

import { PassThrough } from "node:stream";

import { render as inkRender } from "ink";
import type { ReactNode } from "react";

/** `text` without ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return Bun.stripANSI(text);
}

/** Named keys `press` understands; anything else is typed as is. */
const KEYS: Readonly<Record<string, string>> = {
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  enter: "\r",
  escape: "\u001b",
  backspace: "\u007f",
  tab: "\t",
  "ctrl-c": "\u0003",
  "ctrl-r": "\u0012",
  pageup: "\u001b[5~",
  pagedown: "\u001b[6~",
  home: "\u001b[H",
  end: "\u001b[F",
};

const POLL_MS = 5;

export interface RenderSize {
  readonly columns?: number;
  readonly rows?: number;
}

/** A fake terminal: TTY-like stdin and stdout streams and what was written to stdout. */
export interface FakeTerminal {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  /** Every `setRawMode` call, in order. */
  readonly rawMode: boolean[];
  /** Types one named key (`up`, `down`, `enter`, `escape`, `backspace`, `ctrl-c`) or text. */
  press(key: string): Promise<void>;
  /** The last frame written, ANSI stripped. */
  frame(): string;
  /** Resolves with the frame once it contains `text`; fails after `timeoutMs`. */
  waitFor(text: string, timeoutMs?: number): Promise<string>;
  /** Changes the terminal size and tells Ink, as SIGWINCH does. */
  resize(columns: number, rows: number): void;
  /** Everything written, ANSI kept. */
  raw(): string;
}

export function fakeTerminal(size: RenderSize = {}): FakeTerminal {
  const rawMode: boolean[] = [];
  const stdout = Object.assign(new PassThrough(), {
    columns: size.columns ?? 100,
    rows: size.rows ?? 30,
    isTTY: true,
  });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (on: boolean) => {
      rawMode.push(on);
      return stdin;
    },
    ref: () => stdin,
    unref: () => stdin,
  });
  let last = "";
  let all = "";
  let writes = 0;
  stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    all += text;
    writes += 1;
    if (stripAnsi(text).trim() !== "") last = text;
  });
  const frame = () => stripAnsi(last);
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    rawMode,
    async press(key) {
      const before = writes;
      const rendered = () => writes !== before;
      stdin.write(KEYS[key] ?? key);
      // Escape waits for a possible sequence before Ink reports it alone.
      const limit = performance.now() + (key === "escape" ? 200 : 100);
      while (!rendered() && performance.now() < limit) await Bun.sleep(POLL_MS);
    },
    frame,
    async waitFor(text, timeoutMs = 1_000) {
      const limit = performance.now() + timeoutMs;
      while (!frame().includes(text)) {
        if (performance.now() > limit) {
          throw new Error(`no frame contains ${JSON.stringify(text)}; last frame:\n${frame()}`);
        }
        await Bun.sleep(POLL_MS);
      }
      return frame();
    },
    resize(columns, rows) {
      stdout.columns = columns;
      stdout.rows = rows;
      stdout.emit("resize");
    },
    raw: () => all,
  };
}

export interface Rendered extends FakeTerminal {
  unmount(): Promise<void>;
}

/** Renders `node` in a fake terminal of `columns` x `rows` (100 x 30 by default). */
export function render(node: ReactNode, size: RenderSize = {}): Rendered {
  const terminal = fakeTerminal(size);
  const instance = inkRender(node, {
    stdout: terminal.stdout,
    stdin: terminal.stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  return {
    ...terminal,
    async unmount() {
      instance.unmount();
      await instance.waitUntilExit().catch(() => undefined);
    },
  };
}
