import { describe, expect, it } from "bun:test";

import { MANUAL_CLOCK_START, ManualClock } from "./clock";

describe("ManualClock", () => {
  it("starts at a fixed time and moves only when advanced", () => {
    const clock = new ManualClock();
    expect(clock.now()).toBe(MANUAL_CLOCK_START);
    clock.advance(250);
    expect(clock.now()).toBe(MANUAL_CLOCK_START + 250);
    expect(new ManualClock(42).now()).toBe(42);
  });

  it("fires timers in due order, ties in the order they were set", () => {
    const clock = new ManualClock(0);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push(`c@${clock.now()}`), 30);
    clock.setTimeout(() => fired.push(`a@${clock.now()}`), 10);
    clock.setTimeout(() => fired.push(`b1@${clock.now()}`), 20);
    clock.setTimeout(() => fired.push(`b2@${clock.now()}`), 20);
    clock.advance(100);
    expect(fired).toEqual(["a@10", "b1@20", "b2@20", "c@30"]);
    expect(clock.now()).toBe(100);
  });

  it("never fires a timer early", () => {
    const clock = new ManualClock(0);
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(clock.now()), 1000);
    clock.advance(999);
    expect(fired).toEqual([]);
    expect(clock.pendingTimers).toBe(1);
    clock.advance(1);
    expect(fired).toEqual([1000]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("fires timers set by a callback when they fall due in the same advance", () => {
    const clock = new ManualClock(0);
    const fired: number[] = [];
    clock.setTimeout(() => {
      fired.push(clock.now());
      clock.setTimeout(() => fired.push(clock.now()), 5);
      clock.setTimeout(() => fired.push(clock.now()), 500);
    }, 10);
    clock.advance(20);
    expect(fired).toEqual([10, 15]);
    clock.advance(480);
    expect(fired).toEqual([10, 15]);
    clock.advance(10);
    expect(fired).toEqual([10, 15, 510]);
  });

  it("does not fire a cleared timer", () => {
    const clock = new ManualClock(0);
    const fired: string[] = [];
    const handle = clock.setTimeout(() => fired.push("cleared"), 10);
    clock.setTimeout(() => fired.push("kept"), 10);
    clock.clearTimeout(handle);
    clock.clearTimeout(handle);
    clock.advance(10);
    expect(fired).toEqual(["kept"]);
  });

  it("treats a zero or negative delay as due now and refuses to go back", () => {
    const clock = new ManualClock(0);
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(clock.now()), -5);
    clock.setTimeout(() => fired.push(clock.now()), 0);
    expect(fired).toEqual([]);
    clock.advance(0);
    expect(fired).toEqual([0, 0]);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advanceTo(-1)).toThrow(RangeError);
  });
});
