// Fixture: re-exports and `require` are imports like any other (0004).
export { WORKER_REPORT_JSON_SCHEMA } from "../workers/claude-cli/report-schema";
export * from "bun";
export const sqlite: unknown = require("bun:sqlite");
