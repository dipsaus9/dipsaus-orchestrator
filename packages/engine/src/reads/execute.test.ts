// The executor answers an office read while the office loads (DIPO-380): `office.desk` shows the
// office as loading, and the read does not wait for the load.

import { describe, expect, test } from "bun:test";

import { type OfficeId, RequestId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import type { OfficeAccess, OfficeDirectory } from "../commands/offices";
import { Registry } from "../commands/registry";
import { registerDesk, type DeskSources } from "../overview/desk";
import { executeRead } from "./execute";

const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as OfficeId;

describe("office.desk while the office loads", () => {
  test("answers at once with the office marked loading while its load is held", async () => {
    const registry = new Registry();
    registry.load({ name: "overview/desk", register: (r) => registerDesk(r, {} as DeskSources) });
    // The load starts with the read and never settles: the held load of the office, as the
    // directory reports it while the load runs.
    const held = new Promise<OfficeAccess>(() => {});
    let started = false;
    const offices: OfficeDirectory = {
      load: () => {
        started = true;
        return held;
      },
      get: () => undefined,
      loading: (office) => started && office === OFFICE,
    };

    const reply = await executeRead(
      { registry, offices, clock: new ManualClock() },
      {
        requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z8A9B0C1E"),
        name: "office.desk",
        args: { office: OFFICE },
      },
    );

    expect(started).toBe(true);
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.result).toEqual([
      expect.objectContaining({ kind: "LOADING", blocks: [], actions: [] }),
    ]);
  });
});
