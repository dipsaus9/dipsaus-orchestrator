// Each statement on its own, and the schema check at start (DIPO-426). On some Bun versions one
// `db.run` holding several statements skips a constraint failure in any statement but the last;
// `SqliteConnection.exec` now runs each statement as its own prepared statement, and a database
// whose schema differs from the one the migrations build is refused at open.

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { databaseFailure } from "../../src/create/recovery";
import { openStateDatabase } from "../../src/db/database";
import {
  DatabaseTooNewError,
  MigrationFailedError,
  migratedSchema,
  readSchema,
  SchemaDriftError,
  type Migration,
  type MigrationContext,
} from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import {
  openMemorySqlite,
  openSqlite,
  splitStatements,
  type SqliteConnection,
} from "../../src/platform/sqlite";
import { localMounts, memoryLogger } from "./helpers";

const BASE: readonly Migration[] = MIGRATIONS.slice(0, 1);

function options(dir: string, migrations: readonly Migration[], clock = new ManualClock()) {
  return {
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock,
    engineVersion: "0.0.0-test",
    migrations,
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (caught: unknown) => caught,
  );
}

async function withConnection(dir: string, fn: (db: SqliteConnection) => void): Promise<void> {
  const db = await openSqlite({
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
  });
  try {
    fn(db);
  } finally {
    db.close();
  }
}

const squash = (text: string) => text.replace(/\s+/g, "");
const rawSchema = (db: { all<T>(sql: string): T[] }) =>
  db.all("select type, name, tbl_name, sql from sqlite_schema order by type, name");

const userVersion = (db: SqliteConnection) =>
  db.get<{ user_version: number }>("pragma user_version")?.user_version;

describe("SqliteConnection.exec runs each statement on its own", () => {
  const cases = [
    {
      kind: "NOT NULL",
      setup: "create table t (x integer not null) strict;",
      failing: "insert into t (x) values (null);",
    },
    {
      kind: "UNIQUE",
      setup: "create table t (x integer unique) strict; insert into t (x) values (1);",
      failing: "insert into t (x) values (1);",
    },
    {
      kind: "foreign key",
      setup:
        "create table p (id integer primary key) strict; create table t (x integer references p (id)) strict;",
      failing: "insert into t (x) values (42);",
    },
  ];
  for (const { kind, setup, failing } of cases) {
    for (const position of ["first", "middle", "last"] as const) {
      it(`throws on a ${kind} failure in the ${position} statement and runs none after it`, () =>
        withTempDir((dir) =>
          withConnection(dir, (db) => {
            db.exec(setup);
            db.exec("create table later (n integer) strict;");
            const before = "insert into later (n) values (1);";
            const after = "insert into later (n) values (2);";
            const sql =
              position === "first"
                ? `${failing} ${after}`
                : position === "middle"
                  ? `${before} ${failing} ${after}`
                  : `${before} ${failing}`;
            expect(() => db.exec(sql)).toThrow(/constraint failed/i);
            expect(db.all("select n from later where n = 2")).toEqual([]);
          }),
        ));
    }
  }

  it("rolls the whole statement list back inside a transaction", () =>
    withTempDir((dir) =>
      withConnection(dir, (db) => {
        db.exec("create table t (x integer not null) strict;");
        expect(() =>
          db.immediate(() =>
            db.exec(
              "insert into t (x) values (1); insert into t (x) values (null); insert into t (x) values (3);",
            ),
          ),
        ).toThrow(/NOT NULL/);
        expect(db.all("select x from t")).toEqual([]);
      }),
    ));
});

describe("a failing statement inside a migration step", () => {
  const steps: Migration[] = [
    {
      version: 2,
      name: "sql step",
      sql: `
create table kept (office_id text primary key, note text not null) strict;
insert into kept (office_id, note) values ('o-1', null);
create table after_failure (office_id text primary key) strict;
`,
    },
    {
      version: 2,
      name: "code step",
      source: "a table, a failing insert, another table",
      run: (db: MigrationContext) =>
        db.exec(
          "create table kept (office_id text primary key, note text not null) strict; insert into kept (office_id, note) values ('o-1', null); create table after_failure (office_id text primary key) strict;",
        ),
    },
  ];
  for (const step of steps) {
    it(`fails the step, rolls it back and leaves it unrecorded (${step.name})`, () =>
      withTempDir(async (dir) => {
        (await openStateDatabase(options(dir, BASE))).close();
        const error = await failure(openStateDatabase(options(dir, [...BASE, step])));
        expect(error).toBeInstanceOf(MigrationFailedError);
        expect((error as MigrationFailedError).version).toBe(2);
        expect((error as Error).message).toContain("NOT NULL constraint failed");

        await withConnection(dir, (db) => {
          expect(userVersion(db)).toBe(1);
          expect(db.all("select version from schema_migrations")).toEqual([{ version: 1 }]);
          expect(
            db.all("select name from sqlite_schema where name in ('kept', 'after_failure')"),
          ).toEqual([]);
        });
      }));
  }
});

