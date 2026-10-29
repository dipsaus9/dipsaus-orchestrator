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
// Version 8 (DIPO-164) adds `worker.web` (0020 section 11b): whether the developer role gets the
// web search and fetch tools. `office.local.yaml` gains no key.
// Version 9 (DIPO-266) adds the `box` block (0021 section 5 and decision 9): the image of the
// office's boxes (a Debian slim release, the toolchain versions, extra system packages and the
// pinned Claude Code version) and the files outside git a box may get, each marked as holding no
// real secrets. Every key is optional: what the block leaves out is detected from the repository
// (`box/image.ts`). dipo reads the block from the base branch only, so a story cannot change it.
// `office.local.yaml` gains no key.
// Version 10 (DIPO-285) retires `permissions.presentMinutes`: nothing reads it since DIPO-279
// replaced the presence window with a check for a connected TUI (0021 section 11). An older file
// that still sets it loads; the migration drops the key and the load warns (`RETIRED_KEYS`).
// `office.local.yaml` gains no key.
// Version 11 (DIPO-251, from DIPO-260) adds `story.securityPhrases` and
// `story.securityCriteriaPhrases` (0012 section 3, R30): the phrases of a title or Outcome that
// names a security barrier, and per part the phrases a criterion uses for what the old barrier
// caught, the bypass forms and the fail-closed test against the real path. `office.local.yaml`
// gains no key.
// Version 12 (DIPO-282) adds `box.localPorts` (0021 section 3 and decision 10): the local ports of
// the Mac a box may reach, only through dipo's web proxy and only on the Mac's loopback. dipo reads
// it from the base branch with the rest of the `box` block, so a story cannot change it.
// `office.local.yaml` gains no key.
// Version 13 (DIPO-310) adds the `scan` block (0013 amendment of 2026-10-22): the model, effort,
// token budget and minutes of the fallback session that proposes the run profile capabilities code
// could not resolve. The session has one turn plus one schema retry, fixed in code.
// `office.local.yaml` gains no key.

import { z } from "zod";

/** The newest office configuration version this binary knows. */
export const OFFICE_CONFIG_VERSION = 13;
/** Every version this binary reads; an older file is migrated in memory (`migrateOfficeDocument`). */
export const OFFICE_CONFIG_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] as const;
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
  // Read by nothing since the permission relay went (DIPO-240); kept so existing office files
  // stay valid, and dropped in a later config version.
  permissionWaitSeconds: count(),
  // 0013 section 1: one timeout per script the engine runs, by script name.
  scriptMinutes: z.record(text(), count()),
  // DIPO-309 (0002): how long an open test waits for its record before its box is deleted. Added
  // with a default and no version bump (0017).
  testIdleMinutes: count(),
};

const privacyShape = {
  storePrompts: z.boolean(),
  storeCommandBodies: z.boolean(),
  keepRawEvents: z.boolean(),
};

/** The keys under `privacy` (`storePrompts`, `storeCommandBodies`, `keepRawEvents`). */
export const PRIVACY_KEYS = Object.keys(privacyShape) as ReadonlyArray<keyof typeof privacyShape>;

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
    "No longer read: the required checks are the ones GitHub's branch protection or rulesets require on the base (0002). The key stays valid until the version 14 reset removes it.",
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
    .describe(
      "Whether dipo turns GitHub's auto-merge on for a story PR once it is reviewed and its checks pass, without the maintainer's approval.",
    ),
  conflictAttempts: count().describe(
    "Failed conflict hand-offs of a story before it parks with the reason conflict.",
  ),
  ciAttempts: count().describe(
    "Pushed heads with red required checks before the story parks with the reason verify-failing.",
  ),
  holdLabels: z
    .array(text())
    .refine((labels) => new Set(labels).size === labels.length, "must not name a label twice")
    .describe("Labels that keep auto-merge off for a PR while it carries one."),
  checksWaitMinutes: count().describe(
    "Minutes dipo waits for the required checks of a PR to finish before it reports them stuck.",
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
        "Not read: the Ready gate rule R27 that read these phrases is removed (0012). The key is still accepted until the office configuration drops it.",
      ),
  }),
};

