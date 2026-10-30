// Whether a killed process still runs, for the tests that kill a process group (DIPO-372).

/** True while `pid` runs: `kill(pid, 0)` finds it (EPERM finds one too). */
export function processRunning(pid: number): boolean {
  return found(pid);
}

/** True while a process of group `pgid` runs: `kill(-pgid, 0)` finds one (EPERM finds one too). */
export function groupRunning(pgid: number): boolean {
  return found(-pgid);
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
