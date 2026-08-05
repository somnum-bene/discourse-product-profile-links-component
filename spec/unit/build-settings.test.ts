import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  readLinkConfig,
  resolveProfileLinks,
  type SiteUserField,
} from "../../javascripts/discourse/lib/profile-links";
import {
  FieldMapping,
  renderFieldMappings,
} from "../../scripts/lib/build-catalogue";
import {
  BEGIN_MARKER,
  BuildSettingsError,
  driftReport,
  END_MARKER,
  generatedRegion,
  recordedDigest,
  SETTINGS_FILE,
  settingsWithCatalogue,
} from "../../scripts/lib/build-settings";
import {
  CATALOGUE_FILE,
  declaredDigest,
  readResolvedProducts,
} from "../../scripts/lib/catalogue-refresh";

const DIGEST =
  "c3c3c7d9c7c25e7f16fe08ea83dca4ff367510b7b09cc0c647de8670e9df31b6";
const OTHER_DIGEST =
  "0000000000000000000000000000000000000000000000000000000000000000";

const MACHINE: FieldMapping = {
  user_field_name: "Machine",
  mappings: [
    {
      value: "AirSense 11 AutoSet",
      url: "https://www.cpap.com/products/resmed-airsense-11-autoset",
    },
    {
      value: "AirCurve 10 VAuto BiLevel Machine",
      url: "https://www.cpap.com/products/aircurve-10-vauto-bilevel-machine",
    },
  ],
};

const MASK: FieldMapping = {
  user_field_name: "Mask",
  mappings: [
    {
      value: "Fisher & Paykel Vitera Full Face Mask",
      url: "https://www.cpap.com/products/fisher-paykel-vitera-full-face-mask",
    },
  ],
};

// Shaped like the real file: a hand-written setting before the region, the
// hand-written remainder of the same setting after it, and a second setting
// underneath that has nothing to do with the catalogue.
const SETTINGS = [
  "profile_link_fields:",
  "  type: objects",
  BEGIN_MARKER,
  "  default: []",
  END_MARKER,
  '  description: "Each Field Mapping names one Custom User Field."',
  "  schema:",
  "    name: field",
  "    identifier: user_field_name",
  "",
  "profile_link_debug_mode:",
  "  type: bool",
  "  default: false",
  "",
].join("\n");

function outsideRegion(settingsText: string): string[] {
  const lines = settingsText.split("\n");

  return [
    ...lines.slice(0, lines.indexOf(BEGIN_MARKER)),
    ...lines.slice(lines.indexOf(END_MARKER) + 1),
  ];
}

