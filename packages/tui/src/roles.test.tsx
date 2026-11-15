// The Roles room (DIPO-473): `6` opens it from home and from the retro room, it lists the roles
// `office.roles` answers with their purpose, model and effort, the refused files with their
// problem and the selected role's instructions, and Esc goes back home.

import { afterEach, describe, expect, it } from "bun:test";

import { type Event, StreamName } from "@dipsaus-orchestrator/contract";

import { goldenSnapshots, OFFICES } from "../test/support/fake-session";
import { mount } from "../test/support/setup";
import { BATCH_MS } from "./batch";

const mounted: { unmount(): Promise<void> }[] = [];

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

const STREAM = StreamName.parse(`office:${OFFICES.dipsaus}`);

const ROLES = {
  office: "x",
  roles: [
    {
      name: "developer",
      purpose: "Builds a story",
      instructions: "Read the story first.\nThen build it.",
      kind: "code",
      model: "claude-sonnet-5-5",
      effort: "medium",
    },
    { name: "tester", purpose: "Tests a story", instructions: "Run the checklist.", kind: "docs" },
  ],
  invalid: [{ path: ".dipo/roles/broken.md", problem: "key `purpose`: Required" }],
};

async function open() {
  const view = await mount({ columns: 140, rows: 40 });
  mounted.push(view.ui);
  await view.ui.waitFor("dipsaus-orchestrator");
  return view;
}

describe("the Roles room", () => {
  it("lists each role with its purpose and model or tier, the invalid file with its problem, and the selected role's instructions", async () => {
    const { ui, session } = await open();
    session.roles = ROLES;
    await ui.press("6");
    const frame = await ui.waitFor("Builds a story");
    expect(frame).toContain("developer");
    expect(frame).toContain("kind code · model claude-sonnet-5-5");
    expect(frame).toContain("tester");
    expect(frame).toContain("Tests a story");
    expect(frame).toContain("kind docs · model tier · effort tier");
    expect(frame).toContain("failed to load");
    expect(frame).toContain(".dipo/roles/broken.md: key `purpose`:");
    expect(frame).toContain("Required");
    expect(frame).toContain("Read the story first.");
    expect(frame).not.toContain("Run the checklist.");
    expect(session.reads.some((read) => read.name === "office.roles")).toBe(true);
    // The rooms band marks Roles and lists Plan.
    expect(frame).toContain("5 Plan    6 Roles");
    await ui.press("down");
    expect((await ui.waitFor("Run the checklist.")).includes("Read the story first.")).toBe(false);
  });

  it("opens from the retro room, and Esc goes home", async () => {
    const { ui, session } = await open();
    session.roles = ROLES;
    await ui.press("4");
    await ui.waitFor("capability.missing");
    await ui.press("6");
    await ui.waitFor("Builds a story");
    await ui.press("escape");
    await ui.waitFor("O offices");
    expect(ui.frame()).not.toContain("Builds a story");
  });

  it("lists the room in the palette and the keys overlay with key 6", async () => {
    const { ui, session } = await open();
    session.roles = ROLES;
    await ui.press(":");
    await ui.waitFor("Go to roles");
    expect(ui.frame()).toMatch(/Go to roles\s+6/);
    await ui.press("escape");
    await ui.press("?");
    expect((await ui.waitFor("Roles")).includes("6")).toBe(true);
  });

  it("reads again when the roster changes on the base", async () => {
    const { ui, session } = await open();
    session.roles = ROLES;
    await ui.press("6");
    await ui.waitFor("Builds a story");
    session.roles = {
      ...ROLES,
      roles: [{ name: "designer", purpose: "Designs the screens", instructions: "Draw." }],
      invalid: [],
    };
    session.active(STREAM)?.options.onEvent({
      cursor: { stream: STREAM, epoch: "e2", seq: 900 },
      at: "2026-11-13T10:00:00.000Z",
      type: "roles.changed",
      data: {},
    } as Event);
    await Bun.sleep(BATCH_MS + 50);
    const frame = await ui.waitFor("Designs the screens");
    expect(frame).not.toContain("Builds a story");
    expect(frame).not.toContain("broken.md");
  });

  it("says the office has no roles and names dipo office init", async () => {
    const { ui, session } = await open();
    session.roles = { office: "x", roles: [], invalid: [] };
    await ui.press("6");
    const frame = await ui.waitFor("has no roles");
    expect(frame).toContain("dipo office init");
  });

  it("scrolls instructions that are longer than the screen", async () => {
    const { ui, session } = await open();
    const body = Array.from({ length: 80 }, (_, i) => `step ${i + 1}`).join("\n");
    session.roles = {
      office: "x",
      roles: [{ name: "developer", purpose: "Builds", instructions: body }],
      invalid: [],
    };
    await ui.press("6");
    const first = await ui.waitFor("step 1");
    expect(first).not.toContain("step 60");
    await ui.press("pagedown");
    await ui.press("pagedown");
    const later = await ui.waitFor("step 60");
    expect(later).not.toContain("step 1\n");
  });
});

