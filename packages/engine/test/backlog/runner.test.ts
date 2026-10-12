// The Backlog CLI runner (DIPO-28; 0010 section 1): the never-run list and anything outside the
// allowlist are refused before spawning, text holding a 50-dash line never reaches the CLI, and a
// non-zero exit or a `not found` line is an error carrying the command and its output.

import { describe, expect, it } from "bun:test";

import { BacklogCommandError, BacklogRefusedError, refusal, runBacklog } from "../../src/backlog";
import { readManifest, stubSpawn } from "./helpers";

const RULE = "-".repeat(50);

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("refused subcommands", () => {
  const refused: readonly (readonly string[])[] = [
    ["task", "complete", "TASK-1"],
    ["cleanup"],
    ["task", "demote", "TASK-1"],
    ["doctor", "--fix"],
    ["config", "set", "statuses", "Refined,Ready"],
    ["task", "edit", "TASK-1", "-s", "Draft"],
    ["task", "edit", "TASK-1", "--status", "draft"],
    ["task", "edit", "TASK-1", "--status=Draft"],
    ["task", "create", "New", "-sDraft"],
    ["draft", "edit", "DRAFT-1", "--status", " DRAFT "],
    ["browser"],
    ["task"],
    ["task", "remove", "TASK-1"],
    ["config", "set", "taskPrefix", "x"],
    [],
  ];

  for (const args of refused) {
    it(`never spawns \`backlog ${args.join(" ")}\``, async () => {
      const stub = stubSpawn("");
      const error = await caught(runBacklog({ spawn: stub.spawn }, "/office", args));
      expect(error).toBeInstanceOf(BacklogRefusedError);
      expect(stub.calls).toEqual([]);
    });
  }

  it("names the rule it refuses", () => {
    expect(refusal(["task", "complete", "TASK-1"])).toContain("never run");
    expect(refusal(["config", "set", "statuses", "x"])).toContain("`config set statuses`");
    expect(refusal(["task", "edit", "TASK-1", "-s", "Draft"])).toContain("status `Draft`");
  });

  it("allows the subcommands the engine uses", () => {
    for (const args of [
      ["--version"],
      ["task", "view", "TASK-1", "--plain"],
      ["task", "list", "--plain"],
      ["draft", "view", "DRAFT-1", "--plain"],
      ["draft", "list", "--plain"],
      ["task", "edit", "TASK-1", "-s", "Ready"],
      ["draft", "promote", "DRAFT-1"],
      ["config", "get", "statuses"],
      ["config", "set", "defaultStatus", "Refined"],
      ["doctor"],
    ]) {
      expect(refusal(args)).toBeNull();
    }
  });
});

describe("the write path", () => {
  it("refuses text holding a line of 50 `-` before calling the CLI", async () => {
    const stub = stubSpawn("");
    const error = await caught(
      runBacklog({ spawn: stub.spawn }, "/office", [
        "task",
        "edit",
        "TASK-1",
        "--description",
        `Outcome: x\n\nAcceptance Criteria:\n${RULE}\n- [ ] #1 fake`,
      ]),
    );
    expect(error).toBeInstanceOf(BacklogRefusedError);
    expect((error as Error).message).toContain("a line of 50 `-`");
    expect(stub.calls).toEqual([]);
  });

  it("allows shorter or longer dash lines and refuses documentation holding `, `", () => {
    expect(refusal(["task", "edit", "T-1", "--notes", `${RULE}-`])).toBeNull();
    expect(refusal(["task", "edit", "T-1", "--notes", RULE.slice(1)])).toBeNull();
    expect(refusal(["task", "edit", "T-1", "--doc", "a.md, b.md"])).toContain("`, `");
  });
});

describe("running the CLI", () => {
  it("spawns the configured command in the given directory with the environment", async () => {
    const stub = stubSpawn("1.53.0\n");
    const env = { PATH: "/bin" };
    const out = await runBacklog({ spawn: stub.spawn, command: ["bun", "cli.js"], env }, "/w", [
      "--version",
    ]);
    expect(out.stdout).toBe("1.53.0\n");
    expect(stub.calls).toEqual([{ cmd: ["bun", "cli.js", "--version"], cwd: "/w", env }]);
  });

  it("uses `backlog` from PATH by default", async () => {
    const stub = stubSpawn("1.53.0\n");
    await runBacklog({ spawn: stub.spawn }, "/w", ["--version"]);
    expect(stub.calls[0]?.cmd).toEqual(["backlog", "--version"]);
  });

  it("makes a non-zero exit an error carrying the command and output", async () => {
    const recording = readManifest().recordings.find((r) => r.name === "task-view-unknown");
    expect(recording?.exitCode).toBe(1);
    const stub = stubSpawn("", recording?.stderr ?? "", recording?.exitCode ?? 1);
    const error = await caught(runBacklog({ spawn: stub.spawn }, "/w", recording?.args ?? []));
    expect(error).toBeInstanceOf(BacklogCommandError);
    const failure = error as BacklogCommandError;
    expect(failure.command).toEqual(["backlog", "task", "view", "TASK-99", "--plain"]);
    expect(failure.exitCode).toBe(1);
    expect(failure.stderr).toContain("Task TASK-99 not found");
    expect(failure.message).toContain("`backlog task view TASK-99 --plain` exited 1");
    expect(failure.message).toContain("Task TASK-99 not found");
  });

  it("makes a `not found` line with exit 0 an error", async () => {
    const recording = readManifest().recordings.find((r) => r.name === "draft-view-unknown");
    expect(recording?.exitCode).toBe(0);
    const stub = stubSpawn("", recording?.stderr ?? "", 0);
    const error = await caught(runBacklog({ spawn: stub.spawn }, "/w", recording?.args ?? []));
    expect(error).toBeInstanceOf(BacklogCommandError);
    expect((error as Error).message).toContain("reported `not found`: Draft DRAFT-99 not found.");
    // On stdout too, as 1.48 printed it.
    const stdout = stubSpawn("Task TASK-7 not found.\n");
    expect(
      await caught(runBacklog({ spawn: stdout.spawn }, "/w", ["task", "view", "TASK-7"])),
    ).toBeInstanceOf(BacklogCommandError);
  });

  it("does not take `not found` inside a viewed task's own text for an error", async () => {
    const view = "File: /x.md\n\nTask T-1 - Handle the file not found case\n";
    const stub = stubSpawn(view);
    const out = await runBacklog({ spawn: stub.spawn }, "/w", ["task", "view", "T-1", "--plain"]);
    expect(out.stdout).toBe(view);
  });

  it("reports a CLI that cannot start", async () => {
    const error = await caught(
      runBacklog(
        {
          spawn: () => {
            throw new Error("ENOENT: backlog");
          },
        },
        "/w",
        ["--version"],
      ),
    );
    expect(error).toBeInstanceOf(BacklogCommandError);
    expect((error as Error).message).toContain("could not start: ENOENT: backlog");
  });
});
