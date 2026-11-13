// The Roles room (DIPO-473): `6` opens it from home and from the retro room, it lists the roles
// `office.roles` answers with their purpose, model and effort, the refused files with their
// problem and the selected role's instructions, and Esc goes back home.

import { afterEach, describe, expect, it } from "bun:test";

import { type Event, StreamName } from "@dipsaus-orchestrator/contract";

import { OFFICES } from "../test/support/fake-session";
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
      model: "claude-sonnet-5-5",
      effort: "medium",
    },
    { name: "tester", purpose: "Tests a story", instructions: "Run the checklist." },
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
    expect(frame).toContain("model claude-sonnet-5-5 · effort medium");
    expect(frame).toContain("tester");
    expect(frame).toContain("Tests a story");
    expect(frame).toContain("model tier · effort tier");
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
