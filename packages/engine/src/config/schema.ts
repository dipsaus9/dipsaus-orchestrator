// The office configuration (0017). Version 14 holds only the keys code reads, and every key has a
// default (`OFFICE_DEFAULTS`). A key added later with a default needs no version bump; a version
// changes only when a key's meaning or shape changes, and then a pure migration from the version
// before comes with it (0017).
//
// Versions 1 to 13 bumped the version for every added key. One migration takes a file of any of
// them to version 14 (`migrateOfficeDocument`): it moves the keys that changed section
// (`MOVED_KEYS`) and drops the retired ones (`RETIRED_KEYS`), each named in a warning.

import { z } from "zod";

/** The office configuration version this binary writes and reads natively. */
export const OFFICE_CONFIG_VERSION = 14;
export type OfficeConfigVersion = number;

const count = () => z.int().positive();
const text = () => z.string().min(1);

// 0008: what a tier maps to. Budgets are tokens; effort is passed to the adapter as is.
const TierCaps = z.strictObject({
  model: text(),
  effort: text(),
  budgetTokens: count(),
  maxTurns: count(),
  maxMinutes: count(),
  loops: count(),
});

const Review = z
  .strictObject({
    model: text(),
    effort: text(),
    maxRounds: count(),
    maxTurns: count(),
    maxMinutes: count(),
    budgetTokens: count(),
  })
  .describe(
    "Limits of the review loop (0002): the model and effort of the review worker, the rounds of review and fixes before it stops, and the turns, minutes and tokens of one review.",
  );

const Caps = z
  .strictObject({
    ciAttempts: count().describe(
      "Pushed heads with red required checks before the story parks with the reason verify-failing. A reviewed head and a close-out head each count once their checks are red; a head whose CI run a later push cancelled does not count.",
    ),
    conflictAttempts: count().describe(
      "Failed conflict hand-offs of a story before it parks with the reason conflict.",
    ),
  })
  .describe("How often a story may try again before it parks (0002).");

const Merge = z
  .strictObject({
    autoMerge: z
      .boolean()
      .describe(
        "Whether dipo commits the close-out and turns GitHub's auto-merge on for a story PR as soon as its review approves it, without the maintainer's approval. GitHub merges it once its required checks pass on the close-out head.",
      ),
    holdLabels: z
      .array(text())
      .refine((labels) => new Set(labels).size === labels.length, "must not name a label twice")
      .describe("Labels that keep auto-merge off for a PR while it carries one."),
    checksWaitMinutes: count().describe(
      "Minutes dipo waits for the required checks of a PR to finish before it reports them stuck and polls the PR less often.",
    ),
  })
  .describe("How a story PR merges (0002).");

// The box (0008). Versions are exact, so one description always builds the same image and its
// tag, a hash of the description, stays meaningful.
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
// 0008: a file outside git a box may get, by its path in the repository.
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
        "Must be true: the maintainer's mark that the file holds no real secrets (0008). An entry without it is refused.",
      ),
  })
  .describe("A file outside git that a box gets, by its path in the repository.");
const BoxLocalPort = z
  .int()
  .min(1, "must be a port from 1 to 65535")
  .max(65_535, "must be a port from 1 to 65535");
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
      "The Claude Code version of the box image, installed from npm through Safe-Chain, with its auto-update and nonessential traffic turned off (0008).",
    ),
    files: z
      .array(BoxFile)
      .refine(
        (entries) => new Set(entries.map((entry) => entry.path)).size === entries.length,
        "must not name a file twice",
      )
      .describe(
        "Files outside git that a box may get (0008). Nothing outside git goes into a box unless it is listed here and marked noRealSecrets: true. Their values are redacted from PR comments and stored web calls.",
      ),
    localPorts: z
      .array(BoxLocalPort)
      .refine((ports) => new Set(ports).size === ports.length, "must not name a port twice")
      .describe(
        "Local ports of this Mac a box may reach (0008), only through dipo's web proxy, as host.dipo.internal:<port>, which dipo connects to on the Mac's loopback. No other service on the Mac or its local network is reachable from a box. Empty by default.",
      ),
  })
  .partial()
  .describe(
    "The office's box (0008): the image every story's box runs and the files outside git it may get. dipo reads this block from the base branch only, so a story cannot change it. What it leaves out is detected from the repository; the image is built once per description and rebuilt only when the description changes.",
  );