// Version 7: the office keys of version 6 plus `storyPr.open` (DIPO-210).
const officeShapeV7 = {
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

// Version 8: the office keys of version 7 plus `worker.web` (DIPO-164).
const officeShapeV8 = {
  ...officeShapeV7,
  worker: z.strictObject({
    ...officeShapeV2.worker.shape,
    web: z
      .boolean()
      .describe(
        "Whether the developer role gets the web search and fetch tools (0020 section 11b). Every call shows in the worker output and is counted on the run outcome; the box's web traffic goes through dipo's web proxy (0008). With false the developer keeps the M0 tool list. The key does not apply to the reviewer, which always has them in its reviewer box (0002).",
      ),
  }),
};

// Version 9 (DIPO-266): the `box` block. Versions are exact, so one description always builds the
// same image and its tag, a hash of the description, stays meaningful.
const ExactVersion = text().regex(/^\d+\.\d+\.\d+$/, "must be an exact version such as 1.4.2");
/** A sha256 in lower-case hex. */
const Sha256 = text().regex(/^[0-9a-f]{64}$/, "must be a sha256 in lower-case hex");
const DebianRelease = text()
  .regex(/^[a-z0-9][a-z0-9.]*$/, "must be a Debian release such as trixie, bookworm or 13")
  .describe(
    "The Debian release of the box image. dipo builds on its slim image, docker.io/library/debian:<release>-slim, pinned by digest for trixie, dipo's default; another release is pulled by its tag alone.",
  );
const BoxToolchain = z
  .strictObject({
    node: ExactVersion.describe(
      "Node.js, from nodejs.org; npm comes with it. Every box has Node, because npm installs Claude Code.",
    ),
    bun: ExactVersion.describe("Bun, from npm through Safe-Chain."),
    pnpm: ExactVersion.describe("pnpm, from npm through Safe-Chain."),
    yarn: text()
      .regex(/^1\.\d+\.\d+$/, "must be a Yarn 1 version such as 1.22.22")
      .describe(
        "Yarn 1, from npm through Safe-Chain. A Yarn 2+ repository runs its committed yarnPath release through it.",
      ),
    nodeSha256: z
      .strictObject({ arm64: Sha256, x64: Sha256 })
      .partial()
      .describe(
        "The sha256 of the Node.js tarball (node-v<version>-linux-<arch>.tar.gz) per architecture. dipo pins it for its known Node versions; a Node version it does not know needs it here, or the build is refused.",
      ),
  })
  .partial()
  .describe(
    "The toolchain of the box image and its exact versions. A version left out is detected from the repository (.bun-version, packageManager, .node-version, .nvmrc) or takes dipo's default.",
  );
// A Debian package name, with an optional `=version`. Every image has git already (0008).
const DebianPackage = text().regex(
  /^[a-z0-9][a-z0-9+.-]+(?:=[A-Za-z0-9.+~:-]+)?$/,
  "must be a Debian package name, optionally with =<version>",
);
// 0021 decision 9: a file outside git a box may get, by its path in the repository.
const BoxFilePath = text()
  .refine(
    // oxlint-disable-next-line no-control-regex -- control characters are what this refuses
    (path) => !/[\u0000-\u001f\u007f\\:]/.test(path),
    "may hold no control character, backslash or colon",
  )
  .refine(
    (path) =>
      !path.startsWith("/") &&
      path.split("/").every((segment) => !["", ".", "..", ".git"].includes(segment.toLowerCase())),
    "must be a relative path inside the repository, without empty, ., .. or .git segments (in any case)",
  );
const BoxFile = z
  .strictObject({
    path: BoxFilePath,
    noRealSecrets: z
      .literal(true)
      .describe(
        "Must be true: the maintainer's mark that the file holds no real secrets (0021 decision 9). An entry without it is refused.",
      ),
  })
  .describe("A file outside git that a box gets, by its path in the repository.");
const BoxSection = z
  .strictObject({
    debian: DebianRelease,
    toolchain: BoxToolchain,
    packages: z
      .array(DebianPackage)
      .refine((names) => new Set(names).size === names.length, "must not name a package twice")
      .describe(
        "Extra Debian packages of the box image, installed with apt from Debian's archive.",
      ),
    claudeCode: ExactVersion.describe(
      "The Claude Code version of the box image, installed from npm through Safe-Chain, with its auto-update and nonessential traffic turned off (0021 section 4).",
    ),
    files: z
      .array(BoxFile)
      .refine(
        (entries) => new Set(entries.map((entry) => entry.path)).size === entries.length,
        "must not name a file twice",
      )
      .describe(
        "Files outside git that a box may get (0021 decision 9). Nothing outside git goes into a box unless it is listed here and marked noRealSecrets: true.",
      ),
  })
  .partial()
  .describe(
    "The office's box (0021 section 5, DIPO-266): the image every story's box runs and the files outside git it may get. dipo reads this block from the base branch only, so a story cannot change it. What it leaves out is detected from the repository; the image is built once per description and rebuilt only when the description changes.",
  );

// Version 9: the office keys of version 8 plus `box` (DIPO-266).
const officeShapeV9 = {
  ...officeShapeV8,
  box: BoxSection,
};

// Version 10 (DIPO-285): `permissions` without `presentMinutes`.
const PermissionsV10 = z.strictObject({ ask: officeShapeV1.permissions.shape.ask });

// Version 10: the office keys of version 9 without `permissions.presentMinutes` (DIPO-285).
const officeShapeV10 = {
  ...officeShapeV9,
  permissions: PermissionsV10,
};

// Version 11 (DIPO-251): the story keys of R30, the security-sensitive story rule.
const SecurityCriteriaPhrases = z
  .strictObject({
    oldBarrier: z
      .array(text())
      .describe(
        "Phrases of a criterion that lists what the old barrier caught, with a test for each.",
      ),
    bypassForms: z
      .array(text())
      .describe(
        "Phrases of a criterion that lists the bypass forms to test (wrappers, quoting, indirection, chaining).",
      ),
    failClosed: z
      .array(text())
      .describe("Phrases of a criterion that asks for a fail-closed test against the real path."),
  })
  .describe(
    "Per part of R30, the phrases a criterion must contain (word match, as R10). A story whose title or Outcome names a security barrier fails once for each part no criterion matches (0012 section 3, DIPO-251).",
  );
const StoryV11 = z.strictObject({
  ...officeShapeV6.story.shape,
  securityPhrases: z
    .array(text())
    .describe(
      "Phrases of a title or Outcome that adds or replaces a security barrier, such as a deny rule or a permission check. Such a story needs the criteria parts of story.securityCriteriaPhrases, else it fails the Ready gate (R30, 0012 section 3, DIPO-251).",
    ),
  securityCriteriaPhrases: SecurityCriteriaPhrases,
});

// Version 11: the office keys of version 10 plus the R30 story keys (DIPO-251).
const officeShapeV11 = {
  ...officeShapeV10,
  story: StoryV11,
};

// Version 12 (DIPO-282): the `box` block plus `localPorts`.
const BoxLocalPort = z
  .int()
  .min(1, "must be a port from 1 to 65535")
  .max(65_535, "must be a port from 1 to 65535");
const BoxSectionV12 = z
  .strictObject({
    ...BoxSection.shape,
    localPorts: z
      .array(BoxLocalPort)
      .refine((ports) => new Set(ports).size === ports.length, "must not name a port twice")
      .describe(
        "Local ports of this Mac a box may reach (0021 section 3, DIPO-282), only through dipo's web proxy, as host.dipo.internal:<port>, which dipo connects to on the Mac's loopback. No other service on the Mac or its local network is reachable from a box. Empty by default.",
      ),
  })
  .partial()
  .describe(BoxSection.description ?? "");

// Version 12: the office keys of version 11 with `box.localPorts` (DIPO-282).
const officeShapeV12 = {
  ...officeShapeV11,
  box: BoxSectionV12,
};

// Version 13 (DIPO-310): the scan fallback session (0013 amendment of 2026-10-22).
const ScanV13 = z
  .strictObject({
    model: text().describe("The model of the scan fallback session."),
    effort: text().describe("The effort of the scan fallback session."),
    budgetTokens: count().describe(
      "Input plus output plus cache-creation tokens one fallback session may spend.",
    ),
    maxMinutes: count().describe("Minutes one fallback session may run before dipo stops it."),
  })
  .describe(
    "The fallback session that proposes the run profile capabilities code could not resolve, started only by dipo office infer (0013 section 6, amendment of 2026-10-22). It runs on the Mac with every tool off, one turn plus one schema retry.",
  );

// Version 13: the office keys of version 12 plus `scan` (DIPO-310).
const officeShape = {
  ...officeShapeV12,
  scan: ScanV13,
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

/** The effective configuration of an office, version 7 (kept to read version 7 files). */
export const OfficeConfigV7 = z.strictObject({
  version: z.literal(7),
  ...officeShapeV7,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/** The effective configuration of an office, version 8 (kept to read version 8 files). */
export const OfficeConfigV8 = z.strictObject({
  version: z.literal(8),
  ...officeShapeV8,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/** The effective configuration of an office, version 9 (kept to read version 9 files). */
export const OfficeConfigV9 = z.strictObject({
  version: z.literal(9),
  ...officeShapeV9,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/** The effective configuration of an office, version 10 (kept to read version 10 files). */
export const OfficeConfigV10 = z.strictObject({
  version: z.literal(10),
  ...officeShapeV10,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/** The effective configuration of an office, version 11 (kept to read version 11 files). */
export const OfficeConfigV11 = z.strictObject({
  version: z.literal(11),
  ...officeShapeV11,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/** The effective configuration of an office, version 12 (kept to read version 12 files). */
export const OfficeConfigV12 = z.strictObject({
  version: z.literal(12),
  ...officeShapeV12,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});

/**
 * The effective configuration of an office: every key set, after defaults and overrides. The
 * `box` block is the one exception: its keys stay optional, and what it leaves out is detected
 * from the repository (`box/image.ts`).
 */
export const OfficeConfigV13 = z.strictObject({
  version: z.literal(OFFICE_CONFIG_VERSION),
  ...officeShape,
  // Machine-local only (0007 sections 7 and 8, 0017 section 5).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});
export type OfficeConfig = z.infer<typeof OfficeConfigV13>;
/** The `box` block of an office (version 9, DIPO-266), as committed: every key optional. */
export type OfficeBoxSection = OfficeConfig["box"];

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

/**
 * Overrides from flags on a single command. Never `box`: the box is read from the base branch
 * only (DIPO-266), so no other source may feed a build.
 */
export type OfficeOverrides = DeepPartial<
  Omit<OfficeConfig, "version" | "privacy" | "retention" | "box">
>;
export type OfficeFileOf<V extends OfficeConfigVersion> = DeepPartial<
  Omit<OfficeConfig, "version" | "privacy" | "retention">
> & { version: V };
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
  version: z.literal(7),
  ...fileShape(officeShapeV7),
}) as unknown as z.ZodType<OfficeFileOf<7>>;

/** `.dipo/office.yaml`, version 8: version 7 plus `worker.web` (DIPO-164). */
export const OfficeFileV8 = z.strictObject({
  version: z.literal(8),
  ...fileShape(officeShapeV8),
}) as unknown as z.ZodType<OfficeFileOf<8>>;

/** `.dipo/office.yaml`, version 9: version 8 plus `box` (DIPO-266). */
export const OfficeFileV9 = z.strictObject({
  version: z.literal(9),
  ...fileShape(officeShapeV9),
}) as unknown as z.ZodType<OfficeFileOf<9>>;

/** `.dipo/office.yaml`, version 10: version 9 without `permissions.presentMinutes` (DIPO-285). */
export const OfficeFileV10 = z.strictObject({
  version: z.literal(10),
  ...fileShape(officeShapeV10),
}) as unknown as z.ZodType<OfficeFileOf<10>>;

/**
 * `.dipo/office.yaml`, version 11: version 10 plus `story.securityPhrases` and
 * `story.securityCriteriaPhrases` (DIPO-251).
 */
export const OfficeFileV11 = z.strictObject({
  version: z.literal(11),
  ...fileShape(officeShapeV11),
}) as unknown as z.ZodType<OfficeFileOf<11>>;

/** `.dipo/office.yaml`, version 12: version 11 plus `box.localPorts` (DIPO-282). */
export const OfficeFileV12 = z.strictObject({
  version: z.literal(12),
  ...fileShape(officeShapeV12),
}) as unknown as z.ZodType<OfficeFileOf<12>>;

/** `.dipo/office.yaml`, version 13: version 12 plus `scan` (DIPO-310). */
export const OfficeFileV13 = z.strictObject({
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
  version: z.literal(7),
  ...fileShape(localShape),
}) as unknown as z.ZodType<OfficeLocalFileOf<7>>;

/** `.dipo/office.local.yaml`, version 8: the same keys as version 7 (DIPO-164 adds none here). */
export const OfficeLocalFileV8 = z.strictObject({
  version: z.literal(8),
  ...fileShape(localShape),
}) as unknown as z.ZodType<OfficeLocalFileOf<8>>;

/**
 * `.dipo/office.local.yaml`, version 9: the same keys as version 8. DIPO-266 adds none here: the
 * box is read from the base branch, never from a machine-local file.
 */
export const OfficeLocalFileV9 = z.strictObject({
  version: z.literal(9),
  ...fileShape(localShape),
}) as unknown as z.ZodType<OfficeLocalFileOf<9>>;

/** `.dipo/office.local.yaml`, version 10: the same keys as version 9 (DIPO-285 adds none here). */
export const OfficeLocalFileV10 = z.strictObject({
  version: z.literal(10),
  ...fileShape(localShape),
}) as unknown as z.ZodType<OfficeLocalFileOf<10>>;

/** `.dipo/office.local.yaml`, version 11: the same keys as version 10 (DIPO-251 adds none here). */
export const OfficeLocalFileV11 = z.strictObject({
  version: z.literal(11),
  ...fileShape(localShape),
}) as unknown as z.ZodType<OfficeLocalFileOf<11>>;

/**
 * `.dipo/office.local.yaml`, version 12: the same keys as version 11. DIPO-282 adds none here: the
 * box's local ports are read from the base branch, never from a machine-local file.
 */
export const OfficeLocalFileV12 = z.strictObject({
  version: z.literal(12),
  ...fileShape(localShape),
}) as unknown as z.ZodType<OfficeLocalFileOf<12>>;

/** `.dipo/office.local.yaml`, version 13: the same keys as version 12 (DIPO-310 adds none here). */
export const OfficeLocalFileV13 = z.strictObject({
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

/** Overrides from flags on a single command, version 7 keys. */
export const OfficeOverridesV7 = z.strictObject(
  fileShape(officeShapeV7),
) as unknown as z.ZodType<OfficeOverrides>;

/** Overrides from flags on a single command, version 8 keys. */
export const OfficeOverridesV8 = z.strictObject(
  fileShape(officeShapeV8),
) as unknown as z.ZodType<OfficeOverrides>;

/**
 * Overrides from flags on a single command, version 9 keys: any `office.yaml` key except `version`
 * and `box`. The box is read from the base branch only (DIPO-266), so a flag can never feed a build.
 */
export const OfficeOverridesV9 = z.strictObject(
  fileShape(officeShapeV8),
) as unknown as z.ZodType<OfficeOverrides>;

/**
 * Overrides from flags on a single command, version 10 keys: any `office.yaml` key except
 * `version` and `box`, so without `permissions.presentMinutes` too (DIPO-285).
 */
export const OfficeOverridesV10 = z.strictObject(
  fileShape({ ...officeShapeV8, permissions: PermissionsV10 }),
) as unknown as z.ZodType<OfficeOverrides>;

/**
 * Overrides from flags on a single command, version 11 keys: any `office.yaml` key except
 * `version` and `box`, with the R30 story keys (DIPO-251).
 */
export const OfficeOverridesV11 = z.strictObject(
  fileShape({ ...officeShapeV8, permissions: PermissionsV10, story: StoryV11 }),
) as unknown as z.ZodType<OfficeOverrides>;

/**
 * Overrides from flags on a single command: the keys of version 11. Version 12 adds a `box` key
 * only (DIPO-282), and the box is never set by a flag.
 */
export const OfficeOverridesV12 = OfficeOverridesV11;

/**
 * Overrides from flags on a single command: the keys of version 12 that a flag may set, with the
 * `scan` block (DIPO-310). Never `box`.
 */
export const OfficeOverridesV13 = z.strictObject(
  fileShape({ ...officeShapeV8, permissions: PermissionsV10, story: StoryV11, scan: ScanV13 }),
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
  8: OfficeFileV8,
  9: OfficeFileV9,
  10: OfficeFileV10,
  11: OfficeFileV11,
  12: OfficeFileV12,
  13: OfficeFileV13,
};
export const OFFICE_LOCAL_FILE_SCHEMAS: Readonly<Record<OfficeConfigVersion, z.ZodType>> = {
  1: OfficeLocalFileV1,
  2: OfficeLocalFileV2,
  3: OfficeLocalFileV3,
  4: OfficeLocalFileV4,
  5: OfficeLocalFileV5,
  6: OfficeLocalFileV6,
  7: OfficeLocalFileV7,
  8: OfficeLocalFileV8,
  9: OfficeLocalFileV9,
  10: OfficeLocalFileV10,
  11: OfficeLocalFileV11,
  12: OfficeLocalFileV12,
  13: OfficeLocalFileV13,
};

/** A key that a version retires: nothing reads it any more, and that version's files refuse it. */
export interface RetiredKey {
  /** The key path, such as `permissions.presentMinutes`. */
  readonly path: string;
  /** The first version without the key. */
  readonly version: OfficeConfigVersion;
  /** Why the key is gone, for the warning and the error. */
  readonly reason: string;
}

/**
 * Keys a version retires (DIPO-285). A file of an older version may still set one: the migration
 * drops it, and the load warns with its path (`resolveOfficeConfig`).
 */
export const RETIRED_KEYS: readonly RetiredKey[] = [
  {
    path: "permissions.presentMinutes",
    version: 10,
    reason:
      "nothing reads it since DIPO-279: a worker's question is asked live only while a TUI is connected (0021 section 11)",
  },
];

// The document without the key at `path` (dot-separated), copying each mapping on the way down.
function withoutKey(
  document: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined || !(head in document)) return document;
  const { [head]: value, ...others } = document;
  if (rest.length === 0) return others;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return document;
  return { ...others, [head]: withoutKey(value as Record<string, unknown>, rest) };
}

// Drops the keys that `version` retires.
function withoutRetired(document: Record<string, unknown>, version: OfficeConfigVersion) {
  return RETIRED_KEYS.filter((key) => key.version === version).reduce(
    (current, key) => withoutKey(current, key.path.split(".")),
    document,
  );
}

/**
 * Pure: an office file's document of `version` migrated in memory to the newest version, one
 * step at a time (0017 section 5, "Versioning and migration"). Version 1 to 2 is the identity
 * (0017 amendment of 2026-10-12): `worker.plugins` is new and takes its default. Version 2 to 3
 * is the identity too: `mergeSlot.requiredChecks` is new and takes its default. Version 3 to 4
 * is the identity: `sandbox.toolchainReadPaths` in `office.local.yaml` is new and adds nothing
 * when absent. Version 4 to 5 is the identity too: `review` and the new `mergeSlot` keys take
 * their defaults. Version 5 to 6 is the identity: `story.maintainerStepPhrases` takes its
 * default. Version 6 to 7 is the identity too: `storyPr.open` takes its default, true (DIPO-210).
 * Version 7 to 8 is the identity too: `worker.web` takes its default, true (DIPO-164).
 * Version 8 to 9 is the identity too: without `box` the whole box is detected (DIPO-266).
 * Version 9 to 10 drops `permissions.presentMinutes`, which nothing reads (DIPO-285, `RETIRED_KEYS`);
 * the load warns about it.
 * Version 10 to 11 is the identity: `story.securityPhrases` and `story.securityCriteriaPhrases`
 * take their defaults (DIPO-251).
 * Version 11 to 12 is the identity: `box.localPorts` is new, and without it a box reaches no local
 * port (DIPO-282).
 * Version 12 to 13 is the identity: `scan` takes its defaults (DIPO-310).
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
  if (current.version === 7) current = { ...current, version: 8 };
  if (current.version === 8) current = { ...current, version: 9 };
  if (current.version === 9) current = { ...withoutRetired(current, 10), version: 10 };
  if (current.version === 10) current = { ...current, version: 11 };
  if (current.version === 11) current = { ...current, version: 12 };
  if (current.version === 12) current = { ...current, version: 13 };
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
      maxTurns: 90,
      maxMinutes: 45,
      loops: 3,
    },
    M: {
      model: "sonnet",
      effort: "medium",
      budgetTokens: 800_000,
      maxTurns: 200,
      maxMinutes: 90,
      loops: 5,
    },
    L: {
      model: "opus",
      effort: "high",
      budgetTokens: 2_000_000,
      maxTurns: 300,
      maxMinutes: 180,
      loops: 8,
    },
  },
  // 0008 sections 2 and 5; `plugins` empty: no plugin in a worker session (0008 amendment of
  // 2026-10-12).
  // `web` true: the developer role gets the web search and fetch tools (0020 section 11b,
  // DIPO-164).
  worker: { adapter: "claude-cli", allowProjectSettings: [], plugins: [], web: true },
  // `requiredChecks` is no longer read (0002); the version 14 reset removes it. The rest of the
  // block and the review limits are DIPO-139's defaults.
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
  // 0013 amendment of 2026-10-22 (DIPO-310): the scan fallback session.
  scan: { model: "sonnet", effort: "low", budgetTokens: 100_000, maxMinutes: 5 },
  // 0008 section 5; whether the maintainer is present is a connected TUI (DIPO-279).
  permissions: { ask: "when-present" },
  // 0008, 0009 and 0013 section 1.
  timeouts: {
    workerStallMinutes: 20,
    workerQuietMinutes: 3,
    questionWaitMinutes: 15,
    permissionWaitSeconds: 300,
    scriptMinutes: { install: 15, setup: 10, post_create: 10, verify: 20 },
    testIdleMinutes: 240,
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
    // Not read since R27 was removed (0012); kept until the office configuration drops the key.
    maintainerStepPhrases: [
      "task notes",
      "implementation notes",
      "by the maintainer",
      "backlog task edit",
      "live recording",
      "live capture",
      "run outside the sandbox",
      "the PR states",
      "the PR description",
    ],
    // 0012 section 3 (R30, DIPO-251): a title or Outcome that names a security barrier, and the
    // criteria parts such a story needs. Design choice of DIPO-251; the office may change them.
    securityPhrases: [
      "deny rule",
      "deny rules",
      "guard",
      "guards",
      "sandbox setting",
      "sandbox settings",
      "permission check",
      "permission checks",
    ],
    securityCriteriaPhrases: {
      oldBarrier: [
        "old barrier",
        "old rule",
        "old guard",
        "old check",
        "previous rule",
        "previously caught",
        "still catches",
      ],
      bypassForms: [
        "bypass",
        "bypasses",
        "wrapper",
        "wrappers",
        "quoting",
        "quoted",
        "indirection",
        "chaining",
        "chained",
      ],
      failClosed: ["fail-closed", "fails closed", "fail closed", "real path"],
    },
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
  // 0021 section 5 (DIPO-266): no committed box block; the box is detected from the repository.
  box: {},
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
