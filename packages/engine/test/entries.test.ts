// The engine's two entries (0004, 0005, DIPO-318), pinned name by name, types included: the engine
// entry gives `createEngine`, the engine's surface and its port types; the platform entry gives the
// daemon's process pieces. A name added to either shows here, so its growth is a reviewed change.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as engineEntry from "../src/index";
import * as platformEntry from "../src/platform-entry";

const SRC = join(import.meta.dir, "..", "src");

/** Every name a file exports, `type ` before a type-only one, sorted. */
function exportedNames(file: string): string[] {
  const text = readFileSync(join(SRC, file), "utf8");
  const names: string[] = [];
  for (const match of text.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    for (const part of (match[2] ?? "").split(",")) {
      const raw = part.trim();
      if (raw === "") continue;
      const isType = match[1] !== undefined || raw.startsWith("type ");
      const name =
        raw
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim() ?? raw;
      names.push(isType ? `type ${name}` : name);
    }
  }
  for (const match of text.matchAll(/export\s+const\s+(\w+)/g)) names.push(match[1] ?? "");
  return names.toSorted((a, b) => a.replace(/^type /, "").localeCompare(b.replace(/^type /, "")));
}

/** The value names of `names`, as the module object has them. */
const values = (names: readonly string[]) =>
  names.filter((name) => !name.startsWith("type ")).toSorted();

const ENGINE_ENTRY = [
  "type BoxPort",
  "type CodeHost",
  "createEngine",
  "type DaemonFacts",
  "type DatabaseCheck",
  "type DrainCaps",
  "type DrainRequest",
  "type DrainResult",
  "type Engine",
  "type EngineDeps",
  "type EnginePaths",
  "type EngineSurface",
  "type FeatureModule",
  "type FeatureRegistry",
  "type HostStarter",
  "type LaunchPlan",
  "type ListenHttp",
  "type LogFields",
  "type Logger",
  "type Migration",
  "type OfficePage",
  "packageName",
  "type PreparedWorker",
  "type Presence",
  "type ProcessProbe",
  "type RecoveryContext",
  "type RecoveryStep",
  "type RunLaunchPaths",
  "type SessionFacts",
  "type StartForwarder",
  "type StoryStore",
  "type Subscribed",
  "type TestBoxesDeps",
  "type WorkerPort",
  "type WorkerSpec",
];

const PLATFORM_ENTRY = [
  "acquireLock",
  "BackupRestoreError",
  "bootoutOwnLaunchdJob",
  "boxTokenHoldPath",
  "chooseRuntimeDir",
  "clearBoxTokenHold",
  "CLOSE_INVALID_PAYLOAD",
  "CLOSE_POLICY_VIOLATION",
  "type ConnectionSession",
  "containerOnPath",
  "createLogger",
  "currentPlatform",
  "detachedEnv",
  "ensurePrivateDir",
  "errorCodeOf",
  "type ExecutableStamp",
  "type HeldLock",
  "helloHandshake",
  "isLogLevel",
  "LAUNCH_FILE",
  "loadSoftwareConfig",
  "type LockOutcome",
  "LOG_LEVELS",
  "type LogFile",
  "openLogFile",
  "passwdHome",
  "type PidRecord",
  "platformSelfChecks",
  "type ProcessIdentity",
  "type ReadExecutableStamp",
  "readRuntimeRecord",
  "removeSocketFile",
  "resolveSoftwareDirs",
  "resolveTools",
  "restoreBackup",
  "RUN_DIR_ENV",
  "RUN_ID_PATTERN",
  "runtimeCandidates",
  "runWorkerHost",
  "sameStamp",
  "type SelfCheck",
  "selfCommand",
  "type ServedSocket",
  "serveUnixSocket",
  "signalGroup",
  "SOCKET_FILE",
  "type SocketConnection",
  "SoftwareDirError",
  "type SpawnDetached",
  "type SpawnInteractive",
  "type SpawnKeepAwake",
  "startForwarder",
  "storeBoxToken",
  "systemClock",
  "systemExecutableStamp",
  "systemHostStarter",
  "systemListenHttp",
  "systemProcessProbe",
  "systemReach",
  "systemSpawn",
  "systemSpawnDetached",
  "systemSpawnInteractive",
  "systemSpawnKeepAwake",
  "testShellArgs",
  "TOKEN_KEYCHAIN_ACCOUNT",
  "TOKEN_KEYCHAIN_SERVICE",
  "underLaunchdJob",
  "writeRuntimeRecord",
];

describe("the engine's entries", () => {
  it("the engine entry gives createEngine, the surface and the port types, and nothing else", () => {
    expect(exportedNames("index.ts")).toEqual(ENGINE_ENTRY);
    expect(Object.keys(engineEntry).toSorted()).toEqual(values(ENGINE_ENTRY));
  });

  it("the platform entry gives the daemon's process pieces, and nothing else", () => {
    expect(exportedNames("platform-entry.ts")).toEqual(PLATFORM_ENTRY);
    expect(Object.keys(platformEntry).toSorted()).toEqual(values(PLATFORM_ENTRY));
  });
});
