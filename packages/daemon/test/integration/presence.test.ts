// The maintainer's presence for live questions (DIPO-279, 0021 section 11): a TUI is connected
// right now, known from the client name its `engine.hello` sends. Any other client, its reads and
// commands do not count, and a TUI counts from its handshake until its connection closes, with no
// activity window.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { CONTRACT_VERSION, TUI_CLIENT_NAME } from "@dipsaus-orchestrator/contract";
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

describe("presence", () => {
  it("counts a connected TUI from its handshake until it closes, whatever it sends", async () => {
    const presence = harness.server.presence;
    expect(presence.tuiConnected()).toBe(false);

    const tui = await TestClient.connect(harness.socketPath);
    expect(presence.tuiConnected()).toBe(false);
    await tui.read("engine.hello", {
      contract: CONTRACT_VERSION,
      client: { name: TUI_CLIENT_NAME, version: "0" },
    });
    expect(presence.tuiConnected()).toBe(true);

    // Heartbeats only, past the old 10-minute window: still connected, still present.
    await tui.subscribe("software");
    harness.clock.advance(11 * 60_000);
    await settle();
    expect(presence.tuiConnected()).toBe(true);

    await tui.close();
    await settle();
    expect(presence.tuiConnected()).toBe(false);
  });

  it("does not count another client, even one that sends reads and commands", async () => {
    const presence = harness.server.presence;
    const cli = await TestClient.connect(harness.socketPath);
    await cli.hello();
    await cli.read("commands.describe");
    expect(presence.tuiConnected()).toBe(false);
    await cli.close();
    await settle();
  });
});

/** Opens a connection whose handshake names the TUI. */
async function connectTui(): Promise<TestClient> {
  const tui = await TestClient.connect(harness.socketPath);
  await tui.read("engine.hello", {
    contract: CONTRACT_VERSION,
    client: { name: TUI_CLIENT_NAME, version: "0" },
  });
  return tui;
}

describe("telling the engine when the last TUI closes (DIPO-284)", () => {
  it("calls the listener when the last TUI closes, not while another TUI stays connected", async () => {
    const presence = harness.server.presence;
    const heard: boolean[] = [];
    harness.server.onPresenceChanged(() => heard.push(presence.tuiConnected()));

    const first = await connectTui();
    expect(heard).toEqual([true]);
    const second = await connectTui();
    expect(heard).toEqual([true]);

    // One of two TUIs closes: a question stays live, so the engine is not told.
    await first.close();
    await settle();
    expect(presence.tuiConnected()).toBe(true);
    expect(heard).toEqual([true]);

    // The last TUI closes: the engine is told, and reads no TUI connected.
    await second.close();
    await settle();
    expect(heard).toEqual([true, false]);

    // A reconnect is a change too; the engine reads the TUI connected again.
    const again = await connectTui();
    expect(heard).toEqual([true, false, true]);
    await again.close();
    await settle();
    expect(heard).toEqual([true, false, true, false]);
  });

  it("does not call the listener for another client, and keeps going when a listener throws", async () => {
    const heard: string[] = [];
    harness.server.onPresenceChanged(() => {
      throw new Error("listener failed");
    });
    const remove = harness.server.onPresenceChanged(() => heard.push("changed"));

    const cli = await TestClient.connect(harness.socketPath);
    await cli.hello();
    await cli.close();
    await settle();
    expect(heard).toEqual([]);

    const tui = await connectTui();
    await tui.close();
    await settle();
    expect(heard).toEqual(["changed", "changed"]);
    expect(harness.server.presence.tuiConnected()).toBe(false);

    // A removed listener hears nothing more.
    remove();
    const later = await connectTui();
    await later.close();
    await settle();
    expect(heard).toEqual(["changed", "changed"]);
  });
});
