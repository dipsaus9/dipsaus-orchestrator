// The first layer of the package cache fill (DIPO-267): cheap checks of what the base branch hands
// the fill, before any box starts. The fill box is the boundary; these checks refuse, with
// `box.cacheUnsupported`, what a registry-only cache has no use for and what could steer the fill
// box beyond the registries:
//
// - a dependency that is not a registry package: git (`git+ssh:`, `github:`, an `owner/repo`
//   shorthand), an http(s) tarball URL, `file:` or `link:`, in a manifest or in the lockfile;
// - a lockfile that names any host but an npm registry Safe-Chain checks: `bun.lock`'s registry
//   field, npm's `resolved` (also in the legacy tree) and pnpm's `resolution.tarball` are the
//   fields that name one; a top-level lockfile field dipo does not know is refused, and the other
//   entry fields (integrity, engines, platforms, bins) name no source;
// - a workspace glob or a workspace path that is absolute or holds `..`;
// - for pnpm, any `pnpm-workspace.yaml` key other than `packages` (such as `configDependencies`
//   or `pnpmfile`, which run code). The fill gets a workspace file dipo writes from `packages`.
//
// Pure: no I/O.

import { posix } from "node:path";

import { stringifyYamlDocument, parseYamlDocument } from "../platform/yaml";
import { SAFE_CHAIN_NPM_HOSTS } from "./safe-chain";
import { PNPM_WORKSPACE, ROOT_MANIFEST } from "../scan/detect/manifest";
import { BoxError } from "./port";

/** The package managers whose cache dipo fills. */
export type CacheManager = "bun" | "npm" | "pnpm";

/** One file of the project, as committed on the base. */
export interface ProjectFile {
  readonly path: string;
  readonly text: string;
}

/** The lockfile and the project files a frozen install needs, as committed on the base. */
export interface BaseLockfile {
  /** The base commit everything was read from. */
  readonly commit: string;
  /** Null when the base has no lockfile: the cache is empty. */
  readonly lockfile: {
    readonly name: string;
    readonly manager: CacheManager;
    readonly text: string;
  } | null;
  /** Every `package.json` (outside `node_modules`) and, for pnpm, `pnpm-workspace.yaml`. */
  readonly files: readonly ProjectFile[];
}

/** The dependency maps of a manifest whose values are package specs. */
const DEPENDENCY_MAPS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
/** Manifest fields whose string values, at any depth, are package specs. */
const OVERRIDE_MAPS = ["overrides", "resolutions"] as const;

/**
 * Specs that do not come from a registry. A leading `~` is refused as a home folder path when only
 * spaces stand between it and a slash or the end; `~1.2.3` is a tilde version range.
 */
const NON_REGISTRY =
  /^(?:git(?:\+[a-z]+)?:|git@|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:|portal:|patch:|[./\\]|~\s*(?:[/\\]|$))/i;
/** `owner/repo` (GitHub) without a protocol. */
const SHORTHAND = /^[^@:\s/]+\/\S+$/;

function refuse(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new BoxError("box.cacheUnsupported", message, false, details);
}

/** A relative path inside the project: not absolute, no `.`, `..` or empty part. */
export function isProjectPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** A workspace glob that stays in the project (a leading `!` excludes and is allowed). */
export function isProjectGlob(glob: string): boolean {
  const body = glob.startsWith("!") ? glob.slice(1) : glob;
  const trimmed = body.startsWith("./") ? body.slice(2) : body;
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith("/") &&
    !trimmed.includes("\\") &&
    !trimmed.includes("\0") &&
    trimmed.split("/").every((part) => part !== ".." && part !== "")
  );
}

/** True when `spec` names a registry package (a version, a range, a tag, an alias, a workspace). */
export function isRegistrySpec(spec: string): boolean {
  const value = spec.trim();
  if (value.startsWith("npm:")) {
    const aliased = value.slice(4);
    const at = aliased.indexOf("@", 1);
    return at < 0 || isRegistrySpec(aliased.slice(at + 1));
  }
  if (value.startsWith("workspace:")) {
    const target = value.slice("workspace:".length);
    return /^[*^~]?$/.test(target) || /^[\d^~<>=*]/.test(target) || isProjectPath(target);
  }
  if (value.startsWith("catalog:")) return true;
  return !NON_REGISTRY.test(value) && !SHORTHAND.test(value);
}

