// The test box (DIPO-309, 0002, 0008): a story's pushed head running for the maintainer's test.
//
// - Made per test (`start`), like every box (`BoxWorkers.create`): the office image, the code of
//   the pushed head with its own local git repository made by `git init` (0008), only the files
//   the office config lists, nothing of the Mac mounted but the package cache and the network
//   tools. The builder's box is never touched. Its run id is the test id (`TEST_BOX_RUN_PREFIX`).
// - Then, as the box user and behind the box firewall: the office's install through the web route
//   (Safe-Chain and the package cache, `BoxWorkers.install`), `setup` when the office has one, and
//   `dev` when the product has something to start. dipo reads `dev`'s output for the first URL it
//   prints, within the start deadline, and takes the port from it.
// - The way in (`#serve`): the firewall is set again with the `dev` port open to the Mac's address
//   on the box network only (`firewall.ts`, `inbound`), so the box answers connections the Mac
//   opened to that port and nothing else; it opens no new connection beyond dipo's proxies. When
//   `dev` listens only on the box's loopback, the Mac cannot reach it at the box's address, so
//   dipo starts the smallest relay in the box: socat (in every image) from the box's address to
//   the loopback port. Then the forwarder on the Mac (`forwarder.ts`) listens on 127.0.0.1 and
//   passes connections to the box from the Mac's bridge address. No port is published. The URL is
//   `http://localhost:<forwarder port>` with `dev`'s path.
// - `reattach` (a daemon restart keeps open tests): the box still runs its product (a daemon stop
//   leaves test boxes running, `BoxWorkers.close`), so the new daemon sets the firewall again with
//   its own web route and starts the forwarder again, on the same port when it is free.
// - `close`: the forwarder stopped, the box deleted and its route released (`BoxWorkers.discard`).
//   `sweep` deletes every test box no open test names (reconcile at daemon start).
//
// No tool runs on the Mac on the box's files. A failed step closes the box and throws a
// `TestBoxError` whose message says which step, with the cleaned tail of its output.

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import type { OfficeGit } from "../git/office";
import { cleanDoorText } from "./door";
import type { RunningForwarder, StartForwarder } from "./forwarder";
import { type BoxPort, type BoxProcess, boxName, TEST_BOX_RUN_PREFIX } from "./port";
import { type BoxWorkers, readBoxRun } from "./workers";

/** The `dev` start deadline when the office's `timeouts.scriptMinutes` names none. */
export const TEST_DEV_START_MINUTES_DEFAULT = 5;

/** How long dipo tries to reach `dev` at the box's address, each try. */
export const TEST_REACH_TIMEOUT_MS = 3_000;

/** How many times dipo tries to reach the relay once it started, a second apart. */
export const TEST_RELAY_TRIES = 10;

/** The most characters of `dev`'s output tail a failure names. */
const OUTPUT_TAIL = 1_500;

/** The most characters of `dev`'s output dipo keeps while it waits for the URL. */
const OUTPUT_KEEP = 64 * 1024;

/** A step of a test box that failed; its message is for the maintainer. */
export class TestBoxError extends Error {
  constructor(
    readonly step: "box" | "install" | "setup" | "dev" | "reach",
    message: string,
  ) {
    super(message);
    this.name = "TestBoxError";
  }
}

/** One command list step's input, as the office's run profile gives it. */
export interface TestBoxScript {
  readonly commands: readonly (readonly string[])[];
  readonly timeoutMs: number;
}

/** What a test box is made from. */
export interface TestBoxRequest {
  readonly office: OfficeId;
  /** The test id: the box's run id. */
  readonly testId: string;
  /** The folder the box's record lives in. */
  readonly runDir: string;
  readonly git: OfficeGit;
  /** The story branch's pushed head. */
  readonly head: string;
  /** The office's install; null when the run profile has none. */
  readonly install: TestBoxScript | null;
  /** `setup` in its folder; null when the office has none. */
  readonly setup: (TestBoxScript & { readonly cwd: string }) | null;
  /** `dev` in its folder; null for a product with nothing to start. */
  readonly dev: {
    readonly command: readonly [string, ...string[]];
    readonly cwd: string;
    readonly startTimeoutMs: number;
  } | null;
}

