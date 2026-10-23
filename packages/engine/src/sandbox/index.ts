// The bundled sandbox runtime `srt` behind `dipo daemon sandbox-exec` (DIPO-37, 0008 section 2),
// which runs the Safe-Chain checking proxy (DIPO-84). The engine steps on worker-written code went
// with the Mac worker path (DIPO-240).

export {
  DENIED_SOCKET_PATHS,
  expandHome,
  globRoot,
  isAtOrUnder,
  trustViolations,
  writableRoots,
} from "./policy";
export type { SandboxTools, SrtSettings, TrustedCandidate, WritableRoot } from "./policy";
export { evaluateProbe, MIN_BWRAP_VERSION, parseBwrapVersion } from "./probe";
export type { ProbeResult, SandboxFacts } from "./probe";
export {
  KILL_GRACE_MS,
  refusalPathFor,
  SANDBOX_REFUSED_EXIT_CODE,
  SANDBOX_REFUSED_MARKER,
} from "./step";
