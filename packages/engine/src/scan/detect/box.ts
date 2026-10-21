// The box toolchain a repository asks for (0021 section 5, DIPO-266): which tools its box needs
// and the exact versions the repository pins for them, read from the scan's probe and toolchain.
// dipo fills a tool without a pinned version from its own defaults (`box/image.ts`), so a new
// office needs no hand-written box block. Pure.

import { BUN_VERSION_FILE, ROOT_MANIFEST } from "./manifest";
import type { PackageManager, PackageManagerName, Probe, Resolution, Toolchain } from "./types";

/** The tools a box image can carry. npm comes with Node. */
export const BOX_TOOLS = ["node", "bun", "pnpm", "yarn"] as const;
export type BoxTool = (typeof BOX_TOOLS)[number];

/** One tool the repository needs in its box. */
export interface DetectedBoxTool {
  /** The exact version (x.y.z) the repository pins, or null when it pins none. */
  readonly version: string | null;
  /** Where the version, or the need for the tool, was read, for the maintainer. */
  readonly evidence: string;
}

/** The tools the repository needs in its box; a tool it does not need is absent. */
export type DetectedBoxToolchain = Partial<Readonly<Record<BoxTool, DetectedBoxTool>>>;

const EXACT = /^v?(\d+\.\d+\.\d+)$/;

/** `1.4.2` from `1.4.2`, `v1.4.2` or `bun-v1.4.2`; null for a range, a major or anything else. */
export function exactVersion(text: string | null | undefined): string | null {
  const trimmed = text?.trim().replace(/^bun-/, "");
  if (trimmed === undefined) return null;
  return EXACT.exec(trimmed)?.[1] ?? null;
}

/** Every package manager the scan names: the resolved one, or each candidate of a conflict. */
function managersOf(resolution: Resolution<PackageManager>): PackageManager[] {
  if (resolution.status === "resolved") return [resolution.value];
  if (resolution.status === "conflict") return resolution.candidates.map((c) => c.value);
  return [];
}

function managerVersion(managers: readonly PackageManager[], name: PackageManagerName) {
  return exactVersion(managers.find((manager) => manager.name === name)?.version);
}

/**
 * The tools the repository needs in its box, with the versions it pins. The probe must be of the
 * same base commit the box block was read from (`readBaseBoxSection`), never of a story's checkout
 * or branch, so a story cannot change its own box; `readBaseBox` reads both from one commit.
 */
export function detectBoxToolchain(probe: Probe, toolchain: Toolchain): DetectedBoxToolchain {
  const managers = managersOf(toolchain.packageManager);
  const uses = (name: PackageManagerName) => managers.some((manager) => manager.name === name);
  const detected: Partial<Record<BoxTool, DetectedBoxTool>> = {};

  const runtime = toolchain.runtimeVersion;
  const node = runtime.status === "resolved" ? exactVersion(runtime.value) : null;
  detected.node =
    node !== null && runtime.status === "resolved"
      ? { version: node, evidence: runtime.evidence }
      : {
          version: null,
          evidence: "no exact Node version in .node-version, .nvmrc or engines.node",
        };

  const bunFile = exactVersion(probe.texts[BUN_VERSION_FILE]);
  const bunField = managerVersion(managers, "bun");
  if (bunFile !== null) {
    detected.bun = { version: bunFile, evidence: BUN_VERSION_FILE };
  } else if (bunField !== null) {
    detected.bun = { version: bunField, evidence: `${ROOT_MANIFEST} packageManager` };
  } else if (uses("bun") || probe.texts[BUN_VERSION_FILE] !== undefined) {
    detected.bun = { version: null, evidence: "bun is the package manager; no exact version" };
  }

  if (uses("pnpm")) {
    const version = managerVersion(managers, "pnpm");
    detected.pnpm =
      version === null
        ? { version: null, evidence: "pnpm is the package manager; no exact version" }
        : { version, evidence: `${ROOT_MANIFEST} packageManager` };
  }

  if (uses("yarn")) {
    // Only Yarn 1 installs from npm; a Yarn 2+ repository runs its committed release through it.
    const version = managerVersion(managers, "yarn");
    detected.yarn =
      version !== null && version.startsWith("1.")
        ? { version, evidence: `${ROOT_MANIFEST} packageManager` }
        : { version: null, evidence: "yarn is the package manager; no Yarn 1 version" };
  }
  return detected;
}
