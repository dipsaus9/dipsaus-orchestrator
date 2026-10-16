// The office configuration (0017 section 5). The keys belong to the ADRs named next to them;
// names no ADR sets are fixed by DIPO-26. Every key added later bumps `version` with a migration
// (0017 amendment of 2026-10-12): version 1 stays as it was, and each later version is the one
// before plus its keys.
//
// Version 2 (DIPO-108) adds `worker.plugins` (0008 amendment of 2026-10-12): the plugins a worker
// session may load, in the `<plugin>@<marketplace>` form Claude Code's `enabledPlugins` uses.

import { z } from "zod";

/** The newest office configuration version this binary knows. */
export const OFFICE_CONFIG_VERSION = 2;
/** Every version this binary reads; an older file is migrated in memory (`migrateOfficeDocument`). */
export const OFFICE_CONFIG_VERSIONS = [1, 2] as const;
export type OfficeConfigVersion = (typeof OFFICE_CONFIG_VERSIONS)[number];

const count = () => z.int().positive();
const text = () => z.string().min(1);

// 0008 section 9: what a tier maps to. Budgets are tokens; effort is passed to the adapter as is.
const TierCaps = z.strictObject({
  model: text(),
  effort: text(),
  budgetTokens: count(),
  maxTurns: count(),
  maxMinutes: count(),
  loops: count(),
});

// 0014 section 4: S, M, L and XL are project size classes counted from `git ls-files` at pickup
// (S under 150 files, M under 500, L under 5,000, XL above). They are not story tiers.
const SIZE_CLASSES =
  "Keys S, M, L and XL are 0014 project size classes from `git ls-files` (S under 150 files, M under 500, L under 5,000, XL above), not story tiers.";
const BySize = z
  .strictObject({ S: count(), M: count(), L: count(), XL: count() })
  .describe(SIZE_CLASSES);

// 0014 section 4, one entry per table row and per-item cap, in characters unless the name says
// otherwise. `taskMessage` is the total cap of the L4 task message.
const PromptBudgets = z
  .strictObject({
    context: BySize,
    contextItem: BySize,
    inputs: BySize,
    inputsFile: BySize,
    dependencies: BySize,
    background: BySize,
    handoff: BySize,
    feedbackItem: BySize,
    feedbackTotal: BySize,
    feedbackLogLines: BySize,
    diff: BySize,
    nudge: BySize,
    taskMessage: BySize,
  })
  .describe(
    `Prompt section budgets per project size class (0014 section 4), in characters unless the name says lines. ${SIZE_CLASSES}`,
  );

// 0008 section 2: a toolchain read path or install cache is absolute or starts at the home
// directory (`~/`). The sandbox stories (DIPO-37, DIPO-40) expand `~` against the injected home.
const ToolchainPath = text().regex(/^(?:~\/|\/)/, "must start with ~/ or /");

// 0010 section 8.
const WorktreeFile = z.strictObject({
  path: text(),
  mode: z.enum(["copy", "link"]).default("copy"),
  required: z.boolean().default(false),
});

const timeoutsShape = {
  // 0009 consequences and 0008 section 5.
  workerStallMinutes: count(),
  workerQuietMinutes: count(),
  questionWaitMinutes: count(),
  permissionWaitSeconds: count(),
  // 0013 section 1: one timeout per script the engine runs, by script name.
  scriptMinutes: z.record(text(), count()),
};

const privacyShape = {
  storePrompts: z.boolean(),
  storeCommandBodies: z.boolean(),
  keepRawEvents: z.boolean(),
};

const retentionShape = {
  shortDays: count(),
  stateDays: count(),
};

const workerShapeV1 = {
  adapter: text(),
  allowProjectSettings: z.array(text()),
};

// 0008 amendment of 2026-10-12: a plugin id as `enabledPlugins` names it, `<plugin>@<marketplace>`.
const PluginId = text().regex(
  /^[^@\s]+@[^@\s]+$/,
  "must be <plugin>@<marketplace>, as enabledPlugins names it",
);

