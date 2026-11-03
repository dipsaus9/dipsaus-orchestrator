// The box-token hold is sticky (DIPO-271, criterion 8): a passing launch check does not lift it,
// a daemon restart restores it from its record, and only the record's removal by `dipo login box`
// (or `liftSticky`) lifts it. Other holds keep lifting as before.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { BOX_TOKEN_CHECK, tokenCheckFailure } from "../../src/box/token-check";
import {
  BOX_TOKEN_LIFTED_BY,
  boxTokenHoldPath,
  boxTokenStickyPauses,
  clearBoxTokenHold,
  readBoxTokenHold,
} from "../../src/box/token-hold";
import {
  AdapterPauses,
  type PauseNotice,
  pauseMessage,
  type LaunchCheckFailure,
  type StickyPauseRecord,
} from "../../src/run/starts-paused";

const ADAPTER = "claude-cli";
const FOUND: LaunchCheckFailure = tokenCheckFailure(
  { ok: false, code: "box.tokenFound", hold: true, foundIn: ["files"] },
  "dipo-run_1",
) as LaunchCheckFailure;
const PROBE: LaunchCheckFailure = { check: "probe", detail: "claude did not answer" };

function holdsAt(path: string, notices: PauseNotice[] = []): AdapterPauses {
  return new AdapterPauses({
    clock: new ManualClock(),
    notify: (notice) => notices.push(notice),
    sticky: boxTokenStickyPauses(path, ADAPTER),
  });
}

