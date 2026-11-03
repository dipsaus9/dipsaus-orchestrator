// A TUI client on the socket (0009, 0020, DIPO-428): a connected TUI tells the engine nothing but
// what it reads and follows, however long it stays and however it leaves an office, so no engine
// decision depends on whether a TUI is open (0001); a worker's question parks at once either way
// (packages/engine/test/questions). The "since you left" digest counts from a time the TUI keeps
// itself and sends with `office.digest` (packages/tui/src/digest.test.tsx).

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
    await tui.close();
    await settle();
    expect(harness.engine.heard).toEqual([{ kind: "read", name: "engine.hello" }]);
  });

  it("tells the engine nothing when the last TUI of an office switches away or closes", async () => {
    const office = harness.addOffice();
    const other = harness.addOffice();
    const tui = await connectTui();
    await tui.subscribe(`office:${office}`);
    harness.clock.advance(60_000);
    tui.sendRaw({ kind: "unsubscribe", stream: `office:${office}` });
    await tui.subscribe(`office:${other}`);
    harness.clock.advance(60_000);
    await tui.close();
    await settle();
    expect(harness.engine.heard).toEqual([{ kind: "read", name: "engine.hello" }]);
  });
});
