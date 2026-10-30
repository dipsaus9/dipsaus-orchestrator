// `engine.hello` (0005): the first frame on every connection. It answers with the daemon's binary
// version, the daemon state, the office summaries and the software stream cursor read together with
// them. Client and daemon ship in one binary: a client of another version stops and asks for
// `dipo daemon restart`, so the hello and its version are among the shapes that never change.

import {
  type Cursor,
  type DaemonState,
  engineHello,
  type OfficeSummary,
} from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";

/**
 * Where `engine.hello` and the software stream get office summaries. Empty until the office index
 * (DIPO-32) registers its source.
 */
export type OfficeSummarySource = () => readonly OfficeSummary[];

export const noOfficeSummaries: OfficeSummarySource = () => [];

export interface HelloSource {
  /** The engine (binary) version. */
  readonly engineVersion: string;
  readonly daemonState: () => DaemonState;
  /** The software stream position; read in the same tick as the summaries. */
  readonly softwareCursor: () => Cursor;
  readonly officeSummaries: OfficeSummarySource;
}

/** Registers `engine.hello` answered from `source`. */
export function helloFeature(source: HelloSource): FeatureModule {
  return {
    name: "reads/hello",
    register(registry) {
      registry.addRead({
        definition: engineHello,
        handle: () => ({
          engine: source.engineVersion,
          daemon: source.daemonState(),
          offices: [...source.officeSummaries()],
          cursor: source.softwareCursor(),
        }),
      });
    },
  };
}
