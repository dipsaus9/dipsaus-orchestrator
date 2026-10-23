// The index pass reads a story's view again only when a Backlog file it printed changed
// (DIPO-314): the blobs of the base's Backlog files decide, with a scripted CLI that counts its
// view calls. A story whose own task file blob is unchanged is not read again; one named by a
// story that changed, appeared or went away is; a change to another Backlog file reads them all.

import { describe, expect, it } from "bun:test";

import type { SpawnOptions } from "@dipsaus-orchestrator/contract";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { backlogFolders } from "../../src/stories/index-stories";
import { backlogBlobs, readBacklog, StoryViewCache } from "../../src/stories/read";
import { scriptedSpawn } from "../backlog/helpers";
import { withReconcileOffice } from "../reconcile/helpers";

interface Story {
  readonly id: string;
  readonly status: string;
  /** Ids the view prints: its dependencies, parent or subtasks. */
  readonly names?: readonly string[];
}

function view(story: Story): string {
  return [
    `File: /base/backlog/tasks/${story.id.toLowerCase()} - Story.md`,
    "",
    `Task ${story.id} - Story ${story.id}`,
    "=".repeat(50),
    "",
    `Status: ○ ${story.status}`,
    "Created: 2026-10-12 11:28 (UTC)",
    ...(story.names === undefined || story.names.length === 0
      ? []
      : ["", `Depends on (${story.names.length}):`, ...story.names.map((id) => `  └─ ${id} - x`)]),
    "",
    "Description:",
    "-".repeat(50),
    `Outcome: ${story.id} works.`,
    "",
  ].join("\n");
}

function list(stories: readonly Story[]): string {
  const lines = ["Ready:", ...stories.map((story) => `  ${story.id} - Story ${story.id}`), ""];
  return stories.length === 0 ? "" : lines.join("\n");
}

/** A CLI over `stories` that counts the views it printed. */
function cli(stories: () => readonly Story[]) {
  const stub = scriptedSpawn((args) => {
    const [kind, verb, id] = args;
    const all = kind === "draft" ? [] : stories();
    if (verb === "list")
      return { stdout: args.includes("--count") ? `${all.length}\n` : list(all) };
    const found = all.find((story) => story.id === id);
    return found === undefined
      ? { stderr: `Task ${id} not found.`, code: 1 }
      : { stdout: view(found) };
  });
  const views = (): string[] =>
    stub.calls
      .filter((call: SpawnOptions) => call.cmd[2] === "view")
      .map((call: SpawnOptions) => call.cmd[3] ?? "");
  return { cli: { spawn: stub.spawn, env: {} }, views };
}

/** One `ls-tree -r -z` record per file: `{path: blob}`. */
function tree(files: Readonly<Record<string, string>>): string {
  return Object.entries(files)
    .map(([path, blob]) => `100644 blob ${blob.padEnd(40, "0")}\t${path}\0`)
    .join("");
}

/** The task file path of `id`. */
const file = (id: string) => `backlog/tasks/${id.toLowerCase()} - Story.md`;

describe("backlogBlobs", () => {
  it("keys each story's files by its id and keeps every other Backlog file apart", () => {
    const blobs = backlogBlobs(
      tree({
        [file("TASK-1")]: "a1",
        "backlog/completed/task-2 - Done.md": "b1",
        "backlog/config.yml": "c1",
        "backlog/docs/notes.md": "d1",
      }),
    );
    expect([...blobs.byId.keys()].toSorted()).toEqual(["TASK-1", "TASK-2"]);
    expect(blobs.rest).toContain("backlog/config.yml");
    expect(blobs.rest).toContain("backlog/docs/notes.md");
    expect(blobs.rest).not.toContain("task-1");
  });
});

