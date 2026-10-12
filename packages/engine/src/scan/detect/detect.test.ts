import { describe, expect, it } from "bun:test";

import { detect, splitCommand } from "./detect";
import type { CommandSpec, EnvFile, Probe, Resolution, RunProfile } from "./types";

type Shape = {
  scripts?: Record<string, string>;
  manifest?: Record<string, unknown>;
  lockfiles?: string[];
  workflow?: Record<string, unknown>;
  texts?: Record<string, string>;
  workspaces?: Record<string, Record<string, unknown>>;
  configImports?: Record<string, string[]>;
  envFiles?: EnvFile[];
};

/** A probe shaped like a repository, built by hand: no file system involved. */
function probeOf(shape: Shape): Probe {
  const texts: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "repo",
      ...shape.manifest,
      scripts: shape.scripts ?? {},
    }),
    ...shape.texts,
  };
  if (shape.workflow !== undefined) {
    texts[".claude/backlog-workflow.json"] = JSON.stringify(shape.workflow);
  }
  for (const [dir, manifest] of Object.entries(shape.workspaces ?? {})) {
    texts[`${dir}/package.json`] = JSON.stringify(manifest);
  }
  return {
    texts,
    lockfiles: shape.lockfiles ?? [],
    workspaceDirs: Object.keys(shape.workspaces ?? {}),
    configImports: shape.configImports ?? {},
    envFiles: shape.envFiles ?? [],
  };
}

const codes = (profile: RunProfile) => profile.conformance.deviations.map((d) => d.code);
const commands = (resolution: Resolution<CommandSpec>) =>
  resolution.status === "resolved" ? resolution.value.commands : null;

const VITE_APP = {
  lint: "oxlint",
  typecheck: "tsc -b --noEmit",
  test: "vitest run",
  build: "tsc -b && vite build",
  dev: "vite",
};

