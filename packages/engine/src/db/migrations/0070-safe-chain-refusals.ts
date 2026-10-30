// Migration 70 (DIPO-376): a run keeps Safe-Chain's refusals. When each developer session of a
// box run ends, dipo reads the lines the Safe-Chain box's logs gained since the session started
// and keeps them on the run, so the worker's next session and the reviewer have them after that
// box is gone. `runs.safe_chain` holds the JSON of `SafeChainRecord`: the refusals, the session
// logs that could not be read, and the mark of the session in progress. Null for a run no session
// marked.

import type { SqlMigration } from "../migrations";

export const safeChainRefusals: SqlMigration = {
  version: 70,
  name: "safe-chain refusals",
  sql: `
alter table runs add column safe_chain text;
`,
};
