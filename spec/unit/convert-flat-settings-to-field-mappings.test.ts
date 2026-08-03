import { describe, expect, it } from "vitest";
// A settings migration is plain JS: Discourse runs it in its own sandbox at
// install and update time, not as part of the component's bundle.
import rawMigrate from "../../migrations/settings/0001-convert-flat-settings-to-field-mappings.js";

/** The overridden settings Discourse hands a migration. */
function flatSettings(overrides: Record<string, unknown>) {
  return new Map<string, unknown>(Object.entries(overrides));
}

/**
 * The helpers Discourse hands a migration. `isValidUrl` is backed by
 * `UrlHelper.is_valid_url?`, the same check the setting schema applies, so a
 * stand-in only has to agree with it on the cases under test.
 */
const HELPERS = {
  isValidUrl: (url: string) =>
    url.startsWith("https://") ||
    url.startsWith("http://") ||
    url.startsWith("/"),
};

/** Discourse always supplies the helpers, so the tests default to having them. */
function migrate(
  settings: Map<string, unknown>,
  helpers: unknown = HELPERS
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return rawMigrate(settings, helpers);
}

/** What a Discourse that stopped supplying them would do. */
function migrateWithoutHelpers(settings: Map<string, unknown>) {
  return rawMigrate(settings, undefined);
}

