// A TUI client on the socket (0009, 0020, DIPO-428): a connected TUI tells the engine nothing but
// what it reads and follows, however long it stays, so no engine decision depends on whether a TUI
// is open; a worker's question parks at once either way (packages/engine/test/questions). When an
// office's last TUI stops following it, the server tells the engine the time (DIPO-308); the engine
// stores it for `office.digest` (packages/engine/test/create).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { TUI_CLIENT_NAME } from "@dipsaus-orchestrator/contract";
import { makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { settle, TestClient } from "../support/client";
import { startHarness, type Harness } from "../support/harness";

let dir: string;
let harness: Harness;

beforeEach(async () => {
  dir = makeTempDir();
  harness = await startHarness(dir, { heartbeatMs: 60_000 });
});

afterEach(async () => {
  await harness.close();
  removeTempDir(dir);
});

/** Opens a connection whose handshake names the TUI. */
async function connectTui(): Promise<TestClient> {
  const tui = await TestClient.connect(harness.socketPath);
  await tui.read("engine.hello", {
    client: { name: TUI_CLIENT_NAME, version: "0" },
  });
  return tui;
}

describe("a connected TUI (DIPO-428)", () => {
  it("tells the engine only its hello read while it stays connected, past the old 15-minute question wait", async () => {
    const tui = await connectTui();
    await tui.subscribe("software");
    harness.clock.advance(16 * 60_000);
    await settle();
    expect(harness.engine.heard).toEqual([{ kind: "read", name: "engine.hello" }]);
    expect(harness.tuiLeft).toEqual([]);
    // Its close tells the engine nothing either: it followed no office.
    await tui.close();
    await settle();
    expect(harness.engine.heard).toEqual([{ kind: "read", name: "engine.hello" }]);
    expect(harness.tuiLeft).toEqual([]);
  });
});

/** When the server last told the engine that the last TUI of `office` left; null for never. */
function leftAt(office: string): number | null {
  return harness.tuiLeft.filter((left) => left.office === office).at(-1)?.at ?? null;
}

describe("telling the engine when the last TUI of an office left (DIPO-308)", () => {
  it("tells it once the office's last TUI stops following it", async () => {
    const office = harness.addOffice();
    const first = await connectTui();
    const second = await connectTui();
    await first.subscribe(`office:${office}`);
    await second.subscribe(`office:${office}`);

    // Another client following the office, and one of two TUIs closing, tell nothing.
    const cli = await TestClient.connect(harness.socketPath);
    await cli.hello();
    await cli.subscribe(`office:${office}`);
    await cli.close();
    await first.close();
    await settle();
    expect(leftAt(office)).toBeNull();

    // Subscribing again to the same office does not leave it.
    harness.clock.advance(60_000);
    await second.subscribe(`office:${office}`);
    expect(leftAt(office)).toBeNull();

    // The last TUI closes: the engine is told the time, once.
    harness.clock.advance(60_000);
    const closedAt = harness.clock.now();
    await second.close();
    await settle();
    expect(harness.tuiLeft).toEqual([{ office, at: closedAt }]);
  });

  it("tells it when the last TUI unsubscribes from the office, as a switch to another does", async () => {
    const office = harness.addOffice();
    const other = harness.addOffice();
    const tui = await connectTui();
    await tui.subscribe(`office:${office}`);
    harness.clock.advance(60_000);
    const switchedAt = harness.clock.now();
    tui.sendRaw({ kind: "unsubscribe", stream: `office:${office}` });
    await tui.subscribe(`office:${other}`);
    expect(leftAt(office)).toBe(switchedAt);
    expect(leftAt(other)).toBeNull();
    await tui.close();
    await settle();
    expect(leftAt(other)).toBe(switchedAt);
  });
});