describe("an index read with the view cache", () => {
  /** Three Ready stories; TASK-2 depends on TASK-1. */
  const stories: Story[] = [
    { id: "TASK-1", status: "Ready" },
    { id: "TASK-2", status: "Ready", names: ["TASK-1"] },
    { id: "TASK-3", status: "Ready" },
  ];
  const files = { [file("TASK-1")]: "a1", [file("TASK-2")]: "b1", [file("TASK-3")]: "c1" };

  it("does not read a story again whose task file blob is unchanged", async () => {
    const cache = new StoryViewCache();
    const { cli: backlog, views } = cli(() => stories);
    const first = await readBacklog(backlog, "/nowhere", cache.pass(backlogBlobs(tree(files))));
    expect(views()).toEqual(["TASK-1", "TASK-2", "TASK-3"]);
    const again = await readBacklog(backlog, "/nowhere", cache.pass(backlogBlobs(tree(files))));
    // Only the lists ran again.
    expect(views()).toEqual(["TASK-1", "TASK-2", "TASK-3"]);
    expect(again).toEqual(first);
  });

  it("reads a changed story and the stories that print it, and no other", async () => {
    const cache = new StoryViewCache();
    let now = stories;
    const { cli: backlog, views } = cli(() => now);
    await readBacklog(backlog, "/nowhere", cache.pass(backlogBlobs(tree(files))));
    now = [{ id: "TASK-1", status: "Done" }, ...stories.slice(1)];
    const read = await readBacklog(
      backlog,
      "/nowhere",
      cache.pass(backlogBlobs(tree({ ...files, [file("TASK-1")]: "a2" }))),
    );
    // TASK-2's view prints TASK-1, so it is read again; TASK-3 is not.
    expect(views().slice(3)).toEqual(["TASK-1", "TASK-2"]);
    expect(read.map((story) => story.status)).toEqual(["Done", "Ready", "Ready"]);
  });

  it("reads a kept story again when a new or a gone story's view names it", async () => {
    const cache = new StoryViewCache();
    let now: Story[] = stories;
    const { cli: backlog, views } = cli(() => now);
    await readBacklog(backlog, "/nowhere", cache.pass(backlogBlobs(tree(files))));

    // A new subtask of TASK-3: its view names TASK-3, whose view now lists it.
    now = [...stories, { id: "TASK-4", status: "Ready", names: ["TASK-3"] }];
    await readBacklog(
      backlog,
      "/nowhere",
      cache.pass(backlogBlobs(tree({ ...files, [file("TASK-4")]: "d1" }))),
    );
    expect(views().slice(3)).toEqual(["TASK-4", "TASK-3"]);

    // TASK-4 is gone: TASK-3 is read again, as its view no longer lists it.
    now = stories;
    await readBacklog(backlog, "/nowhere", cache.pass(backlogBlobs(tree(files))));
    expect(views().slice(5)).toEqual(["TASK-3"]);
  });

  it("reads a kept story again once an id it named without a file gets one", async () => {
    const cache = new StoryViewCache();
    const named: Story[] = [
      { id: "TASK-1", status: "Ready" },
      { id: "TASK-2", status: "Ready", names: ["TASK-9"] },
    ];
    const { cli: backlog, views } = cli(() => named);
    const two = { [file("TASK-1")]: "a1", [file("TASK-2")]: "b1" };
    await readBacklog(backlog, "/nowhere", cache.pass(backlogBlobs(tree(two))));
    await readBacklog(backlog, "/nowhere", cache.pass(backlogBlobs(tree(two))));
    expect(views()).toEqual(["TASK-1", "TASK-2"]);
    // TASK-9 appears (completed, so not listed): TASK-2's view prints it differently now.
    await readBacklog(
      backlog,
      "/nowhere",
      cache.pass(backlogBlobs(tree({ ...two, "backlog/completed/task-9 - Done.md": "z1" }))),
    );
    expect(views()).toEqual(["TASK-1", "TASK-2", "TASK-2"]);
  });

  it("reads every story again when another Backlog file changed", async () => {
    const cache = new StoryViewCache();
    const { cli: backlog, views } = cli(() => stories);
    await readBacklog(
      backlog,
      "/nowhere",
      cache.pass(backlogBlobs(tree({ ...files, "backlog/config.yml": "e1" }))),
    );
    await readBacklog(
      backlog,
      "/nowhere",
      cache.pass(backlogBlobs(tree({ ...files, "backlog/config.yml": "e2" }))),
    );
    expect(views()).toEqual(["TASK-1", "TASK-2", "TASK-3", "TASK-1", "TASK-2", "TASK-3"]);
  });

  it("reads a story with no task file in the listing every time", async () => {
    const cache = new StoryViewCache();
    const { cli: backlog, views } = cli(() => stories);
    const partial = { [file("TASK-1")]: "a1", [file("TASK-2")]: "b1" };
    await readBacklog(backlog, "/nowhere", cache.pass(backlogBlobs(tree(partial))));
    await readBacklog(backlog, "/nowhere", cache.pass(backlogBlobs(tree(partial))));
    expect(views().filter((id) => id === "TASK-3")).toEqual(["TASK-3", "TASK-3"]);
  });
});

/** Runs `fn` in a checkout with `backlog/` and, unless null, a `backlog.config.yml` of `config`. */
function withCheckout(config: string | null, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(process.env["DIPO_TMP"] || "/tmp", "folders-"));
  try {
    if (config !== null) writeFileSync(join(dir, "backlog.config.yml"), config);
    mkdirSync(join(dir, "backlog"));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("backlogFolders", () => {
  it("lists backlog/, .backlog/ and the folder backlog.config.yml names, as the scan does", () => {
    withCheckout(null, (dir) =>
      expect(backlogFolders(dir)).toEqual(["backlog", ".backlog", "backlog.config.yml"]),
    );
    withCheckout('project_name: "x"\nbacklog_directory: "planning"\n', (dir) =>
      expect(backlogFolders(dir)).toEqual([
        "backlog",
        ".backlog",
        "backlog.config.yml",
        "planning",
      ]),
    );
  });

  it("turns the cache off for a folder it cannot resolve", () => {
    withCheckout("backlog_directory: /elsewhere\n", (dir) =>
      expect(backlogFolders(dir)).toBeNull(),
    );
  });
});

describe("an index pass of an office", () => {
  it("reads no view again in a pass over an unchanged base", () =>
    withReconcileOffice(
      {
        base: [
          { id: "TASK-1", status: "Ready" },
          { id: "TASK-2", status: "Ready" },
        ],
        reuseViews: true,
      },
      async (o) => {
        await o.index.indexStories(o.officeId);
        const viewsOf = () => o.cliCalls.filter((call) => call.cmd[2] === "view").length;
        const before = viewsOf();
        expect(before).toBeGreaterThan(0);
        await o.index.indexStories(o.officeId);
        expect(viewsOf()).toBe(before);
      },
    ));
});
