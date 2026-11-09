// A fake `gh` executable for tests that run the real spawn path (DIPO-468): a shell script that
// prints a version for `--version` and, for every other call, appends its arguments to `calls` and
// answers as its mode says. No test reaches GitHub.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MIN_GH_VERSION } from "../../src/platform/host";

/** How the fake answers a call other than `--version`. */
export type FakeGhMode =
  /** Prints `body` and exits 0. */
  | { readonly kind: "answer"; readonly body: string }
  /** Prints `stderr` and exits with `code`. */
  | { readonly kind: "fail"; readonly code: number; readonly stderr: string }
  /** Never answers: sleeps far past any deadline. */
  | { readonly kind: "hang" };

export interface FakeGh {
  /** The executable's absolute path. */
  readonly path: string;
  /** The directory that holds it, to put first on `PATH`. */
  readonly dir: string;
  /** The arguments of every call other than `--version`, one line each. */
  calls(): string[];
}

/** Writes the fake `gh` into `dir` (which must exist) with `mode`. */
export function fakeGh(dir: string, mode: FakeGhMode): FakeGh {
  const path = join(dir, "gh");
  const log = join(dir, "gh-calls.log");
  const body = join(dir, "gh-body.json");
  const lines = [
    "#!/bin/sh",
    `if [ "$1" = "--version" ]; then echo "gh version ${MIN_GH_VERSION} (2024-05-29)"; exit 0; fi`,
    `echo "$*" >> '${log}'`,
  ];
  if (mode.kind === "answer") {
    writeFileSync(body, mode.body);
    lines.push(`cat '${body}'`, "exit 0");
  } else if (mode.kind === "fail") {
    lines.push(`echo '${mode.stderr.replaceAll("'", "")}' >&2`, `exit ${mode.code}`);
  } else {
    lines.push("exec sleep 600");
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  chmodSync(path, 0o755);
  return {
    path,
    dir,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((line) => line !== "")
        : [],
  };
}

/** One PR of `GET /repos/{o}/{r}/commits/{sha}/pulls`, merged as `merge` unless `merged` is false. */
export function restPr(pr: {
  readonly number: number;
  readonly head: string;
  readonly base?: string;
  readonly merge: string;
  readonly merged?: boolean;
  readonly state?: "open" | "closed";
}): Record<string, unknown> {
  const merged = pr.merged ?? true;
  return {
    number: pr.number,
    html_url: `https://github.com/o/r/pull/${pr.number}`,
    state: pr.state ?? "closed",
    title: `feat(${pr.head.split("/")[0]}): x`,
    head: { ref: pr.head, sha: "9".repeat(40) },
    base: { ref: pr.base ?? "main" },
    merge_commit_sha: pr.merge,
    merged_at: merged ? "2026-11-09T12:00:00Z" : null,
  };
}