// Probes shaped like the nine repositories of the 0013 survey (2026-10-09).
const survey = {
  couchcade: probeOf({
    manifest: { packageManager: "pnpm@11.27.0", engines: { node: ">=24" } },
    scripts: {
      dev: "pnpm -r --parallel --if-present run dev",
      check: "oxfmt --check && oxlint && pnpm -r --if-present run typecheck",
      test: "pnpm -r --if-present run test",
      e2e: "pnpm --filter ./e2e --if-present run e2e",
      build: "pnpm -r --if-present run build",
      format: "oxfmt",
      lint: "oxlint",
    },
    lockfiles: ["pnpm-lock.yaml"],
    texts: {
      ".node-version": "24\n",
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\ncatalog:\n  vite: ^8.3.0\n",
      "apps/host/vite.config.ts":
        'import { defineAppConfig, devPorts } from "@couchcade/config/vite";\nexport default defineAppConfig({ base: "/host/", port: devPorts.host });\n',
      "apps/controller/vite.config.ts":
        'import { defineAppConfig, devPorts } from "@couchcade/config/vite";\nexport default defineAppConfig({ base: "/", port: devPorts.controller });\n',
      "apps/server/vite.config.ts":
        'import { defineWorkerConfig } from "@couchcade/config/vite";\nexport default defineWorkerConfig({});\n',
      "packages/config/vite/index.ts":
        "export const devPorts = {\n  server: 5173,\n  host: 5174,\n  controller: 5175,\n} as const;\n",
    },
    workspaces: {
      "apps/controller": {
        name: "@couchcade/controller",
        scripts: { dev: "vite", test: "vitest run" },
      },
      "apps/host": { name: "@couchcade/host", scripts: { dev: "vite", test: "vitest run" } },
      "apps/server": {
        name: "@couchcade/server",
        scripts: { dev: "vite", deploy: "wrangler deploy" },
      },
      "packages/config": { name: "@couchcade/config", exports: { "./*": "./*/index.ts" } },
    },
    configImports: {
      "apps/host/vite.config.ts": ["packages/config/vite/index.ts"],
      "apps/controller/vite.config.ts": ["packages/config/vite/index.ts"],
      "apps/server/vite.config.ts": ["packages/config/vite/index.ts"],
    },
    workflow: {
      worktree: {
        install: "pnpm install --frozen-lockfile",
        includeGitignored: ["apps/server/.dev.vars"],
      },
      verify: [],
    },
    envFiles: [
      {
        example: "apps/server/.dev.vars.example",
        path: "apps/server/.dev.vars",
        present: true,
        ignored: true,
      },
    ],
  }),
  slaydoku: probeOf({
    scripts: { ...VITE_APP, verify: "bun tools/verify.ts", "test:slow": "vitest run --mode slow" },
    lockfiles: ["bun.lock"],
    workflow: {
      worktree: { install: "bun install", includeGitignored: [] },
      verify: ["bun run lint", "bun run typecheck", "bun run test"],
    },
  }),
  cadeauko: probeOf({
    scripts: { ...VITE_APP, preview: "vite preview", verify: "bun tools/verify.ts" },
    lockfiles: ["bun.lock"],
    workflow: {
      worktree: { install: "bun install", includeGitignored: [] },
      verify: ["bun run lint", "bun run typecheck", "bun run test"],
    },
  }),
  "kompanen/borrel-35": probeOf({
    scripts: {
      dev: "next dev --turbopack",
      start: "next start",
      test: "vitest run",
      "test:watch": "vitest",
      lint: "eslint .",
      typecheck: "tsc --noEmit",
      format: "prettier --write .",
      "format:check": "prettier --check .",
    },
    lockfiles: ["bun.lock"],
    workflow: {
      worktree: { install: "bun install" },
      verify: ["bun run lint", "bun run typecheck"],
    },
  }),
  "tennis-booker": probeOf({
    scripts: {
      book: "bun src/book.ts",
      slots: "bun src/slots.ts",
      scheduler: "bun src/scheduler.ts",
      test: "bun test",
      typecheck: "tsc --noEmit",
    },
    lockfiles: ["bun.lock"],
    envFiles: [
      { example: ".env.example", path: ".env", present: true, ignored: true },
      { example: "config.example.json", path: "config.json", present: true, ignored: true },
    ],
  }),
  "valentine-2026": probeOf({
    scripts: {
      dev: "react-router dev",
      start: "react-router-serve ./build/server/index.js",
      build: "react-router build",
      typecheck: "react-router typegen && tsc",
    },
    lockfiles: ["pnpm-lock.yaml"],
    texts: { "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - esbuild\n" },
  }),
  "kompanen/borrel-34": probeOf({
    scripts: {
      predev: "node scripts/generate.js",
      dev: "next dev",
      build: "next build",
      start: "next start",
      lint: "next lint",
    },
    lockfiles: ["package-lock.json"],
  }),
  "romy-blij-maken": probeOf({
    scripts: {
      dev: "next dev --turbopack",
      build: "next build",
      start: "next start",
      lint: "eslint",
    },
    lockfiles: ["package-lock.json"],
  }),
  blog: probeOf({
    scripts: { format: "prettier --check .", "format:fix": "prettier --write ." },
    lockfiles: ["package-lock.json"],
  }),
} as const;

