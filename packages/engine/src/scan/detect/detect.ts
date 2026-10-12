// `detect` turns a probe into a run profile (0013 sections 2 to 4 and 7). It is pure: no file,
// process, clock or model is touched, so the same probe always gives the same profile.

import { fingerprint } from "./fingerprint";
import {
  LOCKFILES,
  parseManifest,
  parseWorkflow,
  ROOT_MANIFEST,
  WORKFLOW_FILE,
  joinPath,
  type Manifest,
  type Workflow,
} from "./manifest";
import { detectPorts } from "./ports";
import {
  CAPABILITIES,
  type Candidate,
  type CapabilityName,
  type CommandSpec,
  type ConformanceLevel,
  type DetectOptions,
  type Deviation,
  type PackageManager,
  type PackageManagerName,
  type Probe,
  type Resolution,
  type RunProfile,
} from "./types";

const PACKAGE_MANAGERS: readonly PackageManagerName[] = ["bun", "pnpm", "yarn", "npm"];
const SCRIPT_CAPABILITIES = ["setup", "dev", "test", "lint", "typecheck", "build"] as const;
const COMPOSED_VERIFY = ["lint", "typecheck", "test"] as const;

const FROZEN_INSTALL: Readonly<Record<PackageManagerName, readonly string[]>> = {
  bun: ["bun", "install", "--frozen-lockfile"],
  pnpm: ["pnpm", "install", "--frozen-lockfile"],
  yarn: ["yarn", "install", "--immutable"],
  npm: ["npm", "ci"],
};

const UNRESOLVED = { status: "unresolved" } as const;

const runScript = (pm: PackageManagerName, script: string) => [pm, "run", script];
const spec = (...commands: (readonly string[])[]): CommandSpec => ({ commands, cwd: "." });
const shown = (command: readonly string[]) => command.join(" ");

