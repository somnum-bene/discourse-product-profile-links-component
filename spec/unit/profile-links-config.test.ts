import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteUserField } from "../../javascripts/discourse/lib/profile-links";

// profile-links-config caches the configuration in module state, deliberately —
// it is derived once per page load. Each test therefore resets the module
// registry and re-imports, which is the unit-test equivalent of a fresh load.
async function freshModule(settings: unknown) {
  vi.resetModules();
  vi.stubGlobal("settings", settings);
  // The .js extension is what TypeScript's nodenext resolution wants from a
  // dynamic import; vite maps it back to the .ts source.
  return import("../../javascripts/discourse/lib/profile-links-config.js");
}

const SITE = {
  user_fields: [{ id: 1, name: "Machine" }] as SiteUserField[],
};

const MACHINE_FIELD = {
  user_field_name: "Machine",
  mappings: [{ value: "AirSense 11", url: "https://example.com/airsense-11" }],
};

let warn: ReturnType<typeof vi.spyOn>;
let debug: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  debug = vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reportConfigProblems", () => {
  it("warns once per Config Problem even with debug mode off", async () => {
    const { reportConfigProblems } = await freshModule({
      profile_link_debug_mode: false,
      profile_link_fields: [
        { user_field_name: "Humidifier", mappings: [] },
        { user_field_name: "Machine", mappings: [] },
      ],
    });

    reportConfigProblems(SITE);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("Humidifier");
    expect(warn.mock.calls[1][0]).toContain("Machine");
  });

  it("stays silent when the configuration is sound", async () => {
    const { reportConfigProblems } = await freshModule({
      profile_link_debug_mode: false,
      profile_link_fields: [MACHINE_FIELD],
    });

    reportConfigProblems(SITE);

    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent when nothing is configured", async () => {
    const { reportConfigProblems } = await freshModule({
      profile_link_debug_mode: false,
      profile_link_fields: [],
    });

    reportConfigProblems(SITE);

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("profileLinksFor", () => {
  it("resolves a user's Profile Links without reporting Config Problems", async () => {
    const { profileLinksFor } = await freshModule({
      profile_link_debug_mode: false,
      profile_link_fields: [MACHINE_FIELD],
    });

    expect(profileLinksFor(SITE, { 1: "AirSense 11" })).toEqual([
      {
        fieldName: "Machine",
        value: "AirSense 11",
        url: "https://example.com/airsense-11",
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never reports Config Problems, so a Link Surface cannot duplicate them", async () => {
    const { profileLinksFor } = await freshModule({
      profile_link_debug_mode: false,
      profile_link_fields: [{ user_field_name: "Humidifier", mappings: [] }],
    });

    profileLinksFor(SITE, { 1: "AirSense 11" });
    profileLinksFor(SITE, { 1: "AirSense 11" });

    expect(warn).not.toHaveBeenCalled();
  });

  it("derives the configuration once, however many surfaces render", async () => {
    const settings = {
      profile_link_debug_mode: false,
      profile_link_fields: [MACHINE_FIELD],
    };
    const { profileLinksFor } = await freshModule(settings);

    expect(profileLinksFor(SITE, { 1: "AirSense 11" })).toHaveLength(1);

    // Mutating the settings after the first resolution proves the second one
    // reuses the cached configuration rather than re-reading the global.
    settings.profile_link_fields = [];

    expect(profileLinksFor(SITE, { 1: "AirSense 11" })).toHaveLength(1);
  });

  it("logs values matching no Mapping only when debug mode is on", async () => {
    const off = await freshModule({
      profile_link_debug_mode: false,
      profile_link_fields: [MACHINE_FIELD],
    });
    off.profileLinksFor(SITE, { 1: "Some Other Machine" });
    expect(debug).not.toHaveBeenCalled();

    const on = await freshModule({
      profile_link_debug_mode: true,
      profile_link_fields: [MACHINE_FIELD],
    });
    on.profileLinksFor(SITE, { 1: "Some Other Machine" });
    expect(debug).toHaveBeenCalledOnce();
  });

  it("returns an empty array when the user has no field values", async () => {
    const { profileLinksFor } = await freshModule({
      profile_link_debug_mode: false,
      profile_link_fields: [MACHINE_FIELD],
    });

    expect(profileLinksFor(SITE, null)).toEqual([]);
  });
});
