// Delivery in parts, the pure rules (DIPO-273, 0021 section 8): the message cleaning, the protected
// list, the secret scan, the comparison with the last delivered tree and the in-box exclude list.
// The flow on real git with a bare remote is in test/run/parts-commit.test.ts. Every secret-shaped
// text here is built from pieces, so this file itself holds none a scan would find.

import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { ArchiveLink } from "../../src/box/cache-extract";
import { IgnoreRules, MatchBudget } from "../../src/box/ignore";
import {
  blobId,
  comparePart,
  inBoxExcludes,
  dotenvValue,
  leftOutPaths,
  LISTED_VALUE_KIND,
  listedValues,
  secretLike,
  PART_STAGE_PREFIX,
  PART_STAGE_ROOT_PREFIX,
  PART_SUBJECT_MAX,
  type PartChange,
  type PartFile,
  partArchiveCommand,
  partCommitMessage,
  partPark,
  partStageRoot,
  partStuckText,
  partSubject,
  partUnstuckText,
  protectedDetail,
  protectedHits,
  protectedKind,
  refusedDetail,
  secretDetail,
  secretHits,
  sweepPartStages,
  type TreeEntry,
  unsafePath,
} from "../../src/box/parts";
import { yieldToEventLoop } from "../../src/platform/clock";
import {
  isSecretPartPath,
  isSecretPath,
  newSecretKinds,
  SECRET_SCAN_CHUNK,
  secretKeysOfFile,
  secretMatches,
} from "../../src/context/secrets";

const ESC = "\u001b";
const PRIVATE_KEY = `-----BEGIN ${"OPENSSH"} PRIVATE ${"KEY"}-----\nb3BlbnNzaC1rZXk=\n`;
const AWS_KEY = `AK${"IA"}${"ABCDEFGHIJKLMNOP"}`;
const ANTHROPIC_KEY = `sk-${"ant"}-api03-${"x".repeat(40)}`;
const GITHUB_TOKEN = `gh${"p"}_${"a".repeat(36)}`;

describe("the part message", () => {
  it("cleans the worker's message, keeps one line and cuts it to 72 characters", () => {
    expect(partSubject(`Add the reader${ESC}[31m‮`, "fallback")).toBe("Add the reader");
    expect(partSubject("\n  first   line \t here\nsecond line", "fallback")).toBe(
      "first line here",
    );
    const long = "word ".repeat(30);
    const cut = partSubject(long, "fallback");
    expect([...cut].length).toBeLessThanOrEqual(PART_SUBJECT_MAX);
    expect(cut).toBe("word ".repeat(15).slice(0, 72).trimEnd());
    // A character outside the BMP is never split in half.
    const emoji = partSubject("😀".repeat(80), "fallback");
    expect([...emoji]).toHaveLength(72);
    expect(emoji.isWellFormed()).toBe(true);
    expect(partSubject(`${ESC}]0;title\u0007  `, "Part 3 of DIPO-1")).toBe("Part 3 of DIPO-1");
  });

  it("puts the story and the part number in the body", () => {
    expect(partCommitMessage("DIPO-273", 2, "Scan the part")).toEqual({
      subject: "Scan the part",
      body: "Part 2 of DIPO-273, delivered from its box by dipo.",
    });
    expect(partCommitMessage("DIPO-273", 4, "").subject).toBe("Part 4 of DIPO-273");
  });
});

