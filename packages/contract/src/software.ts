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
import { Cursor, OfficeId } from "./ids";
import { ContractVersion } from "./version";

// 0006 section 7. Closed enum: a new state is a major change (0005 section 11).
export const DaemonState = z.enum(["starting", "recovering", "running", "draining", "safe"]);
export type DaemonState = z.infer<typeof DaemonState>;

export const LogLevel = z.enum(["error", "warn", "info", "debug", "trace"]);
export type LogLevel = z.infer<typeof LogLevel>;

const Count = z.int().nonnegative();

export const OfficeSummary = z.object({
  office: OfficeId,
  name: z.string(),
  path: z.string(),
  running: Count,
  parked: Count, // includes on-hold
  onHold: Count, // subset of parked
  waitingOnMaintainer: Count, // open gates, questions, tests, parked other than on-hold
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
const OfficeResult = z.object({ office: OfficeId });

// Commands

export const officeOpen = defineCommand({
  name: "office.open",
  level: "software",
  args: z.object({ path: z.string().min(1) }),
  result: z.object({ office: OfficeId, registered: z.boolean() }), // registered: true when new
  confirm: false,
  irreversible: false,
  since: 0,
});

export const officeForget = defineCommand({
  name: "office.forget",
  level: "software",
  args: OfficeArgs,
  result: OfficeResult, // never deletes repository data
  confirm: true,
  irreversible: false,
  since: 0,
});

// Runs office init (0010 section 6). The result is shaped by the story that builds it (DIPO-36).
export const officeInit = defineCommand({
  name: "office.init",
  level: "software",
  args: OfficeArgs,
  result: z.object({
    office: OfficeId,
    pr: z.object({ number: z.int().positive(), url: z.string() }).optional(),
    branch: z.string().optional(), // the branch waiting for a PR, when none is open yet
  }),
  confirm: false,
  irreversible: false,
  provisional: true,
});

// Deletes the office's rows and its `<git-common-dir>/dipo/` directory (0007 section 3). Its
// idempotency record lives in the daemon's in-memory request table (0005 amendment).
export const officePurge = defineCommand({
  name: "office.purge",
  level: "software",
  args: OfficeArgs,
  result: OfficeResult,
  confirm: true,
  irreversible: true,
  provisional: true,
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

// Re-reads the office configuration (0017 section 5). An invalid file keeps the previous one.
export const officeReloadConfig = defineCommand({
  name: "office.reloadConfig",
  level: "software",
  args: OfficeArgs,
  result: z.object({ office: OfficeId, valid: z.boolean(), errors: z.array(z.string()) }),
  confirm: false,
  irreversible: false,
  provisional: true,
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

// Run knowledge; the shape is owned by the scan (0013).
export const scanFinished = defineEvent({
  type: "scan.finished",
  stream: "office",
  derived: false,
  data: z.object({ scripts: z.record(z.string(), z.string()), warnings: z.array(z.string()) }),
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
