// Shared setup for the office tests: a migrated state database on the manual clock, the office
// manager with real git in an isolated environment, a software stream that records its events,
// and helpers that send commands through the one executor.

import { join } from "node:path";

import {
  type CommandReply,
  type Event,
  type IdSource,
  officeRescan,
  defineCommand,
  type OfficeId,
  RequestId,
} from "@dipsaus-orchestrator/contract";
import { isolatedEnv, ManualClock } from "@dipsaus-orchestrator/testkit";

import { executeCommand, type ExecutorDeps } from "../../src/commands/execute";
import { buildRegistry, type FeatureModule, type Registry } from "../../src/commands/registry";
import { MemoryRequestTable } from "../../src/commands/requests";
import type { StateDatabase } from "../../src/db/database";
import { createLogger } from "../../src/log/logger";
import { officeFeature } from "../../src/office/feature";
import { OfficeManager } from "../../src/office/manager";
import type { MountReader } from "../../src/platform/sqlite";
import { systemSpawn } from "../../src/platform/process";
import { SoftwareStream } from "../../src/software-stream";
import { localMounts } from "../db/helpers";
import { openTestState } from "../commands/helpers";

/** The Backlog.md fixture project: copied into a temp repository it gives `backlog/config.yml`. */
export const BACKLOG_FIXTURE = join(import.meta.dir, "..", "fixtures", "backlog");

const { provisional: _provisional, since: _since, ...rescan } = officeRescan;
/** An office-level command that only answers, so a test can make an office load. */
export const pingCommand = defineCommand({ ...rescan, name: "fixture.ping", since: 0 });

export const pingFeature: FeatureModule = {
  name: "fixture/ping",
  register(registry) {
    registry.addOfficeCommand({
      definition: pingCommand,
      handle: () => ({ result: { scan: "started" as const }, changed: false }),
    });
  },
};

export interface OfficeSetup {
  readonly state: StateDatabase;
  readonly clock: ManualClock;
  readonly ids: IdSource;
  readonly manager: OfficeManager;
  readonly registry: Registry;
  readonly software: SoftwareStream;
  /** Every software stream event, in order. */
  readonly events: Event[];
  /** Offices whose change log got entries outside a command. */
  readonly changed: OfficeId[];
  readonly deps: ExecutorDeps;
}

export interface OfficeSetupOptions {
  /** Feature modules, or a function that makes them for the manager, as the daemon wires them. */
  readonly features?:
    | readonly FeatureModule[]
    | ((manager: OfficeManager, clock: ManualClock) => readonly FeatureModule[]);
  readonly readMounts?: MountReader;
}

/** A state database under `dir/state` and an office manager whose git uses `dir/home`. */
export async function officeSetup(
  dir: string,
  options: OfficeSetupOptions = {},
): Promise<OfficeSetup> {
  const t = await openTestState(dir);
  const software = new SoftwareStream({ clock: t.clock });
  const events: Event[] = [];
  software.onAppend((event) => events.push(event));
  const changed: OfficeId[] = [];
  let registry: Registry | undefined;
  const manager = new OfficeManager({
    database: () => t.state,
    registry: () => {
      if (registry === undefined) throw new Error("the registry is not built yet");
      return registry;
    },
    software,
    clock: t.clock,
    ids: t.ids,
    git: { spawn: systemSpawn, env: isolatedEnv(join(dir, "home")) },
    logger: createLogger({ clock: t.clock, sinks: [], component: "office", level: "error" }),
    readMounts: options.readMounts ?? localMounts,
    onOfficeChanged: (office) => changed.push(office),
  });
  const features =
    typeof options.features === "function"
      ? options.features(manager, t.clock)
      : (options.features ?? []);
  registry = buildRegistry([officeFeature(manager), pingFeature, ...features]);
  const deps: ExecutorDeps = {
    registry,
    offices: manager,
    clock: t.clock,
    ids: t.ids,
    softwareRequests: new MemoryRequestTable(t.clock),
  };
  return {
    state: t.state,
    clock: t.clock,
    ids: t.ids,
    manager,
    registry,
    software,
    events,
    changed,
    deps,
  };
}

let requestCount = 0;

/** A fresh request id for every command a test sends. */
export function nextRequestId(): RequestId {
  requestCount += 1;
  return RequestId.parse(`01J9ZK5Q8W3V4X6Y7Z${requestCount.toString().padStart(8, "0")}`);
}

export function send(
  s: OfficeSetup,
  name: string,
  args: unknown,
  office?: OfficeId,
): Promise<CommandReply> {
  return executeCommand(s.deps, {
    requestId: nextRequestId(),
    name,
    args,
    origin: "cli",
    confirmed: false,
    ...(office === undefined ? {} : { office }),
  });
}

/** The result of a successful reply; throws with the error otherwise. */
export function resultOf<T = unknown>(reply: CommandReply): T {
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply.result as T;
}

/** The error code of a failed reply; throws when it succeeded. */
export function errorOf(reply: CommandReply): string {
  if (reply.ok) throw new Error(`expected an error, got ${JSON.stringify(reply.result)}`);
  return reply.error.code;
}

export interface OfficeRow {
  readonly office_id: string;
  readonly path: string;
  readonly display_name: string;
  readonly forgotten_at: number | null;
}

export function officeRows(state: StateDatabase): OfficeRow[] {
  return state.connection.all<OfficeRow>(
    "select office_id, path, display_name, forgotten_at from offices order by added_at, office_id",
  );
}
