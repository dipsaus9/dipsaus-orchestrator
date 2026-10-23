// The box user (DIPO-334): its fixed ids and folders, dipo's fixed root steps, and the copy for
// the box user through a root-only stage, never a root copy into a folder the worker can write.

import { describe, expect, it } from "bun:test";

import { BOX_WORKDIR, BOX_DIPO_DIR } from "../../src/box/code";
import { DOOR_QUEUE } from "../../src/box/door";
import { BOX_NET_TOOLS_PATH, BOX_USER_GID, BOX_USER_UID } from "../../src/box/firewall";
import { BUILD_DIR_IN_BOX } from "../../src/box/image";
import { BOX_PACKAGE_CACHE_PATH, type BoxExecOptions } from "../../src/box/port";
import {
  BOX_NPM_PREFIX,
  BOX_ROOT_DIRS,
  BOX_STAGE_ROOT,
  BOX_USER_DIRS,
  BOX_USER_ENV,
  BOX_USER_HOME,
  copyInAsUser,
  DIPO_PART_PATH,
  isRootStep,
  newStagePath,
  partModeCommand,
  stageCopyCommand,
  stageHandOverCommand,
  stageMakeCommand,
  stageRemoveCommand,
  type UserCopyBoxes,
} from "../../src/box/user";
import { BOX_COMMAND_DIR } from "../../src/box/verify";

type Step = { readonly kind: "copy" | "exec"; readonly what: string; readonly root?: boolean };

/** Boxes that log each copy and exec; `fail` names the step whose exec exits 1 or copy throws. */
function recording(fail?: (step: Step) => boolean): { boxes: UserCopyBoxes; steps: Step[] } {
  const steps: Step[] = [];
  const boxes: UserCopyBoxes = {
    copyIn: async (_box, from, to) => {
      const step: Step = { kind: "copy", what: `${from} -> ${to}` };
      steps.push(step);
      if (fail?.(step) === true) throw new Error("the copy failed");
    },
    exec: async (_box, command, options?: BoxExecOptions) => {
      const step: Step = {
        kind: "exec",
        what: command.join(" "),
        ...(options?.rootStep === true ? { root: true } : {}),
      };
      steps.push(step);
      return { code: fail?.(step) === true ? 1 : 0, stdout: "", stderr: "" };
    },
  };
  return { boxes, steps };
}

