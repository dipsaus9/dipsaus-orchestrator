// The contract server in-process on a real Unix socket under the test's temp directory, over a
// hand-written engine surface (`FakeSurface`, DIPO-318), with a manual clock: heartbeats and the
// summary debounce move only when a test advances it.

import { join } from "node:path";

import { OfficeId } from "@dipsaus-orchestrator/contract";
import {
  createLogger,
  serveUnixSocket,
  type ServedSocket,
} from "@dipsaus-orchestrator/engine/platform";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { ContractServer } from "../../src/server";
import { FakeSurface, TEST_VERSION } from "./fake-surface";

export { FakeSurface, TEST_VERSION };

export interface Harness {
  readonly socketPath: string;
  readonly clock: ManualClock;
  readonly engine: FakeSurface;
  readonly server: ContractServer;
  readonly socket: ServedSocket;
  /** Each time the server said the last TUI of an office left. */
  readonly tuiLeft: { readonly office: OfficeId; readonly at: number }[];
  /** Adds an office to the fake's change logs and returns its id. */
  addOffice(): OfficeId;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly heartbeatMs?: number;
  readonly backpressureLimitBytes?: number;
  /** The surface to serve; a new fake by default. A restart serves the same one again. */
  readonly engine?: FakeSurface;
}

let offices = 0;

/** A fresh, valid office id. */
export function officeId(): OfficeId {
  offices += 1;
  return OfficeId.parse(`off_01J9ZK5Q8W3V4X6Y7Z${offices.toString().padStart(8, "0")}`);
}

export async function startHarness(dir: string, options: HarnessOptions = {}): Promise<Harness> {
  const clock = new ManualClock();
  const logger = createLogger({ clock, sinks: [], component: "test" });
  const engine = options.engine ?? new FakeSurface();
  const socketPath = join(dir, "dipo.sock");
  const tuiLeft: { office: OfficeId; at: number }[] = [];
  const server = new ContractServer({
    engine,
    clock,
    logger,
    tuiLeft: (office, at) => tuiLeft.push({ office, at }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
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
    engine,
    server,
    socket,
    tuiLeft,
    addOffice() {
      const office = officeId();
      engine.addOffice(office);
      return office;
    },
    async close() {
      server.close();
      await socket.stop();
    },
  };
}
