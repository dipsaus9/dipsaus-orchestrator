// The privacy settings view (DIPO-136): the three settings with their value and source from the
// office summary, one warning that comments in office.local.yaml are not kept, and the command a
// toggle sends after a confirmation that names what is stored.

import { afterEach, describe, expect, it } from "bun:test";

import type { Event } from "@dipsaus-orchestrator/contract";

import { goldenHello, OFFICES } from "./testing/fake-session";
import { mount } from "./testing/setup";

const mounted: { unmount(): Promise<void> }[] = [];

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

async function open() {
  const view = await mount({ columns: 120, rows: 30 });
  mounted.push(view.ui);
  await view.ui.waitFor("daemon");
  const summary = goldenHello.offices.find((entry) => entry.office === OFFICES.dipsaus);
  view.session.active("software")?.options.onEvent({
    cursor: { stream: "software", epoch: "e1", seq: 90 },
    at: "2026-10-14T10:04:00.000Z",
    type: "office.summary",
    data: {
      ...summary,
      privacy: [
        { key: "privacy.storePrompts", value: true, source: "default" },
        { key: "privacy.storeCommandBodies", value: true, source: "default" },
        { key: "privacy.keepRawEvents", value: false, source: "office.local.yaml" },
      ],
    },
  } as Event);
  return view;
}

describe("privacy settings view", () => {
  it("lists the settings with their values and sources and warns about comments", async () => {
    const { ui } = await open();
    await ui.press("p");
    await ui.waitFor("Privacy settings");
    const frame = await ui.waitFor("keepRawEvents");
    expect(frame).toMatch(/storePrompts\s+on\s+\(default\)/);
    expect(frame).toMatch(/storeCommandBodies\s+on\s+\(default\)/);
    expect(frame).toMatch(/keepRawEvents\s+off\s+\(office\.local\.yaml\)/);
    expect(frame).toContain("comments are not kept");
    await ui.press("escape");
    // Wait for the overview to render again before checking the settings view is gone.
    const overview = await ui.waitFor("[p] privacy");
    expect(overview).not.toContain("Privacy settings");
  });

  it("confirms a toggle with what is stored, sends the command, and drops the warning", async () => {
    const { ui, session } = await open();
    await ui.press("p");
    await ui.waitFor("keepRawEvents");
    await ui.press("down");
    await ui.press("enter");
    const prompt = await ui.waitFor("Turn off storeCommandBodies?");
    expect(prompt).toContain("the commands workers run");
    expect(prompt).toContain("from the next output dipo stores");
    expect(session.commands.some((command) => command.name === "office.setPrivacy")).toBe(false);

    await ui.press("y");
    const frame = await ui.waitFor("storeCommandBodies is off");
    expect(frame).not.toContain("comments are not kept");
    const sent = session.commands.find((command) => command.name === "office.setPrivacy");
    expect(sent?.args).toEqual({
      office: OFFICES.dipsaus,
      key: "storeCommandBodies",
      value: false,
    });
  });

  it("sends nothing when the confirmation is declined", async () => {
    const { ui, session } = await open();
    await ui.press("p");
    await ui.waitFor("keepRawEvents");
    await ui.press("enter");
    await ui.waitFor("Turn off storePrompts?");
    await ui.press("n");
    await ui.waitFor("storePrompts stays as it was");
    expect(session.commands.some((command) => command.name === "office.setPrivacy")).toBe(false);
  });
});