/** Where the forwarder of a test reaches the box. */
export interface TestBoxTarget {
  readonly address: string;
  readonly port: number;
}

/** A test box whose product runs. */
export interface TestBoxRunning {
  readonly box: string;
  /** The URL on the Mac; null for a product with nothing to start. */
  readonly url: string | null;
  /** The forwarder's port on the Mac and what it reaches; null without `dev`. */
  readonly forward: { readonly port: number; readonly target: TestBoxTarget } | null;
}

export interface TestBoxesDeps {
  readonly workers: Pick<
    BoxWorkers,
    "create" | "install" | "verify" | "route" | "inbound" | "discard"
  >;
  readonly boxes: Pick<BoxPort, "address" | "execLive" | "list" | "network">;
  readonly forward: StartForwarder;
  /** True when a connection from `source` reaches `address:port` within `timeoutMs`. */
  readonly reach: (
    target: TestBoxTarget & { readonly source: string },
    timeoutMs: number,
  ) => Promise<boolean>;
  readonly clock: Clock;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  readonly info?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** What `start` keeps of a running test box. */
interface Held {
  readonly forwarder: RunningForwarder | null;
  readonly processes: BoxProcess[];
}

const URL_TEXT = /\bhttps?:\/\/[^\s'"`<>]+/;

/** Pure: the first URL in `text` (escape sequences and controls removed), or null. */
export function firstDevUrl(
  text: string,
): { readonly url: URL; readonly port: number; readonly loopbackV6: boolean } | null {
  const plain = cleanDoorText(text);
  const match = URL_TEXT.exec(plain);
  if (match === null) return null;
  let url: URL;
  try {
    url = new URL(match[0].replace(/[.,;:)\]]+$/, ""));
  } catch {
    return null;
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { url, port, loopbackV6: url.hostname === "[::1]" };
}

/** Pure: the URL on the Mac for `dev`'s URL behind the forwarder on `port`. */
export function testUrl(dev: URL, port: number): string {
  return `${dev.protocol}//localhost:${port}${dev.pathname}${dev.search}`;
}

/** Pure: the relay in the box from its address to `dev`'s loopback port (socat, in every image). */
export function relayCommand(
  address: string,
  port: number,
  loopbackV6: boolean,
): [string, ...string[]] {
  return [
    "socat",
    `TCP-LISTEN:${port},bind=${address},fork,reuseaddr`,
    loopbackV6 ? `TCP6:[::1]:${port}` : `TCP4:127.0.0.1:${port}`,
  ];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The cleaned last part of `text`, for a failure the maintainer reads. */
function tail(text: string): string {
  const clean = cleanDoorText(text).trim();
  return clean.length <= OUTPUT_TAIL ? clean : `…${clean.slice(-OUTPUT_TAIL)}`;
}

export class TestBoxes {
  readonly #deps: TestBoxesDeps;
  readonly #held = new Map<string, Held>();

  constructor(deps: TestBoxesDeps) {
    this.#deps = deps;
  }

  /** The box name of test `testId`. */
  static boxOf(testId: string): string {
    return boxName(testId);
  }

  /** Makes the test box and starts its product (see the file comment). */
  async start(request: TestBoxRequest): Promise<TestBoxRunning> {
    const { workers } = this.#deps;
    const box = boxName(request.testId);
    const held: Held = { forwarder: null, processes: [] };
    this.#held.set(request.testId, held);
    try {
      try {
        await workers.create({
          office: request.office,
          runId: request.testId,
          runDir: request.runDir,
          git: request.git,
          startCommit: request.head,
        });
      } catch (error) {
        throw new TestBoxError("box", `the test box could not be made: ${messageOf(error)}`);
      }
      if (request.install !== null) {
        const installed = await workers.install({ runId: request.testId, ...request.install });
        if (!installed.ok) {
          throw new TestBoxError(
            "install",
            `the install failed in the test box: ${installed.reason}; its output is in the daemon's log.`,
          );
        }
      }
      const env = await workers.route(request.testId);
      if (request.setup !== null) {
        const setup = await workers.verify({
          runId: request.testId,
          commands: request.setup.commands,
          cwd: request.setup.cwd,
          timeoutMs: request.setup.timeoutMs,
          step: "setup",
        });
        if (setup.kind === "red") {
          throw new TestBoxError(
            "setup",
            `setup failed in the test box (\`${setup.command}\`):\n${tail(setup.output)}`,
          );
        }
        if (setup.kind === "failed") {
          throw new TestBoxError("setup", `setup could not run in the test box: ${setup.reason}`);
        }
      }
      if (request.dev === null) return { box, url: null, forward: null };
      return await this.#serve(request, held, env);
    } catch (error) {
      await this.close(request.testId);
      if (error instanceof TestBoxError) throw error;
      throw new TestBoxError("box", `the test box failed: ${messageOf(error)}`);
    }
  }

  /** `dev` started, its URL read, the way in from the Mac made (see the file comment). */
  async #serve(
    request: TestBoxRequest,
    held: Held,
    env: Readonly<Record<string, string>>,
  ): Promise<TestBoxRunning> {
    const dev = request.dev;
    if (dev === null) throw new Error("serve needs dev");
    const box = boxName(request.testId);
    const process = this.#deps.boxes.execLive(box, dev.command, {
      cwd: dev.cwd,
      env,
    });
    held.processes.push(process);
    const found = await this.#devUrl(process, dev.startTimeoutMs);
    const address = await this.#deps.boxes.address(box);
    if (address === null) {
      throw new TestBoxError("reach", "the test box has no address on the box network.");
    }
    // The way in: the Mac's address on the box network, on the `dev` port only.
    await this.#deps.workers.inbound(request.testId, [found.port]);
    const network = await this.#deps.boxes.network();
    const target: TestBoxTarget = { address, port: found.port };
    const source = network.hostAddress;
    if (!(await this.#deps.reach({ ...target, source }, TEST_REACH_TIMEOUT_MS))) {
      // `dev` listens only on the box's loopback: the smallest relay from the box's address.
      this.#deps.info?.("dev listens only on the box's loopback; starting the relay", {
        test: request.testId,
        port: found.port,
      });
      const relay = this.#deps.boxes.execLive(
        box,
        relayCommand(address, found.port, found.loopbackV6),
      );
      held.processes.push(relay);
      relay.exited.catch(() => undefined);
      if (!(await this.#reachSoon({ ...target, source }))) {
        throw new TestBoxError(
          "reach",
          `the Mac does not reach \`dev\` on port ${found.port} in the test box, neither at the box's address nor through the relay.`,
        );
      }
    }
    const forwarder = await this.#deps.forward(
      { ...target, source },
      { avoid: readBoxRun(request.runDir)?.localPorts ?? [] },
    );
    this.#held.set(request.testId, { ...held, forwarder });
    return {
      box,
      url: testUrl(found.url, forwarder.port),
      forward: { port: forwarder.port, target },
    };
  }

  /** True once `target` is reached, trying `TEST_RELAY_TRIES` times a second apart. */
  async #reachSoon(target: TestBoxTarget & { readonly source: string }): Promise<boolean> {
    for (let attempt = 0; attempt < TEST_RELAY_TRIES; attempt++) {
      if (attempt > 0) await this.#sleep(1_000);
      if (await this.#deps.reach(target, TEST_REACH_TIMEOUT_MS)) return true;
    }
    return false;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.#deps.clock.setTimeout(resolve, ms));
  }

  /**
   * The first URL `dev` prints on either stream within `timeoutMs`. Its output is read to the end
   * after that, so `dev` never blocks on a full pipe. Throws when `dev` ends or the time passes
   * first, with the tail of its output.
   */
  async #devUrl(
    process: BoxProcess,
    timeoutMs: number,
  ): Promise<NonNullable<ReturnType<typeof firstDevUrl>>> {
    let text = "";
    let settle: ((value: NonNullable<ReturnType<typeof firstDevUrl>> | Error) => void) | null =
      null;
    const outcome = new Promise<NonNullable<ReturnType<typeof firstDevUrl>> | Error>((resolve) => {
      settle = resolve;
    });
    const done = (value: NonNullable<ReturnType<typeof firstDevUrl>> | Error): void => {
      const resolve = settle;
      settle = null;
      resolve?.(value);
    };
    const read = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done: ended, value } = await reader.read();
          if (ended) return;
          if (settle === null) continue;
          text = `${text}${decoder.decode(value, { stream: true })}`.slice(-OUTPUT_KEEP);
          const found = firstDevUrl(text);
          if (found !== null) done(found);
        }
      } catch {
        return;
      }
    };
    void read(process.stdout);
    void read(process.stderr);
    void process.exited.then(
      (exit) =>
        done(
          new TestBoxError(
            "dev",
            `\`dev\` ended (${exit.signal ?? `exit ${exit.code}`}) before it printed a URL:\n${tail(text)}`,
          ),
        ),
      () => done(new TestBoxError("dev", "`dev` could not run in the test box.")),
    );
    const timer = this.#deps.clock.setTimeout(
      () =>
        done(
          new TestBoxError(
            "dev",
            `\`dev\` printed no URL within ${Math.round(timeoutMs / 1000)} seconds:\n${tail(text)}`,
          ),
        ),
      timeoutMs,
    );
    const value = await outcome;
    this.#deps.clock.clearTimeout(timer);
    if (value instanceof Error) throw value;
    return value;
  }

  /**
   * After a daemon restart: the test box of an open test, still running, gets its firewall with
   * this daemon's web route and the `dev` port again, and its forwarder again, on `port` when it is
   * free. Returns the forwarder's port, or null when the box is gone or stopped, or cannot be
   * reached any more (the caller closes the test).
   */
  async reattach(input: {
    readonly testId: string;
    readonly target: TestBoxTarget | null;
    readonly port: number | null;
    /** The folder of the test box's record, for the office's local ports. */
    readonly runDir?: string;
  }): Promise<{ readonly port: number | null } | null> {
    const box = boxName(input.testId);
    try {
      const listed = (await this.#deps.boxes.list()).find((candidate) => candidate.name === box);
      if (listed?.state !== "running") return null;
      if (input.target === null) return { port: null };
      const address = await this.#deps.boxes.address(box);
      if (address !== input.target.address) return null;
      await this.#deps.workers.inbound(input.testId, [input.target.port]);
      const network = await this.#deps.boxes.network();
      const target = { ...input.target, source: network.hostAddress };
      // `dev` must still answer: the box may run while its product ended.
      if (!(await this.#deps.reach(target, TEST_REACH_TIMEOUT_MS))) return null;
      const forwarder = await this.#deps.forward(target, {
        ...(input.port === null ? {} : { port: input.port }),
        avoid: input.runDir === undefined ? [] : (readBoxRun(input.runDir)?.localPorts ?? []),
      });
      this.#held.set(input.testId, { forwarder, processes: [] });
      return { port: forwarder.port };
    } catch (error) {
      this.#deps.warn?.("an open test's box could not be taken up again", {
        test: input.testId,
        reason: messageOf(error),
      });
      return null;
    }
  }

  /** True when this daemon holds a forwarder or process of test `testId`. */
  holds(testId: string): boolean {
    return this.#held.has(testId);
  }

  /** Stops the test's forwarder and processes, then deletes its box. Never rejects. */
  async close(testId: string): Promise<void> {
    const held = this.#held.get(testId);
    this.#held.delete(testId);
    await held?.forwarder?.close().catch(() => undefined);
    for (const process of held?.processes ?? []) {
      try {
        process.kill("SIGKILL");
      } catch {
        // The client ended already; the box goes below.
      }
    }
    await this.#deps.workers.discard(testId);
  }

  /** Deletes every test box `open` does not name (reconcile at daemon start). Never rejects. */
  async sweep(open: ReadonlySet<string>): Promise<string[]> {
    let listed: Awaited<ReturnType<BoxPort["list"]>>;
    try {
      listed = await this.#deps.boxes.list();
    } catch (error) {
      this.#deps.warn?.("listing the boxes for the test sweep failed", {
        reason: messageOf(error),
      });
      return [];
    }
    const deleted: string[] = [];
    for (const box of listed) {
      if (!box.runId.startsWith(TEST_BOX_RUN_PREFIX) || open.has(box.runId)) continue;
      await this.close(box.runId);
      deleted.push(box.runId);
    }
    return deleted;
  }

  /** Stops every forwarder at daemon stop; the test boxes keep running. */
  async stopForwarders(): Promise<void> {
    for (const held of this.#held.values()) {
      await held.forwarder?.close().catch(() => undefined);
    }
    this.#held.clear();
  }
}
