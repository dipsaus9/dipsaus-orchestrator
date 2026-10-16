// Fixture: Claude specifics stay in engine/src/workers; the rest of the engine reaches the adapter
// through the WorkerPort (0004, 0008 section 1). The path resolves from engine/src/<dir>/.
import { WORKER_REPORT_JSON_SCHEMA } from "../workers/claude-cli/report-schema";

export const leaked = WORKER_REPORT_JSON_SCHEMA;
