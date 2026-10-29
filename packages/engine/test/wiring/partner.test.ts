// A partner (DIPO-318) is connected once in the engine's connect step; a call before it, or a
// second connect, is a wiring error that throws. A partner connected to null is a service the
// wiring leaves out.

import { describe, expect, it } from "bun:test";

import { Partner, PartnerNotConnectedError } from "../../src/wiring/partner";

describe("Partner", () => {
  it("throws, naming the partner, until it is connected", () => {
    const partner = new Partner<{ readonly kick: () => string }>("the auto-merge");
    expect(partner.connected).toBe(false);
    expect(() => partner.get()).toThrow(PartnerNotConnectedError);
    expect(() => partner.get()).toThrow("the auto-merge");
    partner.connect({ kick: () => "kicked" });
    expect(partner.connected).toBe(true);
    expect(partner.get().kick()).toBe("kicked");
  });

  it("refuses a second connect", () => {
    const partner = new Partner<number>("the places");
    partner.connect(1);
    expect(() => partner.connect(2)).toThrow("twice");
    expect(partner.get()).toBe(1);
  });

  it("holds null for a service the wiring leaves out", () => {
    const partner = new Partner<string | null>("the box collisions");
    partner.connect(null);
    expect(partner.connected).toBe(true);
    expect(partner.get()).toBeNull();
  });
});
