// The log reader behind `dipo daemon logs` (DIPO-64, 0006 decision 13): reading the rotated files
// in order, filtering a fixture log by office, run and level, rendering, and following across a
// rotation.

import { describe, expect, it } from "bun:test";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { SEQUENCE_SAMPLES } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import {
  followLogs,
  LogFollower,
  matchesFilter,
  parseLogLine,
  readLogs,
  renderFiltered,
  renderLogLine,
  type LogFilter,
} from "../../src/node/logs/index";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "daemon.log"), "utf8")
  .trim()
  .split("\n");

const messages = (filter: LogFilter) =>
  FIXTURE.filter((raw) => matchesFilter(parseLogLine(raw), filter)).map(
    (raw) => parseLogLine(raw)?.msg ?? raw,
  );

/** A JSON line like the daemon writes. */
const line = (msg: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: "2026-10-13T08:00:00.000Z",
    level: "info",
    msg,
    component: "daemon",
    ...extra,
  });

describe("parseLogLine", () => {
  it("splits the known keys from the other fields", () => {
    expect(parseLogLine(FIXTURE[4] ?? "")).toEqual({
      raw: FIXTURE[4] ?? "",
      ts: "2026-10-13T08:00:03.000Z",
      level: "info",
      msg: "worker started",
      component: "worker-host",
      office: "off_alpha",
      run: "run_1",
      fields: { workerPid: 77 },
    });
  });

  it("returns null for a line that is not a log line", () => {
    expect(parseLogLine("not json: a torn line")).toBeNull();
    expect(parseLogLine("[1,2]")).toBeNull();
    expect(parseLogLine('{"level":"loud","ts":"x","msg":"m"}')).toBeNull();
  });
});

describe("filters over the fixture log", () => {
  it("keeps every line, the torn one too, without a filter", () => {
    expect(messages({})).toHaveLength(FIXTURE.length);
  });

  it("--office keeps that office's lines", () => {
    expect(messages({ office: "off_alpha" })).toEqual([
      "office loaded",
      "worker started",
      "worker event",
      "worker exited",
    ]);
  });

  it("--run keeps that run's lines", () => {
    expect(messages({ run: "run_1" })).toEqual(["worker started", "worker event"]);
  });

  it("--level keeps that level and the more severe ones", () => {
    expect(messages({ level: "warn" })).toEqual(["office refused", "worker exited"]);
    expect(messages({ level: "error" })).toEqual(["worker exited"]);
    expect(messages({ level: "info" })).toEqual([
      "daemon starting",
      "office loaded",
      "office refused",
      "worker started",
      "worker exited",
      "daemon stopped",
    ]);
    expect(messages({ level: "trace" })).toHaveLength(FIXTURE.length - 1);
  });

  it("combines filters", () => {
    expect(messages({ office: "off_alpha", level: "info" })).toEqual([
      "office loaded",
      "worker started",
      "worker exited",
    ]);
    expect(messages({ office: "off_beta", run: "run_1" })).toEqual([]);
  });
});

describe("rendering", () => {
  it("shows time, level, where, message and fields", () => {
    expect(renderLogLine(FIXTURE[4] ?? "")).toBe(
      "2026-10-13T08:00:03.000Z INFO  [worker-host office=off_alpha run=run_1] worker started workerPid=77",
    );
    expect(renderLogLine(FIXTURE[0] ?? "")).toBe(
      "2026-10-13T08:00:00.000Z INFO  [daemon] daemon starting pid=4242 version=0.1.0",
    );
  });

  it("quotes values with spaces and prints objects as JSON", () => {
    expect(renderLogLine(line("m", { note: "two words", detail: { a: 1 } }))).toBe(
      '2026-10-13T08:00:00.000Z INFO  [daemon] m note="two words" detail={"a":1}',
    );
  });

  it("prints a line that is not JSON as it is", () => {
    expect(renderLogLine("not json: a torn line")).toBe("not json: a torn line");
  });

  it("renders only what passes the filter", () => {
    expect(renderFiltered(FIXTURE, { run: "run_2" })).toEqual([
      "2026-10-13T08:00:05.000Z ERROR [worker-host office=off_alpha run=run_2] worker exited exitCode=1",
    ]);
  });
});

describe("readLogs", () => {
  it("reads daemon.log.5 down to daemon.log.1, then daemon.log", async () => {
    await withTempDir((dir) => {
      writeFileSync(join(dir, "daemon.log.5"), "five\n");
      writeFileSync(join(dir, "daemon.log.2"), "two-a\ntwo-b\n");
      writeFileSync(join(dir, "daemon.log.1"), "one\n");
      writeFileSync(join(dir, "daemon.log"), "current\n");
      writeFileSync(join(dir, "daemon.log.6"), "ignored\n");
      expect(readLogs(dir)).toEqual({
        lines: ["five", "two-a", "two-b", "one", "current"],
        found: true,
      });
    });
  });

  it("reports when there is no log at all", async () => {
    await withTempDir((dir) => {
      expect(readLogs(join(dir, "missing"))).toEqual({ lines: [], found: false });
    });
  });
});

