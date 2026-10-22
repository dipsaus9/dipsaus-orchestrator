// The input checks of the package cache fill (DIPO-267): what the base hands the fill box is
// refused with box.cacheUnsupported unless every dependency is a registry package and every
// workspace stays in the project; for pnpm only the `packages` of the workspace file pass.

import { describe, expect, it } from "bun:test";

import {
  type BaseLockfile,
  type CacheManager,
  checkFillInput,
  isProjectGlob,
  isRegistrySpec,
  isRegistryTarball,
  withoutTrailingCommas,
} from "../../src/box/cache-input";
import { BoxError } from "../../src/box/port";
import { parseYamlDocument } from "../../src/platform/yaml";

const TARBALL = "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz";

function base(
  manager: CacheManager,
  text: string,
  files: BaseLockfile["files"] = [{ path: "package.json", text: "{}\n" }],
): BaseLockfile {
  const name = { bun: "bun.lock", npm: "package-lock.json", pnpm: "pnpm-lock.yaml" }[manager];
  return { commit: "c".repeat(40), lockfile: { name, manager, text }, files };
}

function refused(input: BaseLockfile): BoxError {
  try {
    checkFillInput(input);
  } catch (error) {
    expect(error).toBeInstanceOf(BoxError);
    expect((error as BoxError).code).toBe("box.cacheUnsupported");
    return error as BoxError;
  }
  throw new Error("expected the input to be refused");
}

const bunLock = (
  packages: Record<string, unknown[]>,
  workspaces: Record<string, unknown> = { "": {} },
) =>
  `${JSON.stringify({ lockfileVersion: 1, workspaces, packages }, null, 2).replace(/\n\}$/, ",\n}")}\n`;

const npmLock = (packages: Record<string, unknown>, lockfileVersion = 3) =>
  JSON.stringify({ lockfileVersion, packages: { "": {}, ...packages } });

const NON_REGISTRY = [
  "git+ssh://git@example.com/owner/repo.git#abc",
  "git://example.com/repo.git",
  "github:owner/repo",
  "owner/repo",
  "https://example.com/pkg.tgz",
  "http://example.com/pkg.tgz",
  "file:../outside",
  "link:../outside",
  "~/outside",
  "~",
];

describe("registry specs", () => {
  it("passes versions, ranges, tags, aliases, catalogs and workspaces", () => {
    for (const spec of [
      "7.0.0",
      "^1.2.3",
      "~8.9.0",
      ">=1 <2",
      "latest",
      "*",
      "npm:other@1.0.0",
      "catalog:",
      "workspace:*",
      "workspace:packages/a",
    ]) {
      expect(isRegistrySpec(spec)).toBe(true);
    }
  });

  it("refuses git, tarball URLs, folders and links", () => {
    for (const spec of [...NON_REGISTRY, "npm:other@github:owner/repo", "workspace:../outside"]) {
      expect(isRegistrySpec(spec)).toBe(false);
    }
  });

  it("knows a registry tarball only on a checked registry", () => {
    expect(isRegistryTarball(TARBALL)).toBe(true);
    for (const url of [
      "https://example.com/is-number/-/is-number-7.0.0.tgz",
      "http://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
      "https://registry.npmjs.org:8443/is-number/-/is-number-7.0.0.tgz",
      "git+ssh://git@registry.npmjs.org/x.git",
    ]) {
      expect(isRegistryTarball(url)).toBe(false);
    }
  });

  it("keeps workspace globs in the project", () => {
    expect(isProjectGlob("packages/*")).toBe(true);
    expect(isProjectGlob("!packages/private")).toBe(true);
    expect(isProjectGlob("./apps/**")).toBe(true);
    for (const glob of ["../outside/*", "/abs/*", "packages/../../x", ""]) {
      expect(isProjectGlob(glob)).toBe(false);
    }
  });
});

