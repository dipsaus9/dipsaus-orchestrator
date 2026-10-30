// `createEngine` with fakes for the daemon's process concerns (DIPO-318): the manual clock, a quiet
// log, a spawn that runs git and the pinned Backlog CLI in an isolated home, a probe that finds no
// process, and a keep-awake, worker hosts, forwarders and a model-proxy listener that never start.
// `withEngine` runs it over a temporary repository with the Backlog.md fixture and a bare `origin`,
// so an office opens and loads as in the daemon; a second connection to the state database lets a
// test read or change what the engine stored.

import { join } from "node:path";

import {
  type CommandDefinition,
  type CommandReply,
  defineCommand,
  defineRead,
  type OfficeId,
  officeRescan,
  type ReadReply,
  RequestId,
  SOFTWARE_CONFIG_DEFAULTS,
  type Spawn,
} from "@dipsaus-orchestrator/contract";
import {
  isolatedEnv,
  ManualClock,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import type { Renderer } from "../../src/changelog/render";
import type { FeatureModule } from "../../src/commands/registry";
import { createEngine } from "../../src/create/create-engine";
import type { Engine, EngineDeps } from "../../src/create/deps";
import type { DrainRequest } from "../../src/create/drain";
import type { RecoveryStep } from "../../src/create/recovery";
import { openStateDatabase, type StateDatabase } from "../../src/db/database";
import { createLogger } from "../../src/log/logger";
import { systemSpawn } from "../../src/platform/process";

export const TEST_VERSION = "0.0.0-test";
export const BACKLOG_FIXTURE = join(import.meta.dir, "..", "fixtures", "backlog");
const BACKLOG_CLI = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "node_modules",
  ".bin",
  "backlog",
);

function shipped<D extends CommandDefinition>(definition: D, name: string) {
  const { name: _name, ...rest } = definition;
  return defineCommand({ ...rest, name });
}

/** An office command that writes one `scan.finished` entry per call. */
export const scanCommand = shipped(officeRescan, "fixture.scan");
/** A test read with its own schemas. */
export const echoRead = defineRead({
  name: "fixture.echo",
  args: officeRescan.args,
  result: officeRescan.result,
});

export const fixtureFeature: FeatureModule = {
  name: "test/fixtures",
  register(registry) {
    registry.addOfficeCommand({
      definition: scanCommand,
      handle: (ctx) => {
        ctx.emit({
          type: "scan.finished",
          delta: { scripts: { test: "bun test" }, warnings: [] },
        });
        return { result: { scan: "started" as const } };
      },
    });
    registry.addRead({ definition: echoRead, handle: () => ({ scan: "started" as const }) });
  },
};

export interface FakeOptions {
  readonly tools?: EngineDeps["tools"];
  readonly renderer?: Renderer;
  readonly recoverySteps?: readonly RecoveryStep[];
  /** Receives every log line the engine writes; none are kept by default. */
  readonly logSink?: (line: string) => void;
}

export interface FakeDeps {
  readonly deps: EngineDeps;
  readonly clock: ManualClock;
  /** Every drain the engine asked the daemon for. */
  readonly stops: DrainRequest[];
  /** Set `pending` to what `daemon.status` reports as `upgradePending`. */
  readonly upgrade: { pending: boolean };
}