describe("the protected list", () => {
  it("names the task file, the backlog, CI, dipo's configuration and git's own files", () => {
    for (const [path, kind] of [
      ["backlog/tasks/dipo-273 - Commit-each-part.md", "backlog"],
      ["backlog/config.yml", "backlog"],
      [".dipo/office.yaml", "dipo"],
      [".github/workflows/ci.yml", "ci"],
      [".GitHub/Workflows/ci.yml", "ci"],
      [".github/actions/smoke/action.yml", "ci"],
      [".git/config", "git"],
      ["vendor/lib/.git/hooks/pre-commit", "git"],
      [".GIT/hooks/post-checkout", "git"],
      [".claude/settings.json", "claude"],
      [".claude/settings.local.json", "claude"],
      [".gitattributes", "gitConfig"],
      ["packages/a/.gitattributes", "gitConfig"],
      [".gitmodules", "gitConfig"],
    ] as const) {
      expect([path, protectedKind(path)]).toEqual([path, kind]);
    }
  });

  it("folds case and Unicode as the volume does, and catches look-alike names", () => {
    const longS = String.fromCodePoint(0x17f);
    const fullwidthB = String.fromCodePoint(0xff42);
    const combiningDot = String.fromCodePoint(0x307);
    for (const [path, kind] of [
      ["Backlog/tasks/x.md", "backlog"],
      [".Dipo/office.yaml", "dipo"],
      [".GITHUB/workflows/ci.yml", "ci"],
      [`.gitattribute${longS}`, "gitConfig"],
      [`.github/workflow${longS}/ci.yml`, "ci"],
      [`${fullwidthB}acklog/config.yml`, "backlog"],
      [`.di${combiningDot}po/office.yaml`, "dipo"],
    ] as const) {
      expect([path, protectedKind(path)]).toEqual([path, kind]);
    }
  });

  it("refuses paths with control, bidirectional or invisible characters", () => {
    for (const code of [
      0x0a, 0x1b, 0x7f, 0x85, 0x202e, 0x2066, 0x200b, 0x200d, 0xfeff, 0xad, 0x180e, 0x2028, 0x2029,
      0xfff9, 0xfffb, 0xe0041,
    ]) {
      expect([code, unsafePath(`src/a${String.fromCodePoint(code)}b.ts`)]).toEqual([code, true]);
    }
    expect(unsafePath("src/café/日本.ts")).toBe(false);
  });

  it("leaves ordinary paths, also ones that only look alike", () => {
    for (const path of [
      "src/index.ts",
      "docs/backlog.md",
      "packages/backlog/x.ts",
      "github/workflows/ci.yml",
      ".githubx/a",
      ".dipo-notes.md",
      ".gitignore",
      ".claude/commands/x.md",
    ]) {
      expect([path, protectedKind(path)]).toEqual([path, null]);
    }
  });

  it("counts every link hit as protected, kinds in a fixed order, and names no path", () => {
    const changes: PartChange[] = [
      { path: ".github/workflows/ci.yml", kind: "deleted" },
      { path: "src/a.ts", kind: "added", mode: "100644", id: "1", at: "/x" },
    ];
    const hits = protectedHits(changes, ["src/link"]);
    expect(hits.kinds).toEqual(["ci", "link"]);
    expect(hits.paths).toEqual([".github/workflows/ci.yml", "src/link"]);
    const detail = protectedDetail(hits.kinds);
    expect(detail).toContain("CI configuration (.github/)");
    expect(detail).toContain("a symlink or hard link");
    expect(detail).not.toContain("ci.yml");
    expect(detail).not.toContain("src/link");
    expect(protectedHits(changes.slice(1), []).kinds).toEqual([]);
  });
});

