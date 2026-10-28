// Starts git through a `$` shell template: a read, and a push.
import { $ } from "bun";

export async function run(branch: string): Promise<void> {
  await $`git status --porcelain`;
  await $`/usr/bin/git push origin ${branch}`;
}
