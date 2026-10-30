// What `createEngine` takes and what it gives (0005, DIPO-318). The daemon gives its process
// concerns: time, the log, how processes start and are probed (the worker hosts, the test-box
// forwarders and the model proxy's listener among them), its directories, settings and tools, and
// the facts only it knows (its PID, socket, the upgrade check, how a stop is requested). The engine
// builds everything else from them: the state database, git, the code host, the worker port and
// every service. Tests pass fakes for the process concerns.

import type {
  Clock,
  DaemonState,
  OfficeId,
  SoftwareConfig,
  Spawn,
  ToolPaths,
} from "@dipsaus-orchestrator/contract";

import type { ListenHttp } from "../box/model-proxy";
import type { TestBoxesDeps } from "../box/test-box";
import type { Renderer } from "../changelog/render";
import type { FeatureModule } from "../commands/registry";
import type { Logger } from "../log/logger";
import type { SpawnKeepAwake } from "../platform/keepawake";
import type { PostNotification } from "../platform/notify";
import type { ProcessProbe } from "../platform/process";
import type { HostStarter } from "../run/launch";
import type { WorkerPort } from "../workers/port";
import type { DrainCaps, DrainRequest, DrainResult } from "./drain";
import type { RecoveryStep } from "./recovery";
import type { EngineSurface } from "./surface";

/** The directories the engine works in (0005 section 13). */
export interface EnginePaths {
  /** The state directory: `dipo.db`, the box index, the package caches. */
  readonly stateDir: string;
  /** The runtime directory: worker host sockets. */
  readonly runtimeDir: string;
  /** Where each run's temp directory is made. */
  readonly tmpRoot: string;
  /** The passwd home directory, for the tools that need one. */
  readonly home: string;
}

/** What only the daemon process knows, for `daemon.status` and `daemon.stop` (0006). */
export interface DaemonFacts {
  readonly pid: number;
  readonly uid: number;
  /** The binary version, recorded in the database and given by `engine.hello`. */
  readonly version: string;
  /** The commit the binary was built from; absent when run from source (DIPO-198). */
  readonly buildCommit?: string;
  /** When the daemon started, on the engine clock. */
  readonly startedAt: number;
  readonly socket: string;
  /** True once the executable on disk changed (0006 decision 14). */
  readonly upgradePending: () => boolean;
  /** Starts the daemon's drain; the first request wins. */
  readonly requestStop: (request: DrainRequest) => void;
}

export interface EngineDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  /** Starts every process the engine runs: git, gh, the Backlog CLI, boxes, the worker. */
  readonly spawn: Spawn;
  /** Reads a process's start time: the worker hosts and the claims' holders. */
  readonly probe: ProcessProbe;
  /** Starts the keep-awake assertion (0006 decision 12). */
  readonly spawnKeepAwake: SpawnKeepAwake;
  /** Starts the detached worker hosts (0006 decision 8). */
  readonly hosts: HostStarter;
  /** The test boxes' forwarders on the Mac's loopback, and the check that one answers (DIPO-309). */
  readonly forwarders: Pick<TestBoxesDeps, "forward" | "reach">;
  /** The model proxy's HTTP listener on the box network (0008). */
  readonly listenHttp: ListenHttp;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly paths: EnginePaths;
  /** The absolute tool paths resolved from the daemon's PATH at start (DIPO-70). */
  readonly tools: ToolPaths;
  /** The software-level settings read at start. */
  readonly settings: SoftwareConfig;
  /**
   * Posts a desk notification (DIPO-357); the daemon gives the system's, a test a fake. Without it
   * no desk notification is posted.
   */
  readonly postNotification?: PostNotification;
  readonly daemon: DaemonFacts;
  /**
   * SQL steps after the compiled-in migrations, numbered after them; a test adds a failing step
   * (DIPO-111).
   */
  readonly extraMigrations?: readonly { readonly name: string; readonly sql: string }[];
  /** Recovery steps after the engine's own, in order; tests add one. */
  readonly recoverySteps?: readonly RecoveryStep[];
  /** Feature modules served after the engine's own; tests register fixtures here. */
  readonly features?: readonly FeatureModule[];
  /** Wraps the worker port; a test daemon process plans a scripted worker (DIPO-316). */
  readonly workerPort?: (port: WorkerPort) => WorkerPort;
  readonly renderer?: Renderer;
}

/** A running engine: its surface, and what the daemon drives through its life. */
export interface Engine extends EngineSurface {
  /** The daemon state (0006 decision 7). */
  state(): DaemonState;
  /**
   * Moves to `recovering`, runs the recovery steps in their order, then enters `running` and starts
   * the jobs of a running engine. A drain that starts meanwhile lets the current step finish and
   * runs no further step.
   */
  recover(): Promise<void>;
  /** Enters `draining` and drains within the cap (0006 decision 7). */
  drain(request: DrainRequest, caps?: DrainCaps): Promise<DrainResult>;
  /** True while an engine step runs: a child process the engine started, or a command's writes. */
  busy(): boolean;
  /** What the socket server sees: whether a TUI is connected (0021, DIPO-279). */
  setTuiPresent(connected: boolean): void;
  /** The last TUI client of `office` disconnected at `at` (DIPO-308). */
  tuiLeft(office: OfficeId, at: number): void;
  /** Stops every service, timer and engine call; the database stays open. */
  stop(): Promise<void>;
  /** Checkpoints and closes the state database (DIPO-87); last, after the socket closed. */
  closeDatabase(): void;
}
