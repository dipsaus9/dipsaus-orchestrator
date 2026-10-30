// The client's process probe for its `lifecycle` module (0005): liveness is PID plus start time,
// never socket reachability. The parsers and the identity rule are the contract's runtime layout,
// the same the daemon uses (DIPO-320); this module only makes the system calls: `kill(pid, 0)`,
// the `/proc` reads on Linux, and on macOS the `kern.proc.pid.<pid>` and `kern.procargs2` sysctls
// through `bun:ffi` (DIPO-114; the setuid `/bin/ps` is refused inside the sandbox). `client` may
// not import `engine` (0004), so this binding stands next to the engine's own.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFile } from "node:fs/promises";

import {
  darwinProcess,
  linuxProcess,
  type ProcessInfo,
  type ProcessProbe,
  type Sysctl,
} from "@dipsaus-orchestrator/contract";

/** True unless `kill(pid, 0)` says the PID does not exist (EPERM means it does). */
export function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

async function probeLinux(pid: number): Promise<ProcessInfo | null> {
  let stat: string;
  let cmdline: string;
  let procStat: string;
  try {
    [stat, cmdline, procStat] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/cmdline`, "utf8"),
      readFile("/proc/stat", "utf8"),
    ]);
  } catch {
    return null;
  }
  return linuxProcess(pid, stat, cmdline, procStat);
}

function openLibSystem() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    // int sysctl(int *name, u_int namelen, void *oldp, size_t *oldlenp, void *newp, size_t newlen)
    sysctl: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
  });
}

let libSystem: ReturnType<typeof openLibSystem> | null = null;

/** `sysctl` through libSystem, for the macOS probe. */
const systemSysctl: Sysctl = {
  read(mib, size) {
    libSystem ??= openLibSystem();
    const name = Int32Array.from(mib);
    const buffer = new Uint8Array(size);
    const length = BigUint64Array.of(BigInt(size));
    const code = libSystem.symbols.sysctl(
      ptr(name),
      name.length,
      ptr(buffer),
      ptr(length),
      null,
      0n,
    );
    return { code, buffer: code === 0 ? buffer.subarray(0, Number(length[0] ?? 0n)) : buffer };
  },
  size(mib) {
    libSystem ??= openLibSystem();
    const name = Int32Array.from(mib);
    const length = BigUint64Array.of(0n);
    const code = libSystem.symbols.sysctl(ptr(name), name.length, null, ptr(length), null, 0n);
    const needed = length[0] ?? 0n;
    return code === 0 && needed > 0n ? Number(needed) : null;
  },
};

async function probeDarwin(pid: number): Promise<ProcessInfo | null> {
  return darwinProcess(systemSysctl, pid);
}

/** The system probe for this platform (macOS or Linux, 0004). */
export function systemProcessProbe(platform: string = process.platform): ProcessProbe {
  const read = platform === "linux" ? probeLinux : probeDarwin;
  return async (pid) => (pidExists(pid) ? read(pid) : null);
}
