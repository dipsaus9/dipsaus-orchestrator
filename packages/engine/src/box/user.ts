// The box user (DIPO-334; 0021 section 3 and its amendments of 2026-10-23): everything untrusted
// in a box runs as one fixed non-root uid, so it cannot write `/etc`, `/usr`, `/lib`, `/opt`, `/`
// or the tools mount, and cannot redirect a command dipo runs as root.
//
// - Every contained command (`containedCommand` in `firewall.ts`) runs as `BOX_USER_UID` with
//   `BOX_USER_ENV`: the worker's session and its commands, the office install, the package cache
//   fill and the npm installs of an image build.
// - The image build makes the user and its folders before any of that runs: `/home/dipo` (the
//   home, with the npm prefix of Claude Code and the package managers), `/work`, and dipo's two
//   folders the worker's commands write in (`/dipo/command`, `/dipo/door`) belong to it; `/dipo`
//   and `BOX_STAGE_ROOT` belong to root.
// - The backend's copy into a box writes as root, so a copy into a folder the box user can write
//   could follow a link the worker planted there. dipo never does that: a copy for the box user
//   (`copyInAsUser`) goes into a fresh folder under the root-only `BOX_STAGE_ROOT`, is given to
//   the box user there, where nothing of the worker's can be, and the box user copies it on.
// - dipo's root steps outside a build box are only the fixed commands of `isRootStep`, each run
//   with the root allow list (`rootStepCommand`); a build box's root steps are its bootstrap,
//   the Debian packages from Debian's signed archive, and its cleanup.

import { randomUUID } from "node:crypto";

import { BOX_USER_GID, BOX_USER_UID } from "./firewall";
import { BoxError, type BoxPort } from "./port";

/** The box user's name and home. */
export const BOX_USER_NAME = "dipo";
export const BOX_USER_HOME = "/home/dipo";
/** Where npm installs Claude Code and the package managers: the box user's own prefix. */
export const BOX_NPM_PREFIX = `${BOX_USER_HOME}/.local`;
/** The box user's PATH: its npm prefix first, then Debian's. */
export const BOX_USER_PATH = `${BOX_NPM_PREFIX}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
/** The environment every contained command starts with; a command's own environment wins. */
export const BOX_USER_ENV: Readonly<Record<string, string>> = {
  HOME: BOX_USER_HOME,
  USER: BOX_USER_NAME,
  LOGNAME: BOX_USER_NAME,
  PATH: BOX_USER_PATH,
};
/** The root-only folder of dipo's copies for the box user. */
export const BOX_STAGE_ROOT = "/dipo-stage";
/** dipo's `dipo-part` command in a box (`door.ts`), root's. */
export const DIPO_PART_PATH = "/usr/local/bin/dipo-part";
/** The folders of a box that belong to the box user, made by the image build. */
export const BOX_USER_DIRS: readonly string[] = [
  BOX_USER_HOME,
  "/work",
  "/dipo/command",
  "/dipo/door",
];
/** The folders of a box that belong to root, made by the image build before the user's. */
export const BOX_ROOT_DIRS: readonly string[] = ["/dipo", BOX_STAGE_ROOT];

const STAGE = new RegExp(`^${BOX_STAGE_ROOT}/[0-9a-f]{32}$`);
const OWNER = `${BOX_USER_UID}:${BOX_USER_GID}`;

/** A fresh stage folder's path. */
export function newStagePath(): string {
  return `${BOX_STAGE_ROOT}/${randomUUID().replaceAll("-", "")}`;
}

/** Makes the stage folder `stage`, root's and closed to the box user. */
export function stageMakeCommand(stage: string): [string, ...string[]] {
  return ["/bin/mkdir", "-m", "0700", "--", stage];
}

/** Gives the stage folder `stage` and everything in it to the box user; links stay links. */
export function stageHandOverCommand(stage: string): [string, ...string[]] {
  return ["/bin/chown", "-R", "-h", OWNER, "--", stage];
}

/** Removes the stage folder `stage`. */
export function stageRemoveCommand(stage: string): [string, ...string[]] {
  return ["/bin/rm", "-rf", "--", stage];
}

/** Makes `dipo-part`, root's, runnable by the box user. */
export function partModeCommand(): [string, ...string[]] {
  return ["/bin/chmod", "0755", DIPO_PART_PATH];
}

/** The box user's copy of the stage's contents to `to`, made when missing; links stay links. */
export function stageCopyCommand(stage: string, to: string): [string, ...string[]] {
  return ["/bin/cp", "-R", "-P", "--preserve=mode,timestamps", "-T", "--", stage, to];
}

/**
 * True when `command` is one of dipo's root steps a box other than a build box may run: a stage
 * folder's make, hand-over or removal, or the mode of `dipo-part`. Nothing else runs as root there.
 */
export function isRootStep(command: readonly string[]): boolean {
  const same = (form: readonly string[]): boolean =>
    form.length === command.length && form.every((part, at) => command[at] === part);
  if (same(partModeCommand())) return true;
  const stage = command.at(-1) ?? "";
  if (!STAGE.test(stage)) return false;
  return [stageMakeCommand, stageHandOverCommand, stageRemoveCommand].some((form) =>
    same(form(stage)),
  );
}

/** The box calls of `copyInAsUser`. */
export type UserCopyBoxes = Pick<BoxPort, "copyIn" | "exec">;

/** Runs one of dipo's fixed commands in `box`; a non-zero exit fails with `what`. */
async function fixedStep(
  boxes: UserCopyBoxes,
  box: string,
  command: readonly [string, ...string[]],
  what: string,
  rootStep: boolean,
): Promise<void> {
  const result = await boxes.exec(box, command, rootStep ? { rootStep: true } : {});
  if (result.code !== 0) {
    throw new BoxError("box.failed", `${what} failed (exit ${result.code}).`, false, {
      box,
      stderr: result.stderr.trim().slice(-2000),
    });
  }
}

/**
 * Copies the contents of the host folder `from` into the box folder `to` as the box user (file
 * comment): into a fresh root-only stage, given to the box user there, copied on by the box user,
 * and the stage removed whatever happened.
 */
export async function copyInAsUser(
  boxes: UserCopyBoxes,
  box: string,
  from: string,
  to: string,
): Promise<void> {
  const stage = newStagePath();
  const remove = () =>
    fixedStep(boxes, box, stageRemoveCommand(stage), "removing the stage folder", true);
  await fixedStep(boxes, box, stageMakeCommand(stage), "making a stage folder in the box", true);
  try {
    await boxes.copyIn(box, `${from}/.`, stage);
    await fixedStep(boxes, box, stageHandOverCommand(stage), "handing the copy over", true);
    await fixedStep(boxes, box, stageCopyCommand(stage, to), `copying into ${to}`, false);
  } catch (error) {
    // The copy's own failure is the one reported; a stage left behind is root's and harmless.
    await remove().catch(() => undefined);
    throw error;
  }
  await remove();
}