/**
 * An https URL on an npm registry Safe-Chain checks, with no port, credentials, query or
 * fragment; null otherwise.
 */
function registryUrl(url: string): URL | null {
  if (url.includes("?") || url.includes("#")) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    (SAFE_CHAIN_NPM_HOSTS as readonly string[]).includes(parsed.hostname)
    ? parsed
    : null;
}

/** A registry tarball: https on an npm registry Safe-Chain checks, at its `/-/` path. */
export function isRegistryTarball(url: string): boolean {
  const parsed = registryUrl(url);
  return parsed !== null && parsed.pathname.includes("/-/") && parsed.pathname.endsWith(".tgz");
}

/**
 * The registry of a `bun.lock` package entry (its second field): empty for the default registry,
 * or the base URL of an npm registry Safe-Chain checks.
 */
export function isBunRegistry(value: unknown): boolean {
  return value === "" || (typeof value === "string" && registryUrl(value) !== null);
}

/** An exact version, as a lockfile records a registry package. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

/**
 * A version as pnpm records a registry package: exact, with an optional peer suffix in brackets,
 * or as `name@version` for an alias.
 */
export function isPnpmVersion(value: string): boolean {
  const bare = value.replace(/\(.*\)$/, "");
  const at = bare.lastIndexOf("@");
  const version = at > 0 ? bare.slice(at + 1) : bare;
  return (
    EXACT_VERSION.test(version) &&
    (at <= 0 || /^(?:@[^@/\s]+\/)?[^@/\s:]+$/.test(bare.slice(0, at)))
  );
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function checkSpec(where: string, name: string, spec: unknown): void {
  if (typeof spec === "string" && !isRegistrySpec(spec)) {
    refuse(
      `${where}: ${name} is not a registry package (${spec}); dipo fills the cache from registries only.`,
      {
        where,
        name,
        spec,
      },
    );
  }
}

function checkGlobs(where: string, globs: unknown): readonly string[] {
  if (globs === undefined) return [];
  if (!Array.isArray(globs)) refuse(`${where}: the workspaces are not a list.`, { where });
  for (const glob of globs) {
    if (typeof glob !== "string" || !isProjectGlob(glob)) {
      refuse(`${where}: the workspace ${JSON.stringify(glob)} leaves the project.`, {
        where,
        glob,
      });
    }
  }
  return globs as string[];
}

function checkOverrides(where: string, value: unknown): void {
  for (const [name, spec] of Object.entries(record(value))) {
    if (typeof spec === "string") checkSpec(where, name, spec);
    else checkOverrides(where, spec);
  }
}

function checkManifest(file: ProjectFile): void {
  let manifest: Readonly<Record<string, unknown>>;
  try {
    manifest = record(JSON.parse(file.text));
  } catch {
    refuse(`${file.path} is not JSON.`, { path: file.path });
  }
  for (const map of DEPENDENCY_MAPS) {
    for (const [name, spec] of Object.entries(record(manifest[map]))) {
      checkSpec(file.path, name, spec);
    }
  }
  for (const map of OVERRIDE_MAPS) checkOverrides(file.path, manifest[map]);
  const workspaces = manifest["workspaces"];
  checkGlobs(file.path, Array.isArray(workspaces) ? workspaces : record(workspaces)["packages"]);
}

/**
 * `text` without the commas before a closing `}` or `]`, which Bun writes in `bun.lock`; commas
 * inside strings are kept. Comments are not removed: a lockfile with them is not readable.
 */
export function withoutTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[at + 1] ?? "";
        at += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    if (char === ",") {
      let next = at + 1;
      while (next < text.length && /\s/.test(text[next]!)) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    out += char;
  }
  return out;
}

/** The spec of a Bun lockfile identity, `name@spec` (the name may be scoped). */
function specOf(ident: string): string {
  const at = ident.indexOf("@", 1);
  return at < 0 ? "" : ident.slice(at + 1);
}

