// Decision 0016 rules 10 and 11: automerge is limited by `renovate.json`, not by convention. This
// test replays the config's `packageRules` the way Renovate applies them (in order, later rules
// win, every matcher in a rule must match) for each kind of update and checks the outcome. It
// supports only the matchers the config uses and fails on any other, so a new matcher cannot make
// it pass by being ignored.
import { describe, expect, it } from "bun:test";

const CONFIG_PATH = new URL("../renovate.json", import.meta.url).pathname;

interface PackageRule {
  matchPackageNames?: string[];
  matchDepNames?: string[];
  matchDepTypes?: string[];
  matchUpdateTypes?: string[];
  matchManagers?: string[];
  automerge?: boolean;
  [key: string]: unknown;
}

interface RenovateConfig {
  extends?: string[];
  automerge?: boolean;
  minimumReleaseAge?: string;
  vulnerabilityAlerts?: { enabled?: boolean; automerge?: boolean };
  osvVulnerabilityAlerts?: boolean;
  lockFileMaintenance?: { enabled?: boolean; automerge?: boolean; schedule?: string[] };
  packageRules?: PackageRule[];
}

interface Update {
  manager: string;
  depName: string;
  packageName?: string;
  depType: string;
  updateType: "major" | "minor" | "patch" | "digest" | "pin" | "pinDigest" | "lockFileMaintenance";
}

const MATCHERS = new Set([
  "matchPackageNames",
  "matchDepNames",
  "matchDepTypes",
  "matchUpdateTypes",
  "matchManagers",
]);

