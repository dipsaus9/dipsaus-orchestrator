// `dipo daemon logs` reads what the daemon's log module writes (DIPO-64, 0006 decision 13).
// `client` may not import `engine` (0004), so the reader in `client/node` repeats the rotated file
// names; this test sits outside both packages, where neither boundary applies, and runs the real
// writer against the real reader. It imports the source files by path because the repository root
// has no package links.

import { describe, expect, it } from "bun:test";

import {
  DAEMON_LOG_FILE as READER_FILE,
  DAEMON_LOG_KEEP as READER_KEEP,
  LogFollower,
  readLogs,
  renderFiltered,
} from "../../packages/client/src/node/logs/reader";
import { DAEMON_LOG_FILE, DAEMON_LOG_KEEP, openLogFile } from "../../packages/engine/src/log/file";
import { createLogger } from "../../packages/engine/src/log/logger";
import { ManualClock, withTempDir } from "../../packages/testkit/src/index";

describe("daemon log writer and reader", () => {
  it("agree on the file names", () => {
    expect(READER_FILE).toBe(DAEMON_LOG_FILE);
    expect(READER_KEEP).toBe(DAEMON_LOG_KEEP);
  });

  it("read every kept line in order, and follow across the writer's rotations", async () => {
    await withTempDir((dir) => {
      const file = openLogFile(dir, { maxBytes: 400 });
      const logger = createLogger({
        clock: new ManualClock(),
        sinks: [file.sink],
        component: "daemon",
      });
      const follower = new LogFollower(dir);
      const followed: string[] = [];
      const run = logger.child({ component: "worker-host", office: "off_1", run: "run_1" });
      for (let n = 1; n <= 12; n += 1) {
        logger.info(`daemon line ${n}`);
        run.warn(`run line ${n}`, { n });
        // Poll after every second line: each poll sees at most one rotation.
        followed.push(...follower.poll());
      }
      file.close();

      const all = readLogs(dir).lines;
      const msgs = all.map((raw) => (JSON.parse(raw) as { msg: string }).msg);
      // Five rotated files plus the current one keep only the newest lines, in order.
      expect(msgs.length).toBeLessThan(24);
      expect(msgs.at(-1)).toBe("run line 12");
      expect(msgs).toEqual(msgs.toSorted((a, b) => order(a) - order(b)));
      expect(followed).toHaveLength(24);
      expect(renderFiltered(followed, { run: "run_1", level: "warn" })).toHaveLength(12);
    });
  });
});

/** Sort key: line number, daemon line before run line. */
function order(msg: string): number {
  const n = Number(msg.split(" ").at(-1));
  return n * 2 + (msg.startsWith("run") ? 1 : 0);
}
