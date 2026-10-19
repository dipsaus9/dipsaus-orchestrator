// The `mktemp` shim of a sandboxed step on macOS (DIPO-200). `/usr/bin/mktemp` on macOS builds a
// path from `confstr(_CS_DARWIN_USER_TEMP_DIR)` (`/var/folders/<x>/T`) and ignores `TMPDIR` when
// the call names no template (no arguments, only `-d`, `-q` or `-u`, or `-t prefix`). The step may
// not write there, so a package manager that is a wrapper script calling a bare `mktemp` failed its
// setup. The shim is first on the step's PATH and adds `-p "$TMPDIR"` to such a call; every other
// call, an explicit `-p dir` or a template among them, goes to the real `mktemp` unchanged. The step's
// write rules are not widened. GNU `mktemp` on Linux honours `TMPDIR`, so no shim is made there.

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DipoPlatform } from "./paths";

/** The system `mktemp` the shim calls on macOS. */
export const DARWIN_MKTEMP = "/usr/bin/mktemp";

/** Quotes one string for `/bin/sh` inside the shim. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The text of the shim: a `/bin/sh` script around the `mktemp` at `realMktemp`. */
export function mktempShimText(realMktemp: string): string {
  return `#!/bin/sh
# dipo mktemp shim (DIPO-200): keeps a template-less mktemp in $TMPDIR on macOS.
real=${quote(realMktemp)}
[ -n "$TMPDIR" ] || exec "$real" "$@"
need=1
prefix=0
rest=0
for arg in "$@"; do
  if [ "$prefix" = 1 ]; then
    prefix=0
    continue
  fi
  if [ "$rest" = 1 ]; then
    need=0
    continue
  fi
  case "$arg" in
    --) rest=1 ;;
    --?*) need=0 ;;
    -?*)
      opts=\${arg#-}
      while [ -n "$opts" ]; do
        c=\${opts%"\${opts#?}"}
        opts=\${opts#?}
        case "$c" in
          p) need=0 ;;
          t)
            [ -n "$opts" ] || prefix=1
            opts=
            ;;
        esac
      done
      ;;
    *) need=0 ;;
  esac
done
if [ "$need" = 1 ]; then
  exec "$real" -p "$TMPDIR" "$@"
fi
exec "$real" "$@"
`;
}

export interface StepDir {
  /** The private `dipo-sx-*` directory; the caller removes it with `removeStepDir`. */
  readonly privateDir: string;
  /** The PATH of the step: the shim directory first on macOS, `path` unchanged on Linux. */
  readonly path: string | undefined;
  /** The paths `trust` reported. */
  readonly distrust: readonly string[];
}

/**
 * Makes the private directory (srt's sockets and scratch files live there, outside the step temp
 * root) under `baseDir` (`/tmp` in production), and on macOS the read-only shim in a directory
 * inside it, then vets the step's PATH, the shim directory first, with `trust`. The directory is
 * made before the trust check so the check sees the shim directory; it is removed again when
 * anything here throws.
 */
export async function prepareStepDir(options: {
  readonly platform: DipoPlatform;
  readonly baseDir: string;
  readonly path: string | undefined;
  readonly trust: (path: string | undefined) => Promise<string[]>;
  readonly realMktemp?: string;
}): Promise<StepDir> {
  const privateDir = await mkdtemp(join(options.baseDir, "dipo-sx-"));
  try {
    let path = options.path;
    if (options.platform === "darwin") {
      const bin = join(privateDir, "bin");
      await mkdir(bin, { mode: 0o700 });
      const shim = join(bin, "mktemp");
      await writeFile(shim, mktempShimText(options.realMktemp ?? DARWIN_MKTEMP), { mode: 0o555 });
      await chmod(shim, 0o555);
      await chmod(bin, 0o555);
      path = path === undefined || path === "" ? bin : `${bin}:${path}`;
    }
    return { privateDir, path, distrust: await options.trust(path) };
  } catch (error) {
    await removeStepDir(privateDir);
    throw error;
  }
}

/** Removes a directory `prepareStepDir` made, read-only shim directory included. */
export async function removeStepDir(privateDir: string): Promise<void> {
  await chmod(join(privateDir, "bin"), 0o700).catch(() => undefined);
  await rm(privateDir, { recursive: true, force: true }).catch(() => undefined);
}
