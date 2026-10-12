// `@dipsaus-orchestrator/client/node`: the Unix-socket transport, the way a local client finds the
// daemon, the software configuration it reads (DIPO-69) and the `lifecycle` module that starts,
// stops and reports the daemon (DIPO-70); the only client code that uses Bun and Node APIs (0004
// and 0006 amendments of 2026-10-12).

export { systemClock } from "./clock";
export { readSoftwareConfig, softwareConfigPath } from "./config";
export { connectToDaemon, DaemonNotRunningError } from "./connect";
export type { ConnectToDaemonOptions } from "./connect";
export * from "./lifecycle/index";
export { logsDir, readRuntimeInfo, RUNTIME_FILE, stateDir } from "./runtime";
export type { Env, RuntimeInfo } from "./runtime";
export { unixSocketTransport } from "./transport";
