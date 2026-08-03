import { describe, expect, it } from "vitest";
import {
  type ConfigProblem,
  describeConfigProblem,
  readLinkConfig,
  resolveProfileLinks,
  type SiteUserField,
  type ThemeSettings,
} from "../../javascripts/discourse/lib/profile-links";

const SITE_USER_FIELDS: SiteUserField[] = [
  { id: 1, name: "Machine" },
  { id: 2, name: "Mask" },
];

function settingsWith(
  fields: ThemeSettings["profile_link_fields"]
): ThemeSettings {
  return { profile_link_fields: fields };
}

const MACHINE_FIELD = {
  user_field_name: "Machine",
  mappings: [
    { value: "AirSense 11", url: "https://example.com/airsense-11" },
    { value: "DreamStation 2", url: "https://example.com/dreamstation-2" },
  ],
};

describe("readLinkConfig", () => {
  it("joins a Field Mapping to the Custom User Field's integer id", () => {
    const config = readLinkConfig(
      settingsWith([MACHINE_FIELD]),
      SITE_USER_FIELDS
    );

    expect(config.problems).toEqual([]);
    expect(config.fieldMappings).toHaveLength(1);
    expect(config.fieldMappings[0].fieldName).toBe("Machine");
    expect(config.fieldMappings[0].fieldId).toBe(1);
    expect(config.fieldMappings[0].urlsByValue.get("AirSense 11")).toBe(
      "https://example.com/airsense-11"
    );
  });

  it("takes the first Custom User Field when the site has two of a name", () => {
    // The join is indexed rather than searched per Field Mapping. An index
    // keeps the last of a repeated key by default, so first-wins is pinned
    // here: it is what the search it replaced did.
    const config = readLinkConfig(settingsWith([MACHINE_FIELD]), [
      { id: 1, name: "Machine" },
      { id: 9, name: "Machine" },
    ]);

    expect(config.fieldMappings[0].fieldId).toBe(1);
  });

  it("treats an empty configuration as valid", () => {
    const config = readLinkConfig(settingsWith([]), SITE_USER_FIELDS);

    expect(config.fieldMappings).toEqual([]);
    expect(config.problems).toEqual([]);
  });

  it("treats a missing configuration as empty rather than failing", () => {
    const config = readLinkConfig({}, SITE_USER_FIELDS);

    expect(config.fieldMappings).toEqual([]);
    expect(config.problems).toEqual([]);
  });

  it("has no ceiling on the number of Field Mappings", () => {
    const siteUserFields = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      name: `Field ${i + 1}`,
    }));
    const fields = siteUserFields.map((f) => ({
      user_field_name: f.name,
      mappings: [{ value: "yes", url: "https://example.com" }],
    }));

    const config = readLinkConfig(settingsWith(fields), siteUserFields);

    expect(config.fieldMappings).toHaveLength(25);
    expect(config.problems).toEqual([]);
  });

  it("preserves the administrator's configured order", () => {
    const config = readLinkConfig(
      settingsWith([
        {
          user_field_name: "Mask",
          mappings: [{ value: "F20", url: "https://example.com/f20" }],
        },
        MACHINE_FIELD,
      ]),
      SITE_USER_FIELDS
    );

    expect(config.fieldMappings.map((f) => f.fieldName)).toEqual([
      "Mask",
      "Machine",
    ]);
  });

  it("reports a Field Mapping naming a Custom User Field that does not exist", () => {
    const config = readLinkConfig(
      settingsWith([
        {
          user_field_name: "Humidifier",
          mappings: [{ value: "yes", url: "https://example.com" }],
        },
      ]),
      SITE_USER_FIELDS
    );

    expect(config.fieldMappings).toEqual([]);
    expect(config.problems).toEqual([
      { kind: "unknown-user-field", fieldName: "Humidifier" },
    ]);
  });

  it("reports a Field Mapping with no Mappings", () => {
    const config = readLinkConfig(
      settingsWith([{ user_field_name: "Machine", mappings: [] }]),
      SITE_USER_FIELDS
    );

    expect(config.fieldMappings).toEqual([]);
    expect(config.problems).toEqual([
      { kind: "no-mappings", fieldName: "Machine" },
    ]);
  });

  it("reports a Field Mapping whose Mappings key is absent", () => {
    const config = readLinkConfig(
      settingsWith([{ user_field_name: "Machine" }]),
      SITE_USER_FIELDS
    );

    expect(config.problems).toEqual([
      { kind: "no-mappings", fieldName: "Machine" },
    ]);
  });

  it("reports a Field Mapping with no Custom User Field name", () => {
    const config = readLinkConfig(
      settingsWith([
        {
          user_field_name: "   ",
          mappings: [{ value: "yes", url: "https://example.com" }],
        },
      ]),
      SITE_USER_FIELDS
    );

    expect(config.problems).toEqual([{ kind: "missing-user-field-name" }]);
  });

  it("reports a duplicate value and keeps the first Mapping", () => {
    const config = readLinkConfig(
      settingsWith([
        {
          user_field_name: "Machine",
          mappings: [
            { value: "AirSense 11", url: "https://example.com/first" },
            { value: "AirSense 11", url: "https://example.com/second" },
          ],
        },
      ]),
      SITE_USER_FIELDS
    );

    expect(config.problems).toEqual([
      { kind: "duplicate-value", fieldName: "Machine", value: "AirSense 11" },
    ]);
    expect(config.fieldMappings[0].urlsByValue.get("AirSense 11")).toBe(
      "https://example.com/first"
    );
  });

  it("reports a Mapping with a blank value or URL and ignores it", () => {
    const config = readLinkConfig(
      settingsWith([
        {
          user_field_name: "Machine",
          mappings: [
            { value: "", url: "https://example.com/a" },
            { value: "AirSense 11", url: "  " },
            { value: "DreamStation 2", url: "https://example.com/b" },
          ],
        },
      ]),
      SITE_USER_FIELDS
    );

    expect(config.problems).toEqual([
      { kind: "incomplete-mapping", fieldName: "Machine" },
      { kind: "incomplete-mapping", fieldName: "Machine" },
    ]);
    expect([...config.fieldMappings[0].urlsByValue.keys()]).toEqual([
      "DreamStation 2",
    ]);
  });

  it("keeps a value that collides with an object prototype key", () => {
    const config = readLinkConfig(
      settingsWith([
        {
          user_field_name: "Machine",
          mappings: [
            { value: "constructor", url: "https://example.com/constructor" },
          ],
        },
      ]),
      SITE_USER_FIELDS
    );

    expect(config.fieldMappings[0].urlsByValue.get("constructor")).toBe(
      "https://example.com/constructor"
    );
  });

  it("never throws on a malformed configuration", () => {
    const config = readLinkConfig(
      settingsWith([
        null,
        { user_field_name: null, mappings: null },
      ] as unknown as ThemeSettings["profile_link_fields"]),
      SITE_USER_FIELDS
    );

    expect(config.fieldMappings).toEqual([]);
    expect(config.problems).toEqual([
      { kind: "missing-user-field-name" },
      { kind: "missing-user-field-name" },
    ]);
  });
});

