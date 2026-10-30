// Places the late-host stand-in (DIPO-386) where the engine's identity check looks for the source
// form of `dipo`: `<dir>/cli/src/main.ts`, run by Bun.

import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const LATE_HOST = resolve(import.meta.dir, "late-host.ts");

/** Copies the stand-in to `<dir>/cli/src/main.ts` and returns that path. */
export function lateHostScript(dir: string): string {
  const script = join(dir, "cli", "src", "main.ts");
  mkdirSync(join(dir, "cli", "src"), { recursive: true });
  copyFileSync(LATE_HOST, script);
  return script;
}
