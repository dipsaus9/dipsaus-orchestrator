// `dipo office rescan` end to end over the real contract (DIPO-72): the CLI's `main` with a real
// `DipoClient` on a real Unix socket, against the daemon's `ContractServer` in-process. Only the scan
// is a fixture: `office.rescan` replies and writes a load scan's `scan.finished` and then the
// rescan's. The CLI once subscribed with `filter: ["scan.finished"]`, but `filter` names the event
// types the daemon leaves out (0005 section 5), so the event never arrived and the command waited
// out its 120 s deadline. Fakes of the session missed it. `cli` may not import `daemon`, so this
// test sits outside both packages and imports their files by path.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { officeRescan, type OfficeId } from "../../packages/contract/src/index";
import type { FeatureModule } from "../../packages/engine/src/index";
import { makeTempDir, ManualClock, removeTempDir } from "../../packages/testkit/src/index";

import { DipoClient } from "../../packages/client/src/index";
import { systemClock, unixSocketTransport } from "../../packages/client/src/node/index";
import type { DaemonControl } from "../../packages/cli/src/daemon-commands";
import { fakeWorkspace } from "../../packages/cli/src/fake-workspace";
import { main, type CliDeps } from "../../packages/cli/src/index";
import { startHarness, type Harness } from "../../packages/daemon/test/support/harness";

/** `office.rescan` with a scan that is already done: a load scan's event, then the rescan's. */
const rescanFeature: FeatureModule = {
  name: "test/rescan",
  register(registry) {
    registry.addOfficeCommand({
      definition: officeRescan,
      handle: (ctx) => {
        ctx.emit({
          type: "scan.finished",
          delta: { scripts: {}, warnings: [], trigger: "start" },
        });
        ctx.emit({
          type: "scan.finished",
          delta: {
            scripts: { verify: "bun run verify" },
            warnings: [],
            trigger: "rescan",
            level: "conforming",
            deviations: [],
            diff: ["~ verify: bun run test -> bun run verify"],
          },
        });
        return { result: { scan: "started" as const }, changed: false };
      },
    });
  },
};

const NO_LIFECYCLE: DaemonControl = {
  inspect: () => Promise.reject(new Error("inspect must not be called")),
  start: () => Promise.reject(new Error("start must not be called")),
  stop: () => Promise.reject(new Error("stop must not be called")),
  restart: () => Promise.reject(new Error("restart must not be called")),
};

let dir: string;
let harness: Harness | null = null;
const clients: DipoClient[] = [];

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await harness?.close();
  harness = null;
  removeTempDir(dir);
});

function cli(h: Harness) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    writeLine: (line) => out.push(line),
    writeError: (line) => err.push(line),
    runDaemon: async () => {
      throw new Error("runDaemon must not be called");
    },
    connectDaemon: async () => {
      const client = new DipoClient({
        transport: unixSocketTransport(h.socketPath),
        clock: systemClock,
        client: { name: "office-rescan-test", version: "0" },
        origin: "cli",
      });
      clients.push(client);
      await client.connect();
      return client;
    },
    daemon: NO_LIFECYCLE,
    clock: new ManualClock(),
    clientChecks: [],
    stamp: undefined,
    runtime: { bun: "1.4.2", os: "linux", arch: "arm64" },
    workspace: fakeWorkspace(),
  };
  return { deps, out, err };
}

describe("dipo office rescan against the contract server", () => {
  it("receives the rescan's scan.finished and prints it", async () => {
    harness = await startHarness(dir, { features: [rescanFeature] });
    const office: OfficeId = harness.addOffice();
    const run = cli(harness);
    expect(await main(["office", "rescan", "--office", office], run.deps)).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out).toEqual([
      `office ${office}: rescanned, conformance conforming`,
      "changes since the previous profile:",
      "  ~ verify: bun run test -> bun run verify",
      "no deviations from the script standard",
    ]);
  });
});
