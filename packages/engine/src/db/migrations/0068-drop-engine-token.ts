// Migration 68 (DIPO-369): `worker_hosts.engine_token` goes. Migration 22 added it for the hook
// reply guard (DIPO-59); the hooks are gone (PR #417, DIPO-347), so no host reads the token. A
// host an earlier binary started still sends it in its hello, and the host ignores it (0006).

import type { SqlMigration } from "../migrations";

export const dropEngineToken: SqlMigration = {
  version: 68,
  name: "drop engine token",
  sql: `
alter table worker_hosts drop column engine_token;
`,
};
