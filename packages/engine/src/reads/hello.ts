// `engine.hello` (0005 sections 7 and 11): the first frame on every connection. It answers with the
// engine version, the contract version, the capability flags of what this engine actually built,
// the daemon state, the office summaries and the software stream cursor read together with them.
// A client of another contract major gets `contract.unsupported` with the daemon's contract and
// version in `details`; that request and that error are part of the frozen surface.

import {
  type Cursor,
  CONTRACT_VERSION,
  type ContractUnsupportedDetails,
  type DaemonState,
  engineHello,
  type OfficeSummary,
} from "@dipsaus-orchestrator/contract";

import { CommandError } from "../commands/errors";
import type { FeatureModule, Registry } from "../commands/registry";

/**
 * Where `engine.hello` and the software stream get office summaries. Empty until the office index
 * (DIPO-32) registers its source.
 */
export type OfficeSummarySource = () => readonly OfficeSummary[];

export const noOfficeSummaries: OfficeSummarySource = () => [];

/**
 * Capability flags (0005 section 7) and the commands and reads each needs. A flag is offered only
 * when every name it needs is registered and shipped (has `since`), so a provisional or unbuilt
 * entry never shows up as a flag. Flags with no names describe the transport itself.
 */
export const CAPABILITY_FLAGS: Readonly<Record<string, readonly string[]>> = {
  replay: [],
  "daemon.control": ["daemon.status", "daemon.stop", "daemon.resumeScheduling"],
  "daemon.logLevel": ["daemon.setLogLevel"],
  "work.output": ["work.outputRange"],
  "work.intervene": ["work.pause", "work.resume", "work.steer", "work.answer", "work.stop"],
  "test.sessions": ["test.start", "test.record"],
  "usage.report": ["office.usage"],
  digest: ["office.digest"],
  // The maintainer's decision on a merge gate that waits for them (0019 sections 11 and 15).
  review: ["gate.approve", "gate.reject"],
  // The plain-text desk (0020 section 12, DIPO-158).
  desk: ["office.desk"],
  // `OfficeSummary.dayUsage` and `monthUsage` with the all-office limits and alerts (0009 section 8,
  // DIPO-311). Part of the summary, so it needs no command.
  "usage.alerts": [],
  // Accept or dismiss a worker's proposals, and their `proposal.filed` and `proposal.closed` events
  // (0020 section 14, DIPO-166).
  proposals: ["proposal.accept", "proposal.dismiss"],
};

/** The capability flags `registry` can back, in table order. */
export function capabilityFlags(registry: Registry): string[] {
  const shipped = (name: string) => {
    const definition = registry.command(name)?.definition ?? registry.read(name)?.definition;
    return definition !== undefined && definition.since !== undefined;
  };
  return Object.entries(CAPABILITY_FLAGS)
    .filter(([, names]) => names.every(shipped))
    .map(([flag]) => flag);
}

export interface HelloSource {
  /** The engine (binary) version. */
  readonly engineVersion: string;
  readonly daemonState: () => DaemonState;
  /** The software stream position; read in the same tick as the summaries. */
  readonly softwareCursor: () => Cursor;
  readonly officeSummaries: OfficeSummarySource;
}

/** The `contract.unsupported` error of a client of another major. */
export function contractUnsupported(engineVersion: string): CommandError {
  const details: ContractUnsupportedDetails = {
    contract: { ...CONTRACT_VERSION },
    version: engineVersion,
  };
  return new CommandError(
    "contract.unsupported",
    `This daemon speaks contract ${CONTRACT_VERSION.major}.${CONTRACT_VERSION.minor}; a client of another major cannot use it. Restart the daemon with this binary.`,
    details,
  );
}

/** Registers `engine.hello` answered from `source`. */
export function helloFeature(source: HelloSource): FeatureModule {
  return {
    name: "reads/hello",
    register(registry) {
      registry.addRead({
        definition: engineHello,
        handle: (ctx, args) => {
          if (args.contract.major !== CONTRACT_VERSION.major) {
            throw contractUnsupported(source.engineVersion);
          }
          return {
            engine: source.engineVersion,
            contract: { ...CONTRACT_VERSION },
            capabilities: capabilityFlags(ctx.registry),
            daemon: source.daemonState(),
            offices: [...source.officeSummaries()],
            cursor: source.softwareCursor(),
          };
        },
      });
    },
  };
}
