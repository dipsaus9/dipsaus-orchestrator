// Software-level messages: the office list, the daemon, the handshake and command descriptions
// (0005 sections 4, 5 and 7; 0006 decision 5). Office-level work messages are DIPO-20's.

import { z } from "zod";

import {
  CommandDescription,
  defineCommand,
  defineEvent,
  defineRead,
  ReadDescription,
} from "./definition";
import { ConfigErrorData } from "./config";
import { Cursor, OfficeId } from "./ids";
import { ContractVersion } from "./version";
import { EvidenceMap, openEnum } from "./work";

// 0006 section 7. Closed enum: a new state is a major change (0005 section 11).
export const DaemonState = z.enum(["starting", "recovering", "running", "draining", "safe"]);
export type DaemonState = z.infer<typeof DaemonState>;

export const LogLevel = z.enum(["error", "warn", "info", "debug", "trace"]);
export type LogLevel = z.infer<typeof LogLevel>;

const Count = z.int().nonnegative();

// Today's (or this month's, DIPO-311) token usage of an office, engine-derived from the usage alerts (0009 section 8). `tokens`
// counts as the budget does; `estimatedCost` is always estimated.
export const DayUsage = z.object({
  tokens: z.number().nonnegative(),
  limit: z.number().nonnegative().optional(),
  share: z.number().nonnegative().optional(),
  alert: z.boolean(),
  estimatedCost: z.number().nonnegative().optional(),
});
export type DayUsage = z.infer<typeof DayUsage>;

// One privacy setting of an office: its key (`privacy.storeCommandBodies`), the value in force and
// whether the value is the default or comes from `.dipo/office.local.yaml`.
export const PrivacySetting = z.object({
  key: z.string().min(1),
  value: z.boolean(),
  source: z.enum(["default", "office.local.yaml"]),
});
export type PrivacySetting = z.infer<typeof PrivacySetting>;

export const OfficeSummary = z.object({
  office: OfficeId,
  name: z.string(),
  path: z.string(),
  running: Count,
  parked: Count, // includes on-hold
  onHold: Count, // subset of parked
  waitingOnMaintainer: Count, // open gates, questions, tests, parked other than on-hold
  // Since minor 1 (DIPO-81): the stories in the `ready` column, engine-derived, so the office
  // switcher shows Ready for offices that are not open. A minor-1 engine always sends it.
  ready: Count.optional(),
  dayUsage: DayUsage.optional(), // [`usage.alerts`]
  // Since minor 1 (DIPO-311): the same for the UTC calendar month. `tokens` are the office's own;
  // `limit`, `share` and `alert` are those of the all-office total.
  monthUsage: DayUsage.optional(), // [`usage.alerts`]
  evidence: EvidenceMap.optional(), // [`evidence`]
  // The privacy opt-ins on for the office, as full keys such as `privacy.storeCommandBodies`
  // (0007 section 8: the overview shows when one is on). Absent when none is on. Minor 1, DIPO-83.
  optIns: z.array(z.string().min(1)).optional(),
  // The days stored output is kept (`retention.shortDays`, 0007 section 7), so a client can say
  // that output was removed after this period. Absent when the office has no valid configuration.
  // Minor 1, DIPO-97.
  outputRetentionDays: z.int().positive().optional(),
  // The three privacy settings with their effective value and where it comes from, so a client can
  // show and change them (0007 section 8). Absent when the office has no valid configuration.
  // Minor 1, DIPO-136.
  privacy: z.array(PrivacySetting).optional(),
});
export type OfficeSummary = z.infer<typeof OfficeSummary>;