describe("the manifests", () => {
  it("passes registry dependencies and returns the lockfile and the manifests", () => {
    const manifest = JSON.stringify({
      dependencies: { "is-number": "7.0.0" },
      workspaces: ["packages/*"],
    });
    const input = base("bun", bunLock({ "is-number": ["is-number@7.0.0", "", {}, "sha512-x"] }), [
      { path: "package.json", text: manifest },
      { path: "packages/a/package.json", text: "{}" },
    ]);
    expect(checkFillInput(input).map((file) => file.path)).toEqual([
      "bun.lock",
      "package.json",
      "packages/a/package.json",
    ]);
  });

  it("refuses a non-registry dependency in any dependency map or override", () => {
    for (const spec of NON_REGISTRY) {
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        refused(
          base("bun", bunLock({}), [
            { path: "package.json", text: JSON.stringify({ [field]: { x: spec } }) },
          ]),
        );
      }
      refused(
        base("npm", npmLock({}), [
          { path: "package.json", text: JSON.stringify({ overrides: { a: { x: spec } } }) },
        ]),
      );
    }
  });

  it("refuses workspaces that leave the project", () => {
    for (const workspaces of [["../outside"], ["/abs/*"], { packages: ["packages/../../x"] }]) {
      refused(
        base("bun", bunLock({}), [{ path: "package.json", text: JSON.stringify({ workspaces }) }]),
      );
    }
  });

  it("refuses a file that is not a manifest and a path that leaves the project", () => {
    refused(base("bun", bunLock({}), [{ path: ".npmrc", text: "" }]));
    refused(base("bun", bunLock({}), [{ path: "../package.json", text: "{}" }]));
  });
});

describe("bun.lock", () => {
  it("reads Bun's trailing commas, and keeps commas inside strings", () => {
    expect(
      JSON.parse(withoutTrailingCommas('{ "a": ["x,]", "y\\",", ], "b": { "c": 1, }, }')),
    ).toEqual({
      a: ["x,]", 'y",'],
      b: { c: 1 },
    });
  });

  it("passes registry packages and workspace packages", () => {
    checkFillInput(
      base(
        "bun",
        bunLock(
          { a: ["a@workspace:packages/a"], "is-number": ["is-number@7.0.0", "", {}, "sha512-x"] },
          { "": { dependencies: { a: "workspace:*" } }, "packages/a": {} },
        ),
      ),
    );
  });

  it("refuses git, github, tarball, file and link entries", () => {
    for (const spec of NON_REGISTRY) refused(base("bun", bunLock({ x: [`x@${spec}`] })));
  });

  it("refuses a workspace outside the project", () => {
    refused(base("bun", bunLock({}, { "": {}, "../outside": {} })));
    refused(base("bun", bunLock({ a: ["a@workspace:../outside"] })));
  });

  it("passes this repository's own bun.lock and manifests (a tilde range, DIPO-275)", async () => {
    const root = new URL("../../../../", import.meta.url).pathname;
    const paths = ["package.json"];
    for await (const path of new Bun.Glob("packages/*/package.json").scan(root)) paths.push(path);
    const files = await Promise.all(
      paths.toSorted().map(async (path) => ({ path, text: await Bun.file(root + path).text() })),
    );
    const text = await Bun.file(`${root}bun.lock`).text();
    checkFillInput(base("bun", text, files));
  });
});

describe("package-lock.json", () => {
  it("passes registry tarballs and links inside the project", () => {
    checkFillInput(
      base(
        "npm",
        npmLock({
          "node_modules/is-number": { version: "7.0.0", resolved: TARBALL, integrity: "sha512-x" },
          "packages/a": { version: "1.0.0" },
          "node_modules/a": { resolved: "packages/a", link: true },
        }),
      ),
    );
  });

  it("refuses git, tarball URLs off the registry, folders and links out of the project", () => {
    for (const resolved of [
      "git+ssh://git@example.com/x.git#abc",
      "https://example.com/x.tgz",
      "file:../outside",
    ]) {
      refused(base("npm", npmLock({ "node_modules/x": { version: "1.0.0", resolved } })));
    }
    refused(base("npm", npmLock({ "node_modules/x": { resolved: "../outside", link: true } })));
    refused(base("npm", npmLock({ "../outside": { version: "1.0.0" } })));
    refused(base("npm", npmLock({ "node_modules/x": { version: "github:owner/repo" } })));
  });

  it("refuses a lockfile older than version 2", () => {
    refused(base("npm", npmLock({}, 1)));
  });
});