describe("detect over the 0013 survey", () => {
  it("rates each surveyed repository at its fit-table level", () => {
    const levels = Object.fromEntries(
      Object.entries(survey).map(([name, probe]) => [name, detect(probe).conformance.level]),
    );
    expect(levels).toEqual({
      // The fit table says "Conforming, with deviations", but open question 5 (answered the same
      // day) makes fixed dev ports level Partial, and couchcade fixes three ports in code.
      couchcade: "partial",
      slaydoku: "partial",
      cadeauko: "partial",
      "kompanen/borrel-35": "conforming",
      "tennis-booker": "partial",
      "valentine-2026": "partial",
      "kompanen/borrel-34": "partial",
      "romy-blij-maken": "partial",
      // "Not a product": nothing a product needs resolves from code.
      blog: "non-standard",
    });
  });

  it("makes tennis-booker conforming once marked as having nothing to start", () => {
    const profile = detect(survey["tennis-booker"], { nothingToStart: true });
    expect(profile.conformance.level).toBe("conforming");
    expect(codes(profile)).toContain("missing-lint");
    expect(codes(profile)).not.toContain("missing-dev");
  });

  it("reads couchcade's toolchain, composed verify, declared install and fixed ports", () => {
    const profile = detect(survey.couchcade);
    expect(profile.toolchain.packageManager).toMatchObject({
      status: "resolved",
      value: { name: "pnpm", version: "11.27.0" },
      source: "declared",
      confidence: "high",
    });
    expect(profile.toolchain.runtimeVersion).toMatchObject({
      status: "resolved",
      value: "24",
      evidence: ".node-version",
    });
    expect(profile.toolchain.workspaces.map((w) => w.name)).toEqual([
      "@couchcade/controller",
      "@couchcade/host",
      "@couchcade/server",
      "@couchcade/config",
    ]);
    expect(profile.capabilities.install).toMatchObject({
      status: "resolved",
      source: "declared",
      value: { commands: [["pnpm", "install", "--frozen-lockfile"]], cwd: "." },
    });
    expect(profile.capabilities.verify).toMatchObject({
      status: "resolved",
      source: "composed",
      confidence: "medium",
      value: {
        commands: [
          ["pnpm", "run", "lint"],
          ["pnpm", "run", "test"],
        ],
      },
    });
    expect(profile.capabilities.typecheck).toEqual({ status: "unresolved" });
    expect(profile.devPorts.map((p) => [p.dir, p.port, p.fixedInCode, p.source])).toEqual([
      ["apps/controller", 5175, true, "declared"],
      ["apps/host", 5174, true, "declared"],
      ["apps/server", 5173, false, "default"],
    ]);
    expect(codes(profile)).toEqual(
      expect.arrayContaining([
        "verify-composed",
        "relies-on-workflow",
        "missing-typecheck",
        "format-writes",
        "fixed-port:apps/controller:5175",
        "fixed-port:apps/host:5174",
      ]),
    );
    expect(profile.extraScripts.map((s) => s.name)).toEqual(["check", "e2e", "format"]);
    expect(profile.envFiles).toEqual(survey.couchcade.envFiles);
    expect(profile.runRefusal).toBeNull();
  });

  it("finds slaydoku's verify script next to a different declared list as a conflict", () => {
    const profile = detect(survey.slaydoku);
    expect(profile.capabilities.verify.status).toBe("conflict");
    const conflict = profile.conformance.deviations.find((d) => d.code === "verify-conflict");
    expect(conflict?.conflict).toBe(true);
    expect(profile.runRefusal).toContain('"verify" script');
    expect(profile.runRefusal).toContain("verify:puzzle");
    expect(profile.devPorts).toEqual([
      expect.objectContaining({
        port: 5173,
        source: "default",
        confidence: "low",
        fixedInCode: false,
      }),
    ]);
  });

  it("resolves borrel-35's declared verify and reports what composing would add", () => {
    const profile = detect(survey["kompanen/borrel-35"]);
    expect(profile.capabilities.verify).toMatchObject({
      status: "resolved",
      source: "declared",
      value: {
        commands: [
          ["bun", "run", "lint"],
          ["bun", "run", "typecheck"],
        ],
      },
    });
    expect(codes(profile)).toEqual(
      expect.arrayContaining(["verify-declared-differs", "relies-on-workflow", "format-writes"]),
    );
    expect(profile.devPorts).toEqual([
      expect.objectContaining({ port: 3000, honoursPort: true, fixedInCode: false }),
    ]);
  });

  it("names the missing test script for valentine-2026, borrel-34 and romy-blij-maken", () => {
    for (const name of ["valentine-2026", "kompanen/borrel-34", "romy-blij-maken"] as const) {
      expect(codes(detect(survey[name]))).toContain("missing-test");
    }
  });
});

const pm = (probe: Probe) => detect(probe).toolchain.packageManager;
const install = (lockfile: string) =>
  commands(detect(probeOf({ lockfiles: [lockfile] })).capabilities.install);
const runtime = (shape: Shape) => detect(probeOf(shape)).toolchain.runtimeVersion;
const verify = (shape: Shape) =>
  detect(probeOf({ lockfiles: ["bun.lock"], ...shape })).capabilities.verify;
const ports = (shape: Shape) => detect(probeOf({ lockfiles: ["bun.lock"], ...shape })).devPorts;