describe("the generated region", () => {
  it("records the catalogue it was generated from", () => {
    expect(recordedDigest(generatedRegion([MACHINE], DIGEST))).toBe(DIGEST);
  });

  it("says the same thing twice for the same catalogue", () => {
    // No timestamp, no generator version, no host-dependent anything: a build
    // from an unchanged catalogue has to produce an unchanged file or the drift
    // gate reports a difference on every run and stops meaning anything.
    expect(generatedRegion([MACHINE, MASK], DIGEST)).toBe(
      generatedRegion([MACHINE, MASK], DIGEST)
    );
  });

  it("keeps the order the catalogue gave it, and re-sorts nothing", () => {
    // Order is decided by the transform and recorded in the catalogue file. A
    // build that sorted again would be a second opinion about what a user
    // scrolls, and the two could disagree.
    const yaml = parse(
      generatedRegion([MASK, MACHINE], DIGEST)
    ) as SettingBlock;

    expect(yaml.default.map((field) => field.user_field_name)).toEqual([
      "Mask",
      "Machine",
    ]);
    expect(yaml.default[1].mappings.map((mapping) => mapping.value)).toEqual([
      "AirSense 11 AutoSet",
      "AirCurve 10 VAuto BiLevel Machine",
    ]);
  });

  it("refuses a digest that is not one", () => {
    expect(() => generatedRegion([MACHINE], "not-a-digest")).toThrow(
      BuildSettingsError
    );
    expect(() => generatedRegion([MACHINE], DIGEST.toUpperCase())).toThrow(
      /64 hex digits/
    );
  });

  it("refuses a Field Mapping with no Mappings", () => {
    // Shipping one would be worse than shipping nothing: the component reports
    // it as a Config Problem on every page load and ignores the field. A
    // Custom User Field the catalogue has nothing for gets no entry at all,
    // which is the state `Humidifier` is meant to be in.
    expect(() =>
      generatedRegion([{ user_field_name: "Humidifier", mappings: [] }], DIGEST)
    ).toThrow(/no Mappings/);
  });

  it("refuses a Mapping carrying a line break", () => {
    expect(() =>
      generatedRegion(
        [
          {
            user_field_name: "Machine",
            mappings: [{ value: "Air\nSense", url: "https://x.test/a" }],
          },
        ],
        DIGEST
      )
    ).toThrow(/line break/);
  });

  it("writes a long value and a long URL each on one line", () => {
    // YAML folds a long plain scalar across lines by default. The URL is safe
    // whatever the setting, because folding happens at a space and a URL has
    // none — it is the titles that fold, and a Suggested Title long enough to
    // wrap is a matter of what somebody types in the spreadsheet. The value
    // survives the round trip either way; what does not survive is anyone
    // being able to read the file or diff it line by line.
    const longValue =
      "AirFit F30i Full Face CPAP Mask Complete Setup Pack Bundle with Headgear and Cushion Sizes";
    const longUrl =
      "https://www.cpap.com/products/resmed-airsense-10-autoset-cpap-machine-with-humidair-heated-humidifier-and-climateline";
    const region = generatedRegion(
      [
        {
          user_field_name: "Machine",
          mappings: [{ value: longValue, url: longUrl }],
        },
      ],
      DIGEST
    );

    expect(region).toContain(`value: ${longValue}`);
    expect(region).toContain(`url: ${longUrl}`);
  });

  it("survives a title YAML would otherwise misread", () => {
    const awkward: FieldMapping = {
      user_field_name: "Mask",
      mappings: [
        {
          value: "Vitera™ Full Face: the one with #headgear",
          url: "https://x.test/a",
        },
        { value: "yes", url: "https://x.test/b" },
      ],
    };
    const parsed = parse(generatedRegion([awkward], DIGEST)) as SettingBlock;

    // Both of these are the point: a colon would end the key early and `yes`
    // is a YAML boolean. The serialiser quotes them, and what comes back is
    // the string the catalogue holds.
    expect(parsed.default[0].mappings.map((mapping) => mapping.value)).toEqual([
      "Vitera™ Full Face: the one with #headgear",
      "yes",
    ]);
  });
});

describe("splicing the region into settings.yml", () => {
  it("leaves every byte outside the fences alone", () => {
    const built = settingsWithCatalogue(SETTINGS, [MACHINE], DIGEST);

    expect(outsideRegion(built)).toEqual(outsideRegion(SETTINGS));
    expect(built).toContain("profile_link_debug_mode:");
    expect(built).toContain(
      '  description: "Each Field Mapping names one Custom User Field."'
    );
  });

  it("replaces the region rather than accumulating regions", () => {
    const once = settingsWithCatalogue(SETTINGS, [MACHINE], DIGEST);
    const twice = settingsWithCatalogue(once, [MACHINE], DIGEST);

    expect(twice).toBe(once);
    expect(once.split(BEGIN_MARKER)).toHaveLength(2);
  });

  it("refuses a file with no fences, naming the two lines it wants", () => {
    const without = SETTINGS.split("\n")
      .filter((line) => line !== BEGIN_MARKER)
      .join("\n");

    expect(() => settingsWithCatalogue(without, [MACHINE], DIGEST)).toThrow(
      new RegExp(`no BEGIN fence[\\s\\S]*${BEGIN_MARKER.trim()}`)
    );
    expect(() =>
      settingsWithCatalogue(
        SETTINGS.split("\n")
          .filter((line) => line !== END_MARKER)
          .join("\n"),
        [MACHINE],
        DIGEST
      )
    ).toThrow(/no END fence/);
  });

  it("refuses a file with the fences twice", () => {
    expect(() =>
      settingsWithCatalogue(`${SETTINGS}${SETTINGS}`, [MACHINE], DIGEST)
    ).toThrow(/2 BEGIN fences, on lines 3, 16/);
  });

  it("refuses fences the wrong way round", () => {
    const inverted = ["a:", END_MARKER, "  default: []", BEGIN_MARKER, ""].join(
      "\n"
    );

    expect(() => settingsWithCatalogue(inverted, [MACHINE], DIGEST)).toThrow(
      /wrong way round/
    );
  });
});

