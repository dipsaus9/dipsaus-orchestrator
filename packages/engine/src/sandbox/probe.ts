// `probeSandbox` (0008 section 2 and its 2026-10-12 amendment): before a step runs, check what the
// bundled `srt` needs from the machine. `rg` (ripgrep) on macOS and Linux; on Linux also
// `bubblewrap` 0.5 or newer and `socat`, and a user namespace that Ubuntu's AppArmor restriction
// (24.04 and later, `kernel.apparmor_restrict_unprivileged_userns=1`) has not stripped. The facts
// are gathered by the platform module; the judgement here is pure.

import type { DipoPlatform } from "../platform/paths";

/** What the platform module found on this machine. Null means missing or unreadable. */
export interface SandboxFacts {
  readonly platform: DipoPlatform;
  /** Path of `rg` on the step's PATH. */
  readonly rg: string | null;
  /** Path of `bwrap` and the first line of `bwrap --version` (Linux only). */
  readonly bwrap: { readonly path: string; readonly version: string | null } | null;
  /** Path of `socat` (Linux only). */
  readonly socat: string | null;
  /** `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`, trimmed (Linux only). */
  readonly restrictUserns: string | null;
  /** `ID` and `VERSION_ID` of `/etc/os-release` (Linux only). */
  readonly os: { readonly id: string; readonly versionId: string } | null;
}

export type ProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

/** The oldest bubblewrap `srt` 0.0.79 fully supports (`OLDEST_FULLY_SUPPORTED_BWRAP_VERSION`). */
export const MIN_BWRAP_VERSION = [0, 5, 0] as const;

/** Parses `bubblewrap 0.9.0` (the output of `bwrap --version`) into numbers. */
export function parseBwrapVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function atLeast(version: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = version[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Judges the facts; every missing piece is one reason. */
export function evaluateProbe(facts: SandboxFacts): ProbeResult {
  const reasons: string[] = [];
  if (facts.rg === null) reasons.push("ripgrep (rg) is not installed or not on PATH");
  if (facts.platform === "linux") {
    if (facts.bwrap === null) {
      reasons.push("bubblewrap (bwrap) is not installed or not on PATH");
    } else {
      const version = facts.bwrap.version === null ? null : parseBwrapVersion(facts.bwrap.version);
      if (version === null) {
        reasons.push(`could not read the bubblewrap version at ${facts.bwrap.path}`);
      } else if (!atLeast(version, MIN_BWRAP_VERSION)) {
        reasons.push(
          `bubblewrap ${version.join(".")} is older than ${MIN_BWRAP_VERSION.join(".")}`,
        );
      }
    }
    if (facts.socat === null) reasons.push("socat is not installed or not on PATH");
    if (facts.restrictUserns === "1") {
      const where =
        facts.os === null ? "this system" : `${facts.os.id} ${facts.os.versionId}`.trim();
      reasons.push(
        `unprivileged user namespaces are restricted by AppArmor on ${where} ` +
          "(kernel.apparmor_restrict_unprivileged_userns=1), so bubblewrap cannot start",
      );
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