const Scan = z
  .strictObject({
    model: text().describe("The model of the scan fallback session."),
    effort: text().describe("The effort of the scan fallback session."),
    budgetTokens: count().describe(
      "Input plus output plus cache-creation tokens one fallback session may spend.",
    ),
    maxMinutes: count().describe("Minutes one fallback session may run before dipo stops it."),
  })
  .describe(
    "The fallback session that proposes the run profile capabilities code could not resolve, started only by dipo office infer (0013). It runs on the Mac with every tool off, one turn plus one schema retry.",
  );

// 0012: the Ready gate's story rules.
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
    "Per part of R30, the phrases a criterion must contain (word match, as R10). A story whose title or Outcome names a security barrier fails once for each part no criterion matches (0012).",
  );
const Story = z.strictObject({
  types: z.array(text()).min(1),
  tiers: z.array(z.enum(["S", "M", "L"])).min(1),
  bannedPhrases: z.array(text()),
  securityPhrases: z
    .array(text())
    .describe(
      "Phrases of a title or Outcome that adds or replaces a security barrier, such as a deny rule or a permission check. Such a story needs the criteria parts of story.securityCriteriaPhrases, else it fails the Ready gate (R30, 0012).",
    ),
  securityCriteriaPhrases: SecurityCriteriaPhrases,
  titleMax: count(),
  outcomeMin: count(),
  criterionMin: count(),
  slugMax: count(),
});

// 0014: S, M, L and XL are project size classes counted from `git ls-files` at pickup (S under 150
// files, M under 500, L under 5,000, XL above). They are not story tiers.
const SIZE_CLASSES =
  "Keys S, M, L and XL are 0014 project size classes from `git ls-files` (S under 150 files, M under 500, L under 5,000, XL above), not story tiers.";
const BySize = z
  .strictObject({ S: count(), M: count(), L: count(), XL: count() })
  .describe(SIZE_CLASSES);
// 0014, one entry per section budget, in characters. `taskMessage` is the cap of the whole task
// message, `diff` the reviewer's diff.
const PromptBudgets = z
  .strictObject({
    context: BySize,
    inputs: BySize,
    dependencies: BySize,
    background: BySize,
    handoff: BySize,
    feedbackItem: BySize,
    feedbackTotal: BySize,
    diff: BySize,
    taskMessage: BySize,
  })
  .describe(`Prompt section budgets per project size class (0014), in characters. ${SIZE_CLASSES}`);
const Prompt = z.strictObject({ budgets: PromptBudgets, contractMax: count() });

const Timeouts = z.strictObject({
  // 0009: the health of a running worker.
  workerStallMinutes: count(),
  workerQuietMinutes: count(),
  // How long a worker's question waits for an answer.
  questionWaitMinutes: count(),
  // 0013: one timeout per script the engine runs, by script name.
  scriptMinutes: z.record(text(), count()),
  // 0002: how long an open test waits for its record before its box is deleted.
  testIdleMinutes: count(),
});

const Polling = z.strictObject({
  // 0002: the PR poll of an office.
  prStateSeconds: count(),
  // 0010: how often an office fetches its base.
  fetchSeconds: count(),
});

const privacyShape = {
  storePrompts: z.boolean(),
  storeCommandBodies: z.boolean(),
  keepRawEvents: z.boolean(),
};

/** The keys under `privacy` (`storePrompts`, `storeCommandBodies`, `keepRawEvents`). */
export const PRIVACY_KEYS = Object.keys(privacyShape) as ReadonlyArray<keyof typeof privacyShape>;

// 0007: one retention rule, run detail older than `days` goes.
const retentionShape = {
  days: count(),
};