const AbsolutePath = z.string().regex(/^\//, "expected an absolute path");

// The external tools the daemon resolved from the user's PATH at start. A tool it did not find is
// absent (M0 review, DIPO-15).
export const ToolPaths = z.object({
  claude: AbsolutePath.optional(),
  backlog: AbsolutePath.optional(),
  gh: AbsolutePath.optional(),
  rg: AbsolutePath.optional(),
  git: AbsolutePath.optional(),
});
export type ToolPaths = z.infer<typeof ToolPaths>;

const OfficeArgs = z.object({ office: OfficeId });
// Since minor 1 (DIPO-27): `from` is the main worktree a client resolved the office from (its
// current directory). The daemon answers `office.unknown` when it is not the office's registered
// path, so a copied repository that still carries the original's marker never acts on it.
const OfficeTargetArgs = z.object({ office: OfficeId, from: z.string().min(1).optional() });

// Commands

export const officeOpen = defineCommand({
  name: "office.open",
  level: "software",
  args: z.object({ path: z.string().min(1) }), // absolute; any worktree of the repository
  result: z.object({
    office: OfficeId,
    registered: z.boolean(), // true when new
    // Since minor 1: what the maintainer should know, also sent as `engine.notice` (a copied
    // repository that got a new id, a network filesystem).
    warnings: z.array(z.string()).optional(),
  }),
  confirm: false,
  irreversible: false,
  since: 0,
});

export const officeForget = defineCommand({
  name: "office.forget",
  level: "software",
  args: OfficeTargetArgs,
  result: z.object({ office: OfficeId, path: z.string().optional() }), // never deletes repository data; path since minor 1
  confirm: true,
  irreversible: false,
  since: 0,
});

// Since minor 1 (DIPO-36): runs office init (0010 section 6) through one backlog PR. `changed` in
// the reply is false when every step was already on the base or on the open backlog branch. `pr`
// is the open backlog PR of the init steps; without one, `branch` is the engine branch waiting for
// it and `waiting` says why (no remote, `gh` unusable, the merge slot holds it, a failed apply).
// `leftAlone` lists the `To Do` stories init did not migrate because each is in progress on its
// own branch.
export const officeInit = defineCommand({
  name: "office.init",
  level: "software",
  args: OfficeArgs,
  result: z.object({
    office: OfficeId,
    pr: z.object({ number: z.int().positive(), url: z.string() }).optional(),
    branch: z.string().optional(),
    waiting: z.string().optional(),
    leftAlone: z.array(z.string()).optional(),
  }),
  confirm: false,
  irreversible: false,
  since: 1,
});

// Since minor 1 (DIPO-76): deletes the office's rows and its `<git-common-dir>/dipo/` directory,
// `mcp.json` included (0007 section 3), forgotten or not. Its idempotency record lives in the
// daemon's in-memory request table, because purge deletes the office's own `requests` rows (0005
// amendment). `path` is the office's registered path and `rows` the number of rows deleted.
// `directory` is the `<git-common-dir>/dipo/` it removed; it is absent when the path is missing or
// its marker does not name this office.
// `from` is checked as for `office.forget` (0005 amendment of 2026-10-14), so a copied repository
// never purges the original.
export const officePurge = defineCommand({
  name: "office.purge",
  level: "software",
  args: OfficeTargetArgs,
  result: z.object({
    office: OfficeId,
    path: z.string(),
    rows: z.int().nonnegative(),
    directory: z.string().optional(),
  }),
  confirm: true,
  irreversible: true,
  since: 1,
});

export const officeRescan = defineCommand({
  name: "office.rescan",
  level: "office",
  args: z.object({}),
  result: z.object({ scan: z.literal("started") }),
  confirm: false,
  irreversible: false,
  since: 0,
});

// Re-reads the office configuration (0017 section 5, DIPO-27). An invalid file keeps the previous
// configuration for running work, and new runs are refused until a valid reload. `configHash` is
// the hash of the configuration in force, absent while the office never had a valid one.
export const officeReloadConfig = defineCommand({
  name: "office.reloadConfig",
  level: "software",
  args: OfficeTargetArgs,
  result: z.object({
    office: OfficeId,
    valid: z.boolean(),
    errors: z.array(ConfigErrorData),
    configHash: z.string().optional(),
  }),
  confirm: false,
  irreversible: false,
  since: 1,
});

// Changes one privacy setting of an office in `.dipo/office.local.yaml` and reloads the
// configuration (0007 section 8, DIPO-136). `key` is `storeCommandBodies`, `storePrompts` or
// `keepRawEvents`; an unknown key or a value that is not a boolean is refused with the file and key
// named. `configHash` is the hash of the configuration in force after the reload. Every client asks
// before it sends it (the maintainer, 2026-10-20): turning storage on widens what dipo keeps on disk,
// and what was stored stays after it is turned off again.
export const officeSetPrivacy = defineCommand({
  name: "office.setPrivacy",
  level: "software",
  args: z.object({ office: OfficeId, key: z.string().min(1), value: z.unknown() }),
  result: z.object({
    office: OfficeId,
    key: z.string(),
    value: z.boolean(),
    valid: z.boolean(),
    errors: z.array(ConfigErrorData),
    configHash: z.string().optional(),
  }),
  confirm: true,
  irreversible: false,
  since: 1,
});

export const daemonStop = defineCommand({
  name: "daemon.stop",
  level: "software",
  args: z.object({ stopWorkers: z.boolean() }),
  result: z.object({ state: z.literal("draining") }),
  confirm: true,
  irreversible: false,
  since: 0,
});

export const daemonSetLogLevel = defineCommand({
  name: "daemon.setLogLevel",
  level: "software",
  args: z.object({ level: LogLevel }),
  result: z.object({ level: LogLevel }), // until restart
  confirm: false,
  irreversible: false,
  since: 0,
});

export const daemonResumeScheduling = defineCommand({
  name: "daemon.resumeScheduling",
  level: "software",
  args: z.object({}),
  result: z.object({ state: DaemonState }), // leaves safe
  confirm: false,
  irreversible: false,
  since: 0,
});

// Reads

/** The client name `dipo tui` sends in `engine.hello`; the daemon counts such a connection as a TUI (DIPO-279). */
export const TUI_CLIENT_NAME = "dipo-tui";

export const engineHello = defineRead({
  name: "engine.hello",
  args: z.object({
    contract: ContractVersion,
    client: z.object({ name: z.string(), version: z.string() }),
  }),
  result: z.object({
    engine: z.string(), // engine version
    contract: ContractVersion,
    capabilities: z.array(z.string()),
    daemon: DaemonState,
    offices: z.array(OfficeSummary),
    cursor: Cursor, // software stream position read together with offices
  }),
  since: 0,
});

export const commandsDescribe = defineRead({
  name: "commands.describe",
  args: z.object({}),
  result: z.object({
    commands: z.array(CommandDescription),
    reads: z.array(ReadDescription),
  }),
  since: 0,
});

export const daemonStatus = defineRead({
  name: "daemon.status",
  args: z.object({}),
  result: z.object({
    state: DaemonState,
    stateReason: z.string().optional(),
    pid: z.int().positive(),
    version: z.string(),
    uptimeMs: z.int().nonnegative(),
    socket: z.string(),
    webUrl: z.string().optional(),
    loadedOffices: z.array(OfficeId),
    activeRuns: Count,
    keepAwake: z.object({ held: z.boolean(), reason: z.string().optional() }),
    upgradePending: z.boolean(),
    tools: ToolPaths,
    // Since minor 1 (DIPO-198): the commit the binary was built from, `-dirty` for a dirty tree.
    // Absent when the daemon runs from source.
    buildCommit: z.string().min(1).optional(),
    // Since minor 1 (DIPO-198): per loaded office whose repository holds the build commit, the
    // base commits after it that change files under `packages/` (0 when the build is current).
    // Offices without the commit are absent.
    engineBehind: z
      .array(z.object({ office: OfficeId, name: z.string().optional(), commits: Count }))
      .optional(),
  }),
  since: 0,
});

// Events

export const officeRegistered = defineEvent({
  type: "office.registered",
  stream: "software",
  derived: false,
  data: z.object({ office: OfficeId, path: z.string(), name: z.string() }),
});

export const officeForgotten = defineEvent({
  type: "office.forgotten",
  stream: "software",
  derived: false,
  data: z.object({ office: OfficeId }),
});

export const officeSummary = defineEvent({
  type: "office.summary",
  stream: "software",
  derived: true,
  data: OfficeSummary,
});

export const daemonStateChanged = defineEvent({
  type: "daemon.state",
  stream: "software",
  derived: false,
  data: z.object({ from: DaemonState, to: DaemonState, reason: z.string().optional() }),
});

// What started a scan (0007 section 4). Open enum.
export const ScanTrigger = openEnum(["start", "run", "test", "rescan"]);
export type ScanTrigger = z.infer<typeof ScanTrigger>;

// The conformance level of a run profile (0013 section 2). Open enum.
export const ConformanceLevel = openEnum(["conforming", "partial", "non-standard"]);
export type ConformanceLevel = z.infer<typeof ConformanceLevel>;

// Run knowledge; the shape is owned by the scan (0013). `scripts` holds the resolved capabilities
// by name, `warnings` what the maintainer should know, each deviation included. Since minor 1
// (DIPO-72), all optional: `trigger`, the conformance `level`, the `deviations` alone, the `diff`
// from the previous profile (one line per changed fact) and `error` when the scan failed (no
// profile is stored then).
export const scanFinished = defineEvent({
  type: "scan.finished",
  stream: "office",
  derived: false,
  data: z.object({
    scripts: z.record(z.string(), z.string()),
    warnings: z.array(z.string()),
    trigger: ScanTrigger.optional(),
    level: ConformanceLevel.optional(),
    deviations: z.array(z.string()).optional(),
    diff: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
});

export const engineNotice = defineEvent({
  type: "engine.notice",
  stream: "both",
  derived: false,
  data: z.object({ level: z.enum(["info", "warn", "error"]), code: z.string(), text: z.string() }),
});

// Heartbeat when idle; end of catch-up when caughtUp.
export const streamMark = defineEvent({
  type: "stream.mark",
  stream: "both",
  derived: true,
  data: z.object({ caughtUp: z.boolean().optional() }),
});

export const softwareCommands = [
  officeOpen,
  officeForget,
  officeInit,
  officePurge,
  officeRescan,
  officeReloadConfig,
  officeSetPrivacy,
  daemonStop,
  daemonSetLogLevel,
  daemonResumeScheduling,
] as const;

export const softwareReads = [engineHello, commandsDescribe, daemonStatus] as const;

export const softwareEvents = [
  officeRegistered,
  officeForgotten,
  officeSummary,
  daemonStateChanged,
  scanFinished,
  engineNotice,
  streamMark,
] as const;