/** Refuses a top-level key of `name` that is not in `known`: no field outside them is read. */
function checkKeys(
  name: string,
  value: Readonly<Record<string, unknown>>,
  known: readonly string[],
) {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      refuse(`${name} has the field ${key}, which dipo does not check.`, { lockfile: name, key });
    }
  }
}

/** The `bun.lock` fields dipo knows; none of them but the ones checked names a source. */
const BUN_LOCK_KEYS = [
  "lockfileVersion",
  "configVersion",
  "workspaces",
  "packages",
  "overrides",
  "catalog",
  "catalogs",
  "trustedDependencies",
  "patchedDependencies",
];

/**
 * `bun.lock`: every workspace in the project with registry specs, and every package either a
 * workspace package or a registry package at an exact version whose registry field is empty (the
 * default registry) or an npm registry Safe-Chain checks, with registry specs for its own
 * dependencies. Overrides and catalogs hold registry specs only.
 */
function checkBunLock(text: string): void {
  let lock: Readonly<Record<string, unknown>>;
  try {
    lock = record(JSON.parse(withoutTrailingCommas(text)));
  } catch {
    refuse("bun.lock is not readable.");
  }
  checkKeys("bun.lock", lock, BUN_LOCK_KEYS);
  for (const [path, workspace] of Object.entries(record(lock["workspaces"]))) {
    if (path !== "" && !isProjectPath(path)) {
      refuse(`bun.lock names the workspace ${JSON.stringify(path)} outside the project.`, { path });
    }
    for (const map of DEPENDENCY_MAPS) {
      for (const [name, spec] of Object.entries(record(record(workspace)[map]))) {
        checkSpec("bun.lock", name, spec);
      }
    }
  }
  for (const map of ["overrides", "catalog", "catalogs"]) checkOverrides("bun.lock", lock[map]);
  for (const [key, entry] of Object.entries(record(lock["packages"]))) {
    const fields: readonly unknown[] = Array.isArray(entry) ? entry : [];
    const ident = fields[0];
    if (typeof ident !== "string") refuse(`bun.lock entry ${key} is not readable.`, { key });
    const spec = specOf(ident);
    if (spec.startsWith("workspace:")) {
      checkSpec("bun.lock", key, spec);
      continue;
    }
    if (!EXACT_VERSION.test(spec)) {
      refuse(`bun.lock resolves ${key} to ${spec}, not a registry package.`, { key, spec });
    }
    if (!isBunRegistry(fields[1])) {
      refuse(
        `bun.lock fetches ${key} from ${String(fields[1])}, not a registry Safe-Chain checks.`,
        {
          key,
          registry: fields[1],
        },
      );
    }
    for (const map of DEPENDENCY_MAPS) {
      for (const [name, dependency] of Object.entries(record(record(fields[2])[map]))) {
        checkSpec("bun.lock", name, dependency);
      }
    }
  }
}

/** The `package-lock.json` fields dipo knows. */
const NPM_LOCK_KEYS = [
  "name",
  "version",
  "lockfileVersion",
  "requires",
  "packages",
  "dependencies",
];

/** A `resolved` field: absent, or a registry tarball. */
function checkResolved(key: string, resolved: unknown): void {
  if (resolved !== undefined && (typeof resolved !== "string" || !isRegistryTarball(resolved))) {
    refuse(`package-lock.json resolves ${key} to ${String(resolved)}, not a registry tarball.`, {
      key,
      resolved,
    });
  }
}

/** The legacy `dependencies` tree of a version 2 lockfile, which npm 7 and later do not read. */
function checkNpmLegacy(deps: unknown): void {
  for (const [name, value] of Object.entries(record(deps))) {
    const entry = record(value);
    checkResolved(name, entry["resolved"]);
    const version = entry["version"];
    if (typeof version === "string") {
      const local = version.startsWith("file:") && isProjectPath(version.slice("file:".length));
      const alias = version.startsWith("npm:") && EXACT_VERSION.test(specOf(version.slice(4)));
      if (!local && !alias && !EXACT_VERSION.test(version)) {
        refuse(`package-lock.json resolves ${name} to ${version}, not a registry package.`, {
          name,
          version,
        });
      }
    }
    for (const [dependency, spec] of Object.entries(record(entry["requires"]))) {
      checkSpec("package-lock.json", dependency, spec);
    }
    checkNpmLegacy(entry["dependencies"]);
  }
}

