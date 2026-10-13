// A `Workspace` over a checkout the engine owns: file lists and `HEAD` through the office's git
// queue with hardened calls (DIPO-31), file bytes from the work tree. Reads only. A path that
// leaves the work tree, or a symbolic link, is never read, so a link cannot pull a file from
// outside the checkout into a prompt, and a path whose resolved location leaves the work tree is
// refused. A file named like a secret (`secrets.ts`) is never read either.

import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";

import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { isSecretPath } from "./secrets";
import type { Workspace } from "./types";

type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

const splitZ = (text: string) => text.split("\0").filter((entry) => entry !== "");

export interface GitWorkspaceOptions {
  readonly git: OfficeGit;
  readonly location: WorktreeLocation;
}

export function gitWorkspace(options: GitWorkspaceOptions): Workspace {
  const { git, location } = options;
  const root = location.workTree;
  const run = (args: readonly string[]) => git.run((session) => session.ok(location, args));
  return {
    root,
    async headSha() {
      return (await run(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    },
    async trackedFiles() {
      return [...new Set(splitZ(await run(["ls-files", "-z"])))].toSorted();
    },
    async files() {
      const out = await run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
      return [...new Set(splitZ(out))].toSorted();
    },
    async readFile(path) {
      const clean = normalize(path);
      if (isAbsolute(clean) || clean === ".." || clean.startsWith("../")) return undefined;
      if (isSecretPath(clean)) return undefined;
      const full = join(root, clean);
      try {
        const info = await lstat(full);
        if (!info.isFile()) return undefined;
        // lstat checks only the last segment: a directory on the way may be a link (or swapped
        // for one), so the resolved path must still lie under the resolved work tree.
        const [realRoot, realFull] = await Promise.all([realpath(root), realpath(full)]);
        if (!realFull.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
          return undefined;
        }
        return new Uint8Array(await readFile(realFull));
      } catch {
        return undefined;
      }
    },
  };
}
