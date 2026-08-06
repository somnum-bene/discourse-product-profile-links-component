import { describe, expect, it } from "vitest";
// A settings migration is plain JS: Discourse runs it in its own sandbox at
// install and update time, not as part of the component's bundle.
import migration from "../../migrations/settings/0002-drop-empty-profile-link-fields-override.js";

/**
 * Discourse calls every migration with `(settings, helpers)`. This one declares
 * only the first parameter because it makes no judgement that needs a helper,
 * so the tests call it the way Discourse will rather than the way it is typed.
 */
const rawMigrate = migration as (
  settings: Map<string, unknown>,
  helpers?: unknown
) => Map<string, unknown>;

/**
 * The overridden settings Discourse hands a migration. Only settings an
 * administrator has actually overridden appear — a fresh install arrives with
 * nothing in here.
 */
function overrides(entries: Record<string, unknown>) {
  return new Map<string, unknown>(Object.entries(entries));
}

/**
 * This migration reads no helpers, so it is called the way Discourse calls it
 * and also the way a Discourse that stopped supplying them would.
 */
function migrate(
  settings: Map<string, unknown>,
  helpers: unknown = {}
): Map<string, unknown> {
  return rawMigrate(settings, helpers);
}

/** A populated value, shaped the way `settings.yml` ships it. */
function populated() {
  return [
    {
      user_field_name: "Machine",
      mappings: [
        {
          value: "AirSense 11 AutoSet",
          url: "https://www.cpap.com/products/resmed-airsense-11-autoset",
        },
      ],
    },
  ];
}

describe("what it removes", () => {
  it("removes an override of an empty list", () => {
    const settings = migrate(overrides({ profile_link_fields: [] }));

    expect(settings.has("profile_link_fields")).toBe(false);
  });

  it("removes it whether or not other settings are overridden too", () => {
    const settings = migrate(
      overrides({ profile_link_fields: [], profile_link_debug_mode: true })
    );

    expect(settings.has("profile_link_fields")).toBe(false);
  });
});

describe("what it leaves alone", () => {
  it("leaves a populated override exactly as it was", () => {
    const settings = migrate(overrides({ profile_link_fields: populated() }));

    expect(settings.get("profile_link_fields")).toEqual(populated());
  });

  it("keeps a Field Mapping that carries no Mappings of its own", () => {
    // Not empty: the administrator configured a Custom User Field and mapped
    // nothing under it. `readLinkConfig` reports that as a Config Problem,
    // which is a thing to act on rather than a thing to delete.
    const value = [{ user_field_name: "Humidifier", mappings: [] }];
    const settings = migrate(overrides({ profile_link_fields: value }));

    expect(settings.get("profile_link_fields")).toEqual(value);
  });

  it("leaves the setting alone when it was never overridden", () => {
    const settings = migrate(overrides({ profile_link_debug_mode: true }));

    expect(settings.has("profile_link_fields")).toBe(false);
    expect(settings.get("profile_link_debug_mode")).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["the string an empty list serializes to", "[]"],
    ["an empty string", ""],
    ["an object rather than a list", {}],
    ["a number", 0],
    ["a boolean", false],
  ])("leaves a value that is not an empty list alone: %s", (_label, value) => {
    // Discourse hands an `objects` setting over as a real array, so none of
    // these should reach a live site. If one ever does, the shape is not what
    // this migration was written against, and a deletion cannot be undone by a
    // later migration — so the uncertain case keeps the value.
    const settings = migrate(overrides({ profile_link_fields: value }));

    expect(settings.has("profile_link_fields")).toBe(true);
    expect(settings.get("profile_link_fields")).toEqual(value);
  });
});

describe("the settings it was not asked about", () => {
  // `Theme#migrate_settings` destroys every override row and then recreates
  // only the keys this map still holds, so anything dropped here is deleted
  // from the site. These are the tests that make that safe.
  it("returns every other overridden setting untouched", () => {
    const others = {
      profile_link_debug_mode: true,
      some_other_component_setting: "left alone",
      a_list_setting: ["a", "b"],
      a_number_setting: 42,
    };

    const settings = migrate(overrides({ profile_link_fields: [], ...others }));

    expect(Object.fromEntries(settings.entries())).toEqual(others);
  });

  it("removes exactly one key and no others", () => {
    const before = { profile_link_fields: [], one: 1, two: 2, three: 3 };
    const settings = migrate(overrides(before));

    expect(settings.size).toBe(Object.keys(before).length - 1);
  });

  it("removes nothing at all when the override is populated", () => {
    const before = { profile_link_fields: populated(), one: 1, two: 2 };
    const settings = migrate(overrides(before));

    expect(Object.fromEntries(settings.entries())).toEqual(before);
  });
});

describe("the contract the runner enforces", () => {
  it("returns a Map, which the runner rejects the migration without", () => {
    // `migration_function_no_returned_value` and
    // `migration_function_wrong_return_type` are both aborts.
    expect(migrate(overrides({ profile_link_fields: [] }))).toBeInstanceOf(Map);
  });

  it("returns a Map for a fresh install, which arrives with nothing", () => {
    const settings = migrate(overrides({}));

    expect(settings).toBeInstanceOf(Map);
    expect(settings.size).toBe(0);
  });

  it("needs no helpers, so a Discourse that stopped supplying them still runs it", () => {
    // `0001` throws without them on purpose, because it cannot check a URL
    // without `isValidUrl`. This one makes no judgement that needs help.
    expect(() =>
      rawMigrate(overrides({ profile_link_fields: [] }), undefined)
    ).not.toThrow();
  });

  it("is idempotent, though Discourse runs it once per installation", () => {
    const settings = migrate(migrate(overrides({ profile_link_fields: [] })));

    expect(settings.has("profile_link_fields")).toBe(false);
  });
});
