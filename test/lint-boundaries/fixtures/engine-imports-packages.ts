// Fixture: the engine imports only the contract (0004): the daemon, the client, the TUI and the CLI
// are refused, statically, as a dynamic import, by `require` and by `import.meta.require`.
import { runDaemon } from "@dipsaus-orchestrator/daemon";

export const lazy = () => import("@dipsaus-orchestrator/client");
export const required: unknown = require("@dipsaus-orchestrator/tui");
export const metaRequired: unknown = import.meta.require("@dipsaus-orchestrator/cli");
export const leaked = runDaemon;
