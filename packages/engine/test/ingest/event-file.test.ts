// The event-file reader on a file that changed between its stat and its read (DIPO-427).

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { readCompleteLines } from "../../src/ingest/event-file";

describe("readCompleteLines", () => {
  it("returns no lines, without looping, when the file is shorter than its stat said", () => {
    const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "event-file-"));
    try {
      const path = join(dir, "events.ndjson");
      writeFileSync(path, "abc");
      expect(readCompleteLines(path, 0, 100)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a file that grew between passes in full on the next pass", () => {
    const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "event-file-"));
    try {
      const path = join(dir, "events.ndjson");
      writeFileSync(path, "one\ntwo\n");
      const first = readCompleteLines(path, 0, 8);
      expect(first.map((line) => line.text)).toEqual(["one", "two"]);
      appendFileSync(path, "three\nfour\n");
      const second = readCompleteLines(path, first[1]!.end, 19);
      expect(second.map((line) => line.text)).toEqual(["three", "four"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
