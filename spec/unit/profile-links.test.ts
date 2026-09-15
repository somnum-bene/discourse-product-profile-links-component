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
        valueFieldName: "Machine",
        value: "AirSense 11",
        url: "https://example.com/airsense-11",
      },
    ]);
  });

  it("resolves a Mapping the field never offered as a Dropdown Option", () => {
    // Pins the component half of what Collection Links rest on (ADR-0021):
    // nothing in the runtime changes to make this work, because
    // `resolveProfileLinks` looks the User's stored value up in `urlsByValue`
    // and never consults an options list at all, so a Mapping with no Dropdown
    // Option behind it resolves exactly like any other.
    //
    // It is worth being exact about what this cannot prove, because the
    // component half is the cheaper half. `SiteUserField` is `{ id, name }`
    // and this module contains no reference to options, so "no options are
    // consulted" is a property of the types rather than something this test
    // could fail on. And the other half is Discourse's, not ours: that
    // removing a Dropdown Option leaves the members already holding that value
    // holding it still. No test here can reach that, and ADR-0021 requires it
    // verified on staging before a Collection Link is trusted in production.
    //
    // The fixture is what the feature actually ships: a value carrying the
    // ` (Discontinued)` suffix, pointing at a cpap.com collection page, on a
    // field whose other Mappings are ordinary products. The suffix is written
    // out here on exact bytes — one leading space, one capital `D` — because
    // resolution is an exact trimmed string match, and a near miss resolves
    // for nobody.
    const value = "DreamStation Auto CPAP Machine (Discontinued)";
    const url = "https://www.cpap.com/collections/cpap-machines";
    const withCollectionLink = readLinkConfig(
      settingsWith([
        {
          user_field_name: "Machine",
          mappings: [...MACHINE_FIELD.mappings, { value, url }],
        },
      ]),
      SITE_USER_FIELDS
    );

    // No Config Problem: a Mapping the options do not offer is not a fault the
    // component reports, which is what makes the feature free at runtime.
    expect(withCollectionLink.problems).toEqual([]);

    const result = resolveProfileLinks(withCollectionLink, { 1: value });

    expect(result.links).toEqual([
      { fieldName: "Machine", valueFieldName: "Machine", value, url },
    ]);
    expect(result.unmatched).toEqual([]);

    // And the near misses are not the same value. Each of these is what a
    // member would hold if the suffix were generated even slightly differently,
    // and each resolves to nothing.
    for (const nearMiss of [
      "DreamStation Auto CPAP Machine",
      "DreamStation Auto CPAP Machine (discontinued)",
      "DreamStation Auto CPAP Machine(Discontinued)",
    ]) {
      const missed = resolveProfileLinks(withCollectionLink, { 1: nearMiss });

      expect(missed.links).toEqual([]);
      expect(missed.unmatched).toEqual([
        { fieldName: "Machine", value: nearMiss },
      ]);
    }
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
        valueFieldName: "Machine",
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
    {
      kind: "unknown-shadow-user-field",
      fieldName: "Machine",
      shadowFieldName: "Machine (Discontinued)",
    },
    { kind: "shadow-field-is-its-own-field", fieldName: "Machine" },
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

describe("the Shadow Field fallback", () => {
  // A Shadow Field is a `text`-typed Custom User Field holding a Collection
  // Link value, because a `dropdown` cannot keep one: Discourse resolves an
  // off-list `dropdown` value to nil on its holder's next profile save, and a
  // Collection Link is off-list permanently and by construction (#58,
  // ADR-0021, ADR-0024). It is never a Managed Field and never carries a
  // Dropdown Option — see CONTEXT.md — so nothing here consults an option list
  // any more than the rest of this module does.
  //
  // The ids are deliberately not adjacent to the Managed Fields'. A Shadow
  // Field is created later than the field it shadows, so on a real instance it
  // gets whatever id the sequence is on, and a fixture that numbered them 3 and
  // 4 would let an off-by-one read as a pass.
  const SITE_WITH_SHADOWS: SiteUserField[] = [
    { id: 1, name: "Machine" },
    { id: 2, name: "Mask" },
    { id: 17, name: "Machine (Discontinued)" },
    { id: 18, name: "Mask (Discontinued)" },
  ];

  // Exact bytes, for the reason every value in this file is exact: resolution
  // is a trimmed string equality and a near miss resolves for nobody.
  const COLLECTION_VALUE = "DreamStation Auto CPAP Machine (Discontinued)";
  const COLLECTION_URL = "https://www.cpap.com/collections/cpap-machines";

  const MACHINE_WITH_SHADOW = {
    user_field_name: "Machine",
    shadow_user_field_name: "Machine (Discontinued)",
    mappings: [
      ...MACHINE_FIELD.mappings,
      { value: COLLECTION_VALUE, url: COLLECTION_URL },
    ],
  };

  const shadowed = readLinkConfig(
    settingsWith([MACHINE_WITH_SHADOW]),
    SITE_WITH_SHADOWS
  );

  it("joins the Shadow Field to its own integer id", () => {
    expect(shadowed.problems).toEqual([]);
    expect(shadowed.fieldMappings[0].shadow).toEqual({
      name: "Machine (Discontinued)",
      id: 17,
    });
  });

  it("carries no Shadow Field when the Field Mapping names none", () => {
    const plain = readLinkConfig(
      settingsWith([MACHINE_FIELD]),
      SITE_WITH_SHADOWS
    );

    expect(plain.fieldMappings[0].shadow).toBeUndefined();
  });

  it("resolves a Collection Link from the Shadow Field when the Managed Field is empty", () => {
    // This is the whole feature, in the state #58 actually leaves a holder in:
    // the wipe writes "" rather than removing the key.
    const { links, unmatched } = resolveProfileLinks(shadowed, {
      1: "",
      17: COLLECTION_VALUE,
    });

    expect(unmatched).toEqual([]);
    expect(links).toEqual([
      {
        fieldName: "Machine",
        valueFieldName: "Machine (Discontinued)",
        value: COLLECTION_VALUE,
        url: COLLECTION_URL,
      },
    ]);
  });

  it("labels the Profile Link with the Managed Field's name and not the Shadow Field's", () => {
    // `ProfileLinkRow` renders `{{@link.fieldName}}:`, so getting this wrong
    // puts "Machine (Discontinued): DreamStation Auto CPAP Machine
    // (Discontinued)" on a public profile. A fallback changes where a value
    // came from, never which link it is (ADR-0026).
    const { links } = resolveProfileLinks(shadowed, { 17: COLLECTION_VALUE });

    expect(links[0].fieldName).toBe("Machine");
    expect(links[0].fieldName).not.toContain("(Discontinued)");
  });

  it("names the Custom User Field the value was actually read from", () => {
    // The Link Surfaces hide core's plain-text row for the field a Profile
    // Link replaced, and under a fallback that row belongs to the Shadow
    // Field. Without this they would hide the Managed Field's row, which does
    // not exist, and leave the duplicate they meant to remove.
    const fromShadow = resolveProfileLinks(shadowed, { 17: COLLECTION_VALUE });
    const fromField = resolveProfileLinks(shadowed, { 1: "AirSense 11" });

    expect(fromShadow.links[0].valueFieldName).toBe("Machine (Discontinued)");
    expect(fromField.links[0].valueFieldName).toBe("Machine");
  });

  it("falls back when the Managed Field is absent from the payload entirely", () => {
    const { links } = resolveProfileLinks(shadowed, { 17: COLLECTION_VALUE });

    expect(links).toHaveLength(1);
    expect(links[0].value).toBe(COLLECTION_VALUE);
  });

  it("falls back over a whitespace-only Managed Field value", () => {
    const { links } = resolveProfileLinks(shadowed, {
      1: "   ",
      17: COLLECTION_VALUE,
    });

    expect(links).toHaveLength(1);
    expect(links[0].valueFieldName).toBe("Machine (Discontinued)");
  });

  it("falls back over a non-string Managed Field value", () => {
    const { links } = resolveProfileLinks(shadowed, {
      1: ["AirSense 11"],
      17: COLLECTION_VALUE,
    });

    expect(links).toHaveLength(1);
    expect(links[0].valueFieldName).toBe("Machine (Discontinued)");
  });

  it("lets the Managed Field win when both are populated and they disagree", () => {
    // The Managed Field is the one a User can still edit and the Shadow Field
    // is one they cannot, so a disagreement is the Shadow Field being out of
    // date. Rendering it would show equipment the User has replaced, with a
    // working link: absent is a Profile Link missing, stale is a Profile Link
    // lying (ADR-0026).
    const { links, unmatched } = resolveProfileLinks(shadowed, {
      1: "AirSense 11",
      17: COLLECTION_VALUE,
    });

    expect(unmatched).toEqual([]);
    expect(links).toEqual([
      {
        fieldName: "Machine",
        valueFieldName: "Machine",
        value: "AirSense 11",
        url: "https://example.com/airsense-11",
      },
    ]);
  });

  it("produces one Profile Link, not two, when both are populated", () => {
    // Both sources feed one slot. Two links for one Field Mapping would put
    // the same machine on a profile twice.
    const { links } = resolveProfileLinks(shadowed, {
      1: "AirSense 11",
      17: COLLECTION_VALUE,
    });

    expect(links).toHaveLength(1);
  });

  it("lets the Managed Field win when both are populated and they agree", () => {
    const { links } = resolveProfileLinks(shadowed, {
      1: COLLECTION_VALUE,
      17: COLLECTION_VALUE,
    });

    expect(links).toHaveLength(1);
    expect(links[0].valueFieldName).toBe("Machine");
  });

  it("does not fall back over a Managed Field value that matches no Mapping", () => {
    // An Unmatched Value is a value the User holds, not an empty field. Falling
    // back here would replace what they hold now with what they held before.
    const { links, unmatched } = resolveProfileLinks(shadowed, {
      1: "Some Other Machine",
      17: COLLECTION_VALUE,
    });

    expect(links).toEqual([]);
    expect(unmatched).toEqual([
      { fieldName: "Machine", value: "Some Other Machine" },
    ]);
  });

  it("reports an unmatched Shadow Field value against the Managed Field's slot", () => {
    const { links, unmatched } = resolveProfileLinks(shadowed, {
      17: "Equipment No Mapping Covers",
    });

    expect(links).toEqual([]);
    expect(unmatched).toEqual([
      { fieldName: "Machine", value: "Equipment No Mapping Covers" },
    ]);
  });

  it("ignores a blank or non-string Shadow Field value", () => {
    for (const value of ["", "   ", 42, null, ["x"]]) {
      const { links, unmatched } = resolveProfileLinks(shadowed, { 17: value });

      expect(links).toEqual([]);
      expect(unmatched).toEqual([]);
    }
  });

  it("keeps each Managed Field to its own Shadow Field", () => {
    // One Shadow Field per Managed Field (ADR-0026). A Machine value sitting in
    // Machine's Shadow Field must not resolve into Mask's slot.
    const both = readLinkConfig(
      settingsWith([
        MACHINE_WITH_SHADOW,
        {
          user_field_name: "Mask",
          shadow_user_field_name: "Mask (Discontinued)",
          mappings: [{ value: "F20", url: "https://example.com/f20" }],
        },
      ]),
      SITE_WITH_SHADOWS
    );

    const { links } = resolveProfileLinks(both, { 17: COLLECTION_VALUE });

    expect(links).toEqual([
      {
        fieldName: "Machine",
        valueFieldName: "Machine (Discontinued)",
        value: COLLECTION_VALUE,
        url: COLLECTION_URL,
      },
    ]);
  });

  it("resolves both Managed Fields from their own Shadow Fields at once", () => {
    // The case one shared Shadow Field could not represent, which is why there
    // is one each (ADR-0026).
    const maskValue = "Mirage Quattro Full Face Mask (Discontinued)";
    const maskUrl = "https://www.cpap.com/collections/full-face-masks";
    const both = readLinkConfig(
      settingsWith([
        MACHINE_WITH_SHADOW,
        {
          user_field_name: "Mask",
          shadow_user_field_name: "Mask (Discontinued)",
          mappings: [{ value: maskValue, url: maskUrl }],
        },
      ]),
      SITE_WITH_SHADOWS
    );

    const { links } = resolveProfileLinks(both, {
      17: COLLECTION_VALUE,
      18: maskValue,
    });

    expect(links).toEqual([
      {
        fieldName: "Machine",
        valueFieldName: "Machine (Discontinued)",
        value: COLLECTION_VALUE,
        url: COLLECTION_URL,
      },
      {
        fieldName: "Mask",
        valueFieldName: "Mask (Discontinued)",
        value: maskValue,
        url: maskUrl,
      },
    ]);
  });

  it("reports a Shadow Field the site does not define and keeps the Managed Field working", () => {
    // The failure this guards is the expensive one. A Shadow Field is created
    // by hand on the instance and named in a setting here, so the two can
    // disagree — and dropping the whole Field Mapping over it would take every
    // Profile Link off the site to protect the fallback.
    const missing = readLinkConfig(
      settingsWith([
        {
          user_field_name: "Machine",
          shadow_user_field_name: "Machine (Retained)",
          mappings: MACHINE_FIELD.mappings,
        },
      ]),
      SITE_WITH_SHADOWS
    );

    expect(missing.problems).toEqual([
      {
        kind: "unknown-shadow-user-field",
        fieldName: "Machine",
        shadowFieldName: "Machine (Retained)",
      },
    ]);
    expect(missing.fieldMappings).toHaveLength(1);
    expect(missing.fieldMappings[0].shadow).toBeUndefined();
    expect(
      resolveProfileLinks(missing, { 1: "AirSense 11" }).links
    ).toHaveLength(1);
  });

  it("reports a Field Mapping that names itself as its own Shadow Field", () => {
    const itself = readLinkConfig(
      settingsWith([
        {
          user_field_name: "Machine",
          shadow_user_field_name: "Machine",
          mappings: MACHINE_FIELD.mappings,
        },
      ]),
      SITE_WITH_SHADOWS
    );

    expect(itself.problems).toEqual([
      { kind: "shadow-field-is-its-own-field", fieldName: "Machine" },
    ]);
    expect(itself.fieldMappings[0].shadow).toBeUndefined();
  });

  it("ignores a blank Shadow Field name rather than reporting it", () => {
    // Absent and empty are the same intention — no fallback configured — and
    // the objects editor writes an empty string for a property left alone.
    for (const shadow_user_field_name of ["", "   ", null, undefined]) {
      const config = readLinkConfig(
        settingsWith([{ ...MACHINE_FIELD, shadow_user_field_name }]),
        SITE_WITH_SHADOWS
      );

      expect(config.problems).toEqual([]);
      expect(config.fieldMappings[0].shadow).toBeUndefined();
    }
  });

  it("trims a Shadow Field name before looking it up", () => {
    const padded = readLinkConfig(
      settingsWith([
        {
          ...MACHINE_FIELD,
          shadow_user_field_name: "  Machine (Discontinued) ",
        },
      ]),
      SITE_WITH_SHADOWS
    );

    expect(padded.problems).toEqual([]);
    expect(padded.fieldMappings[0].shadow?.id).toBe(17);
  });

  it("names both fields when it describes an unknown Shadow Field", () => {
    const sentence = describeConfigProblem({
      kind: "unknown-shadow-user-field",
      fieldName: "Machine",
      shadowFieldName: "Machine (Retained)",
    });

    expect(sentence).toContain("Machine (Retained)");
    expect(sentence).toContain("Machine");
  });
});
