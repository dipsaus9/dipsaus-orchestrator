// The maintainer's presence for the permission wait (0008 section 5, DIPO-59 AC #4): a client is
// connected, and the time of its last command or read after the handshake. The handshake, a
// subscription and its stream heartbeats do not count.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { makeTempDir, removeTempDir } from "@dipsaus-orchestrator/testkit";

import { settle, TestClient } from "../support/client";
import { startHarness, type Harness } from "../support/harness";

let dir: string;
let harness: Harness;

beforeEach(async () => {
  dir = makeTempDir();
  harness = await startHarness(dir, { heartbeatMs: 10 });
});

afterEach(async () => {
  await harness.close();
  removeTempDir(dir);
});

describe("presence", () => {
  it("counts a connected client and its reads and commands, not its handshake or heartbeats", async () => {
    const presence = harness.server.presence;
    expect(presence.connected()).toBe(false);
    expect(presence.lastRequestAt()).toBeNull();

    const client = await TestClient.connect(harness.socketPath);
    await client.hello();
    expect(presence.connected()).toBe(true);
    expect(presence.lastRequestAt()).toBeNull();

    await client.subscribe("software");
    harness.clock.advance(50);
    await settle();
    expect(presence.lastRequestAt()).toBeNull();

    harness.clock.advance(1000);
    const at = harness.clock.now();
    await client.read("commands.describe");
    expect(presence.lastRequestAt()).toBe(at);

    await client.close();
    await settle();
    expect(presence.connected()).toBe(false);
  });
});