// The keys of `.dipo/office.yaml`, in the order of the 0017 sample.
const officeShape = {
  tiers: z.strictObject({ S: TierCaps, M: TierCaps, L: TierCaps }),
  review: Review,
  caps: Caps,
  merge: Merge,
  box: BoxSection,
  scan: Scan,
  story: Story,
  prompt: Prompt,
  // 0010: the base branch; without it `origin/HEAD` decides.
  base: text().optional(),
  // 0010: where dipo's own worktrees `_base` and `_backlog` live; DIPO-375: the ignored paths a
  // leftover story worktree may hold and still be removed (a build cache, rebuilt by a build).
  worktree: z.strictObject({
    root: text(),
    rebuildable: z
      .array(
        text().refine(
          (path) => !path.startsWith("/"),
          "must be a path relative to the worktree root, without a leading /",
        ),
      )
      .describe(
        "Ignored paths a leftover story worktree may hold and still be removed: a name without a slash matches a file or folder at any depth (a trailing / for a folder only); a path with a slash matches that exact path from the root (DIPO-375).",
      ),
  }),
  // 0013: script overrides; the run profile from the scan decides the rest.
  scripts: z.record(text(), text()),
  timeouts: Timeouts,
  polling: Polling,
};

/**
 * The effective configuration of an office: every key set, after defaults and overrides. The `box`
 * block is the one exception: its keys stay optional, and what it leaves out is detected from the
 * repository (`box/image.ts`).
 */
export const OfficeConfigSchema = z.strictObject({
  version: z.literal(OFFICE_CONFIG_VERSION),
  ...officeShape,
  // Machine-local only (0007, 0017).
  privacy: z.strictObject(privacyShape),
  retention: z.strictObject(retentionShape),
});
export type OfficeConfig = z.infer<typeof OfficeConfigSchema>;
/** The `box` block of an office, as committed: every key optional. */
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
 * only, so no other source may feed a build.
 */
export type OfficeOverrides = DeepPartial<
  Omit<OfficeConfig, "version" | "privacy" | "retention" | "box">
>;
export type OfficeFile = DeepPartial<Omit<OfficeConfig, "version" | "privacy" | "retention">> & {
  version: typeof OFFICE_CONFIG_VERSION;
};
export type OfficeLocalFile = DeepPartial<
  Pick<OfficeConfig, "timeouts" | "privacy" | "retention">
> & {
  version: typeof OFFICE_CONFIG_VERSION;
};

/** `.dipo/office.yaml`. `privacy` and `retention` are not accepted here. */
export const OfficeFileSchema = z.strictObject({
  version: z.literal(OFFICE_CONFIG_VERSION),
  ...fileShape(officeShape),
}) as unknown as z.ZodType<OfficeFile>;

/** `.dipo/office.local.yaml`: only `timeouts`, `privacy` and `retention`. */
export const OfficeLocalFileSchema = z.strictObject({
  version: z.literal(OFFICE_CONFIG_VERSION),
  ...fileShape({
    timeouts: Timeouts,
    privacy: z.strictObject(privacyShape),
    retention: z.strictObject(retentionShape),
  }),
}) as unknown as z.ZodType<OfficeLocalFile>;

/** Overrides from flags on a single command: any `office.yaml` key except `version` and `box`. */
export const OfficeOverridesSchema = z.strictObject(
  fileShape(Object.fromEntries(Object.entries(officeShape).filter(([key]) => key !== "box"))),
) as unknown as z.ZodType<OfficeOverrides>;

/** A key that version 14 retired: nothing reads it, so a version 14 file refuses it. */
export interface RetiredKey {
  /** The key path, such as `permissions` or `mergeSlot.requiredChecks`. */
  readonly path: string;
  /** Why the key is gone, for the warning and the error. */
  readonly reason: string;
}

const NO_MAC_WORKTREE =
  "a story has no Mac worktree but a box, and a file outside git goes into it through box.files (0008, 0010)";
const NO_MAC_SANDBOX = "the Mac sandbox is gone: the box is the boundary (0008)";
const RETENTION_DAYS = "one retention rule, retention.days, replaced the two tiers (0007)";

/**
 * Keys of versions 1 to 13 that version 14 retired (0017). The migration drops each one a file
 * sets, and the load and `dipo config migrate` name it in a warning.
 */