describe("the digest settings.yml records", () => {
  it("comes back out", () => {
    expect(
      recordedDigest(settingsWithCatalogue(SETTINGS, [MACHINE], DIGEST))
    ).toBe(DIGEST);
  });

  it("refuses a file that records none", () => {
    expect(() => recordedDigest(SETTINGS)).toThrow(BuildSettingsError);
    expect(() => recordedDigest(SETTINGS)).toThrow(/records no catalogue/);
  });

  it("refuses a line that records something other than a digest", () => {
    // A truncated or annotated digest has to be a refusal rather than a value
    // returned: whoever reads this is about to compare it against a catalogue,
    // and "abc" would simply never match while looking like a real answer.
    for (const wrong of [
      "  # Catalogue digest (sha256): abc",
      `  # Catalogue digest (sha256): ${DIGEST.toUpperCase()}`,
      `  # Catalogue digest (sha256): ${DIGEST} (approved)`,
      `# Catalogue digest (sha256): ${DIGEST}`,
    ]) {
      expect(() => recordedDigest(`a: b\n${wrong}\n`)).toThrow(
        BuildSettingsError
      );
    }
  });
});

describe("the drift report", () => {
  it("says nothing when the file is what the build would write", () => {
    const built = settingsWithCatalogue(SETTINGS, [MACHINE], DIGEST);

    expect(driftReport(built, built)).toBeNull();
  });

  it("names the first differing line and what to do about it", () => {
    const built = settingsWithCatalogue(SETTINGS, [MACHINE], DIGEST);
    const edited = built.replace(
      "AirSense 11 AutoSet",
      "AirSense 11 AutoSet (Deprecated)"
    );
    const report = driftReport(edited, built) ?? "";

    expect(report).toContain("first difference at line 11");
    expect(report).toContain("AirSense 11 AutoSet (Deprecated)");
    expect(report).toContain("pnpm build:settings");
  });

  it("counts a whitespace-only difference as drift", () => {
    // Indentation is what nesting means in YAML, so a re-indented region is a
    // different setting value rather than the same one laid out differently.
    // A comparison that forgave whitespace would pass a region whose Mappings
    // had migrated to the wrong field.
    const built = settingsWithCatalogue(SETTINGS, [MACHINE], DIGEST);

    expect(
      driftReport(
        built.replace("        - value:", "          - value:"),
        built
      )
    ).toContain("first difference at line 11");
  });

  it("catches a catalogue change as readily as a hand edit", () => {
    // The two are indistinguishable in the file and have the same remedy, which
    // is why one report covers both.
    const built = settingsWithCatalogue(SETTINGS, [MACHINE], DIGEST);
    const other = settingsWithCatalogue(SETTINGS, [MACHINE], OTHER_DIGEST);

    expect(driftReport(other, built)).toContain("first difference at line 5");
  });

  it("reports a truncated file as ending early", () => {
    const built = settingsWithCatalogue(SETTINGS, [MACHINE], DIGEST);
    const lines = built.split("\n");

    expect(driftReport(lines.slice(0, 6).join("\n"), built)).toContain(
      "committed: (end of file)"
    );
  });
});

interface SettingBlock {
  default: FieldMapping[];
}

interface SettingsFile {
  profile_link_fields: { default: FieldMapping[] };
  profile_link_debug_mode: { default: boolean };
}

