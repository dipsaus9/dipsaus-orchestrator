// Fixture: `typeof import(...)` reaches the module's types like an import (0004).
export type BunModule = typeof import("bun");
export type ReportModule = typeof import("../workers/claude-cli/report-schema");
