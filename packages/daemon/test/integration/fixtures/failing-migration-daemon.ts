// A real daemon process for the unavailable-database test (DIPO-111): `dipo daemon --foreground`
// with the compiled-in migrations plus one more step that fails, as a released binary with a broken
// migration would. Usage: bun failing-migration-daemon.ts

import { MIGRATIONS } from "../../../../engine/src/db/schema";
import { runForeground } from "../../../src/foreground";
import { defaultIo } from "../../../src/io";

const code = await runForeground(
  [],
  { ...defaultIo, version: "test" },
  {
    migrations: [
      ...MIGRATIONS,
      {
        version: MIGRATIONS.length + 1,
        name: "test step that fails",
        sql: "insert into no_such_table (x) values (1);",
      },
    ],
  },
);
process.exit(code);