const lock = (body: string) => `lockfileVersion: '9.0'\n${body}`;
const files = (workspace: string) => [
  { path: "package.json", text: "{}" },
  { path: "pnpm-workspace.yaml", text: workspace },
];

describe("pnpm", () => {
  it("passes registry packages and writes the workspace file from packages only", () => {
    const checked = checkFillInput(
      base(
        "pnpm",
        lock(
          [
            "importers:",
            "  .:",
            "    dependencies:",
            "      a: { specifier: 'workspace:*', version: 'link:packages/a' }",
            "      is-number: { specifier: 7.0.0, version: 7.0.0 }",
            "  packages/b:",
            "    dependencies:",
            "      a: { specifier: 'workspace:*', version: 'link:../a' }",
            "packages:",
            "  is-number@7.0.0:",
            "    resolution: { integrity: sha512-x }",
            "",
          ].join("\n"),
        ),
        files("packages:\n  - packages/*\n"),
      ),
    );
    const workspace = checked.find((file) => file.path === "pnpm-workspace.yaml");
    expect(parseYamlDocument(workspace!.text)).toEqual({
      ok: true,
      value: { packages: ["packages/*"] },
    });
  });

  it("refuses any workspace key but packages, such as configDependencies or pnpmfile", () => {
    for (const workspace of [
      "packages: [a]\nconfigDependencies: { x: '1.0.0+sha512-x' }\n",
      "packages: [a]\npnpmfile: .pnpmfile.cjs\n",
      "catalog: { x: 1.0.0 }\n",
      "packages: ['../outside']\n",
    ]) {
      refused(base("pnpm", lock(""), files(workspace)));
    }
  });

  it("refuses git, tarball and folder resolutions, and links out of the project", () => {
    for (const resolution of [
      "{ type: git, repo: 'git+ssh://git@example.com/x.git', commit: abc }",
      "{ tarball: 'https://example.com/x.tgz', integrity: sha512-x }",
      "{ directory: ../outside, type: directory }",
    ]) {
      refused(base("pnpm", lock(`packages:\n  x@1.0.0:\n    resolution: ${resolution}\n`)));
    }
    refused(
      base(
        "pnpm",
        lock(
          "importers:\n  .:\n    dependencies:\n      x: { specifier: 'link:../x', version: 'link:../x' }\n",
        ),
      ),
    );
    refused(base("pnpm", lock("importers:\n  ../outside: {}\n")));
  });
});

const lockWith = (extra: Record<string, unknown>) =>
  JSON.stringify({ lockfileVersion: 1, workspaces: { "": {} }, packages: {}, ...extra });
const legacy = (dependencies: Record<string, unknown>) =>
  JSON.stringify({ lockfileVersion: 2, packages: { "": {} }, dependencies });