/**
 * Splits a declared command string into an argument list. A string that needs a shell (pipes,
 * `&&`, redirects, variables) is kept whole behind `sh -c`, so it runs as the maintainer wrote it.
 */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/[|&;<>$`\\()*?~]/.test(char)) {
      return ["sh", "-c", command];
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote !== null) return ["sh", "-c", command];
  if (started) args.push(current);
  return args;
}

/** Applies a package-manager-dependent build to every package manager the scan holds possible. */
function viaPackageManager(
  pm: Resolution<PackageManager>,
  origin: Omit<Candidate<CommandSpec>, "value">,
  build: (name: PackageManagerName) => CommandSpec,
): Resolution<CommandSpec> {
  if (pm.status === "resolved")
    return { status: "resolved", ...origin, value: build(pm.value.name) };
  if (pm.status === "conflict") {
    return {
      status: "conflict",
      candidates: pm.candidates.map((candidate) => ({
        ...origin,
        evidence: `${origin.evidence}, if the package manager is ${candidate.value.name} (${candidate.evidence})`,
        value: build(candidate.value.name),
      })),
    };
  }
  return UNRESOLVED;
}

function resolvePackageManager(
  root: Manifest,
  lockfiles: readonly string[],
  deviations: Deviation[],
): Resolution<PackageManager> {
  const candidates: Candidate<PackageManager>[] = [];
  let conflict = false;

  const field = root.packageManager;
  if (field !== null) {
    const at = field.indexOf("@", 1);
    const name = at === -1 ? field : field.slice(0, at);
    const version = at === -1 ? null : (field.slice(at + 1).split("+")[0] ?? null);
    if ((PACKAGE_MANAGERS as readonly string[]).includes(name)) {
      candidates.push({
        value: { name: name as PackageManagerName, version },
        source: "declared",
        confidence: "high",
        evidence: `${ROOT_MANIFEST} packageManager`,
      });
    } else {
      deviations.push({
        code: "package-manager-unknown",
        conflict: false,
        message: `packageManager "${field}" names no package manager the scan knows (bun, pnpm, yarn, npm).`,
      });
    }
  }

  const byManager = new Map<PackageManagerName, string[]>();
  for (const [name, manager] of LOCKFILES) {
    if (lockfiles.includes(name)) byManager.set(manager, [...(byManager.get(manager) ?? []), name]);
  }
  if ((byManager.get("bun") ?? []).length > 1) {
    deviations.push({
      code: "lockfile-bun-both",
      conflict: false,
      message: "Both bun.lock and bun.lockb are present. Remove bun.lockb.",
    });
  }
  if (byManager.size > 1) {
    conflict = true;
    const names = [...byManager.values()].flat();
    deviations.push({
      code: "lockfile-conflict",
      conflict: true,
      message: `Lockfiles of more than one package manager are present (${names.join(", ")}). Remove the ones not in use.`,
    });
  }
  const fieldCandidate = candidates[0];
  for (const [manager, names] of byManager) {
    if (fieldCandidate !== undefined && fieldCandidate.value.name !== manager) {
      conflict = true;
      deviations.push({
        code: "package-manager-mismatch",
        conflict: true,
        message: `packageManager says ${fieldCandidate.value.name}, but ${names.join(", ")} belongs to ${manager}. Fix the field or the lockfile.`,
      });
    }
    if (!candidates.some((c) => c.value.name === manager)) {
      candidates.push({
        value: { name: manager, version: null },
        source: "standard",
        confidence: "high",
        evidence: names.join(", "),
      });
    }
  }

  if (conflict) return { status: "conflict", candidates };
  const first = candidates[0];
  if (first !== undefined) return { status: "resolved", ...first };
  return {
    status: "resolved",
    value: { name: "npm", version: null },
    source: "default",
    confidence: "low",
    evidence: "no packageManager field and no lockfile",
  };
}

function resolveRuntime(probe: Probe, root: Manifest): Resolution<string> {
  for (const name of [".node-version", ".nvmrc"]) {
    const value = probe.texts[name]?.trim();
    if (value !== undefined && value !== "") {
      return { status: "resolved", value, source: "declared", confidence: "high", evidence: name };
    }
  }
  const engine = root.engines["node"];
  if (engine !== undefined) {
    return {
      status: "resolved",
      value: engine,
      source: "declared",
      confidence: "medium",
      evidence: `${ROOT_MANIFEST} engines.node`,
    };
  }
  return UNRESOLVED;
}

const norm = (text: string) => text.trim().replace(/\s+/g, " ");

/** True when a declared verify list says the same as the `verify` script. */
function sameVerify(
  script: string,
  declared: readonly string[],
  pms: readonly PackageManagerName[],
): boolean {
  const list = declared.map(norm);
  if (list.length === 1 && pms.some((pm) => list[0] === `${pm} run verify`)) return true;
  const steps = script.split("&&").map(norm);
  return steps.length === list.length && steps.every((step, i) => step === list[i]);
}

function resolveVerify(
  root: Manifest,
  workflow: Workflow | null,
  pm: Resolution<PackageManager>,
  deviations: Deviation[],
): Resolution<CommandSpec> {
  const script = root.scripts["verify"];
  const declared = workflow?.verify ?? [];
  const declaredResolution: Resolution<CommandSpec> = {
    status: "resolved",
    value: spec(...declared.map(splitCommand)),
    source: "declared",
    confidence: "high",
    evidence: `${WORKFLOW_FILE} verify`,
  };
  const pmNames =
    pm.status === "resolved"
      ? [pm.value.name]
      : pm.status === "conflict"
        ? pm.candidates.map((c) => c.value.name)
        : [];

  if (script !== undefined) {
    const fromScript = viaPackageManager(
      pm,
      { source: "standard", confidence: "high", evidence: `${ROOT_MANIFEST} scripts.verify` },
      (name) => spec(runScript(name, "verify")),
    );
    if (declared.length > 0 && !sameVerify(script, declared, pmNames)) {
      deviations.push({
        code: "verify-conflict",
        conflict: true,
        message: `The "verify" script runs \`${script}\`, but ${WORKFLOW_FILE} declares verify as ${declared.join(", ")}. Make the "verify" script run the gate, and rename any other use of the name (for example to "verify:puzzle").`,
      });
      const fromScriptCandidates =
        fromScript.status === "resolved"
          ? [fromScript]
          : fromScript.status === "conflict"
            ? fromScript.candidates
            : [];
      return {
        status: "conflict",
        candidates: [
          ...fromScriptCandidates.map(({ value, source, confidence, evidence }) => ({
            value,
            source,
            confidence,
            evidence,
          })),
          {
            value: declaredResolution.value,
            source: declaredResolution.source,
            confidence: declaredResolution.confidence,
            evidence: declaredResolution.evidence,
          },
        ],
      };
    }
    return fromScript;
  }

  const composed = COMPOSED_VERIFY.filter((name) => root.scripts[name] !== undefined);
  if (declared.length > 0) {
    if (pm.status === "resolved") {
      const wouldCompose = composed.map((name) => shown(runScript(pm.value.name, name)));
      const same =
        wouldCompose.length === declared.length && wouldCompose.every((c, i) => c === declared[i]);
      if (!same && composed.length > 0) {
        deviations.push({
          code: "verify-declared-differs",
          conflict: false,
          message: `${WORKFLOW_FILE} declares verify as ${declared.join(", ")}; composing it would run ${wouldCompose.join(", ")}. Add a "verify" script with the gate you want.`,
        });
      }
    }
    return declaredResolution;
  }

  if (composed.length > 0) {
    deviations.push({
      code: "verify-composed",
      conflict: false,
      message: `No "verify" script: verify is composed from ${composed.join(", ")}. Add a root "verify" script that runs the full gate.`,
    });
    return viaPackageManager(
      pm,
      {
        source: "composed",
        confidence: "medium",
        evidence: composed.map((name) => `${ROOT_MANIFEST} scripts.${name}`).join(", "),
      },
      (name) => spec(...composed.map((step) => runScript(name, step))),
    );
  }
  return UNRESOLVED;
}

