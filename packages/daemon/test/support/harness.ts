// The contract server in-process on a real Unix socket under the test's temp directory: a manual
// clock (heartbeats move only when a test advances it), the daemon lifecycle, the software stream,
// a migrated state database and fixture feature modules.

import { join } from "node:path";

import {
  defineCommand,
  defineRead,
  OfficeId,
  officeInit,
  officeRescan,
  workRun,
  type CommandDefinition,
  type ReadDefinition,
  type ToolPaths,
} from "@dipsaus-orchestrator/contract";
import {
  createLogger,
  createSystemIds,
  engineRegistry,
  FEATURES,
  helloFeature,
  MemoryRequestTable,
  newLogState,
  noOfficeSummaries,
  officeSummaryOfSource,
  officeSummarySource,
  openStateDatabase,
  Renderer,
  serveUnixSocket,
  SoftwareStream,
  stateOfficeDirectory,
  type FeatureModule,
  type ServedSocket,
  type StateDatabase,
} from "@dipsaus-orchestrator/engine";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { controlFeature, emitDaemonStates } from "../../src/control";
import type { DrainRequest } from "../../src/drain";
import { DaemonLifecycle } from "../../src/lifecycle";
import { ContractServer } from "../../src/server";

export const TEST_VERSION = "0.0.0-test";

function shipped<D extends CommandDefinition>(definition: D, name: string = definition.name) {
  const { provisional: _provisional, since: _since, ...rest } = definition;
  return defineCommand({ ...rest, name, since: 0 });
}

/** An office command that writes one `scan.finished` entry per call. */
export const scanCommand = shipped(officeRescan, "fixture.scan");
/** An office command that writes `BULK_ENTRIES` large `scan.finished` entries, to fill a slow client. */
export const bulkCommand = shipped(officeRescan, "fixture.bulk");
export const BULK_ENTRIES = 120;
export const BULK_ENTRY_BYTES = 16 * 1024;
const BULK_TEXT = "x".repeat(BULK_ENTRY_BYTES);
/** `work.run` as if built, so the `safe` check can be seen; it starts nothing. */
export const runCommand = shipped(workRun);
/** A provisional command: registered, but never described and never a capability. */
export const draftCommand = (() => {
  const { since: _since, ...rest } = shipped(officeInit, "fixture.draft");
  return defineCommand({ ...rest, provisional: true });
})();
/** A shipped test read with its own schemas. */
export const echoRead: ReadDefinition = defineRead({
  name: "fixture.echo",
  args: officeRescan.args,
  result: officeRescan.result,
  since: 0,
});

export const fixtureFeature: FeatureModule = {
  name: "test/fixtures",
  register(registry) {
    registry.addOfficeCommand({
      definition: bulkCommand,
      handle: (ctx) => {
        for (let i = 0; i < BULK_ENTRIES; i++) {
          ctx.emit({ type: "scan.finished", delta: { scripts: {}, warnings: [BULK_TEXT] } });
        }
        return { result: { scan: "started" as const } };
      },
    });
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
    registry.addOfficeCommand({
      definition: runCommand,
      handle: () => ({ result: { started: [], skipped: [] } }),
    });
    registry.addSoftwareCommand({
      definition: draftCommand,
      handle: (_ctx, args) => ({ result: { office: args.office } }),
    });
    registry.addRead({ definition: echoRead, handle: () => ({ scan: "started" as const }) });
  },
};