describe("detection order", () => {
  it("takes the package manager from packageManager, then the lockfile, else npm with low confidence", () => {
    expect(
      pm(probeOf({ manifest: { packageManager: "bun@1.4.2" }, lockfiles: ["bun.lock"] })),
    ).toMatchObject({
      status: "resolved",
      value: { name: "bun", version: "1.4.2" },
      source: "declared",
    });
    expect(pm(probeOf({ lockfiles: ["yarn.lock"] }))).toMatchObject({
      status: "resolved",
      value: { name: "yarn", version: null },
      source: "standard",
      confidence: "high",
      evidence: "yarn.lock",
    });
    expect(pm(probeOf({}))).toMatchObject({
      status: "resolved",
      value: { name: "npm" },
      confidence: "low",
      source: "default",
    });
  });

  it("derives a frozen install per package manager unless worktree.install is declared", () => {
    expect(install("bun.lock")).toEqual([["bun", "install", "--frozen-lockfile"]]);
    expect(install("pnpm-lock.yaml")).toEqual([["pnpm", "install", "--frozen-lockfile"]]);
    expect(install("yarn.lock")).toEqual([["yarn", "install", "--immutable"]]);
    expect(install("package-lock.json")).toEqual([["npm", "ci"]]);
  });

  it("takes the runtime version from .node-version, then .nvmrc, then engines.node", () => {
    const engines = { manifest: { engines: { node: ">=22" } } };
    expect(
      runtime({ ...engines, texts: { ".node-version": "24.1\n", ".nvmrc": "22\n" } }),
    ).toMatchObject({ value: "24.1", confidence: "high" });
    expect(runtime({ ...engines, texts: { ".nvmrc": "22\n" } })).toMatchObject({
      value: "22",
      evidence: ".nvmrc",
    });
    expect(runtime(engines)).toMatchObject({ value: ">=22", confidence: "medium" });
    expect(runtime({})).toEqual({ status: "unresolved" });
  });

  it("resolves verify from the script, then the declared list, then lint, typecheck and test", () => {
    const all = { lint: "oxlint", typecheck: "tsc", test: "bun test" };
    expect(verify({ scripts: { ...all, verify: "bun run lint && bun run test" } })).toMatchObject({
      source: "standard",
      confidence: "high",
      value: { commands: [["bun", "run", "verify"]] },
    });
    expect(verify({ scripts: all, workflow: { verify: ["bun run test"] } })).toMatchObject({
      source: "declared",
      value: { commands: [["bun", "run", "test"]] },
    });
    expect(
      verify({ scripts: { test: "bun test", lint: "oxlint", typecheck: "tsc" } }),
    ).toMatchObject({
      source: "composed",
      confidence: "medium",
      value: {
        commands: [
          ["bun", "run", "lint"],
          ["bun", "run", "typecheck"],
          ["bun", "run", "test"],
        ],
      },
    });
  });

  it("accepts a declared list that says the same as the verify script", () => {
    const profile = detect(
      probeOf({
        lockfiles: ["bun.lock"],
        scripts: { verify: "bun run lint && bun run test" },
        workflow: { verify: ["bun run lint", "bun run test"] },
      }),
    );
    expect(profile.capabilities.verify).toMatchObject({ status: "resolved", source: "standard" });
    expect(codes(profile)).not.toContain("verify-conflict");
  });

  it("takes an explicit port from the dev script or a vite config, and sees PORT", () => {
    expect(ports({ scripts: { dev: "vite --port 4000" } })).toEqual([
      expect.objectContaining({
        port: 4000,
        source: "declared",
        confidence: "medium",
        fixedInCode: true,
        honoursPort: false,
      }),
    ]);
    expect(
      ports({
        scripts: { dev: "vite" },
        texts: {
          "vite.config.ts":
            "export default { server: { port: Number(process.env.PORT) || 4100, strictPort: true } };",
        },
      }),
    ).toEqual([
      expect.objectContaining({
        port: 5173,
        source: "default",
        fixedInCode: false,
        honoursPort: true,
      }),
    ]);
    expect(
      ports({
        scripts: { dev: "vite" },
        texts: { "vite.config.ts": "export default { server: { port: 4100 } };" },
      }),
    ).toEqual([
      expect.objectContaining({
        port: 4100,
        evidence: "vite.config.ts",
        fixedInCode: true,
        honoursPort: false,
      }),
    ]);
    expect(ports({ scripts: { dev: "wrangler dev" } })).toEqual([
      expect.objectContaining({ port: 8787, source: "default" }),
    ]);
  });
});