/** The message `run` refuses with when verify is not resolved (0013 amendment of 2026-10-11). */
function refusal(
  verify: Resolution<CommandSpec>,
  hasManifest: boolean,
  deviations: readonly Deviation[],
): string | null {
  if (verify.status === "resolved") return null;
  if (!hasManifest) {
    return 'Verify is unresolved: this repository has no package.json. Add a package.json with a "verify" script that runs the checks a story must pass before review.';
  }
  if (verify.status === "unresolved") {
    return 'Verify is unresolved: add a "verify" script to package.json that runs the checks a story must pass before review (or add "lint", "typecheck" and "test" scripts to compose it from).';
  }
  const conflicts = deviations.filter((d) => d.conflict).map((d) => d.message);
  return `Verify is in conflict, so runs are refused until it is fixed: ${conflicts.join(" ")}`;
}

function emptyCapabilities(): Record<CapabilityName, Resolution<CommandSpec>> {
  return Object.fromEntries(CAPABILITIES.map((name) => [name, UNRESOLVED])) as Record<
    CapabilityName,
    Resolution<CommandSpec>
  >;
}

function nonStandard(probe: Probe, deviation: Deviation): RunProfile {
  const capabilities = emptyCapabilities();
  return {
    fingerprint: fingerprint(probe),
    toolchain: { packageManager: UNRESOLVED, runtimeVersion: UNRESOLVED, workspaces: [] },
    capabilities,
    extraScripts: [],
    envFiles: probe.envFiles,
    devPorts: [],
    conformance: { level: "non-standard", deviations: [deviation] },
    runRefusal: refusal(capabilities.verify, false, []),
  };
}

