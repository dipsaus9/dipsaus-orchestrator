// Migration 70 (DIPO-376): the Safe-Chain refusals of a run are stored on the run when its session
// ends (`BoxWorkers`), so the worker's next turn and the reviewer read them without the box, whose
// logs may be gone by review time. `runs.safe_chain` holds the JSON record of
// `SafeChainRunRecord`: the refusals, the lines read of each log and the logs not readable at the
// last read. Null for a run no session ended in a box.

import type { SqlMigration } from "../migrations";

export const safeChainRefusals: SqlMigration = {
  version: 70,
  name: "safe-chain refusals",
  sql: `
alter table runs add column safe_chain text;
`,
};