describe("conflicts become findings", () => {
  it("reports two lockfiles and leaves the package manager and its commands in conflict", () => {
    const profile = detect(
      probeOf({
        lockfiles: ["bun.lock", "package-lock.json"],
        scripts: { test: "bun test", lint: "oxlint" },
      }),
    );
    expect(profile.toolchain.packageManager.status).toBe("conflict");
    expect(profile.capabilities.test.status).toBe("conflict");
    expect(profile.capabilities.verify.status).toBe("conflict");
    expect(profile.conformance.deviations).toContainEqual(
      expect.objectContaining({ code: "lockfile-conflict", conflict: true }),
    );
    expect(profile.conformance.level).toBe("partial");
    expect(profile.runRefusal).toContain("Lockfiles of more than one package manager");
  });

  it("reports a packageManager field that disagrees with the lockfile", () => {
    const profile = detect(
      probeOf({ manifest: { packageManager: "pnpm@9.0.0" }, lockfiles: ["yarn.lock"] }),
    );
    const manager = profile.toolchain.packageManager;
    expect(manager.status).toBe("conflict");
    if (manager.status === "conflict")
      expect(manager.candidates.map((c) => c.value.name)).toEqual(["pnpm", "yarn"]);
    expect(profile.conformance.deviations).toContainEqual(
      expect.objectContaining({ code: "package-manager-mismatch", conflict: true }),
    );
  });
});

describe("env files", () => {
  it("records env files by path only and flags a missing real file unless setup exists", () => {
    const envFiles: EnvFile[] = [
      {
        example: "apps/server/.dev.vars.example",
        path: "apps/server/.dev.vars",
        present: false,
        ignored: true,
      },
    ];
    const without = detect(probeOf({ lockfiles: ["bun.lock"], envFiles }));
    expect(without.envFiles).toEqual(envFiles);
    expect(without.conformance.deviations).toContainEqual(
      expect.objectContaining({
        message: "apps/server/.dev.vars absent, apps/server/.dev.vars.example present.",
      }),
    );
    const withSetup = detect(
      probeOf({ lockfiles: ["bun.lock"], envFiles, scripts: { setup: "bun scripts/setup.ts" } }),
    );
    expect(codes(withSetup).some((code) => code.startsWith("env-file-missing"))).toBe(false);
  });

  it("flags a present env file git does not ignore", () => {
    const profile = detect(
      probeOf({
        envFiles: [{ example: ".env.example", path: ".env", present: true, ignored: false }],
      }),
    );
    expect(codes(profile)).toContain("env-file-not-ignored:.env");
  });
});

describe("run refusal", () => {
  it("leaves verify unresolved without verify, a declared list, lint, typecheck or test, and names the script to add", () => {
    const profile = detect(
      probeOf({
        lockfiles: ["bun.lock"],
        scripts: { dev: "vite", build: "vite build" },
        workflow: { verify: [] },
      }),
    );
    expect(profile.capabilities.verify).toEqual({ status: "unresolved" });
    expect(profile.runRefusal).toContain('add a "verify" script to package.json');
    expect(profile.conformance.level).toBe("partial");
  });

  it("names package.json and its verify script when the repository has no package.json", () => {
    const profile = detect({
      texts: {},
      lockfiles: [],
      workspaceDirs: [],
      configImports: {},
      envFiles: [],
    });
    expect(profile.conformance.level).toBe("non-standard");
    expect(profile.runRefusal).toContain('package.json with a "verify" script');
  });

  it("is null once verify resolves", () => {
    expect(
      detect(probeOf({ lockfiles: ["bun.lock"], scripts: { verify: "bun test" } })).runRefusal,
    ).toBeNull();
  });
});

describe("detect is pure", () => {
  it("gives the same profile for the same probe and does not change the probe", () => {
    const probe = survey.couchcade;
    const before = JSON.stringify(probe);
    expect(detect(probe)).toEqual(detect(probe));
    expect(JSON.stringify(probe)).toBe(before);
  });
});

describe("splitCommand", () => {
  it("splits plain commands and keeps shell syntax whole behind sh -c", () => {
    expect(splitCommand("pnpm install --frozen-lockfile")).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
    ]);
    expect(splitCommand(`bun run "my script"`)).toEqual(["bun", "run", "my script"]);
    expect(splitCommand("bun run lint && bun test")).toEqual([
      "sh",
      "-c",
      "bun run lint && bun test",
    ]);
  });
});