describe("splitStatements", () => {
  it("keeps quoted text, quoted identifiers and comments whole", () => {
    expect(
      splitStatements(`
-- a comment; with a semicolon
create table "a;b" ([c;d] text, \`e;f\` text, g text default 'x;y') strict;
/* a block; comment */ insert into "a;b" values ('it''s; fine', "no", 'z');
select 1 -- trailing; comment
;
`),
    ).toEqual([
      `-- a comment; with a semicolon
create table "a;b" ([c;d] text, \`e;f\` text, g text default 'x;y') strict;`,
      `/* a block; comment */ insert into "a;b" values ('it''s; fine', "no", 'z');`,
      `select 1 -- trailing; comment
;`,
    ]);
  });

  it("keeps a trigger body whole, with a case ... end inside it, temp or not", () => {
    const trigger = `create trigger t_log after insert on t
begin
  insert into log (v) values (case when new.x > 1 then 'big; one' else 'small' end);
  update t set x = x where 0;
end;`;
    const temp = `CREATE TEMPORARY TRIGGER IF NOT EXISTS t_temp BEFORE DELETE ON t
BEGIN SELECT raise(abort, 'no; never'); END;`;
    expect(splitStatements(`${trigger}\n${temp}\nselect 2;`)).toEqual([trigger, temp, "select 2;"]);
  });

  it("reads trigger and end as plain words outside a create trigger", () => {
    expect(
      splitStatements(
        "create table scans (trigger text, end integer); select trigger, end from scans; create temp table x (n integer);",
      ),
    ).toEqual([
      "create table scans (trigger text, end integer);",
      "select trigger, end from scans;",
      "create temp table x (n integer);",
    ]);
  });

  it("drops empty pieces and keeps a last statement without a semicolon", () => {
    expect(splitStatements(" ;; -- only a comment\n")).toEqual([]);
    expect(splitStatements("select 1;;\n\nselect 2 /* end */")).toEqual([
      "select 1;",
      "select 2 /* end */",
    ]);
    expect(splitStatements("pragma user_version = 3")).toEqual(["pragma user_version = 3"]);
  });

  it("runs SQL holding a trigger body, quoted semicolons and comments as written", () => {
    const db = openMemorySqlite();
    try {
      db.exec(`
create table t (x integer not null, label text) strict; -- after; the statement
create table log (v text) strict;
/* the trigger; has two statements */
create trigger t_log after insert on t
begin
  insert into log (v) values (case when new.x > 1 then 'big; ' || new.label else 'small' end);
  insert into log (v) values ('second;');
end;
insert into t (x, label) values (2, 'it''s; quoted');
insert into "t" ([x], \`label\`) values (1, '-- not a comment; really');
`);
      expect(db.all("select x, label from t order by x")).toEqual([
        { x: 1, label: "-- not a comment; really" },
        { x: 2, label: "it's; quoted" },
      ]);
      expect(db.all("select v from log order by rowid")).toEqual([
        { v: "big; it's; quoted" },
        { v: "second;" },
        { v: "small" },
        { v: "second;" },
      ]);
    } finally {
      db.close();
    }
  });

  it("splits every migration into statements that keep all of its SQL", () => {
    for (const step of MIGRATIONS) {
      if (!("sql" in step)) continue;
      const statements = splitStatements(step.sql);
      expect(statements.length).toBeGreaterThan(0);
      // Nothing is lost or added; only spaces between statements go.
      expect(squash(statements.join(""))).toBe(squash(step.sql));
      for (const statement of statements) expect(statement.endsWith(";")).toBe(true);
    }
  });

  it("builds the same schema from every migration as one db.run per step did", () => {
    // The old path: each SQL step and each code step's exec as one `db.run`.
    const old = new Database(":memory:", { strict: true });
    try {
      old.run("pragma foreign_keys = ON");
      const context: MigrationContext = {
        run: (sql, params = {}) => old.query(sql).run(params),
        get: <T>(sql: string, params = {}) => old.query(sql).get(params) as T | null,
        all: <T>(sql: string, params = {}) => old.query(sql).all(params) as T[],
        exec: (sql) => {
          old.run(sql);
        },
      };
      for (const step of MIGRATIONS) {
        old.transaction(() => {
          if ("sql" in step) old.run(step.sql);
          else step.run(context);
        })();
      }
      const fresh = openMemorySqlite();
      try {
        for (const step of MIGRATIONS) {
          fresh.immediate(() => {
            if ("sql" in step) fresh.exec(step.sql);
            else step.run(fresh);
          });
        }
        expect(rawSchema(fresh)).toEqual(
          rawSchema({ all: <T>(sql: string) => old.query(sql).all() as T[] }),
        );
      } finally {
        fresh.close();
      }
    } finally {
      old.close();
    }
  });
});