describe("0001 convert flat settings to Field Mappings", () => {
  it("turns a name and its CSV slot into one Field Mapping", () => {
    const settings = migrate(
      flatSettings({
        custom_profile_link_user_field_ids: "Machine",
        custom_profile_link_csv_1:
          "ResMed AirSense 11,https://cpap.com/airsense-11",
      })
    );

    expect(settings.get("profile_link_fields")).toEqual([
      {
        user_field_name: "Machine",
        mappings: [
          { value: "ResMed AirSense 11", url: "https://cpap.com/airsense-11" },
        ],
      },
    ]);
  });

  it("pairs each name with the CSV slot its position pointed at", () => {
    const settings = migrate(
      flatSettings({
        custom_profile_link_user_field_ids: "Machine|Mask|Humidifier",
        custom_profile_link_csv_1: "AirSense 11,https://cpap.com/a",
        custom_profile_link_csv_2: "AirFit F20,https://cpap.com/b",
        custom_profile_link_csv_3: "HumidAir,https://cpap.com/c",
      })
    );

    expect(settings.get("profile_link_fields")).toEqual([
      {
        user_field_name: "Machine",
        mappings: [{ value: "AirSense 11", url: "https://cpap.com/a" }],
      },
      {
        user_field_name: "Mask",
        mappings: [{ value: "AirFit F20", url: "https://cpap.com/b" }],
      },
      {
        user_field_name: "Humidifier",
        mappings: [{ value: "HumidAir", url: "https://cpap.com/c" }],
      },
    ]);
  });

  it("keeps every Mapping in a slot, in order", () => {
    const settings = migrate(
      flatSettings({
        custom_profile_link_user_field_ids: "Machine",
        custom_profile_link_csv_1: "A,https://cpap.com/a\nB,https://cpap.com/b",
      })
    );

    expect(settings.get("profile_link_fields")[0].mappings).toEqual([
      { value: "A", url: "https://cpap.com/a" },
      { value: "B", url: "https://cpap.com/b" },
    ]);
  });

  it("splits a Mapping on its first comma, so a URL may contain one", () => {
    // Everything after the first comma is the URL, exactly as the flat format
    // read it. A value containing a comma was unrepresentable then and migrates
    // to the same broken Mapping now — faithfully, rather than silently
    // differently.
    const settings = migrate(
      flatSettings({
        custom_profile_link_user_field_ids: "Machine",
        custom_profile_link_csv_1:
          "AirSense 11,https://cpap.com/search?q=a,b&sort=price",
      })
    );

    expect(settings.get("profile_link_fields")[0].mappings).toEqual([
      { value: "AirSense 11", url: "https://cpap.com/search?q=a,b&sort=price" },
    ]);
  });

  it("trims the whitespace the flat format tolerated", () => {
    const settings = migrate(
      flatSettings({
        custom_profile_link_user_field_ids: " Machine | Mask ",
        custom_profile_link_csv_1: "  AirSense 11 ,  https://cpap.com/a  ",
      })
    );

    expect(settings.get("profile_link_fields")).toEqual([
      {
        user_field_name: "Machine",
        mappings: [{ value: "AirSense 11", url: "https://cpap.com/a" }],
      },
      { user_field_name: "Mask", mappings: [] },
    ]);
  });

  it("drops a CSV line with no comma, which configured nothing", () => {
    const settings = migrate(
      flatSettings({
        custom_profile_link_user_field_ids: "Machine",
        custom_profile_link_csv_1:
          "AirSense 11\n\nAirFit F20,https://cpap.com/b",
      })
    );

    expect(settings.get("profile_link_fields")[0].mappings).toEqual([
      { value: "AirFit F20", url: "https://cpap.com/b" },
    ]);
  });

  it("keeps a name whose CSV slot was empty, rather than dropping it", () => {
    // It resolved no Profile Links before and resolves none now, but carrying it
    // over turns a silent loss into a reported Config Problem.
    const settings = migrate(
      flatSettings({ custom_profile_link_user_field_ids: "Machine" })
    );

    expect(settings.get("profile_link_fields")).toEqual([
      { user_field_name: "Machine", mappings: [] },
    ]);
  });

  it("keeps a name past the tenth slot, which had nowhere to put its Mappings", () => {
    const names = Array.from({ length: 11 }, (_, i) => `Field ${i + 1}`);
    const settings = migrate(
      flatSettings({
        custom_profile_link_user_field_ids: names.join("|"),
        custom_profile_link_csv_11: "ignored,https://cpap.com/ignored",
      })
    );

    const fields = settings.get("profile_link_fields");
    expect(fields).toHaveLength(11);
    expect(fields[10]).toEqual({ user_field_name: "Field 11", mappings: [] });
  });

  it("carries the debug mode override onto its new name", () => {
    const settings = migrate(
      flatSettings({ custom_profile_link_debug_mode: true })
    );

    expect(settings.get("profile_link_debug_mode")).toBe(true);
  });

  it("removes every flat setting it replaced", () => {
    const settings = migrate(
      flatSettings({
        custom_profile_link_user_field_ids: "Machine",
        custom_profile_link_csv_1: "A,https://cpap.com/a",
        custom_profile_link_csv_10: "B,https://cpap.com/b",
        custom_profile_link_debug_mode: true,
      })
    );

    expect([...settings.keys()].sort()).toEqual([
      "profile_link_debug_mode",
      "profile_link_fields",
    ]);
  });

  it("leaves a fresh installation, which overrode nothing, untouched", () => {
    const settings = migrate(flatSettings({}));

    expect([...settings.keys()]).toEqual([]);
  });

  it("sets no Field Mappings when the name list was overridden to empty", () => {
    const settings = migrate(
      flatSettings({ custom_profile_link_user_field_ids: "" })
    );

    expect(settings.has("profile_link_fields")).toBe(false);
  });

  it("drops a Mapping whose URL the new schema would refuse", () => {
    // The flat settings validated nothing, so they could hold this. Writing it
    // would make the whole `profile_link_fields` value invalid and sink every
    // other Field Mapping with it.
    const settings = migrate(
      flatSettings({
        custom_profile_link_user_field_ids: "Machine",
        custom_profile_link_csv_1:
          "AirSense 11,not a url\nAirFit F20,https://cpap.com/b",
      }),
      HELPERS
    );

    expect(settings.get("profile_link_fields")[0].mappings).toEqual([
      { value: "AirFit F20", url: "https://cpap.com/b" },
    ]);
  });

  it("keeps a relative URL, which the schema accepts", () => {
    const settings = migrate(
      flatSettings({
        custom_profile_link_user_field_ids: "Machine",
        custom_profile_link_csv_1: "AirSense 11,/products/airsense-11",
      }),
      HELPERS
    );

    expect(settings.get("profile_link_fields")[0].mappings).toEqual([
      { value: "AirSense 11", url: "/products/airsense-11" },
    ]);
  });

  it("keeps the Field Mapping when every one of its Mappings was refused", () => {
    // Emptied rather than removed, so it is reported as a Config Problem the
    // administrator can act on instead of vanishing.
    const settings = migrate(
      flatSettings({
        custom_profile_link_user_field_ids: "Machine",
        custom_profile_link_csv_1: "AirSense 11,not a url",
      }),
      HELPERS
    );

    expect(settings.get("profile_link_fields")).toEqual([
      { user_field_name: "Machine", mappings: [] },
    ]);
  });

  it("refuses to convert at all when Discourse hands over no helpers", () => {
    // Without the helper the URLs cannot be checked, and converting anyway
    // would delete the flat settings after possibly writing a value the schema
    // refuses. Throwing aborts the update with the old settings still in place,
    // which a corrected version of this migration can convert later.
    const settings = flatSettings({
      custom_profile_link_user_field_ids: "Machine",
      custom_profile_link_csv_1: "AirSense 11,https://cpap.com/a",
    });

    expect(() => migrateWithoutHelpers(settings)).toThrow(
      /Cannot convert Profile Links settings/
    );
    expect(settings.get("custom_profile_link_user_field_ids")).toBe("Machine");
    expect(settings.has("profile_link_fields")).toBe(false);
  });

  it("still converts a debug-mode-only override with no helpers", () => {
    // There are no URLs to check, so there is nothing to refuse over.
    const settings = migrateWithoutHelpers(
      flatSettings({ custom_profile_link_debug_mode: true })
    );

    expect(settings.get("profile_link_debug_mode")).toBe(true);
  });

  it("returns the Map, which Discourse requires", () => {
    const settings = flatSettings({
      custom_profile_link_user_field_ids: "Machine",
    });

    expect(migrate(settings)).toBe(settings);
  });
});
