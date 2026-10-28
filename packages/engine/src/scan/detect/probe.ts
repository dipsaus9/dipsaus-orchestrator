// `readProbe` collects the file facts `detect` and `fingerprint` need from a checkout. It reads
// manifests and config files, checks env files by path only (presence, ignore status), and runs
// no repository script (0013 sections 3, 4 and 7).

import { posix } from "node:path";

import { createRepoFiles, type RepoFiles } from "../../platform/repo-files";
import {
  baseName,
  BUN_VERSION_FILE,
  dirOf,
  expandWorkspaces,
  isConfigFile,
  joinPath,
  LOCKFILES,
  parseManifest,
  parsePnpmWorkspacePackages,
  parseWorkflow,
  PNPM_WORKSPACE,
  ROOT_MANIFEST,
  RUNTIME_FILES,
  WORKFLOW_FILE,
} from "./manifest";
import type { EnvFile, Probe } from "./types";

const inNodeModules = (path: string) => path.split("/").includes("node_modules");

/** The expected real file of an env example: the path with `.example` removed from its name. */
export function realFileOf(example: string): string {
  const name = baseName(example).replace(".example", "");
  return joinPath(dirOf(example), name);
}

export const isEnvExample = (path: string) => baseName(path).includes(".example");

/**
 * Reads the probe of the checkout at `dir`. `files` defaults to the platform's git-backed file
 * facts; tests may pass their own.
 */
export async function readProbe(
  dir: string,
  files: RepoFiles = createRepoFiles(dir),
): Promise<Probe> {
  const listed = (await files.listFiles()).filter((path) => !inNodeModules(path));

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
  await read(BUN_VERSION_FILE);

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
  for (const wsDir of workspaceDirs) await read(joinPath(wsDir, "package.json"));

  const packageDirs = new Set(["", ...workspaceDirs]);
  const configFiles = listed.filter(
    (path) => packageDirs.has(dirOf(path)) && isConfigFile(baseName(path)),
  );
  for (const config of configFiles) await read(config);

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

  return { texts, lockfiles, workspaceDirs, envFiles: sorted };
}
