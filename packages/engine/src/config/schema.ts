// The office configuration (0017 section 5). The keys belong to the ADRs named next to them;
// names no ADR sets are fixed by DIPO-26. Every key added later bumps `version` with a migration
// (0017 amendment of 2026-10-12): version 1 stays as it was, and each later version is the one
// before plus its keys.
//
// Version 2 (DIPO-108) adds `worker.plugins` (0008 amendment of 2026-10-12): the plugins a worker
// session may load, in the `<plugin>@<marketplace>` form Claude Code's `enabledPlugins` uses.
// Version 3 (DIPO-133) adds `mergeSlot.requiredChecks` (0016 rule 2): the checks the merge slot
// waits for before it merges a PR of this office.
// Version 4 (DIPO-172) adds `sandbox.toolchainReadPaths` to `office.local.yaml` (0017 amendment
// of 2026-10-18, maintainer decision 2026-10-17, option A): machine-specific toolchain read
// paths, added to the committed list (or the default), each path once. `office.yaml` gains no key.
// Version 5 (DIPO-139) adds the `review` block (the review loop's limits, 0019 section 16) and the
// rest of `mergeSlot`: `autoMerge`, `conflictAttempts`, `ciAttempts`, `holdLabels` and
// `checksWaitMinutes`. `office.local.yaml` gains no key.
// Version 6 (DIPO-188) adds `story.maintainerStepPhrases` (0012 section 3, R27): the phrases of a
// criterion that names a step only the maintainer or the engine can take. `office.local.yaml`
// gains no key.
// Version 7 (DIPO-210) adds `storyPr.open` (0019 amendment of 2026-10-19): whether the engine opens
// and keeps the story PR for this office. `office.local.yaml` gains no key, so the switch is
// committed with the repository.

import { z } from "zod";

