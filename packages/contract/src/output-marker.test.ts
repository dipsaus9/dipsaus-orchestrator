// Engine phase markers flagged in the worker output (DIPO-95): `work.output` and the
// `work.outputRange` result carry them as `markers`, an optional minor 1 addition.

import { describe, expect, it } from "bun:test";

import { workerOutputFixture, workRef } from "./fixtures";
import { OutputMarker, workOutput, workOutputRange } from "./index";

const marker = {
  from: 1024,
  to: 1069,
  kind: "phase",
  value: "verify",
  at: "2026-10-12T09:00:00.000Z",
};

const work = workRef;

describe("OutputMarker (DIPO-95)", () => {
  it("parses a phase and an end marker, and keeps an unknown kind (open enum)", () => {
    expect(OutputMarker.parse(marker)).toEqual(marker);
    expect(OutputMarker.parse({ ...marker, kind: "ended", value: "in-review" }).kind).toBe("ended");
    expect(OutputMarker.parse({ ...marker, kind: "paused" }).kind).toBe("paused");
  });

  it("refuses an empty value, a negative offset and a time that is not ISO", () => {
    expect(OutputMarker.safeParse({ ...marker, value: "" }).success).toBe(false);
    expect(OutputMarker.safeParse({ ...marker, from: -1 }).success).toBe(false);
    expect(OutputMarker.safeParse({ ...marker, at: "soon" }).success).toBe(false);
  });

  it("is optional on work.output and the work.outputRange result, so older data still parses", () => {
    const range = { from: 0, to: 4, text: "hi!\n" };
    expect(workOutput.data.safeParse({ work, source: "worker", ...range }).success).toBe(true);
    expect(
      workOutput.data.parse({ work, source: "worker", ...range, markers: [marker] }).markers,
    ).toEqual([marker]);
    const run = work.run;
    expect(workOutputRange.result.safeParse({ run, source: "worker", ...range }).success).toBe(
      true,
    );
    expect(
      workOutputRange.result.parse({ run, source: "worker", ...range, markers: [marker] }).markers,
    ).toEqual([marker]);
  });
});

describe("work.output fixtures (DIPO-95)", () => {
  it("keep a plain worker-output range without markers next to the flagged marker", () => {
    const plain = workOutput.data.parse(workerOutputFixture);
    expect(plain.markers).toBeUndefined();
    expect(plain.to - plain.from).toBe(new TextEncoder().encode(plain.text).byteLength);
  });
});