describe("the box user (DIPO-334)", () => {
  it("is a fixed non-root uid with its own home and the npm prefix on its PATH", () => {
    expect(BOX_USER_UID).toBeGreaterThan(0);
    expect(BOX_USER_GID).toBeGreaterThan(0);
    expect(BOX_USER_ENV["HOME"]).toBe(BOX_USER_HOME);
    expect(BOX_USER_ENV["PATH"]?.split(":")[0]).toBe(`${BOX_NPM_PREFIX}/bin`);
    expect(BOX_NPM_PREFIX.startsWith(`${BOX_USER_HOME}/`)).toBe(true);
  });

  it("owns /work, its home and dipo's folders its commands write in; root owns the rest", () => {
    expect(BOX_USER_DIRS).toEqual([
      BOX_USER_HOME,
      BOX_WORKDIR,
      BOX_COMMAND_DIR,
      DOOR_QUEUE.slice(0, DOOR_QUEUE.lastIndexOf("/")),
    ]);
    expect(BOX_ROOT_DIRS).toEqual([BOX_DIPO_DIR, BOX_STAGE_ROOT]);
    // The paths root's commands load from or that dipo copies into as root sit directly under `/`
    // or in a folder of root's, never in one of the user's.
    for (const path of [
      BOX_NET_TOOLS_PATH,
      BUILD_DIR_IN_BOX,
      BOX_STAGE_ROOT,
      BOX_DIPO_DIR,
      DIPO_PART_PATH,
      BOX_PACKAGE_CACHE_PATH,
    ]) {
      expect(BOX_USER_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`))).toBe(false);
    }
    for (const path of [BOX_NET_TOOLS_PATH, BUILD_DIR_IN_BOX, BOX_STAGE_ROOT]) {
      expect(path.split("/")).toHaveLength(2);
    }
  });

  it("names a fresh stage folder under the root-only stage root each time", () => {
    const a = newStagePath();
    expect(a).toMatch(new RegExp(`^${BOX_STAGE_ROOT}/[0-9a-f]{32}$`));
    expect(newStagePath()).not.toBe(a);
  });

  it("takes only the fixed root steps outside a build box", () => {
    const stage = newStagePath();
    expect(isRootStep(stageMakeCommand(stage))).toBe(true);
    expect(isRootStep(stageHandOverCommand(stage))).toBe(true);
    expect(isRootStep(stageRemoveCommand(stage))).toBe(true);
    expect(isRootStep(partModeCommand())).toBe(true);
    // The user's own copy is no root step, nor a step on any other path or with another argument.
    expect(isRootStep(stageCopyCommand(stage, BOX_WORKDIR))).toBe(false);
    expect(isRootStep(stageRemoveCommand(BOX_WORKDIR))).toBe(false);
    expect(isRootStep(stageHandOverCommand("/etc"))).toBe(false);
    expect(isRootStep(stageHandOverCommand(`${BOX_STAGE_ROOT}/x/../../etc`))).toBe(false);
    expect(isRootStep([...stageHandOverCommand(stage), "/etc"])).toBe(false);
    expect(isRootStep(["/bin/chown", "-R", "1000:1000", "--", stage])).toBe(false);
    expect(isRootStep(["/bin/chmod", "4755", DIPO_PART_PATH])).toBe(false);
    expect(isRootStep(["sh", "-c", stageRemoveCommand(stage).join(" ")])).toBe(false);
    // The hand-over keeps links as links (`-h`, and `-R` without `-L`).
    expect(stageHandOverCommand(stage)).toEqual([
      "/bin/chown",
      "-R",
      "-h",
      `${BOX_USER_UID}:${BOX_USER_GID}`,
      "--",
      stage,
    ]);
    expect(stageCopyCommand(stage, BOX_WORKDIR)).toContain("-P");
  });
});

describe("a copy for the box user (DIPO-334)", () => {
  it("goes into a fresh root-only stage, is handed over there, copied on by the box user, and removed", async () => {
    const { boxes, steps } = recording();
    await copyInAsUser(boxes, "dipo-run_1", "/tmp/d334/code", BOX_WORKDIR);
    const stage = steps[0]!.what.split(" ").at(-1)!;
    expect(stage).toMatch(new RegExp(`^${BOX_STAGE_ROOT}/[0-9a-f]{32}$`));
    expect(steps).toEqual([
      { kind: "exec", what: stageMakeCommand(stage).join(" "), root: true },
      { kind: "copy", what: `/tmp/d334/code/. -> ${stage}` },
      { kind: "exec", what: stageHandOverCommand(stage).join(" "), root: true },
      // The box user's copy: never a root step.
      { kind: "exec", what: stageCopyCommand(stage, BOX_WORKDIR).join(" ") },
      { kind: "exec", what: stageRemoveCommand(stage).join(" "), root: true },
    ]);
    // No root write ever names the target.
    for (const step of steps) {
      if (step.root === true || step.kind === "copy") expect(step.what).not.toContain("/work");
    }
  });

  it("removes the stage and reports the copy's own failure when a step fails", async () => {
    for (const failing of ["copy", "/bin/chown", "/bin/cp"]) {
      const { boxes, steps } = recording((step) =>
        failing === "copy" ? step.kind === "copy" : step.what.startsWith(failing),
      );
      await expect(
        copyInAsUser(boxes, "dipo-run_1", "/tmp/d334/code", BOX_WORKDIR),
      ).rejects.toThrow(failing === "copy" ? "the copy failed" : /failed \(exit 1\)/);
      expect(steps.at(-1)?.what.startsWith("/bin/rm -rf -- ")).toBe(true);
      expect(steps.at(-1)?.root).toBe(true);
    }
  });

  it("copies nothing when the stage cannot be made", async () => {
    const { boxes, steps } = recording((step) => step.what.startsWith("/bin/mkdir"));
    await expect(copyInAsUser(boxes, "dipo-run_1", "/tmp/d334/code", BOX_WORKDIR)).rejects.toThrow(
      "making a stage folder in the box failed",
    );
    expect(steps).toHaveLength(1);
  });
});