/** The newest office configuration version this binary knows. */
export const OFFICE_CONFIG_VERSION = 7;
/** Every version this binary reads; an older file is migrated in memory (`migrateOfficeDocument`). */
export const OFFICE_CONFIG_VERSIONS = [1, 2, 3, 4, 5, 6, 7] as const;
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
const ToolchainReadPaths = z
  .array(ToolchainPath)
  .describe(
    "Toolchain paths the worker may read (0008 section 2, 2026-10-12 amendment); engine steps read them too. .dipo/office.local.yaml may add machine-specific paths to this list (version 4).",
  );

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
    toolchainReadPaths: ToolchainReadPaths,
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
const officeShapeV2 = {
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

// Version 3: version 2 plus `mergeSlot.requiredChecks` (DIPO-133). Names are check names as the
// host reports them, and may contain spaces.
const requiredChecks = z
  .array(text())
  .min(1, "must name at least one check")
  .refine((names) => new Set(names).size === names.length, "must not name a check twice")
  .describe(
    "Checks the merge slot waits for before it merges a PR of this office (0016 rule 2): each must pass, and any failed or cancelled check holds the PR back. Names are the check names the host reports, such as ci-ok and pr-title. A repository whose CI names other checks sets its own names here.",
  );
const officeShapeV3 = {
  ...officeShapeV2,
  mergeSlot: z.strictObject({ requiredChecks }),
};

// Version 4: the office keys of version 3; only `office.local.yaml` gains a key (DIPO-172).
const officeShapeV4 = officeShapeV3;

// Version 5 (DIPO-139): the review limits and the rest of `mergeSlot`. A count is at least 1.
const ReviewV5 = z
  .strictObject({
    model: text(),
    effort: text(),
    maxRounds: count(),
    maxTurns: count(),
    maxMinutes: count(),
    budgetTokens: count(),
  })
  .describe(
    "Limits of the review loop (0019 section 16): the model and effort of the review worker, the rounds of review and fixes before it stops, and the turns, minutes and tokens of one review.",
  );
const MergeSlotV5 = z.strictObject({
  ...officeShapeV3.mergeSlot.shape,
  autoMerge: z
    .boolean()
    .describe("Whether the merge slot merges a PR once its checks pass and it is reviewed."),
  conflictAttempts: count().describe(
    "Attempts to rebase a PR onto a base that moved, before the merge slot gives up on it.",
  ),
  ciAttempts: count().describe(
    "Attempts to fix a PR whose required check failed, before the merge slot gives up on it.",
  ),
  holdLabels: z
    .array(text())
    .refine((labels) => new Set(labels).size === labels.length, "must not name a label twice")
    .describe("Labels that hold a PR back from the merge slot while it carries one."),
  checksWaitMinutes: count().describe(
    "Minutes the merge slot waits for the required checks of a PR to finish before it reports them stuck.",
  ),
});

// Version 5: the office keys of version 4 plus `review` and the rest of `mergeSlot` (DIPO-139).
const officeShapeV5 = {
  ...officeShapeV4,
  review: ReviewV5,
  mergeSlot: MergeSlotV5,
};

// Version 6: the office keys of version 5 plus `story.maintainerStepPhrases` (DIPO-188).
const officeShapeV6 = {
  ...officeShapeV5,
  story: z.strictObject({
    ...officeShapeV1.story.shape,
    maintainerStepPhrases: z
      .array(text())
      .describe(
        "Phrases that name a step only the maintainer or the engine can take, such as writing task notes. A criterion that contains one fails the Ready gate (R27) and moves that step to a manual test plan entry (0012 section 3, DIPO-188).",
      ),
  }),
};

// Version 7: the office keys of version 6 plus `storyPr.open` (DIPO-210).
const officeShape = {
  ...officeShapeV6,
  storyPr: z
    .strictObject({
      open: z
        .boolean()
        .describe(
          "Whether the engine opens the story PR at the first In Review push and keeps it updated (0019 section 3). With false it opens, updates, polls and retries no story PR for this office and raises no pr.openFailed notice; the story stays In Review.",
        ),
    })
    .describe("The story PR of this office (0019 section 3, amendment of 2026-10-19)."),
};

/** The effective configuration of an office, version 1 (kept to read version 1 files). */
export const OfficeConfigV1 = z.strictObject({
  version: z.literal(1),
  ...officeShapeV1,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/** The effective configuration of an office, version 2 (kept to read version 2 files). */
export const OfficeConfigV2 = z.strictObject({
  version: z.literal(2),
  ...officeShapeV2,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/** The effective configuration of an office, version 3 (kept to read version 3 files). */
export const OfficeConfigV3 = z.strictObject({
  version: z.literal(3),
  ...officeShapeV3,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/** The effective configuration of an office, version 4 (kept to read version 4 files). */
export const OfficeConfigV4 = z.strictObject({
  version: z.literal(4),
  ...officeShapeV4,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/** The effective configuration of an office, version 5 (kept to read version 5 files). */
export const OfficeConfigV5 = z.strictObject({
  version: z.literal(5),
  ...officeShapeV5,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/** The effective configuration of an office, version 6 (kept to read version 6 files). */
export const OfficeConfigV6 = z.strictObject({
  version: z.literal(6),
  ...officeShapeV6,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/** The effective configuration of an office: every key set, after defaults and overrides. */
export const OfficeConfigV7 = z.strictObject({
  version: z.literal(OFFICE_CONFIG_VERSION),
  ...officeShape,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});
export type OfficeConfig = z.infer<typeof OfficeConfigV7>;

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
export type OfficeLocalFile = OfficeLocalFileOf<typeof OFFICE_CONFIG_VERSION> &
  DeepPartial<{ sandbox: Pick<OfficeConfig["sandbox"], "toolchainReadPaths"> }>;

const localShapeV1 = {
  timeouts: officeShapeV1.timeouts,
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
};

// Version 4 (DIPO-172): `sandbox.toolchainReadPaths` and no other sandbox key. Its entries are
// added to the list below it instead of replacing it (`resolveOfficeConfig`).
const localShape = {
  ...localShapeV1,
  sandbox: z
    .strictObject({ toolchainReadPaths: ToolchainReadPaths })
    .describe(
      "Only toolchainReadPaths: machine-specific paths added to the committed list (or the default), each path once (0017 amendment of 2026-10-18).",
    ),
};

/** `.dipo/office.yaml`, version 1. `privacy` and `retention` are not accepted here. */
export const OfficeFileV1 = z.strictObject({
  version: z.literal(1),
  ...fileShape(officeShapeV1),
}) as unknown as z.ZodType<OfficeFileOf<1>>;

/** `.dipo/office.yaml`, version 2: version 1 plus `worker.plugins`. */
export const OfficeFileV2 = z.strictObject({
  version: z.literal(2),
  ...fileShape(officeShapeV2),
}) as unknown as z.ZodType<OfficeFileOf<2>>;

/** `.dipo/office.yaml`, version 3: version 2 plus `mergeSlot.requiredChecks`. */
export const OfficeFileV3 = z.strictObject({
  version: z.literal(3),
  ...fileShape(officeShapeV3),
}) as unknown as z.ZodType<OfficeFileOf<3>>;

/**
 * `.dipo/office.yaml`, version 4: the same keys as version 3. The office files share one version
 * number, and version 4 adds a key to `office.local.yaml` only.
 */
export const OfficeFileV4 = z.strictObject({
  version: z.literal(4),
  ...fileShape(officeShapeV4),
}) as unknown as z.ZodType<OfficeFileOf<4>>;

/** `.dipo/office.yaml`, version 5: version 4 plus `review` and the rest of `mergeSlot` (DIPO-139). */
export const OfficeFileV5 = z.strictObject({
  version: z.literal(5),
  ...fileShape(officeShapeV5),
}) as unknown as z.ZodType<OfficeFileOf<5>>;

/** `.dipo/office.yaml`, version 6: version 5 plus `story.maintainerStepPhrases` (DIPO-188). */
export const OfficeFileV6 = z.strictObject({
  version: z.literal(6),
  ...fileShape(officeShapeV6),
}) as unknown as z.ZodType<OfficeFileOf<6>>;

/** `.dipo/office.yaml`, version 7: version 6 plus `storyPr.open` (DIPO-210). */
export const OfficeFileV7 = z.strictObject({
  version: z.literal(OFFICE_CONFIG_VERSION),
  ...fileShape(officeShape),
}) as unknown as z.ZodType<OfficeFile>;

/** `.dipo/office.local.yaml`, version 1: only `timeouts`, `privacy` and `retention`. */
export const OfficeLocalFileV1 = z.strictObject({
  version: z.literal(1),
  ...fileShape(localShapeV1),
}) as unknown as z.ZodType<OfficeLocalFileOf<1>>;

/**
 * `.dipo/office.local.yaml`, version 2: the same keys as version 1. The office files share one
 * version number, so a local file may say 2 as soon as `office.yaml` does.
 */
export const OfficeLocalFileV2 = z.strictObject({
  version: z.literal(2),
  ...fileShape(localShapeV1),
}) as unknown as z.ZodType<OfficeLocalFileOf<2>>;

/**
 * `.dipo/office.local.yaml`, version 3: the same keys as version 1. The office files share one
 * version number, so a local file may say 3 as soon as `office.yaml` does.
 */
export const OfficeLocalFileV3 = z.strictObject({
  version: z.literal(3),
  ...fileShape(localShapeV1),
}) as unknown as z.ZodType<OfficeLocalFileOf<3>>;

/**
 * `.dipo/office.local.yaml`, version 4: version 3 plus `sandbox.toolchainReadPaths` (DIPO-172),
 * whose entries add to the committed list. Any other sandbox key stays an error.
 */
export const OfficeLocalFileV4 = z.strictObject({
  version: z.literal(4),
  ...fileShape(localShape),
}) as unknown as z.ZodType<OfficeLocalFileOf<4>>;

/** `.dipo/office.local.yaml`, version 5: the same keys as version 4 (DIPO-139 adds none here). */
export const OfficeLocalFileV5 = z.strictObject({
  version: z.literal(5),
  ...fileShape(localShape),
}) as unknown as z.ZodType<OfficeLocalFileOf<5>>;

/** `.dipo/office.local.yaml`, version 6: the same keys as version 5 (DIPO-188 adds none here). */
export const OfficeLocalFileV6 = z.strictObject({
  version: z.literal(6),
  ...fileShape(localShape),
}) as unknown as z.ZodType<OfficeLocalFileOf<6>>;

/**
 * `.dipo/office.local.yaml`, version 7: the same keys as version 6. DIPO-210 adds none here, so
 * `storyPr.open` is committed with the repository.
 */
export const OfficeLocalFileV7 = z.strictObject({
  version: z.literal(OFFICE_CONFIG_VERSION),
  ...fileShape(localShape),
}) as unknown as z.ZodType<OfficeLocalFile>;

/** Overrides from flags on a single command, version 1 keys. */
export const OfficeOverridesV1 = z.strictObject(
  fileShape(officeShapeV1),
) as unknown as z.ZodType<OfficeOverrides>;

/** Overrides from flags on a single command, version 2 keys. */
export const OfficeOverridesV2 = z.strictObject(
  fileShape(officeShapeV2),
) as unknown as z.ZodType<OfficeOverrides>;

/** Overrides from flags on a single command, version 3 keys. */
export const OfficeOverridesV3 = z.strictObject(
  fileShape(officeShapeV3),
) as unknown as z.ZodType<OfficeOverrides>;

/** Overrides from flags on a single command, version 4 keys. */
export const OfficeOverridesV4 = z.strictObject(
  fileShape(officeShapeV4),
) as unknown as z.ZodType<OfficeOverrides>;

/** Overrides from flags on a single command, version 5 keys. */
export const OfficeOverridesV5 = z.strictObject(
  fileShape(officeShapeV5),
) as unknown as z.ZodType<OfficeOverrides>;

/** Overrides from flags on a single command, version 6 keys. */
export const OfficeOverridesV6 = z.strictObject(
  fileShape(officeShapeV6),
) as unknown as z.ZodType<OfficeOverrides>;

/** Overrides from flags on a single command: any `office.yaml` key except `version`. */
export const OfficeOverridesV7 = z.strictObject(
  fileShape(officeShape),
) as unknown as z.ZodType<OfficeOverrides>;

/** The file schemas of each version, for `resolveOfficeConfig`. */
export const OFFICE_FILE_SCHEMAS: Readonly<Record<OfficeConfigVersion, z.ZodType>> = {
  1: OfficeFileV1,
  2: OfficeFileV2,
  3: OfficeFileV3,
  4: OfficeFileV4,
  5: OfficeFileV5,
  6: OfficeFileV6,
  7: OfficeFileV7,
};
export const OFFICE_LOCAL_FILE_SCHEMAS: Readonly<Record<OfficeConfigVersion, z.ZodType>> = {
  1: OfficeLocalFileV1,
  2: OfficeLocalFileV2,
  3: OfficeLocalFileV3,
  4: OfficeLocalFileV4,
  5: OfficeLocalFileV5,
  6: OfficeLocalFileV6,
  7: OfficeLocalFileV7,
};

/**
 * Pure: an office file's document of `version` migrated in memory to the newest version, one
 * step at a time (0017 section 5, "Versioning and migration"). Version 1 to 2 is the identity
 * (0017 amendment of 2026-10-12): `worker.plugins` is new and takes its default. Version 2 to 3
 * is the identity too: `mergeSlot.requiredChecks` is new and takes its default. Version 3 to 4
 * is the identity: `sandbox.toolchainReadPaths` in `office.local.yaml` is new and adds nothing
 * when absent. Version 4 to 5 is the identity too: `review` and the new `mergeSlot` keys take
 * their defaults. Version 5 to 6 is the identity: `story.maintainerStepPhrases` takes its
 * default. Version 6 to 7 is the identity too: `storyPr.open` takes its default, true (DIPO-210).
 * Works for both office files; the document must already be valid for its own version.
 */
export function migrateOfficeDocument(
  version: OfficeConfigVersion,
  document: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  let current: Record<string, unknown> = { ...document, version };
  if (current.version === 1) current = { ...current, version: 2 };
  if (current.version === 2) current = { ...current, version: 3 };
  if (current.version === 3) current = { ...current, version: 4 };
  if (current.version === 4) current = { ...current, version: 5 };
  if (current.version === 5) current = { ...current, version: 6 };
  if (current.version === 6) current = { ...current, version: 7 };
  return current;
}

/** Keys that live only in `.dipo/office.local.yaml`. */
export const LOCAL_ONLY_KEYS = ["privacy", "retention"] as const;
/** Top-level keys `.dipo/office.local.yaml` accepts besides `version`, in the newest version. */
export const LOCAL_ALLOWED_KEYS = ["timeouts", "privacy", "retention", "sandbox"] as const;
/**
 * What `.dipo/office.local.yaml` accepts besides `version`, as key paths, in the newest version:
 * `sandbox` only with `toolchainReadPaths` (version 4, DIPO-172).
 */
export const LOCAL_ALLOWED_KEY_PATHS = [
  "timeouts.*",
  "privacy.*",
  "retention.*",
  "sandbox.toolchainReadPaths",
] as const;

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
  // 0016 rule 2: the checks every backlog PR waits for in the merge slot (DIPO-133). The rest of
  // the merge slot block and the review limits are DIPO-139's defaults (ADR 0019 section 16).
  mergeSlot: {
    requiredChecks: ["ci-ok", "pr-title"],
    autoMerge: true,
    conflictAttempts: 2,
    ciAttempts: 2,
    holdLabels: [],
    checksWaitMinutes: 30,
  },
  // 0019 section 3: the story PR opens at the first In Review push unless the office switches it
  // off (amendment of 2026-10-19, DIPO-210).
  storyPr: { open: true },
  review: {
    model: "opus",
    effort: "high",
    maxRounds: 3,
    maxTurns: 60,
    maxMinutes: 30,
    budgetTokens: 200_000,
  },
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
    // 0012 section 3 (R27, DIPO-188): steps the worker cannot take; they go to a manual test plan.
    maintainerStepPhrases: [
      "task notes",
      "implementation notes",
      "by the maintainer",
      "backlog task edit",
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
  // 0007 sections 7 and 8; commands and prompts are stored by default (DIPO-135 and DIPO-137,
  // maintainer decision of 2026-10-16), and raw events stay off.
  privacy: { storePrompts: true, storeCommandBodies: true, keepRawEvents: false },
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