describe("LogFollower", () => {
  it("returns complete lines only, and the rest once its newline arrives", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "daemon.log");
      writeFileSync(path, "a\nb");
      const follower = new LogFollower(dir);
      expect(follower.poll()).toEqual(["a"]);
      expect(follower.poll()).toEqual([]);
      appendFileSync(path, "c\nd\n");
      expect(follower.poll()).toEqual(["bc", "d"]);
    });
  });

  it("follows across a rotation without losing or repeating a line", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "daemon.log");
      writeFileSync(path, "1\n");
      const follower = new LogFollower(dir);
      expect(follower.poll()).toEqual(["1"]);
      // The daemon writes once more, then rotates and starts a new file before the next poll.
      appendFileSync(path, "2\n");
      renameSync(path, `${path}.1`);
      writeFileSync(path, "3\n");
      expect(follower.poll()).toEqual(["2", "3"]);
      appendFileSync(path, "4\n");
      expect(follower.poll()).toEqual(["4"]);
    });
  });

  it("reads every file rotated between two polls, oldest first", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "daemon.log");
      // Shifts like the daemon does: .4 to .5, ..., daemon.log to .1, then a new daemon.log.
      const rotate = (next: string) => {
        for (let n = 4; n >= 1; n -= 1) {
          if (existsSync(`${path}.${n}`)) renameSync(`${path}.${n}`, `${path}.${n + 1}`);
        }
        renameSync(path, `${path}.1`);
        writeFileSync(path, next);
      };
      writeFileSync(path, "older\n");
      rotate("1\n");
      const follower = new LogFollower(dir);
      expect(follower.poll()).toEqual(["1"]);
      // Three rotations before the next poll: the followed file ends up as daemon.log.3.
      appendFileSync(path, "2\n");
      rotate("3a\n3b\n");
      rotate("4\n");
      rotate("5\n");
      // daemon.log.4 holds lines from before the followed file; they are not repeated.
      expect(follower.poll()).toEqual(["2", "3a", "3b", "4", "5"]);
      appendFileSync(path, "6\n");
      expect(follower.poll()).toEqual(["6"]);
    });
  });

  it("waits for daemon.log to appear, and starts over after it was removed", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "daemon.log");
      const follower = new LogFollower(dir);
      expect(follower.poll()).toEqual([]);
      writeFileSync(path, "first\n");
      expect(follower.poll()).toEqual(["first"]);
      rmSync(path);
      expect(follower.poll()).toEqual([]);
      writeFileSync(path, "again\n");
      expect(follower.poll()).toEqual(["again"]);
    });
  });

  it("starts over when the file is truncated in place", async () => {
    await withTempDir((dir) => {
      const path = join(dir, "daemon.log");
      writeFileSync(path, "long line one\n");
      const follower = new LogFollower(dir);
      expect(follower.poll()).toEqual(["long line one"]);
      writeFileSync(path, "x\n");
      expect(follower.poll()).toEqual(["x"]);
    });
  });
});

describe("followLogs", () => {
  it("prints history, then new lines on each tick, filtered, until the signal aborts", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "daemon.log");
      writeFileSync(`${path}.1`, `${line("old", { run: "run_1" })}\n${line("other")}\n`);
      writeFileSync(path, `${line("current", { run: "run_1" })}\n`);
      const clock = new ManualClock();
      const out: string[] = [];
      const stop = new AbortController();
      const done = followLogs({
        logsDir: dir,
        filter: { run: "run_1" },
        clock,
        write: (rendered) => out.push(rendered),
        signal: stop.signal,
        intervalMs: 100,
      });
      const msgs = () => out.map((rendered) => rendered.split("] ")[1]);
      expect(msgs()).toEqual(["old", "current"]);

      appendFileSync(
        path,
        `${line("new", { run: "run_1" })}\n${line("skipped", { run: "run_2" })}\n`,
      );
      renameSync(path, `${path}.1`);
      writeFileSync(path, `${line("rotated", { run: "run_1" })}\n`);
      expect(msgs()).toEqual(["old", "current"]);
      clock.advance(100);
      expect(msgs()).toEqual(["old", "current", "new", "rotated"]);

      stop.abort();
      await done;
      appendFileSync(path, `${line("after", { run: "run_1" })}\n`);
      clock.advance(1000);
      expect(msgs()).toEqual(["old", "current", "new", "rotated"]);
    });
  });
});

describe("log text is cleaned of terminal control characters (DIPO-313)", () => {
  for (const [name, sample] of Object.entries(SEQUENCE_SAMPLES)) {
    it(`prints ${name} as plain text`, () => {
      const json = line(`story${sample}done`, { detail: `x${sample}y`, other: 'a"b' });
      const rendered = renderFiltered([json, `raw${sample}line`], {});
      expect(rendered[0]).toContain("storydone");
      expect(rendered[0]).toContain("detail=xy");
      expect(rendered[1]).toBe("rawline");
      // oxlint-disable-next-line no-control-regex
      expect(rendered.join("\n")).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    });
  }
});
