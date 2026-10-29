// Fixture: the daemon imports only the contract and the engine (0004): the TUI, the client and the
// CLI are refused, statically, as a dynamic import and by `require`.
import { runTui } from "@dipsaus-orchestrator/tui";

export const lazy = () => import("@dipsaus-orchestrator/client");
export const required: unknown = require("@dipsaus-orchestrator/cli");
export const leaked = runTui;