describe("the schema check at open", () => {
  const indexed: Migration = {
    version: 2,
    name: "widgets with an index",
    sql: `
create table widgets (office_id text not null, widget_id text not null, colour text,
  primary key (office_id, widget_id)) strict;
create index widgets_by_colour on widgets (office_id, colour);
`,
  };

  it("refuses a database with a dropped index, naming the index and the backup", () =>
    withTempDir(async (dir) => {
      const clock = new ManualClock();
      (await openStateDatabase(options(dir, BASE, clock))).close();
      clock.advance(60_000);
      const migrated = await openStateDatabase(options(dir, [...BASE, indexed], clock));
      migrated.close();
      const backup = migrated.migration.backup;
      expect(backup).not.toBeNull();

      await withConnection(dir, (db) => db.exec("drop index widgets_by_colour;"));

      const error = await failure(openStateDatabase(options(dir, [...BASE, indexed], clock)));
      expect(error).toBeInstanceOf(SchemaDriftError);
      expect((error as SchemaDriftError).objects).toEqual(["index widgets_by_colour is missing"]);
      expect((error as SchemaDriftError).backup).toBe(backup);
      expect((error as Error).message).toContain("index widgets_by_colour is missing");
      expect((error as Error).message).toContain(backup ?? "");

      // The daemon holds it in recovering with the reason, and the text names the index.
      const held = databaseFailure(error, join(dir, "state"));
      expect(held.details.reason).toBe("open");
      expect(held.text).toContain("index widgets_by_colour is missing");
    }));

  it("refuses a database built by every migration once one of their indexes is dropped", () =>
    withTempDir(async (dir) => {
      (await openStateDatabase(options(dir, MIGRATIONS))).close();
      await withConnection(dir, (db) => db.exec("drop index backlog_journal_open;"));
      const error = await failure(openStateDatabase(options(dir, MIGRATIONS)));
      expect(error).toBeInstanceOf(SchemaDriftError);
      expect((error as SchemaDriftError).objects).toEqual([
        "index backlog_journal_open is missing",
      ]);
      // A new database got no backup, so none is named.
      expect((error as SchemaDriftError).backup).toBeNull();
      expect((error as Error).message).toContain("There is no pre-migration backup.");
    }));

  it("names a changed and an extra object, and ignores SQLite's own tables", () =>
    withTempDir(async (dir) => {
      (await openStateDatabase(options(dir, [...BASE, indexed]))).close();
      await withConnection(dir, (db) => {
        db.exec(`drop index widgets_by_colour;
create index widgets_by_colour on widgets (colour);
create table stray (n integer);
analyze;`);
        expect(db.get("select name from sqlite_schema where name = 'sqlite_stat1'")).not.toBeNull();
      });
      const error = await failure(openStateDatabase(options(dir, [...BASE, indexed])));
      expect((error as SchemaDriftError).objects).toEqual([
        "index widgets_by_colour has different SQL",
        "table stray is not built by the migrations",
      ]);
    }));

  it("opens a database whose schema matches, also after ANALYZE wrote its tables", () =>
    withTempDir(async (dir) => {
      (await openStateDatabase(options(dir, [...BASE, indexed]))).close();
      await withConnection(dir, (db) => db.exec("analyze;"));
      const state = await openStateDatabase(options(dir, [...BASE, indexed]));
      try {
        expect(readSchema(state.connection)).toEqual([
          ...migratedSchema([...BASE, indexed], options(dir, [...BASE, indexed])),
        ]);
      } finally {
        state.close();
      }
    }));

  it("refuses a database newer than the engine as before, ahead of the schema check", () =>
    withTempDir(async (dir) => {
      (await openStateDatabase(options(dir, [...BASE, indexed]))).close();
      await withConnection(dir, (db) => db.exec("drop index widgets_by_colour;"));
      const error = await failure(openStateDatabase(options(dir, BASE)));
      expect(error).toBeInstanceOf(DatabaseTooNewError);
      expect((error as Error).message).toContain("upgrade dipo");
    }));
});