describe("the secret scan", () => {
  it("finds content patterns by kind", () => {
    expect(secretMatches(`const k = "${AWS_KEY}";\n${PRIVATE_KEY}`).map((m) => m.kind)).toEqual([
      "a private key",
      "an AWS access key",
    ]);
    expect(secretMatches(`ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`).map((m) => m.kind)).toEqual([
      "an Anthropic key",
    ]);
    expect(secretMatches(new TextEncoder().encode(`\u0000\u0001${GITHUB_TOKEN}`))).toHaveLength(1);
    expect(secretMatches("export const key = process.env.API_KEY;\n")).toEqual([]);
  });

  it("counts only a secret the change brings in, not one the file already held", () => {
    const before = `fixture: "${ANTHROPIC_KEY}"\n`;
    expect(newSecretKinds(`${before}more code\n`, before)).toEqual([]);
    expect(newSecretKinds(`${before}const t = "${GITHUB_TOKEN}";\n`, before)).toEqual([
      "a GitHub token",
    ]);
    expect(newSecretKinds(before, null)).toEqual(["an Anthropic key"]);
  });

  it("finds secret file names", () => {
    for (const path of [".env", "config/.env.local", ".npmrc", "keys/server.pem", ".ssh/id_rsa"]) {
      expect([path, isSecretPath(path)]).toEqual([path, true]);
    }
    expect(isSecretPath("src/env.ts")).toBe(false);
  });

  it("takes .env.example and .env.sample as no secret name in a part, .env and .env.<name> still", () => {
    for (const path of [
      ".env.example",
      "config/.env.sample",
      "app/.ENV.Example",
      "x/.env.SAMPLE",
    ]) {
      expect([path, isSecretPartPath(path)]).toEqual([path, false]);
    }
    for (const path of [
      ".env",
      ".env.local",
      "config/.env.production",
      ".envrc",
      ".env.example.local",
      ".env.examples",
      // A secret folder above a template still makes it one.
      ".ssh/.env.example",
      "config/.env.d/.env.sample",
      ".npmrc",
      "keys/server.pem",
    ]) {
      expect([path, isSecretPartPath(path)]).toEqual([path, true]);
    }
    expect(isSecretPartPath("src/env.ts")).toBe(false);
    // The context provider and the workspace keep 0008's rule: a template is never read there.
    expect(isSecretPath(".env.example")).toBe(true);
    expect(isSecretPath("config/.env.sample")).toBe(true);
  });

  it("scans added and changed files, asks for the delivered content only on a match", () =>
    withTempDir(async (dir) => {
      const staged = (name: string, text: string) => {
        writeFileSync(join(dir, name), text);
        return join(dir, name);
      };
      const view = new Map<string, TreeEntry>([
        ["test/fixture.ts", { mode: "100644", type: "blob", id: "old-fixture" }],
        ["src/a.ts", { mode: "100644", type: "blob", id: "old-a" }],
      ]);
      const asked: string[][] = [];
      const before = async (ids: readonly string[]) => {
        asked.push([...ids]);
        return new Map(
          ids.map((id) => [id, id === "old-fixture" ? `"${ANTHROPIC_KEY}"\n` : ""] as const),
        );
      };
      const clean = await secretHits({
        changes: [
          {
            path: "test/fixture.ts",
            kind: "changed",
            mode: "100644",
            id: "1",
            at: staged("f", `"${ANTHROPIC_KEY}"\nmore\n`),
          },
          { path: "src/a.ts", kind: "changed", mode: "100644", id: "2", at: staged("a", "x\n") },
          { path: "gone.ts", kind: "deleted" },
        ],
        before,
        view,
        subject: "Add a fixture",
      });
      expect(clean).toEqual({ kinds: [], paths: [] });
      expect(asked).toEqual([["old-fixture"]]);
      const hit = await secretHits({
        changes: [
          {
            path: "src/a.ts",
            kind: "changed",
            mode: "100644",
            id: "2",
            at: staged("b", `const k = "${AWS_KEY}";\n`),
          },
          { path: ".env", kind: "added", mode: "100644", id: "3", at: staged("e", "A=1\n") },
        ],
        before,
        view,
        subject: "Add a key",
      });
      if (hit === "tooBig") throw new Error("not too big");
      expect(hit.kinds).toEqual(["a secret file name", "an AWS access key"]);
      expect(hit.paths).toEqual([".env", "src/a.ts"]);
      const detail = secretDetail(hit.kinds, hit.paths.length);
      expect(detail).toBe(
        "The part the worker delivered holds what looks like a secret: a secret file name; an AWS access key, in 2 files. dipo committed and pushed nothing, and the files stay in the box.",
      );
      expect(detail).not.toContain(AWS_KEY);
      expect(detail).not.toContain(".env");
    }));

  it("scans the commit subject and every changed path name, and refuses a file over the cap", () =>
    withTempDir(async (dir) => {
      writeFileSync(join(dir, "plain"), "plain\n");
      const plain: PartChange = {
        path: "src/plain.ts",
        kind: "added",
        mode: "100644",
        id: "1",
        at: join(dir, "plain"),
      };
      const subject = await secretHits({
        changes: [plain],
        view: new Map(),
        before: noDelivered,
        subject: `Use ${GITHUB_TOKEN} for the test`,
      });
      expect(subject).toEqual({ kinds: ["a GitHub token"], paths: [] });
      const named = await secretHits({
        changes: [{ ...plain, path: `keys/${AWS_KEY}.txt` }],
        view: new Map(),
        before: noDelivered,
        subject: "Add a file",
      });
      expect(named).toEqual({ kinds: ["an AWS access key"], paths: [`keys/${AWS_KEY}.txt`] });
      writeFileSync(join(dir, "big"), "x".repeat(2048));
      const big = await secretHits({
        changes: [{ ...plain, at: join(dir, "big") }],
        view: new Map(),
        before: noDelivered,
        subject: "Add a big file",
        maxFileBytes: 1024,
      });
      expect(big).toBe("tooBig");
    }));

  it("finds a key across a chunk border, once", () =>
    withTempDir(async (dir) => {
      const at = join(dir, "long");
      const pad = `${"x".repeat(SECRET_SCAN_CHUNK - 11)} `;
      writeFileSync(at, `${pad}${AWS_KEY}\n${"y".repeat(100)}`);
      const keys = await secretKeysOfFile(at, 64 * 1024 * 1024);
      if (keys === "tooBig") throw new Error("not too big");
      expect([...keys]).toEqual([["an AWS access key", new Set([AWS_KEY])]]);
      expect(await secretKeysOfFile(at, 1024)).toBe("tooBig");
    }));

  it("finds a value of a listed box file brought into a file, not one it already held", () =>
    withTempDir(async (dir) => {
      const main = join(dir, "main");
      mkdirSync(join(main, "config"), { recursive: true });
      writeFileSync(
        join(main, "config/.env.local"),
        [
          "# local settings",
          'export DB_PASSWORD="correct-horse-battery"',
          "SERVICE=ANTHROPIC_API_KEY",
          "SHORT=abc",
          "TOKEN=hx7Kq2Lm9Pz4 # rotated",
          "not a pair",
        ].join("\n"),
      );
      writeFileSync(join(main, "linked-target.env"), "X=never-read-through-a-link\n");
      symlinkSync(join(main, "linked-target.env"), join(main, "linked.env"));
      const values = await listedValues(main, ["config/.env.local", "linked.env", "missing.env"]);
      expect(values).toEqual(["correct-horse-battery", "hx7Kq2Lm9Pz4"]);
      const literals = { kind: LISTED_VALUE_KIND, values };
      writeFileSync(join(dir, "uses"), 'const pw = "correct-horse-battery";\n');
      const change: PartChange = {
        path: "src/db.ts",
        kind: "changed",
        mode: "100644",
        id: "new",
        at: join(dir, "uses"),
      };
      const view = new Map<string, TreeEntry>([
        ["src/db.ts", { mode: "100644", type: "blob", id: "old" }],
      ]);
      const brought = await secretHits({
        changes: [change],
        view,
        literals,
        subject: "Use the database",
        before: async () => new Map([["old", "const pw = process.env.PW;\n"]]),
      });
      expect(brought).toEqual({ kinds: [LISTED_VALUE_KIND], paths: ["src/db.ts"] });
      const held = await secretHits({
        changes: [change],
        view,
        literals,
        subject: "Use the database",
        before: async () => new Map([["old", 'const pw = "correct-horse-battery";\n']]),
      });
      expect(held).toEqual({ kinds: [], paths: [] });
    }));
});