describe("the settings.yml this repository ships", () => {
  const settingsText = readFileSync(SETTINGS_FILE, "utf8");
  const catalogueText = readFileSync(CATALOGUE_FILE, "utf8");
  const catalogue = readResolvedProducts(catalogueText);
  const parsed = parse(settingsText) as SettingsFile;
  const shipped = parsed.profile_link_fields.default;

  it("is what a fresh build would write, byte for byte", () => {
    // The drift gate, as a test. `pnpm build:settings --check` is the same
    // comparison run as its own CI step with a message aimed at whoever caused
    // it; this one means a stale settings.yml also fails `pnpm test`, which is
    // what the pre-commit hook runs.
    expect(
      settingsWithCatalogue(
        settingsText,
        renderFieldMappings(catalogue),
        declaredDigest(catalogueText)
      )
    ).toBe(settingsText);
  });

  it("records the digest of the catalogue it was built from", () => {
    // The two sinks have to come from one catalogue (ADR-0011). This is what
    // lets the apply step notice it is about to push Dropdown Options derived
    // from a different one than the shipped Mappings were built from.
    expect(recordedDigest(settingsText)).toBe(declaredDigest(catalogueText));
  });

  it("keeps the rest of the file, so Debug Mode still exists", () => {
    expect(parsed.profile_link_debug_mode.default).toBe(false);
  });

  it("produces no Config Problems on a site defining its fields", () => {
    // Through the component's own reader, on the real shipped value. Ids are
    // invented here because readLinkConfig only joins on the name — what the
    // real instance numbers them is a fact about the instance, not about this
    // file.
    const site: SiteUserField[] = shipped.map((field, index) => ({
      id: index + 1,
      name: field.user_field_name,
    }));

    expect(
      readLinkConfig({ profile_link_fields: shipped }, site).problems
    ).toEqual([]);
  });

  it("resolves a Profile Link for a user holding a shipped value", () => {
    const site: SiteUserField[] = shipped.map((field, index) => ({
      id: index + 1,
      name: field.user_field_name,
    }));
    const config = readLinkConfig({ profile_link_fields: shipped }, site);
    const first = shipped[0].mappings[0];

    expect(resolveProfileLinks(config, { 1: first.value })).toEqual({
      links: [
        {
          fieldName: shipped[0].user_field_name,
          value: first.value,
          url: first.url,
        },
      ],
      unmatched: [],
    });
  });

  it("links only to https cpap.com product pages", () => {
    // readLinkConfig is not schema validation — it checks that a URL is present,
    // not that it is a URL. Discourse's own `validations: url: true` runs
    // server-side on an administrator's input and never sees this default, so
    // the shipped URLs are checked here or nowhere.
    for (const field of shipped) {
      for (const mapping of field.mappings) {
        const url = new URL(mapping.url);

        expect(url.protocol).toBe("https:");
        expect(url.host).toBe("www.cpap.com");
        expect(url.pathname.startsWith("/products/")).toBe(true);
      }
    }

    // The spreadsheet these titles came from was written for sleeping.com, and
    // the URLs are Shopify's rather than rewritten ones (ADR-0009). One
    // surviving rewrite would be a link to somebody else's store.
    expect(settingsText).not.toContain("sleeping.com");
  });

  it("ships every Mapping in the catalogue and nothing else", () => {
    expect(
      shipped.flatMap((field) =>
        field.mappings.map(
          (mapping) => `${field.user_field_name} ${mapping.value}`
        )
      )
    ).toEqual(
      catalogue.map((entry) => `${entry.userFieldName} ${entry.value}`)
    );
  });

  it("gives no field an empty mappings list", () => {
    // `Humidifier` curates no titles (ADR-0012), so it is absent rather than
    // present and empty — the two look similar in a diff and mean opposite
    // things to the component.
    expect(shipped.map((field) => field.user_field_name)).not.toContain(
      "Humidifier"
    );

    for (const field of shipped) {
      expect(field.mappings.length).toBeGreaterThan(0);
    }
  });
});

describe("what each file is allowed to do", () => {
  const lib = readFileSync("scripts/lib/build-settings.ts", "utf8");
  const command = readFileSync("scripts/build-settings.ts", "utf8");

  it("keeps the decisions away from the filesystem and the network", () => {
    expect([...lib.matchAll(/from "(node:[^"]+)"/g)]).toEqual([]);
    expect(lib).not.toContain("fetch(");
    expect(lib).not.toContain("writeFile");
  });

  it("needs no credentials at all, which is what lets it gate CI", () => {
    for (const forbidden of [
      "process.env",
      "SHOPIFY",
      "DISCOURSE",
      "--env-file",
      "fetch(",
    ]) {
      expect(command).not.toContain(forbidden);
    }

    // The npm script deliberately omits the --env-file-if-exists flag the other
    // two commands carry: a build that could read .env is a build that might
    // one day depend on it.
    const scripts = readFileSync("package.json", "utf8");

    expect(scripts).toContain(
      '"build:settings": "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/build-settings.ts"'
    );
  });

  it("decides no file format and no path of its own", () => {
    for (const forbidden of ["sha256", "# BEGIN", "default:", "yaml"]) {
      expect(command).not.toContain(forbidden);
    }

    expect(command).not.toContain(`"${SETTINGS_FILE}"`);
    expect(command).toContain("writeFile(SETTINGS_FILE, built)");
  });

  it("writes the file in exactly one place", () => {
    // `--check` is a gate: CI and the pre-commit hook run it against a checkout
    // they are about to judge, and a gate that repaired what it was inspecting
    // would report success on a repository nobody had fixed. One write, on the
    // path that is not the check, is the whole guarantee.
    expect(command.match(/writeFile\(/g)).toHaveLength(1);
  });

  it("reads the catalogue through the reader that verifies its digest", () => {
    // Not by parsing the CSV again. A second parser would be a second chance to
    // disagree with the file's own account of itself.
    expect(command).toContain("readResolvedProducts(catalogueText)");
    expect(command).not.toContain("parseCsv");
    expect(command).not.toContain("split(");
  });
});
