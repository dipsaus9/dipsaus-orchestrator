// `readProbe` collects the file facts `detect` and `fingerprint` need from a checkout. It reads
// manifests and config files, checks env files by path only (presence, ignore status), and runs
// no repository script (0013 sections 3, 4 and 7).

import { posix } from "node:path";

import { createRepoFiles, type RepoFiles } from "../../platform/repo-files";
import {
  baseName,
  dirOf,
  expandWorkspaces,
  importSpecifiers,
  isConfigFile,
  isViteConfig,
  joinPath,
  LOCKFILES,
  parseExports,
  parseManifest,
  parsePnpmWorkspacePackages,
  parseWorkflow,
  PNPM_WORKSPACE,
  ROOT_MANIFEST,
  RUNTIME_FILES,
  WORKFLOW_FILE,
} from "./manifest";
import type { EnvFile, Probe } from "./types";

const MODULE_EXTENSIONS = ["", ".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"];

const inNodeModules = (path: string) => path.split("/").includes("node_modules");

/** The expected real file of an env example: the path with `.example` removed from its name. */
export function realFileOf(example: string): string {
  const name = baseName(example).replace(".example", "");
  return joinPath(dirOf(example), name);
}

export const isEnvExample = (path: string) => baseName(path).includes(".example");

function firstExisting(base: string, files: ReadonlySet<string>): string | undefined {
  for (const ext of MODULE_EXTENSIONS) {
    if (files.has(base + ext)) return base + ext;
  }
  for (const ext of MODULE_EXTENSIONS.slice(1)) {
    if (files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  return undefined;
}

/** The file an `exports` entry points at, preferring the import condition. */
function pick(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["import", "default", "node", "types"]) {
      const found = pick(record[key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function exportTarget(exports: unknown, subpath: string): string | undefined {
  if (typeof exports === "string") return subpath === "." ? exports : undefined;
  if (typeof exports !== "object" || exports === null || Array.isArray(exports)) return undefined;
  const map = exports as Record<string, unknown>;
  if (!Object.keys(map).some((key) => key.startsWith("."))) {
    return subpath === "." ? pick(map) : undefined;
  }
  if (subpath in map) return pick(map[subpath]);
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= key.length - 1
    ) {
      const target = pick(value);
      const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
      if (target !== undefined) return target.replaceAll("*", middle);
    }
  }
  return undefined;
}

type WorkspaceInfo = { dir: string; name: string | null; exports: unknown };

/** Resolves an import in a config file to a repo file, for relative and workspace imports. */
function resolveImport(
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
  workspaces: readonly WorkspaceInfo[],
): string | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = posix.normalize(posix.join(dirOf(from), specifier));
    return base.startsWith("../") ? undefined : firstExisting(base, files);
  }
  for (const pkg of workspaces) {
    if (pkg.name === null) continue;
    if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue;
    const subpath = specifier === pkg.name ? "." : `./${specifier.slice(pkg.name.length + 1)}`;
    const target = exportTarget(pkg.exports, subpath) ?? subpath;
    const base = posix.normalize(posix.join(pkg.dir, target));
    return base.startsWith("../") ? undefined : firstExisting(base, files);
  }
  return undefined;
}

/**
 * Reads the probe of the checkout at `dir`. `files` defaults to the platform's git-backed file
 * facts; tests may pass their own.
 */
export async function readProbe(
  dir: string,
  files: RepoFiles = createRepoFiles(dir),
): Promise<Probe> {
  const listed = (await files.listFiles()).filter((path) => !inNodeModules(path));
  const fileSet = new Set(listed);
  const workflowText = await files.readText(WORKFLOW_FILE);
  const workflow = workflowText === undefined ? null : parseWorkflow(workflowText);

  // Env files: by path only (0013 section 4). They are known before anything else is read, so
  // `read` can refuse every env path, even one whose name looks like a config file.
  const candidates: { example: string | null; path: string }[] = [];
  for (const example of listed.filter(isEnvExample)) {
    candidates.push({ example, path: realFileOf(example) });
  }
  for (const path of workflow?.includeGitignored ?? []) {
    const clean = posix.normalize(path).replace(/^\.\//, "");
    if (clean.startsWith("../") || candidates.some((c) => c.path === clean)) continue;
    candidates.push({ example: null, path: clean });
  }
  const envPaths = new Set(candidates.map((c) => c.path));

  const texts: Record<string, string> = {};
  if (workflowText !== undefined) texts[WORKFLOW_FILE] = workflowText;
  const read = async (path: string) => {
    if (isEnvExample(path) || envPaths.has(path)) return undefined;
    if (path in texts) return texts[path];
    const text = await files.readText(path);
    if (text !== undefined) texts[path] = text;
    return text;
  };

  const rootText = await read(ROOT_MANIFEST);
  const root = rootText === undefined ? null : parseManifest(rootText);
  const pnpmText = await read(PNPM_WORKSPACE);
  for (const name of RUNTIME_FILES) await read(name);

  const lockfiles: string[] = [];
  for (const [name] of LOCKFILES) {
    if (await files.exists(name)) lockfiles.push(name);
  }

  const patterns = [
    ...(root?.workspaces ?? []),
    ...(pnpmText === undefined ? [] : parsePnpmWorkspacePackages(pnpmText)),
  ];
  const manifestDirs = listed.filter((path) => baseName(path) === "package.json").map(dirOf);
  const workspaceDirs = expandWorkspaces(patterns, manifestDirs);
  const workspaces: WorkspaceInfo[] = [];
  for (const wsDir of workspaceDirs) {
    const text = await read(joinPath(wsDir, "package.json"));
    workspaces.push({
      dir: wsDir,
      name: text === undefined ? null : (parseManifest(text)?.name ?? null),
      exports: text === undefined ? null : parseExports(text),
    });
  }

  const packageDirs = new Set(["", ...workspaceDirs]);
  const configFiles = listed.filter(
    (path) => packageDirs.has(dirOf(path)) && isConfigFile(baseName(path)),
  );
  const configImports: Record<string, string[]> = {};
  for (const config of configFiles) {
    const text = await read(config);
    if (text === undefined || !isViteConfig(baseName(config))) continue;
    const resolved: string[] = [];
    for (const specifier of importSpecifiers(text)) {
      const target = resolveImport(config, specifier, fileSet, workspaces);
      if (target === undefined || resolved.includes(target)) continue;
      if ((await read(target)) !== undefined) resolved.push(target);
    }
    if (resolved.length > 0) configImports[config] = resolved;
  }

  const ignored = await files.ignored(candidates.map((c) => c.path));
  const envFiles: EnvFile[] = [];
  for (const candidate of candidates) {
    envFiles.push({
      example: candidate.example,
      path: candidate.path,
      present: await files.exists(candidate.path),
      ignored: ignored.has(candidate.path),
    });
  }
  const sorted = envFiles.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { texts, lockfiles, workspaceDirs, configImports, envFiles: sorted };
}
