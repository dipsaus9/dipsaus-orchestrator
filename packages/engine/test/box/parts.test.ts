// Delivery in parts, the pure rules (DIPO-273, 0021 section 8): the message cleaning, the protected
// list, the secret scan, the comparison with the last delivered tree and the in-box exclude list.
// The flow on real git with a bare remote is in test/run/parts-commit.test.ts. Every secret-shaped
// text here is built from pieces, so this file itself holds none a scan would find.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import type { ArchiveLink } from "../../src/box/cache-extract";
import { IgnoreRules } from "../../src/box/ignore";
import {
  blobId,
  comparePart,
  inBoxExcludes,
  PART_SUBJECT_MAX,
  type PartChange,
  type PartFile,
  partArchiveCommand,
  partCommitMessage,
  partPark,
  partSubject,
  protectedDetail,
  protectedHits,
  protectedKind,
  refusedDetail,
  secretDetail,
  secretHits,
  type TreeEntry,
} from "../../src/box/parts";
import { isSecretPath, newSecretKinds, secretMatches } from "../../src/context/secrets";

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
      const asked: string[] = [];
      const before = async (id: string) => {
        asked.push(id);
        return id === "old-fixture" ? `"${ANTHROPIC_KEY}"\n` : "";
      };
      const clean = await secretHits(
        [
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
      );
      expect(clean).toEqual({ kinds: [], paths: [] });
      expect(asked).toEqual(["old-fixture"]);
      const hit = await secretHits(
        [
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
      );
      expect(hit.kinds).toEqual(["an AWS access key", "a secret file name"]);
      expect(hit.paths).toEqual(["src/a.ts", ".env"]);
      const detail = secretDetail(hit.kinds, hit.paths.length);
      expect(detail).toBe(
        "The part the worker delivered holds what looks like a secret: an AWS access key; a secret file name, in 2 files. dipo committed and pushed nothing, and the files stay in the box.",
      );
      expect(detail).not.toContain(AWS_KEY);
      expect(detail).not.toContain(".env");
    }));
});

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
    expect(inBoxExcludes(rules, view)).toEqual([".cache", "node_modules"]);
  });

  it("leaves out a name a `!` rule could re-include, but not for an unrelated `!` rule", () => {
    const rules = new IgnoreRules([
      { dir: "", text: "node_modules/\n.env*\n!.env.example\ndist/\n!dist/\n" },
    ]);
    expect(inBoxExcludes(rules, new Map())).toEqual(["node_modules"]);
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
  });
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