describe("resolveProfileLinks", () => {
  const config = readLinkConfig(
    settingsWith([
      MACHINE_FIELD,
      {
        user_field_name: "Mask",
        mappings: [{ value: "F20", url: "https://example.com/f20" }],
      },
    ]),
    SITE_USER_FIELDS
  );

  it("resolves a matching value into a named Profile Link record", () => {
    const { links } = resolveProfileLinks(config, { 1: "AirSense 11" });

    expect(links).toEqual([
      {
        fieldName: "Machine",
        value: "AirSense 11",
        url: "https://example.com/airsense-11",
      },
    ]);
  });

  it("renders Profile Links in the administrator's configured order", () => {
    const { links } = resolveProfileLinks(config, {
      2: "F20",
      1: "AirSense 11",
    });

    expect(links.map((l) => l.fieldName)).toEqual(["Machine", "Mask"]);
  });

  it("keys user field values by integer id, including string keys from JSON", () => {
    const { links } = resolveProfileLinks(config, { "1": "DreamStation 2" });

    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/dreamstation-2");
  });

  it("returns an empty array, never undefined, when nothing matches", () => {
    expect(resolveProfileLinks(config, {}).links).toEqual([]);
    expect(resolveProfileLinks(config, null).links).toEqual([]);
    expect(resolveProfileLinks(config, undefined).links).toEqual([]);
  });

  it("reports an unmatched value without producing a Config Problem", () => {
    const result = resolveProfileLinks(config, { 1: "Some Other Machine" });

    expect(result.links).toEqual([]);
    expect(result.unmatched).toEqual([
      { fieldName: "Machine", value: "Some Other Machine" },
    ]);
    expect(config.problems).toEqual([]);
  });

  it("produces neither a Profile Link nor an unmatched report for a blank value", () => {
    const result = resolveProfileLinks(config, { 1: "   ", 2: "" });

    expect(result.links).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  it("ignores a non-string field value", () => {
    const result = resolveProfileLinks(config, { 1: ["AirSense 11"] });

    expect(result.links).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  it("resolves a value that collides with an object prototype key", () => {
    const protoConfig = readLinkConfig(
      settingsWith([
        {
          user_field_name: "Machine",
          mappings: [
            { value: "constructor", url: "https://example.com/constructor" },
          ],
        },
      ]),
      SITE_USER_FIELDS
    );

    const { links } = resolveProfileLinks(protoConfig, { 1: "constructor" });

    expect(links).toEqual([
      {
        fieldName: "Machine",
        value: "constructor",
        url: "https://example.com/constructor",
      },
    ]);
  });

  it("resolves nothing from a configuration with no Field Mappings", () => {
    const empty = readLinkConfig(settingsWith([]), SITE_USER_FIELDS);

    expect(resolveProfileLinks(empty, { 1: "AirSense 11" }).links).toEqual([]);
  });
});

describe("describeConfigProblem", () => {
  const problems: ConfigProblem[] = [
    { kind: "missing-user-field-name" },
    { kind: "unknown-user-field", fieldName: "Humidifier" },
    { kind: "no-mappings", fieldName: "Machine" },
    { kind: "duplicate-value", fieldName: "Machine", value: "AirSense 11" },
    { kind: "incomplete-mapping", fieldName: "Machine" },
  ];

  it("describes every kind of Config Problem", () => {
    for (const problem of problems) {
      expect(describeConfigProblem(problem)).toMatch(/\S/);
    }
  });

  it("names the Custom User Field that caused the problem", () => {
    expect(
      describeConfigProblem({
        kind: "unknown-user-field",
        fieldName: "Humidifier",
      })
    ).toContain("Humidifier");
  });
});