/**
 * `package-lock.json` (version 2 or 3): every package path in the project, every link to a path
 * in the project, every other package at an exact version from a registry tarball on an npm
 * registry Safe-Chain checks, and registry specs for its dependencies.
 */
function checkNpmLock(text: string): void {
  let lock: Readonly<Record<string, unknown>>;
  try {
    lock = record(JSON.parse(text));
  } catch {
    refuse("package-lock.json is not JSON.");
  }
  const version = lock["lockfileVersion"];
  if (typeof version !== "number" || version < 2) {
    refuse("package-lock.json must be lockfileVersion 2 or 3.", { lockfileVersion: version });
  }
  checkKeys("package-lock.json", lock, NPM_LOCK_KEYS);
  for (const [key, value] of Object.entries(record(lock["packages"]))) {
    if (key !== "" && !isProjectPath(key)) {
      refuse(`package-lock.json names ${JSON.stringify(key)} outside the project.`, { key });
    }
    const entry = record(value);
    const resolved = entry["resolved"];
    if (entry["link"] === true) {
      if (typeof resolved !== "string" || !isProjectPath(resolved)) {
        refuse(`package-lock.json links ${key} outside the project.`, { key, resolved });
      }
      continue;
    }
    checkResolved(key, resolved);
    const packageVersion = entry["version"];
    if (
      packageVersion !== undefined &&
      (typeof packageVersion !== "string" || !EXACT_VERSION.test(packageVersion))
    ) {
      refuse(
        `package-lock.json records ${key} at ${String(packageVersion)}, not an exact version.`,
        {
          key,
          version: packageVersion,
        },
      );
    }
    for (const map of DEPENDENCY_MAPS) {
      for (const [name, spec] of Object.entries(record(entry[map]))) {
        checkSpec("package-lock.json", name, spec);
      }
    }
  }
  checkNpmLegacy(lock["dependencies"]);
}

function parseYaml(name: string, text: string): Readonly<Record<string, unknown>> {
  const parsed = parseYamlDocument(text);
  if (!parsed.ok) refuse(`${name} is not readable: ${parsed.message}`);
  return record(parsed.value);
}

/** A pnpm `link:` target from importer `importer`, which must stay in the project. */
function checkPnpmLink(importer: string, version: string): void {
  const target = version.slice("link:".length);
  const joined = posix.normalize(posix.join(importer === "." ? "" : importer, target));
  if (
    target.startsWith("/") ||
    joined === ".." ||
    joined.startsWith("../") ||
    joined.startsWith("/")
  ) {
    refuse(`pnpm-lock.yaml links ${version} outside the project.`, { importer, version });
  }
}

/** A version pnpm resolved a dependency to: a link in the project, or a registry version. */
function checkPnpmVersion(importer: string, name: string, version: unknown): void {
  if (typeof version !== "string") return;
  if (version.startsWith("link:")) checkPnpmLink(importer, version);
  else if (!isPnpmVersion(version)) {
    refuse(`pnpm-lock.yaml resolves ${name} to ${version}, not a registry package.`, {
      name,
      version,
    });
  }
}

/** The `pnpm-lock.yaml` fields dipo knows. */
const PNPM_LOCK_KEYS = [
  "lockfileVersion",
  "settings",
  "importers",
  "packages",
  "snapshots",
  "overrides",
  "catalogs",
  "patchedDependencies",
  "pnpmfileChecksum",
  "packageExtensionsChecksum",
  "ignoredOptionalDependencies",
  "time",
];

/**
 * `pnpm-lock.yaml` (version 9): every importer in the project with registry specifiers and
 * versions or links in the project; every package and snapshot keyed by `name@version`; every
 * package resolved by its integrity alone (pnpm then fetches it from the default registry, as no
 * `.npmrc` reaches the fill) or by a registry tarball on an npm registry Safe-Chain checks.
 */