/** The daemon's process concerns as fakes, in `root`; processes run with `home` as their home. */
export function fakeDeps(root: string, home: string, options: FakeOptions = {}): FakeDeps {
  const clock = new ManualClock();
  const env = isolatedEnv(home);
  const spawn: Spawn = (spawnOptions) =>
    systemSpawn({ ...spawnOptions, env: spawnOptions.env ?? env });
  const stops: DrainRequest[] = [];
  const upgrade = { pending: false };
  return {
    clock,
    stops,
    upgrade,
    deps: {
      clock,
      logger: createLogger({
        clock,
        sinks: options.logSink === undefined ? [] : [options.logSink],
        component: "test",
      }),
      spawn,
      probe: async () => null,
      spawnKeepAwake: () => {
        throw new Error("no keep-awake starts here");
      },
      hosts: {
        start: async () => {
          throw new Error("no worker host starts here");
        },
      },
      forwarders: {
        forward: async () => {
          throw new Error("no forwarder starts here");
        },
        reach: async () => false,
      },
      listenHttp: () => {
        throw new Error("no model proxy listens here");
      },
      env: { PATH: "/usr/bin:/bin", HOME: home },
      paths: {
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        tmpRoot: join(root, "tmp"),
        home,
      },
      tools: options.tools ?? {},
      settings: SOFTWARE_CONFIG_DEFAULTS,
      daemon: {
        pid: process.pid,
        uid: -1,
        version: TEST_VERSION,
        startedAt: clock.now(),
        socket: join(root, "run", "dipo.sock"),
        upgradePending: () => upgrade.pending,
        requestStop: (request) => stops.push(request),
      },
      features: [fixtureFeature],
      ...(options.renderer === undefined ? {} : { renderer: options.renderer }),
      ...(options.recoverySteps === undefined ? {} : { recoverySteps: options.recoverySteps }),
    },
  };
}

let requests = 0;

/** A fresh request id. */
export function requestId(): RequestId {
  requests += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${requests.toString().padStart(8, "0")}`);
}

export interface EngineFixture extends FakeDeps {
  readonly engine: Engine;
  readonly repo: TempRepoWithRemote;
  /** Sends a command; `office` makes it an office command. */
  command(name: string, args: unknown, office?: OfficeId): Promise<CommandReply>;
  read(name: string, args?: unknown): Promise<ReadReply>;
  /** `engine.hello` with this binary's contract, or `contract` when given. */
  hello(contract?: { major: number; minor: number }): Promise<ReadReply>;
  /** Registers the repository as an office (`office.open`) and returns its id. */
  open(): Promise<OfficeId>;
  /** A second connection to the engine's state database, closed at the end. */
  state(): Promise<StateDatabase>;
}

/**
 * Runs `fn` with an engine over a temporary repository whose `main` is pushed to a bare `origin`.
 * The engine is not recovered: a test calls `recover` itself. It is stopped at the end.
 */
export function withEngine<T>(
  fn: (fixture: EngineFixture) => Promise<T>,
  options: FakeOptions = {},
): Promise<T> {
  return withBareRemote(
    async (repo) => {
      await repo.commitAll("backlog");
      await repo.git("push", "--quiet", "-u", "origin", "main");
      const fake = fakeDeps(repo.root, repo.home, {
        tools: { backlog: BACKLOG_CLI, git: Bun.which("git") ?? "/usr/bin/git" },
        ...options,
      });
      const engine = createEngine(fake.deps);
      const second: { state: StateDatabase | null } = { state: null };
      const command: EngineFixture["command"] = (name, args, office) =>
        engine.executeCommand({
          requestId: requestId(),
          name,
          args,
          origin: "cli",
          confirmed: false,
          ...(office === undefined ? {} : { office }),
        });
      const read: EngineFixture["read"] = (name, args = {}) =>
        engine.executeRead({ requestId: requestId(), name, args });
      try {
        return await fn({
          ...fake,
          engine,
          repo,
          command,
          read,
          hello: () => read("engine.hello", { client: { name: "test", version: "0" } }),
          open: async () => {
            const reply = await command("office.open", { path: repo.dir });
            if (!reply.ok) throw new Error(`office.open: ${reply.error.message}`);
            return (reply.result as { office: OfficeId }).office;
          },
          state: async () => {
            second.state ??= await openStateDatabase({
              stateDir: fake.deps.paths.stateDir,
              logger: fake.deps.logger,
              clock: fake.clock,
              engineVersion: TEST_VERSION,
            });
            return second.state;
          },
        });
      } finally {
        second.state?.close();
        await engine.stop();
        engine.closeDatabase();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}