const officeShapeV1 = {
  tiers: z.strictObject({ S: TierCaps, M: TierCaps, L: TierCaps }),
  worker: z.strictObject(workerShapeV1),
  permissions: z.strictObject({
    ask: z.enum(["when-present", "never"]),
    presentMinutes: count(),
  }),
  timeouts: z.strictObject(timeoutsShape),
  base: text().optional(),
  remote: text(),
  worktree: z.strictObject({
    root: text(),
    files: z.array(WorktreeFile),
    ports: z.strictObject({
      stride: count(),
      named: z.record(text(), z.int().min(1).max(65535)),
    }),
    env: z.record(text(), z.string()),
    post_create: z.array(z.array(text()).min(1)),
    maxSlots: count(),
  }),
  scripts: z.record(text(), text()),
  story: z.strictObject({
    types: z.array(text()).min(1),
    tiers: z.array(z.enum(["S", "M", "L"])).min(1),
    bannedPhrases: z.array(text()),
    titleMax: count(),
    outcomeMin: count(),
    criterionMin: count(),
    slugMax: count(),
  }),
  prompt: z.strictObject({
    budgets: PromptBudgets,
    contractMax: count(),
  }),
  sandbox: z.strictObject({
    toolchainReadPaths: z
      .array(ToolchainPath)
      .describe(
        "Toolchain paths the worker may read (0008 section 2, 2026-10-12 amendment); engine steps read them too.",
      ),
    installCachePaths: z
      .array(ToolchainPath)
      .describe(
        "Package caches an install step may write (0008 section 2, 2026-10-12 amendment). A cache that holds a PATH directory or the dipo or bun binary refuses the step.",
      ),
    registryHosts: z.array(text()),
    allowRead: z.array(text()),
    allowedDomains: z.array(text()),
    allowLocalBinding: z.boolean(),
  }),
  polling: z.strictObject({
    prStateSeconds: count(),
    fetchSeconds: count(),
  }),
};

// Version 2: version 1 plus `worker.plugins`.
const officeShape = {
  ...officeShapeV1,
  worker: z.strictObject({
    ...workerShapeV1,
    plugins: z
      .array(PluginId)
      .describe(
        "Plugins a worker session may load, as <plugin>@<marketplace> (0008 amendment of 2026-10-12). Every other installed plugin is switched off in the run settings, and a session whose system/init lists one refuses to start. A listed plugin brings its hooks, which run outside the sandbox, so listing one is reviewed like code.",
      ),
  }),
};

