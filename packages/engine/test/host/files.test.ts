// The run files the host writes: `events.ndjson` lines with growing byte offsets, the line
// splitter, and `host.log` capped by dropping the oldest half (0006 decisions 8 and 13).

import { describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { EventLog, LineSplitter } from "../../src/host/events";
import { newerHalf, openHostLog } from "../../src/host/host-log";

describe("EventLog", () => {
  it("appends { t, ch, data } lines and returns the byte offset after each", () =>
    withTempDir((dir) => {
      const path = join(dir, "events.ndjson");
      const log = EventLog.open(path);
      expect(log.offset).toBe(0);
      const first = log.append({ t: 0, ch: "stdout", data: '{"type":"system"}\n' });
      const second = log.append({ t: 5, ch: "stderr", data: "é warning\n" });
      log.close();
      const bytes = readFileSync(path);
      expect(second).toBe(bytes.byteLength);
      expect(first).toBe(bytes.indexOf(0x0a) + 1);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const lines = bytes
        .toString("utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines).toEqual([
        { t: 0, ch: "stdout", data: '{"type":"system"}\n' },
        { t: 5, ch: "stderr", data: "é warning\n" },
      ]);
      // A second host for the run continues the offsets.
      const again = EventLog.open(path);
      expect(again.offset).toBe(second);
      again.close();
    }));
});

describe("LineSplitter", () => {
  it("keeps newlines, holds partial lines and survives split UTF-8", () => {
    const splitter = new LineSplitter();
    const bytes = new TextEncoder().encode("a\nbé");
    expect(splitter.push(bytes.subarray(0, 4))).toEqual(["a\n"]);
    expect(splitter.push(bytes.subarray(4))).toEqual([]);
    expect(splitter.push("c\nd\ne")).toEqual(["béc\n", "d\n"]);
    expect(splitter.flush()).toBe("e");
    expect(splitter.flush()).toBeNull();
  });
});

describe("host.log", () => {
  it("keeps the newer half from a line boundary", () => {
    expect(newerHalf(Buffer.from("aaaa\nbbbb\ncccc\n")).toString()).toBe("cccc\n");
    expect(newerHalf(Buffer.from("")).toString()).toBe("");
  });

  it("drops the oldest half once the cap would be passed", () =>
    withTempDir((dir) => {
      const path = join(dir, "host.log");
      const log = openHostLog(path, 200);
      for (let i = 0; i < 40; i++) log.sink(`line ${String(i).padStart(3, "0")}`);
      log.close();
      const text = readFileSync(path, "utf8");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200);
      expect(text.endsWith("line 039\n")).toBe(true);
      expect(text).not.toContain("line 000");
      expect(text.split("\n").every((l) => l === "" || /^line \d{3}$/.test(l))).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }));
});
