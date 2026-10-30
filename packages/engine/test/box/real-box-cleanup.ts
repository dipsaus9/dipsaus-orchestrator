// The boxes of one run of a real-box test file (DIPO-374). Every backend the file makes labels its
// boxes with this run's state folder label (`stateLabel`, or `other(...)` for a box made as if by
// another state folder), so:
// - after all its tests, also when one failed, the run deletes every box with one of its labels,
//   and says so for each box it could not delete;
// - before its tests, the run reports each box an earlier run of the same file left (a label of
//   the file's but not of this run), and deletes none of them: that run may still go on;
// - no daemon's sweep deletes a test's box, and no test's sweep a daemon's: the labels differ.
// A box made before DIPO-374 has no label, so it is neither found nor reported.

import { basename } from "node:path";

import { afterAll, beforeAll } from "bun:test";

import { cleanEnv } from "@dipsaus-orchestrator/testkit";

import { AppleContainerBoxes } from "../../src/box/apple-container";
import type { BoxInfo } from "../../src/box/port";
import { systemClock } from "../../src/platform/clock";
import { systemSpawn } from "../../src/platform/process";

/** How long the report and the clean-up may take: a delete per box. */
const CLEANUP_TIMEOUT_MS = 5 * 60_000;

export interface RealBoxCleanup {
  /** The state folder label of this run: every backend the file makes passes it. */
  readonly stateLabel: string;
  /** Another label of this run, for a box made as if by another state folder; deleted as well. */
  other(name: string): string;
}

/** The label prefix every run of the test file `file` uses: `test.<file stem>.`. */
export function testLabelPrefix(file: string): string {
  const stem = basename(file)
    .replace(/\.test\.ts$/, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-");
  return `test.${stem}.`;
}

/** True when `box` carries `label` or one of its `other` labels. */
function hasRunLabel(box: BoxInfo, label: string): boolean {
  return box.stateLabel === label || (box.stateLabel?.startsWith(`${label}.`) ?? false);
}

/**
 * Registers the report of boxes an earlier run left (before all) and the clean-up of this run's
 * boxes (after all) for the real-box test file `file`; call it once, where its tests register.
 */
export function cleanUpRealBoxes(file: string): RealBoxCleanup {
  const prefix = testLabelPrefix(file);
  const stateLabel = `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const env = cleanEnv();
  const lister = new AppleContainerBoxes({
    spawn: systemSpawn,
    clock: systemClock,
    env: { PATH: env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin", HOME: env["HOME"] ?? "/" },
  });
  const say = (text: string) => console.warn(`box clean-up (${basename(file)}): ${text}`);

  beforeAll(async () => {
    try {
      for (const box of await lister.list()) {
        if (box.stateLabel?.startsWith(prefix) !== true || hasRunLabel(box, stateLabel)) continue;
        say(`leaked by an earlier run: ${box.name} (${box.state}, label ${box.stateLabel})`);
      }
    } catch (error) {
      say(`listing the boxes failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, CLEANUP_TIMEOUT_MS);

  afterAll(async () => {
    let listed: BoxInfo[];
    try {
      listed = await lister.list();
    } catch (error) {
      say(`listing the boxes failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const box of listed) {
      if (!hasRunLabel(box, stateLabel)) continue;
      try {
        await lister.delete(box.name);
        say(`deleted ${box.name}, which the run left`);
      } catch (error) {
        say(
          `deleting ${box.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }, CLEANUP_TIMEOUT_MS);

  return { stateLabel, other: (name) => `${stateLabel}.${name}` };
}