export const RETIRED_KEYS: readonly RetiredKey[] = [
  { path: "worker.adapter", reason: "the worker is always the Claude CLI adapter (0008)" },
  {
    path: "worker.allowProjectSettings",
    reason: "no session loads settings from the repository copy (0008)",
  },
  {
    path: "worker.plugins",
    reason: "no session loads plugins; every installed plugin is off (0008)",
  },
  { path: "worker.web", reason: "a developer in its box always has the web (0008)" },
  { path: "permissions", reason: NO_MAC_SANDBOX },
  { path: "sandbox", reason: NO_MAC_SANDBOX },
  { path: "remote", reason: "the remote is always origin (0010)" },
  { path: "worktree.files", reason: NO_MAC_WORKTREE },
  { path: "worktree.ports", reason: NO_MAC_WORKTREE },
  { path: "worktree.env", reason: NO_MAC_WORKTREE },
  { path: "worktree.post_create", reason: NO_MAC_WORKTREE },
  { path: "worktree.maxSlots", reason: NO_MAC_WORKTREE },
  {
    path: "mergeSlot.requiredChecks",
    reason: "the required checks are the ones GitHub requires on the base (0002)",
  },
  { path: "storyPr", reason: "every story gets its PR: CI on it is the final gate (0002)" },
  { path: "story.maintainerStepPhrases", reason: "the Ready gate rule R27 is removed (0012)" },
  { path: "timeouts.permissionWaitSeconds", reason: "the permission relay is gone (0008)" },
  { path: "prompt.budgets.contextItem", reason: "the per-item cap is fixed in code (0014)" },
  { path: "prompt.budgets.inputsFile", reason: "the per-file cap is fixed in code (0014)" },
  { path: "prompt.budgets.feedbackLogLines", reason: "the log line cap is fixed in code (0014)" },
  { path: "prompt.budgets.nudge", reason: "nudges are gone with the developer's hooks (0008)" },
  { path: "retention.shortDays", reason: RETENTION_DAYS },
  { path: "retention.stateDays", reason: RETENTION_DAYS },
];

/** A key that moved to another section in version 14. */
export interface MovedKey {
  readonly from: string;
  readonly to: string;
}

/** Keys of versions 5 to 13 that version 14 moved: `mergeSlot` split into `caps` and `merge`. */
export const MOVED_KEYS: readonly MovedKey[] = [
  { from: "mergeSlot.ciAttempts", to: "caps.ciAttempts" },
  { from: "mergeSlot.conflictAttempts", to: "caps.conflictAttempts" },
  { from: "mergeSlot.autoMerge", to: "merge.autoMerge" },
  { from: "mergeSlot.holdLabels", to: "merge.holdLabels" },
  { from: "mergeSlot.checksWaitMinutes", to: "merge.checksWaitMinutes" },
];

/** One step of the migration to version 14, applied to a document in the same order. */
export type MigrationStep =
  | { readonly kind: "drop"; readonly path: readonly string[]; readonly reason: string }
  | { readonly kind: "move"; readonly from: readonly string[]; readonly to: readonly string[] };