export interface Harness {
  readonly socketPath: string;
  readonly clock: ManualClock;
  readonly lifecycle: DaemonLifecycle;
  readonly software: SoftwareStream;
  readonly server: ContractServer;
  readonly state: StateDatabase;
  readonly stops: DrainRequest[];
  /** Set `pending` to what `daemon.status` reports as `upgradePending`. */
  readonly upgrade: { pending: boolean };
  readonly socket: ServedSocket;
  /** Registers an office row as `office.open` will, and returns its id. */
  addOffice(name?: string): OfficeId;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Lifecycle states to walk through before serving; `[]` stays in `starting`. */
  readonly states?: readonly ("recovering" | "running" | "safe" | "draining")[];
  readonly heartbeatMs?: number;
  readonly softwareCapacity?: number;
  readonly backpressureLimitBytes?: number;
  readonly renderer?: Renderer;
  /** What `daemon.status` reports as the resolved tool paths. */
  readonly tools?: ToolPaths;
  /** Feature modules registered after the fixtures, for a test that needs a real command name. */
  readonly features?: readonly FeatureModule[];
  /** Office summaries from the state database (DIPO-52); none by default. */
  readonly officeSummaries?: boolean;
}

export async function startHarness(dir: string, options: HarnessOptions = {}): Promise<Harness> {
  const clock = new ManualClock();
  const logger = createLogger({ clock, sinks: [], component: "test" });
  const lifecycle = new DaemonLifecycle("daemon started");
  const software = new SoftwareStream({
    clock,
    ...(options.softwareCapacity === undefined ? {} : { capacity: options.softwareCapacity }),
  });
  emitDaemonStates(lifecycle, software);
  for (const to of options.states ?? ["recovering", "running"]) lifecycle.transition(to, "setup");

  const state = await openStateDatabase({
    stateDir: join(dir, "state"),
    logger,
    clock,
    engineVersion: TEST_VERSION,
  });
  const socketPath = join(dir, "dipo.sock");
  const stops: DrainRequest[] = [];
  const upgrade = { pending: false };
  const registry = engineRegistry([
    ...FEATURES,
    helloFeature({
      engineVersion: TEST_VERSION,
      daemonState: () => lifecycle.state,
      softwareCursor: () => software.head(),
      officeSummaries: noOfficeSummaries,
    }),
    controlFeature({
      lifecycle,
      logger,
      clock,
      startedAt: clock.now(),
      pid: process.pid,
      version: TEST_VERSION,
      socket: socketPath,
      tools: options.tools ?? {},
      upgradePending: () => upgrade.pending,
      loadedOffices: () => [],
      requestStop: (request) => stops.push(request),
    }),
    fixtureFeature,
    ...(options.features ?? []),
  ]);
  const ids = createSystemIds(clock);
  const server = new ContractServer({
    registry,
    offices: stateOfficeDirectory(state),
    clock,
    ids,
    softwareRequests: new MemoryRequestTable(clock),
    lifecycle,
    software,
    officeSummaries:
      options.officeSummaries === true ? officeSummarySource(() => state) : noOfficeSummaries,
    ...(options.officeSummaries === true
      ? { officeSummary: officeSummaryOfSource(() => state) }
      : {}),
    engineVersion: TEST_VERSION,
    logger,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.renderer === undefined ? {} : { renderer: options.renderer }),
  });
  const socket = serveUnixSocket(
    socketPath,
    (connection) => server.accept(connection),
    options.backpressureLimitBytes === undefined
      ? {}
      : { backpressureLimitBytes: options.backpressureLimitBytes },
  );

  return {
    socketPath,
    clock,
    lifecycle,
    software,
    server,
    state,
    stops,
    upgrade,
    socket,
    addOffice(name = "demo") {
      const office = OfficeId.parse(ids.next("off"));
      const log = newLogState();
      state.connection.immediate(() =>
        state.connection.run(
          `insert into offices (office_id, path, display_name, added_at, epoch, next_seq, replay_floor_seq)
           values ($office, $path, $name, $at, $epoch, $next, $floor)`,
          {
            office,
            path: `/repos/${name}`,
            name,
            at: clock.now(),
            epoch: log.epoch,
            next: log.nextSeq,
            floor: log.replayFloorSeq,
          },
        ),
      );
      return office;
    },
    async close() {
      await socket.stop();
      state.close();
    },
  };
}