/** No delivered content: the files are new. */
async function noDelivered(): Promise<Map<string, string | null>> {
  return new Map();
}

/** A file of the part, its id standing in for its content. */
function file(id: string, mode: PartFile["mode"] = "100644"): PartFile {
  return { mode, id, at: `/stage/${id}` };
}

describe("comparing a part with the last delivered tree", () => {
  const view = new Map<string, TreeEntry>([
    ["README.md", { mode: "100644", type: "blob", id: "readme" }],
    ["src/a.ts", { mode: "100644", type: "blob", id: "a" }],
    ["src/gone.ts", { mode: "100644", type: "blob", id: "gone" }],
    ["bin/run", { mode: "100644", type: "blob", id: "run" }],
    ["dist/kept.js", { mode: "100644", type: "blob", id: "kept" }],
    ["link", { mode: "120000", type: "blob", id: blobId("sha1", "README.md") }],
    ["vendor/sub", { mode: "160000", type: "commit", id: "sub" }],
  ]);
  const rules = new IgnoreRules([{ dir: "", text: "dist/\nnode_modules/\n" }]);
  const compare = (files: Map<string, PartFile>, links: ArchiveLink[] = []) =>
    comparePart({
      view,
      files,
      links,
      leftOut: (path) => path === "listed.json" || rules.ignored(path),
      linkId: (target) => blobId("sha1", target),
    });

  it("finds added, changed and deleted files, a mode change, and leaves ignored paths out", () => {
    const { changes, linkHits } = compare(
      new Map([
        ["README.md", file("readme")],
        ["src/a.ts", file("a2")],
        ["src/new.ts", file("new")],
        ["bin/run", file("run", "100755")],
        ["dist/kept.js", file("kept")],
        ["dist/built.js", file("built")],
        ["node_modules/x/index.js", file("nm")],
        ["listed.json", file("listed")],
        ["vendor/sub/inner.c", file("inner")],
      ]),
      [{ path: "link", kind: "symlink", target: "README.md" }],
    );
    expect(changes.map((change) => [change.path, change.kind])).toEqual([
      ["bin/run", "changed"],
      ["src/a.ts", "changed"],
      ["src/gone.ts", "deleted"],
      ["src/new.ts", "added"],
    ]);
    expect(linkHits).toEqual([]);
  });

  it("deletes a tracked file even under an ignored folder, never a submodule", () => {
    const { changes } = compare(new Map([["README.md", file("readme")]]));
    expect(changes.map((change) => change.path)).toEqual([
      "bin/run",
      "dist/kept.js",
      "link",
      "src/a.ts",
      "src/gone.ts",
    ]);
  });

  it("takes only an unchanged tracked symlink; a new, changed or hard link is a hit", () => {
    const files = new Map([
      ["README.md", file("readme")],
      ["src/a.ts", file("a")],
      ["src/gone.ts", file("gone")],
      ["bin/run", file("run")],
      ["dist/kept.js", file("kept")],
    ]);
    expect(
      compare(files, [{ path: "link", kind: "symlink", target: "/Users/maintainer/.ssh" }])
        .linkHits,
    ).toEqual(["link"]);
    expect(
      compare(files, [
        { path: "link", kind: "symlink", target: "README.md" },
        { path: "src/home", kind: "symlink", target: "../../.." },
        { path: "hard", kind: "hardlink", target: "README.md" },
        { path: "node_modules/.bin/tsc", kind: "symlink", target: "../typescript/bin/tsc" },
      ]).linkHits,
    ).toEqual(["hard", "src/home"]);
  });
});