/** A document migrated to version 14 and the steps that took it there, in order. */
export interface Migration {
  readonly document: Record<string, unknown>;
  readonly steps: readonly MigrationStep[];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(document: unknown, path: readonly string[]): unknown {
  let current = document;
  for (const key of path) {
    if (!isMapping(current) || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

// The document without the key at `path`, copying each mapping on the way down. A mapping left
// empty by the removal goes too, so a moved section leaves nothing behind.
function without(
  document: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined || !(head in document)) return document;
  const { [head]: value, ...others } = document;
  if (rest.length === 0) return others;
  if (!isMapping(value)) return document;
  const inner: Record<string, unknown> = without(value, rest);
  return Object.keys(inner).length === 0 ? others : { ...others, [head]: inner };
}

function withValue(
  document: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (head === undefined) return document;
  if (rest.length === 0) return { ...document, [head]: value };
  const inner = isMapping(document[head]) ? document[head] : {};
  return { ...document, [head]: withValue(inner, rest, value) };
}

/**
 * Pure: an office file's document of a version from 1 to 13 migrated to version 14 (0017). Each
 * moved key goes to its new place, unless the file sets that place already, then each retired key
 * is dropped. `steps` lists what it did, in order, for the warnings and for `dipo config migrate`,
 * which applies the same steps to the YAML document so its comments stay. A version 14 document
 * comes back unchanged. Works for both office files.
 */
export function migrateOfficeDocument(
  version: number,
  document: Readonly<Record<string, unknown>>,
): Migration {
  if (version >= OFFICE_CONFIG_VERSION) return { document: { ...document }, steps: [] };
  let current: Record<string, unknown> = { ...document };
  const steps: MigrationStep[] = [];
  for (const moved of MOVED_KEYS) {
    const from = moved.from.split(".");
    const to = moved.to.split(".");
    const value = at(current, from);
    if (value === undefined) continue;
    if (at(current, to) === undefined) {
      current = withValue(without(current, from), to, value);
      steps.push({ kind: "move", from, to });
    } else {
      current = without(current, from);
      steps.push({ kind: "drop", path: from, reason: `${moved.to} is set already` });
    }
  }
  // What is left of `mergeSlot` after the moves is retired too.
  for (const retired of RETIRED_KEYS) {
    const path = retired.path.split(".");
    if (at(current, path) === undefined) continue;
    current = without(current, path);
    steps.push({ kind: "drop", path, reason: retired.reason });
  }
  return { document: { ...current, version: OFFICE_CONFIG_VERSION }, steps };
}

/** Keys that live only in `.dipo/office.local.yaml`. */
export const LOCAL_ONLY_KEYS = ["privacy", "retention"] as const;
/** Top-level keys `.dipo/office.local.yaml` accepts besides `version`. */
export const LOCAL_ALLOWED_KEYS = ["timeouts", "privacy", "retention"] as const;

const bySize = (S: number, M: number, L: number, XL: number) => ({ S, M, L, XL });
const sameSize = (value: number) => bySize(value, value, value, value);

/** Built-in defaults, the lowest layer (0017). */
export const OFFICE_DEFAULTS: OfficeConfig = {
  version: OFFICE_CONFIG_VERSION,
  // 0008.
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
  // 0002.
  review: {
    model: "opus",
    effort: "high",
    maxRounds: 3,
    maxTurns: 60,
    maxMinutes: 30,
    budgetTokens: 200_000,
  },
  caps: { ciAttempts: 2, conflictAttempts: 2 },
  merge: { autoMerge: true, holdLabels: [], checksWaitMinutes: 30 },
  // 0008: no committed box block; the box is detected from the repository.
  box: {},
  // 0013: the scan fallback session.
  scan: { model: "sonnet", effort: "low", budgetTokens: 100_000, maxMinutes: 5 },
  // 0012.
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
    // R30: a title or Outcome that names a security barrier, and the criteria parts such a story
    // needs. The office may change them.
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
  // 0014.
  prompt: {
    budgets: {
      context: bySize(12_000, 18_000, 24_000, 32_000),
      inputs: bySize(8_000, 12_000, 16_000, 20_000),
      dependencies: bySize(1_500, 1_500, 2_000, 2_000),
      background: bySize(2_000, 2_000, 3_000, 3_000),
      handoff: sameSize(6_000),
      feedbackItem: sameSize(3_000),
      feedbackTotal: sameSize(8_000),
      diff: bySize(40_000, 60_000, 80_000, 80_000),
      taskMessage: bySize(40_000, 50_000, 60_000, 70_000),
    },
    contractMax: 12_000,
  },
  // 0010. `base` has no default: `origin/HEAD` decides when it is absent.
  worktree: {
    root: "../{repo}.worktrees",
    rebuildable: ["node_modules/", ".DS_Store", ".tsbuild/", ".claude/.cc-writes/"],
  },
  // 0013: no overrides; the run profile from the scan decides.
  scripts: {},
  // 0009, 0013 and 0002.
  timeouts: {
    workerStallMinutes: 20,
    workerQuietMinutes: 3,
    questionWaitMinutes: 15,
    scriptMinutes: { install: 15, setup: 10, verify: 20 },
    testIdleMinutes: 240,
  },
  polling: { prStateSeconds: 60, fetchSeconds: 300 },
  // 0007; commands and prompts are stored by default, and raw events stay off.
  privacy: { storePrompts: true, storeCommandBodies: true, keepRawEvents: false },
  retention: { days: 30 },
};

/**
 * The privacy opt-ins that are on, as their full keys (`privacy.storeCommandBodies`), in schema
 * order: what the overview shows (0007). Empty without a configuration.
 */
export function privacyOptIns(config: Pick<OfficeConfig, "privacy"> | undefined): string[] {
  if (config === undefined) return [];
  return Object.keys(privacyShape)
    .filter((key) => config.privacy[key as keyof typeof privacyShape])
    .map((key) => `privacy.${key}`);
}
