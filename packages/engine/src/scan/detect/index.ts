// Repository scan, code part (0013): read the file facts of a checkout, detect its run profile,
// fingerprint the inputs. No model is called in M0 (0013 amendment of 2026-10-11).

export { detect, splitCommand } from "./detect";
export { fingerprint, fingerprintInputs } from "./fingerprint";
export { readProbe } from "./probe";
export { CAPABILITIES } from "./types";
export type {
  CapabilityName,
  CommandSpec,
  ConformanceLevel,
  Confidence,
  DetectOptions,
  DevPort,
  Deviation,
  EnvFile,
  PackageManager,
  PackageManagerName,
  Probe,
  Resolution,
  RunProfile,
  Source,
  Toolchain,
  WorkspacePackage,
} from "./types";