/** Turns the file facts of a checkout into its run profile. Pure, runs nothing. */
export function detect(probe: Probe, options: DetectOptions = {}): RunProfile {
  const rootText = probe.texts[ROOT_MANIFEST];
  if (rootText === undefined) {
    return nonStandard(probe, {
      code: "no-package-json",
      conflict: false,
      message: "No root package.json: code detection covers Node-family repositories only.",
    });
  }
  const root = parseManifest(rootText);
  if (root === null) {
    return nonStandard(probe, {
      code: "package-json-invalid",
      conflict: false,
      message: "The root package.json is not a JSON object.",
    });
  }

  const deviations: Deviation[] = [];
  const workflowText = probe.texts[WORKFLOW_FILE];
  const workflow = workflowText === undefined ? null : parseWorkflow(workflowText);
  if (workflowText !== undefined && workflow === null) {
    deviations.push({
      code: "workflow-invalid",
      conflict: false,
      message: `${WORKFLOW_FILE} is not a JSON object and was ignored.`,
    });
  }

  const workspaces = probe.workspaceDirs.flatMap((dir) => {
    const text = probe.texts[joinPath(dir, "package.json")];
    const manifest = text === undefined ? null : parseManifest(text);
    return manifest === null ? [] : [{ dir, manifest }];
  });

  const packageManager = resolvePackageManager(root, probe.lockfiles, deviations);
  if (probe.lockfiles.length === 0) {
    deviations.push({
      code: "no-lockfile",
      conflict: false,
      message: "No lockfile: commit the package manager's lockfile so installs are reproducible.",
    });
  }

  const capabilities = emptyCapabilities();
  const relies: string[] = [];
  if (workflow !== null && workflow.install !== null) {
    capabilities.install = {
      status: "resolved",
      value: spec(splitCommand(workflow.install)),
      source: "declared",
      confidence: "high",
      evidence: `${WORKFLOW_FILE} worktree.install`,
    };
    relies.push("install");
  } else {
    capabilities.install = viaPackageManager(
      packageManager,
      { source: "standard", confidence: "high", evidence: "frozen install of the package manager" },
      (name) => spec(FROZEN_INSTALL[name]),
    );
  }
  for (const name of SCRIPT_CAPABILITIES) {
    if (root.scripts[name] === undefined) continue;
    capabilities[name] = viaPackageManager(
      packageManager,
      { source: "standard", confidence: "high", evidence: `${ROOT_MANIFEST} scripts.${name}` },
      (pm) => spec(runScript(pm, name)),
    );
  }
  capabilities.verify = resolveVerify(root, workflow, packageManager, deviations);
  if (capabilities.verify.status === "resolved" && capabilities.verify.source === "declared") {
    relies.push("verify");
  }
  if (relies.length > 0) {
    deviations.push({
      code: "relies-on-workflow",
      conflict: false,
      message: `Still relies on ${WORKFLOW_FILE} for ${relies.join(" and ")}.`,
    });
  }

  if (root.scripts["test"] === undefined) {
    deviations.push({
      code: "missing-test",
      conflict: false,
      message: 'No "test" script. Add one: it is required.',
    });
  }
  if (root.scripts["dev"] === undefined && options.nothingToStart !== true) {
    deviations.push({
      code: "missing-dev",
      conflict: false,
      message: 'No "dev" script. Add one, or mark the product as having nothing to start.',
    });
  }
  for (const name of ["lint", "typecheck"] as const) {
    if (root.scripts[name] === undefined) {
      deviations.push({
        code: `missing-${name}`,
        conflict: false,
        message: `No "${name}" script (recommended).`,
      });
    }
  }
  const format = root.scripts["format"];
  if (format !== undefined && !/check/.test(format)) {
    deviations.push({
      code: "format-writes",
      conflict: false,
      message: `"format" runs \`${format}\`, which looks like it rewrites files. "format" checks only; move the writing variant to "format:fix".`,
    });
  }

  const hasSetup = root.scripts["setup"] !== undefined;
  for (const file of probe.envFiles) {
    if (file.example !== null && !file.present && !hasSetup) {
      deviations.push({
        code: `env-file-missing:${file.path}`,
        conflict: false,
        message: `${file.path} absent, ${file.example} present.`,
      });
    }
    if (file.present && !file.ignored) {
      deviations.push({
        code: `env-file-not-ignored:${file.path}`,
        conflict: false,
        message: `${file.path} is present but git does not ignore it.`,
      });
    }
  }

  const devPorts = detectPorts(probe, root, workspaces);
  const fixed = devPorts.filter((port) => port.fixedInCode && !port.honoursPort);
  for (const port of fixed) {
    deviations.push({
      code: `fixed-port:${port.dir}:${port.port}`,
      conflict: false,
      message: `dev in ${port.dir} uses fixed port ${port.port} (${port.evidence}); let PORT override it so parallel worktrees do not collide.`,
    });
  }

  const extraScripts = Object.entries(root.scripts)
    .filter(([name]) => !(CAPABILITIES as readonly string[]).includes(name))
    .map(([name, command]) => ({ name, command }));

  const scriptResolved = (
    ["setup", "dev", "test", "lint", "typecheck", "verify", "build"] as const
  ).some((name) => capabilities[name].status !== "unresolved");
  let level: ConformanceLevel = "partial";
  if (!scriptResolved) level = "non-standard";
  else if (
    probe.lockfiles.length > 0 &&
    packageManager.status === "resolved" &&
    capabilities.test.status === "resolved" &&
    (capabilities.dev.status === "resolved" || options.nothingToStart === true) &&
    capabilities.verify.status === "resolved" &&
    fixed.length === 0
  ) {
    level = "conforming";
  }

  return {
    fingerprint: fingerprint(probe),
    toolchain: {
      packageManager,
      runtimeVersion: resolveRuntime(probe, root),
      workspaces: workspaces.map(({ dir, manifest }) => ({ dir, name: manifest.name })),
    },
    capabilities,
    extraScripts,
    envFiles: probe.envFiles,
    devPorts,
    conformance: { level, deviations },
    runRefusal: refusal(capabilities.verify, true, deviations),
  };
}