describe("the sticky box-token hold", () => {
  it("is not lifted by a passing launch check, which still refuses the launch", () =>
    withTempDir(async (dir) => {
      const holds = holdsAt(boxTokenHoldPath(dir));
      holds.pause(ADAPTER, [FOUND]);
      const gate = await holds.gateLaunch(ADAPTER, async () => ({ ok: true }));
      expect(gate.ok).toBe(false);
      if (gate.ok) return;
      expect(gate.pause.check).toBe(BOX_TOKEN_CHECK);
      expect(holds.lift(ADAPTER)).toBe(false);
      expect(holds.adapterPaused(ADAPTER)?.check).toBe(BOX_TOKEN_CHECK);
      // The refusal says how it is lifted, not "repeat the launch checks".
      const text = pauseMessage(holds.adapterPaused(ADAPTER)!);
      expect(text).toContain(BOX_TOKEN_LIFTED_BY);
      expect(text).not.toContain("the pause lifts when they pass");
    }));

  it("drops only the other failures when the launch checks pass", () =>
    withTempDir(async (dir) => {
      const holds = holdsAt(boxTokenHoldPath(dir));
      holds.pause(ADAPTER, [PROBE, FOUND]);
      expect(holds.lift(ADAPTER)).toBe(false);
      expect(holds.adapterPaused(ADAPTER)?.failures).toEqual([FOUND]);
    }));

  it("is kept in its record, restored after a restart, and lifted when dipo login box removes it", () =>
    withTempDir(async (dir) => {
      const path = boxTokenHoldPath(dir);
      holdsAt(path).pause(ADAPTER, [FOUND]);
      expect(readBoxTokenHold(path, ADAPTER)).toMatchObject({
        adapter: ADAPTER,
        failures: [FOUND],
      });
      // The record holds no token: only the fixed texts of the check.
      expect(readFileSync(path, "utf8")).not.toContain("setup-token-value");

      // A new daemon: the hold is back before any launch check runs.
      const notices: PauseNotice[] = [];
      const restarted = holdsAt(path, notices);
      expect(restarted.adapterPaused(ADAPTER)?.check).toBe(BOX_TOKEN_CHECK);
      expect(notices.map((notice) => notice.code)).toEqual(["starts.paused"]);
      const gate = await restarted.gateLaunch(ADAPTER, async () => ({ ok: true }));
      expect(gate.ok).toBe(false);

      // `dipo login box` replaced the token and removed the record (another process).
      expect(clearBoxTokenHold(path)).toBe(true);
      expect(restarted.adapterPaused(ADAPTER)).toBeNull();
      expect(notices.at(-1)).toMatchObject({ code: "starts.resumed", level: "info" });
      expect((await restarted.gateLaunch(ADAPTER, async () => ({ ok: true }))).ok).toBe(true);
    }));

  it("is lifted by liftSticky, which also clears the record", () =>
    withTempDir(async (dir) => {
      const path = boxTokenHoldPath(dir);
      const holds = holdsAt(path);
      holds.pause(ADAPTER, [FOUND]);
      expect(holds.liftSticky(ADAPTER)).toBe(true);
      expect(holds.adapterPaused(ADAPTER)).toBeNull();
      expect(existsSync(path)).toBe(false);
    }));

  it("holds when its record cannot be read: a record that reads as nothing proves nothing", () =>
    withTempDir(async (dir) => {
      const path = boxTokenHoldPath(dir);
      writeFileSync(path, "{ not json");
      const holds = holdsAt(path);
      expect(holds.adapterPaused(ADAPTER)?.check).toBe(BOX_TOKEN_CHECK);
      writeFileSync(path, JSON.stringify({ adapter: ADAPTER, failures: [] }));
      expect(readBoxTokenHold(path, ADAPTER)?.failures[0]?.check).toBe(BOX_TOKEN_CHECK);
    }));

  it("holds in memory first and keeps holding when its record cannot be written", async () => {
    const warnings: string[] = [];
    const holds = new AdapterPauses({
      clock: new ManualClock(),
      notify: () => {},
      sticky: {
        checks: new Set([BOX_TOKEN_CHECK]),
        liftedBy: BOX_TOKEN_LIFTED_BY,
        store: {
          read: () => null,
          write: () => {
            throw new Error("EACCES: the state folder cannot be written");
          },
          clear: () => {},
        },
      },
      warn: (message) => warnings.push(message),
    });
    expect(holds.pause(ADAPTER, [FOUND]).check).toBe(BOX_TOKEN_CHECK);
    expect(warnings).toEqual(["the sticky pause record could not be written; the pause stays"]);
    // No record does not mean "lifted" here: the launch is still refused.
    expect(holds.adapterPaused(ADAPTER)?.check).toBe(BOX_TOKEN_CHECK);
    expect((await holds.gateLaunch(ADAPTER, async () => ({ ok: true }))).ok).toBe(false);
    expect(holds.liftSticky(ADAPTER)).toBe(true);
    expect(holds.adapterPaused(ADAPTER)).toBeNull();
  });

  it("keeps an unrecorded sticky hold under a later non-sticky hold, and records it on a later look", async () => {
    let record: StickyPauseRecord | null = null;
    let writable = false;
    const holds = new AdapterPauses({
      clock: new ManualClock(),
      notify: () => {},
      sticky: {
        checks: new Set([BOX_TOKEN_CHECK]),
        liftedBy: BOX_TOKEN_LIFTED_BY,
        store: {
          read: () => record,
          write: (next) => {
            if (!writable) throw new Error("EACCES");
            record = next;
          },
          clear: () => {
            record = null;
          },
        },
      },
    });
    holds.pause(ADAPTER, [FOUND]);
    expect(record).toBeNull();
    // A later hold of another check does not replace the sticky failure ...
    const later = holds.pause(ADAPTER, [PROBE]);
    expect(later.failures).toEqual([FOUND, PROBE]);
    expect(later.liftedBy).toBe(BOX_TOKEN_LIFTED_BY);
    // ... so a passing launch check lifts only the other failure.
    expect((await holds.gateLaunch(ADAPTER, async () => ({ ok: true }))).ok).toBe(false);
    expect(holds.adapterPaused(ADAPTER)?.failures).toEqual([FOUND]);
    // The record is written once the store takes it again, at the next look.
    writable = true;
    expect(holds.adapterPaused(ADAPTER)?.check).toBe(BOX_TOKEN_CHECK);
    expect(record).toMatchObject({ adapter: ADAPTER, failures: [FOUND] });
    // From then on the record decides: `dipo login box` removing it lifts the hold.
    record = null;
    expect(holds.adapterPaused(ADAPTER)).toBeNull();
  });

  it("leaves other holds as they were: a passing launch check lifts them", () =>
    withTempDir(async (dir) => {
      const holds = holdsAt(join(dir, "box-token-hold.json"));
      holds.pause(ADAPTER, [PROBE]);
      expect(existsSync(join(dir, "box-token-hold.json"))).toBe(false);
      expect((await holds.gateLaunch(ADAPTER, async () => ({ ok: true }))).ok).toBe(true);
      expect(holds.adapterPaused(ADAPTER)).toBeNull();
    }));
});