describe("the Roles room's chat (DIPO-475)", () => {
  const RUN = "run_01J9ZK5Q8W3V4X6Y7Z8A9B0P01";
  const rolesView = (extra: Record<string, unknown> = {}) =>
    ({
      run: RUN,
      kind: "roles",
      goal: "Add a tester role",
      model: "claude-opus-5-5",
      state: "waiting",
      turns: 1,
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        turns: 1,
        elapsedMs: 1_000,
      },
      startedAt: "2026-11-13T10:00:00.000Z",
      ...extra,
    }) as never;

  it("starts a roles session with a typed goal and shows the chat beside the list", async () => {
    const { ui, session } = await open();
    session.roles = ROLES;
    await ui.press("6");
    await ui.waitFor("Builds a story");
    await ui.press("c");
    const form = await ui.waitFor("Roles chat: no open session");
    // The list stays on the left, the chat on the right.
    expect(form).toContain("Builds a story");
    expect(form).toContain("goal (what do you want to ask about the roles?):");
    session.commandReply = (name) =>
      name === "planning.start"
        ? {
            ok: true,
            result: { run: RUN, view: rolesView({ state: "starting", turns: 0 }) },
            changed: true,
          }
        : undefined;
    await ui.press("Add a tester role");
    await ui.press("enter");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.start"); i++) {
      await Bun.sleep(5);
    }
    expect(session.commands.find((c) => c.name === "planning.start")?.args).toEqual({
      kind: "roles",
      goal: "Add a tester role",
    });
  });

  it("shows an open roles session beside the list, and confirms a role proposal", async () => {
    const snapshots = new Map([
      [
        OFFICES.dipsaus,
        {
          ...goldenSnapshots.get(OFFICES.dipsaus)!,
          planning: rolesView({
            proposals: [
              {
                n: 1,
                proposal: {
                  kind: "role",
                  name: "tester",
                  purpose: "Writes the tests",
                  instructions: "Test each criterion.",
                  why: "Stories need a tester.",
                },
                state: "open",
                at: "2026-11-13T10:04:00.000Z",
              },
            ],
          }),
        },
      ],
    ]);
    const view = await mount({ columns: 140, rows: 34, snapshots });
    mounted.push(view.ui);
    const { ui, session } = view;
    await ui.waitFor("dipsaus-orchestrator");
    session.roles = ROLES;
    await ui.press("6");
    const frame = await ui.waitFor("add role tester");
    expect(frame).toContain("Builds a story");
    expect(frame).toContain("Writes the tests");
    expect(frame).toContain("Planning · roles");
    session.commandReply = (name) =>
      name === "planning.confirm"
        ? {
            ok: true,
            result: { run: RUN, proposal: 1, state: "confirmed", stories: [] },
            changed: true,
          }
        : undefined;
    await ui.press("up");
    await ui.waitFor("c confirm");
    await ui.press("c");
    for (let i = 0; i < 100 && !session.commands.some((c) => c.name === "planning.confirm"); i++) {
      await Bun.sleep(5);
    }
    expect(session.commands.find((c) => c.name === "planning.confirm")?.args).toEqual({
      proposal: 1,
    });
  });

  it("does not start a roles chat while another kind of session is open", async () => {
    const snapshots = new Map([
      [
        OFFICES.dipsaus,
        { ...goldenSnapshots.get(OFFICES.dipsaus)!, planning: rolesView({ kind: "plan" }) },
      ],
    ]);
    const view = await mount({ columns: 140, rows: 34, snapshots });
    mounted.push(view.ui);
    view.session.roles = ROLES;
    await view.ui.press("6");
    await view.ui.waitFor("Builds a story");
    await view.ui.press("c");
    await view.ui.waitFor("a planning session is open: end it first");
    expect(view.session.commands.some((c) => c.name === "planning.start")).toBe(false);
  });
});