/** Exact names only, with `!name` as a negation; globs and regexes are not supported here. */
function matchesList(list: string[] | undefined, value: string): boolean {
  if (list === undefined) return true;
  for (const item of list) {
    if (/[*?/{}]/.test(item.replace(/^!/, "").replace(/^@[^/]+\//, ""))) {
      throw new Error(`unsupported pattern ${JSON.stringify(item)}: extend this test first`);
    }
  }
  const positives = list.filter((item) => !item.startsWith("!"));
  const negatives = list.filter((item) => item.startsWith("!")).map((item) => item.slice(1));
  return (positives.length === 0 || positives.includes(value)) && !negatives.includes(value);
}

function ruleMatches(rule: PackageRule, update: Update): boolean {
  for (const key of Object.keys(rule)) {
    if (key.startsWith("match") && !MATCHERS.has(key)) {
      throw new Error(`unsupported matcher ${key}: extend this test first`);
    }
  }
  return (
    matchesList(rule.matchPackageNames, update.packageName ?? update.depName) &&
    matchesList(rule.matchDepNames, update.depName) &&
    matchesList(rule.matchDepTypes, update.depType) &&
    matchesList(rule.matchUpdateTypes, update.updateType) &&
    matchesList(rule.matchManagers, update.manager)
  );
}

/** Whether Renovate would automerge this update. Vulnerability settings apply last. */
function automerges(config: RenovateConfig, update: Update, vulnerability = false): boolean {
  let automerge = config.automerge ?? false;
  for (const rule of config.packageRules ?? []) {
    if (ruleMatches(rule, update) && rule.automerge !== undefined) automerge = rule.automerge;
  }
  if (vulnerability && config.vulnerabilityAlerts?.automerge !== undefined) {
    automerge = config.vulnerabilityAlerts.automerge;
  }
  return automerge;
}

/**
 * Whether Renovate would automerge the lockfile-maintenance PR: the global setting, then
 * `lockFileMaintenance`, then every package rule that matches an update of type
 * `lockFileMaintenance`, which has no dependency name or type.
 */
function lockFileMaintenanceAutomerges(config: RenovateConfig): boolean {
  let automerge = config.automerge ?? false;
  if (config.lockFileMaintenance?.automerge !== undefined) {
    automerge = config.lockFileMaintenance.automerge;
  }
  const update: Update = {
    manager: "bun",
    depName: "",
    depType: "",
    updateType: "lockFileMaintenance",
  };
  for (const rule of config.packageRules ?? []) {
    if (ruleMatches(rule, update) && rule.automerge !== undefined) automerge = rule.automerge;
  }
  return automerge;
}

const UPDATE_TYPES = ["major", "minor", "patch"] as const;

/** Every reason the config would automerge `backlog.md`, for each update type. */
function backlogAutomerges(config: RenovateConfig): string[] {
  return UPDATE_TYPES.filter((updateType) =>
    automerges(config, {
      manager: "bun",
      depName: "backlog.md",
      depType: "devDependencies",
      updateType,
    }),
  );
}

const config = (await Bun.file(CONFIG_PATH).json()) as RenovateConfig;

describe("renovate.json settings (AC #1)", () => {
  it("extends the presets 0016 rule 10 names", () => {
    expect(config.extends).toEqual(
      expect.arrayContaining([
        "config:recommended",
        "helpers:pinGitHubActionDigests",
        ":semanticCommits",
        "schedule:weekly",
      ]),
    );
  });

  it("waits three days, raises vulnerability PRs and maintains the lockfile monthly", () => {
    expect(config.minimumReleaseAge).toBe("3 days");
    expect(config.vulnerabilityAlerts?.enabled).toBe(true);
    expect(config.osvVulnerabilityAlerts).toBe(true);
    expect(config.lockFileMaintenance?.enabled).toBe(true);
    // Hours 0-3 on the first day of every month.
    expect(config.lockFileMaintenance?.schedule).toEqual(["* 0-3 1 * *"]);
  });

  it("defines the three groups", () => {
    const groups = (config.packageRules ?? []).flatMap((rule) =>
      typeof rule["groupName"] === "string" ? [rule] : [],
    );
    expect(groups.map((rule) => rule["groupName"]).toSorted()).toEqual([
      "Bun",
      "GitHub Actions",
      "TypeScript tooling",
    ]);
    const group = (update: Update) =>
      groups.filter((rule) => ruleMatches(rule, update)).map((rule) => rule["groupName"]);
    for (const depName of ["oxlint", "oxfmt", "typescript"]) {
      expect(
        group({
          manager: "bun",
          depName,
          depType: "devDependencies",
          updateType: "minor",
        }),
      ).toEqual(["TypeScript tooling"]);
    }
    expect(
      group({ manager: "bun-version", depName: "bun", depType: "", updateType: "patch" }),
    ).toEqual(["Bun"]);
    expect(
      group({
        manager: "bun",
        depName: "@types/bun",
        depType: "devDependencies",
        updateType: "patch",
      }),
    ).toEqual(["Bun"]);
    expect(
      group({
        manager: "github-actions",
        depName: "actions/checkout",
        depType: "action",
        updateType: "digest",
      }),
    ).toEqual(["GitHub Actions"]);
  });
});

describe("renovate.json automerge (AC #2)", () => {
  it("is off globally and for vulnerability PRs", () => {
    expect(config.automerge).toBe(false);
    expect(config.vulnerabilityAlerts?.automerge).toBe(false);
  });

  it("is on for devDependency minor and patch updates", () => {
    for (const updateType of ["minor", "patch"] as const) {
      expect(
        automerges(config, {
          manager: "bun",
          depName: "oxlint",
          depType: "devDependencies",
          updateType,
        }),
      ).toBe(true);
    }
  });

  const never: Array<[string, Update]> = [
    [
      "a devDependency major",
      { manager: "bun", depName: "oxlint", depType: "devDependencies", updateType: "major" },
    ],
    [
      "the Bun version",
      { manager: "bun-version", depName: "bun", depType: "", updateType: "patch" },
    ],
    ["engines.bun", { manager: "bun", depName: "bun", depType: "engines", updateType: "minor" }],
    [
      "@types/bun",
      { manager: "bun", depName: "@types/bun", depType: "devDependencies", updateType: "patch" },
    ],
    [
      "an action digest",
      {
        manager: "github-actions",
        depName: "actions/checkout",
        depType: "action",
        updateType: "digest",
      },
    ],
    [
      "an action minor",
      {
        manager: "github-actions",
        depName: "actions/checkout",
        depType: "action",
        updateType: "minor",
      },
    ],
    [
      "a runtime dependency patch",
      { manager: "bun", depName: "zod", depType: "dependencies", updateType: "patch" },
    ],
    [
      "a runtime dependency minor",
      { manager: "bun", depName: "ink", depType: "dependencies", updateType: "minor" },
    ],
    [
      "backlog.md patch",
      { manager: "bun", depName: "backlog.md", depType: "devDependencies", updateType: "patch" },
    ],
  ];

  for (const [name, update] of never) {
    it(`is off for ${name}`, () => {
      expect(automerges(config, update)).toBe(false);
    });
  }

  it("is off for a vulnerability fix, even a devDependency patch", () => {
    const update: Update = {
      manager: "bun",
      depName: "oxlint",
      depType: "devDependencies",
      updateType: "patch",
    };
    expect(automerges(config, update, true)).toBe(false);
  });
});

describe("lockfile maintenance (DIPO-321)", () => {
  it("is off, set explicitly on lockFileMaintenance", () => {
    expect(config.lockFileMaintenance?.automerge).toBe(false);
    expect(lockFileMaintenanceAutomerges(config)).toBe(false);
  });

  it("fails when any setting or rule enables automerge for it", () => {
    const rules = config.packageRules ?? [];
    const lockFileMaintenance = config.lockFileMaintenance ?? {};
    const broken: RenovateConfig[] = [
      { ...config, lockFileMaintenance: { ...lockFileMaintenance, automerge: true } },
      {
        ...config,
        packageRules: [...rules, { matchUpdateTypes: ["lockFileMaintenance"], automerge: true }],
      },
      { ...config, packageRules: [...rules, { matchManagers: ["bun"], automerge: true }] },
      { ...config, packageRules: [...rules, { automerge: true }] },
    ];
    for (const candidate of broken) {
      expect(lockFileMaintenanceAutomerges(candidate)).toBe(true);
    }
  });

  it("is not enabled by rules that match only named dependencies", () => {
    // The one automerge rule matches devDependencies, which a lockfile-maintenance PR has none of.
    const candidate: RenovateConfig = {
      ...config,
      lockFileMaintenance: { ...config.lockFileMaintenance },
    };
    delete candidate.lockFileMaintenance?.automerge;
    expect(lockFileMaintenanceAutomerges(candidate)).toBe(false);
  });
});

describe("backlog.md (0016 amendment of 2026-10-12)", () => {
  it("never automerges and stays on 1.53.x", () => {
    expect(backlogAutomerges(config)).toEqual([]);
    const rule = (config.packageRules ?? []).find((r) =>
      r.matchPackageNames?.includes("backlog.md"),
    );
    expect(rule?.["allowedVersions"]).toBe("1.53.x");
  });

  it("fails when any rule enables automerge for backlog.md", () => {
    const rules = config.packageRules ?? [];
    const broken: RenovateConfig[] = [
      {
        ...config,
        packageRules: [...rules, { matchPackageNames: ["backlog.md"], automerge: true }],
      },
      { ...config, packageRules: [...rules, { matchDepNames: ["backlog.md"], automerge: true }] },
      { ...config, packageRules: [...rules, { matchUpdateTypes: ["patch"], automerge: true }] },
      { ...config, packageRules: [...rules, { automerge: true }] },
    ];
    for (const candidate of broken) {
      expect(backlogAutomerges(candidate)).not.toEqual([]);
    }
  });

  it("refuses matchers it cannot replay", () => {
    const candidate: RenovateConfig = {
      ...config,
      packageRules: [{ matchPackagePatterns: ["^backlog"], automerge: true }],
    };
    expect(() => backlogAutomerges(candidate)).toThrow("unsupported matcher");
    const glob: RenovateConfig = {
      ...config,
      packageRules: [{ matchPackageNames: ["backlog*"], automerge: true }],
    };
    expect(() => backlogAutomerges(glob)).toThrow("unsupported pattern");
  });
});
