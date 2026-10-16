// Fixture: `import x = require(...)` is an import like any other (0004).
import bun = require("bun");
import report = require("../workers/claude-cli/report-schema");

export const used: unknown[] = [bun, report];
