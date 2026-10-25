// Decides which CI path a pull request takes (0016): `backlog-only` when every path it changes lies
// under `backlog/`, `full` otherwise. An empty list is `full`, so a diff that could not be read never
// skips a job. The `changes` job of ci.yml runs it and hands the scope to every other job.
//
// Usage: bun scripts/changed-scope.ts <base> <head> [repository]
//   Diffs `<base>...<head>` (from their merge base to the head), prints the scope and, when
//   GITHUB_OUTPUT is set, appends `scope=<scope>` to it.

import { appendFileSync } from "node:fs";

export type ChangeScope = "backlog-only" | "full";

export const BACKLOG_DIR = "backlog/";

/** `backlog-only` when `paths` is not empty and every path lies under `backlog/`. */
export function changeScope(paths: readonly string[]): ChangeScope {
  return paths.length > 0 && paths.every((path) => path.startsWith(BACKLOG_DIR))
    ? "backlog-only"
    : "full";
}

/** The paths changed from the merge base of `base` and `head` to `head`, renames as two paths. */
export function changedPaths(repo: string, base: string, head: string): string[] {
  const args = ["diff", "--name-only", "-z", "--no-renames", `${base}...${head}`];
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "");
}

if (import.meta.main) {
  const [base, head, repo = process.cwd()] = process.argv.slice(2);
  if (base === undefined || base === "" || head === undefined || head === "") {
    console.error("usage: bun scripts/changed-scope.ts <base> <head> [repository]");
    process.exit(2);
  }
  try {
    const paths = changedPaths(repo, base, head);
    const scope = changeScope(paths);
    console.log(`${paths.length} changed path(s): ${scope}`);
    const output = process.env["GITHUB_OUTPUT"];
    if (output !== undefined && output !== "") appendFileSync(output, `scope=${scope}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