/** The effective configuration of an office, version 1 (kept to read version 1 files). */
export const OfficeConfigV1 = z.strictObject({
  version: z.literal(1),
  ...officeShapeV1,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/** The effective configuration of an office: every key set, after defaults and overrides. */
export const OfficeConfigV2 = z.strictObject({
  version: z.literal(OFFICE_CONFIG_VERSION),
  ...officeShape,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});
export type OfficeConfig = z.infer<typeof OfficeConfigV2>;

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

// The file form of a schema: every object key optional, recursively, still strict. Records and
// lists are values that replace, so their insides keep their full schemas.
function fileForm(schema: z.ZodType): z.ZodType {
  const def = schema.def;
  if (def.type === "optional") return fileForm((schema as z.ZodOptional).unwrap() as z.ZodType);
  if (def.type === "object") {
    const shape = (schema as z.ZodObject).shape as Record<string, z.ZodType>;
    const partial: Record<string, z.ZodType> = {};
    for (const [key, value] of Object.entries(shape)) partial[key] = fileForm(value).optional();
    const form = z.strictObject(partial);
    return schema.description === undefined ? form : form.describe(schema.description);
  }
  return schema;
}

function fileShape(shape: Record<string, z.ZodType>): Record<string, z.ZodType> {
  const result: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(shape)) result[key] = fileForm(value).optional();
  return result;
}

export type OfficeOverrides = DeepPartial<Omit<OfficeConfig, "version" | "privacy" | "retention">>;
export type OfficeFileOf<V extends OfficeConfigVersion> = OfficeOverrides & { version: V };
export type OfficeFile = OfficeFileOf<typeof OFFICE_CONFIG_VERSION>;
export type OfficeLocalFileOf<V extends OfficeConfigVersion> = DeepPartial<
  Pick<OfficeConfig, "timeouts" | "privacy" | "retention">
> & {
  version: V;
};
export type OfficeLocalFile = OfficeLocalFileOf<typeof OFFICE_CONFIG_VERSION>;

const localShape = {
  timeouts: officeShapeV1.timeouts,
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
};

/** `.dipo/office.yaml`, version 1. `privacy` and `retention` are not accepted here. */
export const OfficeFileV1 = z.strictObject({
  version: z.literal(1),
  ...fileShape(officeShapeV1),
}) as unknown as z.ZodType<OfficeFileOf<1>>;

/** `.dipo/office.yaml`, version 2: version 1 plus `worker.plugins`. */
export const OfficeFileV2 = z.strictObject({
  version: z.literal(OFFICE_CONFIG_VERSION),
  ...fileShape(officeShape),
}) as unknown as z.ZodType<OfficeFile>;

/** `.dipo/office.local.yaml`, version 1: only `timeouts`, `privacy` and `retention`. */
export const OfficeLocalFileV1 = z.strictObject({
  version: z.literal(1),
  ...fileShape(localShape),
}) as unknown as z.ZodType<OfficeLocalFileOf<1>>;

/**
 * `.dipo/office.local.yaml`, version 2: the same keys as version 1. The office files share one
 * version number, so a local file may say 2 as soon as `office.yaml` does.
 */
export const OfficeLocalFileV2 = z.strictObject({
  version: z.literal(OFFICE_CONFIG_VERSION),
  ...fileShape(localShape),
}) as unknown as z.ZodType<OfficeLocalFile>;

/** Overrides from flags on a single command, version 1 keys. */
export const OfficeOverridesV1 = z.strictObject(
  fileShape(officeShapeV1),
) as unknown as z.ZodType<OfficeOverrides>;

/** Overrides from flags on a single command: any `office.yaml` key except `version`. */
export const OfficeOverridesV2 = z.strictObject(
  fileShape(officeShape),
) as unknown as z.ZodType<OfficeOverrides>;

/** The file schemas of each version, for `resolveOfficeConfig`. */
export const OFFICE_FILE_SCHEMAS: Readonly<Record<OfficeConfigVersion, z.ZodType>> = {
  1: OfficeFileV1,
  2: OfficeFileV2,
};
export const OFFICE_LOCAL_FILE_SCHEMAS: Readonly<Record<OfficeConfigVersion, z.ZodType>> = {
  1: OfficeLocalFileV1,
  2: OfficeLocalFileV2,
};

/**
 * Pure: an office file's document of `version` migrated in memory to the newest version, one
 * step at a time (0017 section 5, "Versioning and migration"). Version 1 to 2 is the identity
 * (0017 amendment of 2026-10-12): `worker.plugins` is new and takes its default. Works for both
 * office files; the document must already be valid for its own version.
 */
export function migrateOfficeDocument(
  version: OfficeConfigVersion,
  document: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  let current: Record<string, unknown> = { ...document, version };
  if (current.version === 1) current = { ...current, version: 2 };
  return current;
}

/** Keys that live only in `.dipo/office.local.yaml`. */
export const LOCAL_ONLY_KEYS = ["privacy", "retention"] as const;
/** Top-level keys `.dipo/office.local.yaml` accepts besides `version`. */
export const LOCAL_ALLOWED_KEYS = ["timeouts", "privacy", "retention"] as const;

const bySize = (S: number, M: number, L: number, XL: number) => ({ S, M, L, XL });
const sameSize = (value: number) => bySize(value, value, value, value);

/** Built-in defaults, the lowest layer (0017 section 5). */
export const OFFICE_DEFAULTS: OfficeConfig = {
  version: OFFICE_CONFIG_VERSION,
  // 0008 section 9.
  tiers: {
    S: {
      model: "haiku",
      effort: "low",
      budgetTokens: 300_000,
      maxTurns: 60,
      maxMinutes: 30,
      loops: 3,
    },
    M: {
      model: "sonnet",
      effort: "medium",
      budgetTokens: 800_000,
      maxTurns: 120,
      maxMinutes: 60,
      loops: 5,
    },
    L: {
      model: "opus",
      effort: "high",
      budgetTokens: 2_000_000,
      maxTurns: 200,
      maxMinutes: 120,
      loops: 8,
    },
  },
  // 0008 sections 2 and 5; `plugins` empty: no plugin in a worker session (0008 amendment of
  // 2026-10-12).
  worker: { adapter: "claude-cli", allowProjectSettings: [], plugins: [] },
  permissions: { ask: "when-present", presentMinutes: 10 },
  // 0008, 0009 and 0013 section 1.
  timeouts: {
    workerStallMinutes: 20,
    workerQuietMinutes: 3,
    questionWaitMinutes: 15,
    permissionWaitSeconds: 300,
    scriptMinutes: { install: 15, setup: 10, post_create: 10, verify: 20 },
  },
  // 0010 sections 7 to 9. `base` has no default: `origin/HEAD` decides when it is absent.
  remote: "origin",
  worktree: {
    root: "../{repo}.worktrees",
    files: [],
    ports: { stride: 10, named: {} },
    env: {},
    post_create: [],
    maxSlots: 20,
  },
  // 0013: no overrides; the run profile from the scan decides.
  scripts: {},
  // 0012 section 3 (F5, F11, R04, R05, R09, R10, R18).
  story: {
    types: ["feature", "bug", "enhancement", "task", "chore", "docs", "spike"],
    tiers: ["S", "M", "L"],
    bannedPhrases: [
      "works well",
      "looks good",
      "properly",
      "as expected",
      "etc",
      "and so on",
      "if possible",
      "should be fine",
    ],
    titleMax: 100,
    outcomeMin: 20,
    criterionMin: 10,
    slugMax: 40,
  },
  // 0014 section 4.
  prompt: {
    budgets: {
      context: bySize(12_000, 18_000, 24_000, 32_000),
      contextItem: sameSize(4_000),
      inputs: bySize(8_000, 12_000, 16_000, 20_000),
      inputsFile: sameSize(4_000),
      dependencies: bySize(1_500, 1_500, 2_000, 2_000),
      background: bySize(2_000, 2_000, 3_000, 3_000),
      handoff: sameSize(6_000),
      feedbackItem: sameSize(3_000),
      feedbackTotal: sameSize(8_000),
      feedbackLogLines: sameSize(60),
      diff: bySize(40_000, 60_000, 80_000, 80_000),
      nudge: sameSize(300),
      taskMessage: bySize(40_000, 50_000, 60_000, 70_000),
    },
    contractMax: 12_000,
  },
  // 0008 section 2 and its 2026-10-12 amendment. `~` is the maintainer's home directory. The read
  // list keeps `bun` and `npm` runnable for the worker. The install caches are the package
  // caches only: an install step writes them, so no default may hold a PATH directory or the bun
  // and dipo binaries (`~/.bun/bin`), and `~/.cache` is not written by default.
  sandbox: {
    toolchainReadPaths: ["~/.bun", "~/.npm", "~/.cache"],
    installCachePaths: ["~/.bun/install/cache", "~/.npm/_cacache"],
    registryHosts: [],
    allowRead: [],
    allowedDomains: [],
    allowLocalBinding: false,
  },
  // M0 review (DIPO-15).
  polling: { prStateSeconds: 60, fetchSeconds: 300 },
  // 0007 sections 7 and 8.
  privacy: { storePrompts: false, storeCommandBodies: false, keepRawEvents: false },
  retention: { shortDays: 7, stateDays: 365 },
};

/**
 * The privacy opt-ins that are on, as their full keys (`privacy.storeCommandBodies`), in schema
 * order: what the overview shows (0007 section 8, DIPO-83). Empty without a configuration.
 */
export function privacyOptIns(config: Pick<OfficeConfig, "privacy"> | undefined): string[] {
  if (config === undefined) return [];
  return Object.keys(privacyShape)
    .filter((key) => config.privacy[key as keyof typeof privacyShape])
    .map((key) => `privacy.${key}`);
}