function checkPnpmLock(text: string): void {
  const lock = parseYaml("pnpm-lock.yaml", text);
  const version = lock["lockfileVersion"];
  if (String(version).split(".")[0] !== "9") {
    refuse("pnpm-lock.yaml must be lockfileVersion 9.", { lockfileVersion: version });
  }
  checkKeys("pnpm-lock.yaml", lock, PNPM_LOCK_KEYS);
  for (const [importer, value] of Object.entries(record(lock["importers"]))) {
    if (importer !== "." && !isProjectPath(importer)) {
      refuse(`pnpm-lock.yaml names the importer ${JSON.stringify(importer)} outside the project.`, {
        importer,
      });
    }
    for (const map of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, dependency] of Object.entries(record(record(value)[map]))) {
        const { specifier, version: resolved } = record(dependency);
        checkSpec("pnpm-lock.yaml", name, specifier);
        checkPnpmVersion(importer, name, resolved);
      }
    }
  }
  checkOverrides("pnpm-lock.yaml", lock["overrides"]);
  for (const catalog of Object.values(record(lock["catalogs"]))) {
    for (const [name, entry] of Object.entries(record(catalog))) {
      checkSpec("pnpm-lock.yaml", name, record(entry)["specifier"]);
      checkPnpmVersion(".", name, record(entry)["version"]);
    }
  }
  for (const section of ["packages", "snapshots"]) {
    for (const [key, value] of Object.entries(record(lock[section]))) {
      if (!isPnpmVersion(key)) {
        refuse(`pnpm-lock.yaml lists ${key}, not a registry package.`, { key });
      }
      for (const map of ["dependencies", "optionalDependencies"]) {
        for (const [name, resolved] of Object.entries(record(record(value)[map]))) {
          checkPnpmVersion(".", name, resolved);
        }
      }
    }
  }
  for (const [key, value] of Object.entries(record(lock["packages"]))) {
    const resolution = record(record(value)["resolution"]);
    for (const field of Object.keys(resolution)) {
      if (field === "integrity") continue;
      if (field === "tarball" && isRegistryTarball(String(resolution["tarball"]))) continue;
      refuse(`pnpm-lock.yaml resolves ${key} by ${field}, not from a registry.`, { key, field });
    }
    if (resolution["integrity"] === undefined) {
      refuse(`pnpm-lock.yaml has no integrity for ${key}.`, { key });
    }
  }
}

/** The workspace file dipo writes for pnpm: `packages` only, after its checks. */
function pnpmWorkspace(text: string): ProjectFile {
  const workspace = parseYaml(PNPM_WORKSPACE, text);
  for (const key of Object.keys(workspace)) {
    if (key !== "packages") {
      refuse(
        `${PNPM_WORKSPACE} sets ${key}; dipo fills a cache only for a workspace file with packages alone.`,
        {
          key,
        },
      );
    }
  }
  const packages = checkGlobs(PNPM_WORKSPACE, workspace["packages"]);
  return { path: PNPM_WORKSPACE, text: stringifyYamlDocument({ packages: [...packages] }) };
}

/**
 * Checks what the base hands the fill and returns the files the fill box gets: the lockfile, the
 * manifests, and for pnpm the workspace file dipo wrote from `packages`. Refuses with
 * `box.cacheUnsupported` anything the module comment lists.
 */
export function checkFillInput(source: BaseLockfile): readonly ProjectFile[] {
  const { lockfile } = source;
  if (lockfile === null) return [];
  const files: ProjectFile[] = [{ path: lockfile.name, text: lockfile.text }];
  for (const file of source.files) {
    if (!isProjectPath(file.path)) refuse(`${JSON.stringify(file.path)} is not a project path.`);
    if (file.path === PNPM_WORKSPACE) {
      if (lockfile.manager === "pnpm") files.push(pnpmWorkspace(file.text));
      continue;
    }
    if (posix.basename(file.path) !== ROOT_MANIFEST) {
      refuse(`${file.path} is not a file the fill takes.`, { path: file.path });
    }
    checkManifest(file);
    files.push(file);
  }
  if (lockfile.manager === "bun") checkBunLock(lockfile.text);
  else if (lockfile.manager === "npm") checkNpmLock(lockfile.text);
  else checkPnpmLock(lockfile.text);
  return files;
}
