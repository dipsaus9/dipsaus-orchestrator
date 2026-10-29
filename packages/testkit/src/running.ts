// Whether a killed process still runs, for the tests that kill a process group (DIPO-372).
//
// A killed process whose parent is gone becomes a child of PID 1. On the Mac and on a CI runner
// PID 1 reaps it at once; in a box PID 1 is the box's keepalive `tail` (0008), which reaps
// nothing, so the dead process stays a zombie and `kill(pid, 0)` still finds it. These checks
// count a zombie as gone. Without `/proc` (macOS) a process that `kill(pid, 0)` finds runs.

import { existsSync, readdirSync, readFileSync } from "node:fs";

const HAS_PROC = existsSync("/proc/self/stat");

/** The state (field 3) and process group (field 5) of a `/proc/<pid>/stat` line; null if malformed. */
export function procStatGroup(text: string): { state: string; pgrp: number } | null {
  // The command name in field 2 may hold spaces and parentheses: count from the last `)`.
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const [state, , pgrp] = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  if (state === undefined || pgrp === undefined || !/^\d+$/.test(pgrp)) return null;
  return { state, pgrp: Number(pgrp) };
}

/** The `/proc/<pid>/stat` reading of `pid`; null when it is gone or unreadable. */
function readStat(pid: number): { state: string; pgrp: number } | null {
  try {
    return procStatGroup(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/** `kill(target, 0)`: true when it finds a process (EPERM finds one too). */
function found(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/** True while `pid` runs: a process has it and, where `/proc` exists, it is not a zombie. */
export function processRunning(pid: number): boolean {
  if (!found(pid)) return false;
  if (!HAS_PROC) return true;
  const stat = readStat(pid);
  return stat !== null && stat.state !== "Z";
}

/** True while a process of group `pgid` runs that is not a zombie. */
export function groupRunning(pgid: number): boolean {
  if (!found(-pgid)) return false;
  if (!HAS_PROC) return true;
  return readdirSync("/proc").some((entry) => {
    if (!/^\d+$/.test(entry)) return false;
    const stat = readStat(Number(entry));
    return stat !== null && stat.pgrp === pgid && stat.state !== "Z";
  });
}