describe("the in-box exclude list", () => {
  it("uses plain ignored names that no tracked path carries", () => {
    const view = new Map<string, TreeEntry>([
      ["src/build/index.ts", { mode: "100644", type: "blob", id: "1" }],
    ]);
    const rules = new IgnoreRules([{ dir: "", text: "node_modules/\nbuild/\n*.log\n.cache\n" }]);
    // `node_modules/` matches folders only: the exclude drops what such a folder holds, never a
    // regular file of that name.
    expect(inBoxExcludes(rules, view)).toEqual([".cache", "node_modules/*"]);
  });

  it("leaves out a name a `!` rule could re-include, but not for an unrelated `!` rule", () => {
    const rules = new IgnoreRules([
      { dir: "", text: "node_modules/\n.env*\n!.env.example\ndist/\n!dist/\n" },
    ]);
    expect(inBoxExcludes(rules, new Map())).toEqual(["node_modules/*"]);
  });

  it("excludes names anchored to the root as ./<name>, once, unless tracked or re-included", () => {
    const rules = new IgnoreRules([
      {
        dir: "",
        text: "/node_modules\n/dist/\n/.cache\n.cache\n/build\n/coverage\n!/coverage\n/src/gen\n/*.tmp\n",
      },
      // A deeper file's anchored names apply only below its folder.
      { dir: "pkg", text: "/out\n" },
    ]);
    const view = new Map<string, TreeEntry>([
      ["tools/build/index.ts", { mode: "100644", type: "blob", id: "1" }],
    ]);
    expect(rules.rootNames).toEqual(["build", "coverage", "dist", "node_modules"]);
    expect(inBoxExcludes(rules, view)).toEqual([".cache", "./dist/*", "./node_modules"]);
  });

  it("excludes the whole name when one of its rules matches files too", () => {
    const rules = new IgnoreRules([{ dir: "", text: "dist/\ndist\n/out/\n/out\n/tmp/\n" }]);
    expect(rules.foldersOnly("dist", false)).toBe(false);
    expect(rules.foldersOnly("out", true)).toBe(false);
    expect(rules.foldersOnly("tmp", true)).toBe(true);
    expect(rules.foldersOnly("tmp", false)).toBe(false);
    expect(inBoxExcludes(rules, new Map())).toEqual(["dist", "./out", "./tmp/*"]);
  });

  it("streams tar of the work folder with the excludes before the folder, under timeout", () => {
    const command = partArchiveCommand(["node_modules", ".cache"]);
    expect(command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(command[2]).toContain('exec timeout 540 "$@"');
    expect(command.slice(3)).toEqual([
      "dipo-part-out",
      "tar",
      "--hard-dereference",
      "-C",
      "/work",
      "-cf",
      "-",
      "--exclude=node_modules",
      "--exclude=.cache",
      ".",
    ]);
    expect(() => partArchiveCommand(["a b"])).toThrow("not a plain name");
    expect(partArchiveCommand(["./node_modules"]).at(-2)).toBe("--exclude=./node_modules");
    expect(partArchiveCommand(["node_modules/*", "./dist/*"]).slice(-3)).toEqual([
      "--exclude=node_modules/*",
      "--exclude=./dist/*",
      ".",
    ]);
    for (const bad of [
      "./a/b",
      "./..",
      "./.",
      "../x",
      ".//x",
      "/x",
      "*",
      "./*",
      "a/**",
      "a/*/*",
      "../*",
      "a/b/*",
    ]) {
      expect(() => partArchiveCommand([bad])).toThrow("not a plain name");
    }
  });
});

describe("the part stage sweep", () => {
  it("gives each daemon its own folder of stages in the temp root", () => {
    const a = partStageRoot("/tmp", "/home/a/.dipo");
    expect(a.startsWith(`/tmp/${PART_STAGE_ROOT_PREFIX}`)).toBe(true);
    expect(partStageRoot("/tmp", "/home/a/.dipo")).toBe(a);
    expect(partStageRoot("/tmp", "/scratch/dipo-home")).not.toBe(a);
  });

  it("removes the stage folders its daemon left, only dipo's, only this user's folders", () =>
    withTempDir(async (dir) => {
      const root = join(dir, `${PART_STAGE_ROOT_PREFIX}mine`);
      const other = join(dir, `${PART_STAGE_ROOT_PREFIX}other`);
      mkdirSync(join(root, `${PART_STAGE_PREFIX}a1`, "take-1", "files"), { recursive: true });
      writeFileSync(join(root, `${PART_STAGE_PREFIX}a1`, "take-1", "files", "a.ts"), "box\n");
      mkdirSync(join(root, `${PART_STAGE_PREFIX}b2`));
      mkdirSync(join(root, `${PART_STAGE_PREFIX}in-use`));
      writeFileSync(join(root, `${PART_STAGE_PREFIX}file`), "kept\n");
      mkdirSync(join(dir, "outside"));
      symlinkSync(join(dir, "outside"), join(root, `${PART_STAGE_PREFIX}link`));
      mkdirSync(join(root, "dipo-box-files-x"));
      // Another daemon's stage, in its own folder, and one left directly in the temp root.
      mkdirSync(join(other, `${PART_STAGE_PREFIX}live`), { recursive: true });
      mkdirSync(join(dir, `${PART_STAGE_PREFIX}loose`));
      const keep = new Set([join(root, `${PART_STAGE_PREFIX}in-use`)]);
      const uid = process.getuid?.();
      // Folders of another user are left.
      expect(await sweepPartStages(root, keep, (uid ?? 0) + 1)).toBe(0);
      expect(await sweepPartStages(root, keep, uid)).toBe(2);
      expect(readdirSync(root).toSorted()).toEqual([
        "dipo-box-files-x",
        `${PART_STAGE_PREFIX}file`,
        `${PART_STAGE_PREFIX}in-use`,
        `${PART_STAGE_PREFIX}link`,
      ]);
      expect(readdirSync(other)).toEqual([`${PART_STAGE_PREFIX}live`]);
      expect(readdirSync(dir)).toContain(`${PART_STAGE_PREFIX}loose`);
      expect(await sweepPartStages(join(dir, "missing"))).toBe(0);
      // A folder of stages reached through a link is not swept.
      mkdirSync(join(dir, "target", `${PART_STAGE_PREFIX}c3`), { recursive: true });
      symlinkSync(join(dir, "target"), join(dir, `${PART_STAGE_ROOT_PREFIX}linked`));
      expect(await sweepPartStages(join(dir, `${PART_STAGE_ROOT_PREFIX}linked`))).toBe(0);
      expect(readdirSync(join(dir, "target"))).toEqual([`${PART_STAGE_PREFIX}c3`]);
    }));
});

describe("blob ids and parks", () => {
  it("computes git's blob id", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(blobId("sha1", "hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("parks scope-violation on a hit or a refused part, conflict on a rejected push", () => {
    expect(partPark({ kind: "hit", cause: "secret", detail: "d" })).toEqual({
      reason: "scope-violation",
      cause: "secret",
      detail: "d",
    });
    expect(partPark({ kind: "refused", detail: refusedDetail("cap", 10) })?.cause).toBe(
      "part-refused",
    );
    expect(refusedDetail("cap", 10)).toContain("larger than 10 bytes");
    const push = { pushed: false, rejected: true, error: "rejected" };
    expect(partPark({ kind: "committed", n: 1, commit: "c", paths: [], push })?.reason).toBe(
      "conflict",
    );
    expect(
      partPark({
        kind: "committed",
        n: 1,
        commit: "c",
        paths: [],
        push: { pushed: false, rejected: false, error: "offline" },
      }),
    ).toBeNull();
    expect(partPark({ kind: "empty" })).toBeNull();
    expect(partPark({ kind: "stopped" })).toBeNull();
  });
});

describe("a part that fails too often", () => {
  it("tells the maintainer with a fixed text that names the reads, no path and no error", () => {
    expect(partStuckText(5, 2)).toBe(
      "dipo could not take the worker's part out of the box on 5 door reads in a row, for 2 minutes or more: the stream out of the box or a git step failed each time. Nothing of it is committed yet; the part stays queued in the box, dipo keeps trying, and the worker goes on. The daemon log has the reasons.",
    );
    expect(partUnstuckText(7)).toBe(
      "dipo took the worker's part out of the box again, after 7 door reads in a row that failed.",
    );
  });
});

describe("the ignore-matching budget", () => {
  const rules = new IgnoreRules([{ dir: "", text: "node_modules/\n*.log\n" }]);

  it("leaves out ignored and listed untracked paths, never a tracked one", async () => {
    const view = new Map<string, TreeEntry>([
      ["dist/kept.log", { mode: "100644", type: "blob", id: "1" }],
    ]);
    const out = await leftOutPaths({
      paths: ["dist/kept.log", "a.log", "node_modules/x.js", "listed.json", "src/a.ts"],
      view,
      listed: new Set(["listed.json"]),
      rules: [rules],
      budget: 1_000_000,
    });
    expect(out === "budget" ? out : [...out].toSorted()).toEqual([
      "a.log",
      "listed.json",
      "node_modules/x.js",
    ]);
  });

  it("refuses past the budget, and frees the event loop between batches", async () => {
    const hostile = new IgnoreRules([
      { dir: "", text: Array.from({ length: 100 }, (_, i) => `*a*a*a*a*${i}b`).join("\n") },
    ]);
    const paths = Array.from({ length: 3_000 }, (_, i) => `deep/${"a".repeat(45)}${i}`);
    // The real steps of the first batch, so the budget lets one batch through and stops the next.
    const measured = new MatchBudget(Number.POSITIVE_INFINITY);
    hostile.withBudget(measured);
    for (const path of paths.slice(0, 1_000)) hostile.ignored(path);
    let turns = 0;
    const state = { ticking: true };
    const tick = async () => {
      while (state.ticking) {
        turns += 1;
        await yieldToEventLoop();
      }
    };
    const ticker = tick();
    const before = turns;
    const out = await leftOutPaths({
      paths,
      view: new Map(),
      listed: new Set(),
      rules: [hostile],
      budget: Math.ceil(measured.steps * 1.5),
    });
    state.ticking = false;
    await ticker;
    expect(out).toBe("budget");
    // The ticker ran while the paths were matched: the first batch fit the budget, the second not.
    expect(turns).toBeGreaterThan(before);
  });
});

describe("the values of a listed box file", () => {
  it("reads the value of a dotenv line, never its key", () => {
    expect(dotenvValue("API_KEY=abc123def456")).toBe("abc123def456");
    expect(dotenvValue("export A = 'quoted value here' # note")).toBe("quoted value here");
    expect(dotenvValue('B="x y z"')).toBe("x y z");
    expect(dotenvValue("C=plain-value-12 # cut here")).toBe("plain-value-12");
    expect(dotenvValue("# DB=commented")).toBeNull();
    expect(dotenvValue("D=")).toBeNull();
    expect(dotenvValue('  "json": "value"')).toBeNull();
  });

  it("skips identifier-shaped words of low spread, keeps values with digits or spread", () => {
    expect(secretLike("ANTHROPIC_API_KEY")).toBe(false);
    expect(secretLike("development_mode")).toBe(false);
    expect(secretLike("short")).toBe(false);
    expect(secretLike("abcdefghijklmnopqrst")).toBe(true);
    expect(secretLike("password1234")).toBe(true);
    expect(secretLike("correct-horse-battery")).toBe(true);
  });
});