describe("where a package is fetched from", () => {
  it("refuses a bun.lock entry whose registry field names any other host (the review's probe)", () => {
    for (const registry of [
      "https://npm.evil.example/",
      "http://registry.npmjs.org/",
      "https://registry.npmjs.org:8443/",
      "https://user:secret@registry.npmjs.org/",
      "https://registry.npmjs.org/?x=1",
      "https://registry.npmjs.org/#x",
      "registry.npmjs.org",
      7,
    ]) {
      refused(base("bun", bunLock({ "is-number": ["is-number@7.0.0", registry, {}, "sha512-x"] })));
    }
  });

  it("passes a bun.lock registry field that is empty or an npm registry Safe-Chain checks", () => {
    for (const registry of ["", "https://registry.npmjs.org/", "https://registry.yarnpkg.com/"]) {
      checkFillInput(
        base("bun", bunLock({ "is-number": ["is-number@7.0.0", registry, {}, "sha512-x"] })),
      );
    }
  });

  it("refuses a bun.lock package that is not at an exact version, or whose own dependencies are not registry specs", () => {
    refused(base("bun", bunLock({ x: ["x@^1.0.0", "", {}, "sha512-x"] })));
    refused(
      base(
        "bun",
        bunLock({
          x: ["x@1.0.0", "", { dependencies: { y: "https://example.com/y.tgz" } }, "sha512-x"],
        }),
      ),
    );
  });

  it("refuses non-registry specs in bun.lock overrides and catalogs, and fields dipo does not check", () => {
    refused(base("bun", lockWith({ overrides: { x: "github:owner/repo" } })));
    refused(base("bun", lockWith({ catalog: { x: "https://example.com/x.tgz" } })));
    refused(base("bun", lockWith({ catalogs: { tools: { x: "git+ssh://git@example.com/x" } } })));
    refused(base("bun", lockWith({ registry: "https://npm.evil.example/" })));
    checkFillInput(base("bun", lockWith({ overrides: { x: "1.0.0" }, catalog: { y: "^2.0.0" } })));
  });

  it("refuses package-lock.json fields dipo does not check, versions that are not exact, and the legacy tree's sources", () => {
    refused(
      base(
        "npm",
        JSON.stringify({ lockfileVersion: 3, packages: {}, registry: "https://npm.evil.example/" }),
      ),
    );
    refused(base("npm", npmLock({ "node_modules/x": { version: "https://example.com/x.tgz" } })));
    refused(
      base(
        "npm",
        legacy({ x: { version: "1.0.0", resolved: "https://npm.evil.example/x/-/x-1.0.0.tgz" } }),
      ),
    );
    refused(base("npm", legacy({ x: { version: "git+ssh://git@example.com/x.git#abc" } })));
    refused(base("npm", legacy({ x: { version: "file:../outside" } })));
    refused(base("npm", legacy({ x: { version: "1.0.0", requires: { y: "github:owner/repo" } } })));
    refused(
      base(
        "npm",
        legacy({
          x: { version: "1.0.0", dependencies: { y: { version: "https://example.com/y.tgz" } } },
        }),
      ),
    );
    checkFillInput(
      base(
        "npm",
        legacy({
          x: { version: "1.0.0", resolved: TARBALL, requires: { y: "^1.0.0" } },
          a: { version: "file:packages/a" },
          z: { version: "npm:is-number@7.0.0" },
        }),
      ),
    );
  });

  it("refuses pnpm lockfiles before version 9, unknown fields, and packages or versions that are not registry packages", () => {
    refused(base("pnpm", "lockfileVersion: '6.0'\n"));
    refused(base("pnpm", lock("registry: https://npm.evil.example/\n")));
    refused(
      base(
        "pnpm",
        lock(
          "packages:\n  'x@https://example.com/x.tgz':\n    resolution: { integrity: sha512-x }\n",
        ),
      ),
    );
    refused(
      base(
        "pnpm",
        lock("snapshots:\n  x@1.0.0:\n    dependencies:\n      y: https://example.com/y.tgz\n"),
      ),
    );
    refused(
      base(
        "pnpm",
        lock(
          "importers:\n  .:\n    dependencies:\n      x: { specifier: ^1.0.0, version: 'github.com/owner/repo/abc' }\n",
        ),
      ),
    );
    refused(
      base(
        "pnpm",
        lock("catalogs:\n  default:\n    x: { specifier: 'github:owner/repo', version: 1.0.0 }\n"),
      ),
    );
    checkFillInput(
      base(
        "pnpm",
        lock(
          [
            "catalogs:",
            "  default:",
            "    x: { specifier: ^1.0.0, version: 1.0.0 }",
            "packages:",
            "  '@scope/x@1.0.0':",
            "    resolution: { integrity: sha512-x }",
            "snapshots:",
            "  '@scope/x@1.0.0(peer@2.0.0)':",
            "    dependencies:",
            "      y: 1.2.3",
            "      z: string-width@4.2.3",
            "",
          ].join("\n"),
        ),
      ),
    );
  });
});
