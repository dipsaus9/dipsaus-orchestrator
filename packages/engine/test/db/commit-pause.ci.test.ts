// CI only (0017 section 1): measures the pause of one commit under synchronous=FULL, the number
// 0007 section 1 asks M0 to record before the maintenance budget is tuned. It reports, it does
// not gate: CI disks vary too much for a threshold.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { openSqlite } from "../../src/platform/sqlite";
import { localMounts, memoryLogger } from "./helpers";

const COMMITS = 200;
const ms = (value: number) => value.toFixed(3);

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("commit pause under synchronous=FULL", () => {
    it(
      "records commit times",
      () =>
        withTempDir(async (dir) => {
          const db = await openSqlite({
            stateDir: join(dir, "state"),
            logger: memoryLogger(),
            readMounts: localMounts,
          });
          try {
            expect(db.get<{ synchronous: number }>("pragma synchronous")).toEqual({
              synchronous: 2,
            });
            db.immediate(() =>
              db.exec("create table facts (n integer primary key, body text not null) strict"),
            );
            const body = "x".repeat(600); // about one change-log entry (0007 section 11)
            const times: number[] = [];
            for (let n = 0; n < COMMITS; n++) {
              const start = performance.now();
              db.immediate(() =>
                db.run("insert into facts (n, body) values ($n, $body)", { n, body }),
              );
              times.push(performance.now() - start);
            }
            times.sort((x, y) => x - y);
            const at = (q: number) =>
              times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
            console.log(
              `commit pause, synchronous=FULL, ${COMMITS} commits on ${process.platform}/${process.arch} sqlite ${db.sqliteVersion}: ` +
                `p50 ${ms(at(0.5))} ms, p95 ${ms(at(0.95))} ms, p99 ${ms(at(0.99))} ms, max ${ms(at(1))} ms`,
            );
            expect(times).toHaveLength(COMMITS);
          } finally {
            db.close();
          }
        }),
      30_000,
    );
  });
}
