// Fixture: a deeper file reaches the Backlog.md implementation the same way (0010). The relative
// path resolves from engine/src/<dir>/<dir>/; the package path is also a banned deep import.
import { listAll } from "../../backlog/list";
import { TASKS_DIR } from "@dipsaus-orchestrator/engine/src/backlog/runner";

export const leaked = [listAll, TASKS_DIR];
