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
