// The run profile fingerprint (0013 section 5): a hash over exactly the inputs the profile
// depends on. Lockfile contents are left out on purpose: a dependency change means "install
// again", not "rescan".

import { createHash } from "node:crypto";

import {
  baseName,
  dirOf,
  isConfigFile,
  joinPath,
  parseManifest,
  parsePnpmWorkspacePackages,
  PNPM_WORKSPACE,
  ROOT_MANIFEST,
  RUNTIME_FILES,
  WORKFLOW_FILE,
} from "./manifest";
import type { Probe } from "./types";

/** JSON with object keys sorted, so equal inputs hash equally whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The fingerprint inputs of a probe, in the shape that is hashed. */
export function fingerprintInputs(probe: Probe): Record<string, unknown> {
  const text = (path: string) => probe.texts[path] ?? null;
  const manifests: Record<string, unknown> = {};
  for (const dir of ["", ...probe.workspaceDirs]) {
    const path = dir === "" ? ROOT_MANIFEST : joinPath(dir, "package.json");
    const raw = probe.texts[path];
    if (raw === undefined) continue;
    // An unparsable manifest is hashed as written, so fixing it triggers a rescan.
    manifests[path] = parseManifest(raw)?.fingerprintFields ?? { unparsed: raw };
  }
  const packageDirs = new Set(["", ...probe.workspaceDirs]);
  const configs: Record<string, string> = {};
  for (const [path, content] of Object.entries(probe.texts)) {
    if (packageDirs.has(dirOf(path)) && isConfigFile(baseName(path))) configs[path] = content;
  }
  const pnpm = probe.texts[PNPM_WORKSPACE];
  return {
    manifests,
    workspaceManifest: pnpm === undefined ? null : parsePnpmWorkspacePackages(pnpm),
    lockfiles: [...probe.lockfiles].toSorted(),
    runtime: Object.fromEntries(RUNTIME_FILES.map((name) => [name, text(name)])),
    configs,
    envFiles: probe.envFiles.map((file) => `${file.example ?? ""}=>${file.path}`).toSorted(),
    workflow: text(WORKFLOW_FILE),
  };
}

/** `sha256:<hex>` over the 0013 section 5 inputs of the probe. */
export function fingerprint(probe: Probe): string {
  const hash = createHash("sha256")
    .update(canonical(fingerprintInputs(probe)))
    .digest("hex");
  return `sha256:${hash}`;
}
