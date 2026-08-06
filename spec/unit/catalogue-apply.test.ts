import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dropdownOptionsFor,
  renderFieldMappings,
} from "../../scripts/lib/build-catalogue.ts";
import { SETTING_NAME } from "../../scripts/lib/build-settings.ts";
import {
  API_KEY_VAR,
  applyDecision,
  BASE_URL_VAR,
  CatalogueApplyError,
  CLEAR_UNSUPPORTED,
  componentDrift,
  digestDisagreement,
  findComponent,
  instanceOrigin,
  type LiveUserField,
  parseApplyArgs,
  parseUserFields,
  readbackMismatches,
  renderComponent,
  renderPlan,
  renderReadback,
  themesUrl,
  unsupportedWrites,
  userFieldsUrl,
  userFieldUrl,
  writePayload,
} from "../../scripts/lib/catalogue-apply.ts";
import {
  CATALOGUE_FILE,
  readResolvedProducts,
} from "../../scripts/lib/catalogue-refresh.ts";
import { type FieldWrite, planApply } from "../../scripts/lib/plan-apply.ts";

const LIB_FILE = "scripts/lib/catalogue-apply.ts";
const COMMAND_FILE = "scripts/apply-catalogue.ts";

/**
 * The test instance's three fields exactly as `/admin/config/user_fields.json`
 * reported them on 2026-08-05, all thirteen keys of each. The nine keys the plan
 * has no opinion about are here because the update route takes a whole field
 * object, so they are the thing most likely to be lost.
 */
const LIVE_RESPONSE = {
  user_fields: [
    {
      id: 2,
      name: "Machine",
      description: "Machine",
      field_type: "dropdown",
      editable: true,
      required: false,
      requirement: "optional",
      show_on_profile: true,
      show_on_user_card: true,
      show_on_signup: true,
      searchable: false,
      position: 1,
      options: [
        "AirCurve™ 11 VAuto with HumidAir™",
        "AirMini AutoSet™ Travel CPAP Machine",
      ],
    },
    {
      id: 3,
      name: "Mask",
      description: "Mask",
      field_type: "dropdown",
      editable: true,
      required: false,
      requirement: "optional",
      show_on_profile: true,
      show_on_user_card: true,
      show_on_signup: true,
      searchable: false,
      position: 2,
      options: ["Mirage FX Nasal CPAP Mask"],
    },
    {
      id: 4,
      name: "Humidifier",
      description: "Humidifier link",
      field_type: "dropdown",
      editable: true,
      required: false,
      requirement: "optional",
      show_on_profile: true,
      show_on_user_card: true,
      show_on_signup: true,
      searchable: false,
      position: 3,
      options: [
        "DreamStation Heated Humidifier",
        "HC150 Heated Humidifier",
        "Dreamstation Heated Humidifier",
        "S9™ Series H5i™ Heated Humidifier",
      ],
    },
  ],
};

function realCatalogue() {
  return readResolvedProducts(readFileSync(CATALOGUE_FILE, "utf8"));
}

function themesResponse(
  themes: {
    id: number;
    name: string;
    value?: unknown;
    default?: unknown;
    other?: boolean;
  }[]
) {
  return {
    themes: themes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      component: true,
      settings: theme.other
        ? [{ setting: "brand_colour", value: "red", default: "blue" }]
        : [
            {
              setting: SETTING_NAME,
              type: "objects",
              value: theme.value ?? [],
              default: theme.default ?? [],
            },
            {
              setting: "profile_link_debug_mode",
              value: false,
              default: false,
            },
          ],
    })),
  };
}

function mapping(value: string, url: string) {
  return { value, url };
}

function field(name: string, mappings: { value: string; url: string }[]) {
  return { user_field_name: name, mappings };
}

function dropdown(
  id: number,
  name: string,
  options: string[] | null
): LiveUserField {
  return { id, name, field_type: "dropdown", options };
}

describe("the arguments the command takes", () => {
  it("defaults to writing nothing destructive and clearing nothing", () => {
    expect(parseApplyArgs([])).toEqual({
      replace: false,
      clear: [],
      planOnly: false,
    });
  });

  it("takes replace and plan as flags", () => {
    expect(parseApplyArgs(["--replace", "--plan"])).toEqual({
      replace: true,
      clear: [],
      planOnly: true,
    });
  });

  it("takes a field to clear either spelling", () => {
    expect(parseApplyArgs(["--clear", "Humidifier"]).clear).toEqual([
      "Humidifier",
    ]);
    expect(parseApplyArgs(["--clear=Humidifier"]).clear).toEqual([
      "Humidifier",
    ]);
  });

  it("takes a field name with spaces in it", () => {
    expect(parseApplyArgs(["--clear", "Sleep Position"]).clear).toEqual([
      "Sleep Position",
    ]);
  });

  it("collects more than one field, one name at a time", () => {
    expect(
      parseApplyArgs(["--clear", "Humidifier", "--clear", "Mask"]).clear
    ).toEqual(["Humidifier", "Mask"]);
  });

  it("refuses clear with nothing after it, rather than clearing everything", () => {
    expect(() => parseApplyArgs(["--clear"])).toThrow(CatalogueApplyError);
    expect(() => parseApplyArgs(["--clear", "--replace"])).toThrow(
      /needs the name of one Custom User Field/
    );
    expect(() => parseApplyArgs(["--clear="])).toThrow(CatalogueApplyError);
  });

  it("refuses an argument it does not know, and names the ones it does", () => {
    expect(() => parseApplyArgs(["--force"])).toThrow(/--replace/);
    expect(() => parseApplyArgs(["--dry-run"])).toThrow(/--plan/);
  });
});

describe("the instance a run is pointed at", () => {
  it("keeps the origin and drops a trailing slash", () => {
    expect(instanceOrigin("https://tyler-test.discourse.group")).toBe(
      "https://tyler-test.discourse.group"
    );
    expect(instanceOrigin("https://tyler-test.discourse.group/")).toBe(
      "https://tyler-test.discourse.group"
    );
    expect(instanceOrigin("  https://community.cpap.com  ")).toBe(
      "https://community.cpap.com"
    );
  });

  it("refuses http, because the API key travels in a header", () => {
    expect(() => instanceOrigin("http://tyler-test.discourse.group")).toThrow(
      /has to be https/
    );
  });

  it("refuses a bare hostname and says what is missing", () => {
    expect(() => instanceOrigin("tyler-test.discourse.group")).toThrow(
      /needs the scheme/
    );
  });

  it("refuses credentials in the URL", () => {
    expect(() => instanceOrigin("https://user:pass@example.com")).toThrow(
      /belong in DISCOURSE_API_USERNAME/
    );
  });

  it("refuses anything after the origin, because the routes are appended", () => {
    expect(() => instanceOrigin("https://example.com/forum")).toThrow(
      /origin and nothing more/
    );
    expect(() => instanceOrigin("https://example.com/?x=1")).toThrow(
      /origin and nothing more/
    );
  });
});

describe("the routes, confirmed against the running instance", () => {
  const origin = "https://tyler-test.discourse.group";

  it("reads and writes under /admin/config, not /admin/customize", () => {
    expect(userFieldsUrl(origin)).toBe(
      "https://tyler-test.discourse.group/admin/config/user_fields.json"
    );
    expect(userFieldUrl(origin, 4)).toBe(
      "https://tyler-test.discourse.group/admin/config/user_fields/4.json"
    );
    expect(themesUrl(origin)).toBe(
      "https://tyler-test.discourse.group/admin/themes.json"
    );
  });

  it("refuses an id that is not a positive integer", () => {
    // The instance answers 500 rather than 404 for a field it does not know, so
    // a malformed id arrives looking like an outage.
    expect(() => userFieldUrl(origin, 0)).toThrow(CatalogueApplyError);
    expect(() => userFieldUrl(origin, -1)).toThrow(/positive integer/);
    expect(() => userFieldUrl(origin, 1.5)).toThrow(/positive integer/);
    expect(() => userFieldUrl(origin, Number.NaN)).toThrow(/positive integer/);
  });
});

describe("reading the field definitions", () => {
  it("reads the real response and keeps every key of every field", () => {
    const fields = parseUserFields(LIVE_RESPONSE);

    expect(fields.map((entry) => [entry.id, entry.name])).toEqual([
      [2, "Machine"],
      [3, "Mask"],
      [4, "Humidifier"],
    ]);
    expect(Object.keys(fields[0])).toHaveLength(13);
    expect(fields[2].description).toBe("Humidifier link");
    expect(fields[2].position).toBe(3);
  });

  it("refuses an envelope it does not recognise instead of reading it as empty", () => {
    // An empty field list and a changed envelope look identical afterwards, and
    // the next thing that happens is a destructive write.
    expect(() => parseUserFields({ fields: [] })).toThrow(
      /"user_fields" array/
    );
    expect(() => parseUserFields([])).toThrow(CatalogueApplyError);
    expect(() => parseUserFields(null)).toThrow(CatalogueApplyError);
    expect(() => parseUserFields("<html>")).toThrow(CatalogueApplyError);
  });

  it("refuses a field with no id, because the id is how a write addresses it", () => {
    expect(() =>
      parseUserFields({
        user_fields: [{ name: "Machine", field_type: "text" }],
      })
    ).toThrow(/no integer id/);
  });

  it("refuses a field with no name, because the name is how it is found", () => {
    expect(() =>
      parseUserFields({ user_fields: [{ id: 2, field_type: "text" }] })
    ).toThrow(/no name/);
    expect(() =>
      parseUserFields({
        user_fields: [{ id: 2, name: "", field_type: "text" }],
      })
    ).toThrow(/no name/);
  });

  it("refuses options that are not strings, because matching is exact", () => {
    expect(() =>
      parseUserFields({
        user_fields: [
          { id: 2, name: "Machine", field_type: "dropdown", options: [7] },
        ],
      })
    ).toThrow(/not a list of strings/);
  });

  it("accepts a field with no options at all, which is every other type", () => {
    const fields = parseUserFields({
      user_fields: [
        { id: 9, name: "Bio", field_type: "text" },
        { id: 10, name: "Location", field_type: "text", options: null },
      ],
    });

    expect(fields.map((entry) => entry.options)).toEqual([undefined, null]);
  });
});

describe("the body one write sends", () => {
  const humidifier = parseUserFields(LIVE_RESPONSE)[2];

  it("carries every key the instance reported except the id", () => {
    const { user_field: body } = writePayload(humidifier, ["Only this"]);

    expect(body.id).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(
      [
        "description",
        "editable",
        "field_type",
        "name",
        "options",
        "position",
        "required",
        "requirement",
        "searchable",
        "show_on_profile",
        "show_on_signup",
        "show_on_user_card",
      ].sort()
    );
    expect(body.description).toBe("Humidifier link");
    expect(body.show_on_user_card).toBe(true);
    expect(body.position).toBe(3);
  });

  it("replaces the options and nothing else", () => {
    const { user_field: body } = writePayload(humidifier, ["A", "B"]);

    expect(body.options).toEqual(["A", "B"]);
  });

  it("leaves the field it was given alone", () => {
    writePayload(humidifier, ["A"]);

    expect(humidifier.options).toEqual([
      "DreamStation Heated Humidifier",
      "HC150 Heated Humidifier",
      "Dreamstation Heated Humidifier",
      "S9™ Series H5i™ Heated Humidifier",
    ]);
  });

  it("writes options in the order it was given, not sorted", () => {
    const { user_field: body } = writePayload(humidifier, [
      "zeta",
      "Alpha",
      "Mu",
    ]);

    // Confirmed against the instance: it stores the order it is sent.
    expect(body.options).toEqual(["zeta", "Alpha", "Mu"]);
  });
});

describe("a write this transport cannot carry out", () => {
  const clear: FieldWrite = {
    id: 4,
    user_field_name: "Humidifier",
    reason: "clear",
    before: ["DreamStation Heated Humidifier"],
    after: [],
    added: [],
    removed: ["DreamStation Heated Humidifier"],
  };
  const populate: FieldWrite = {
    id: 2,
    user_field_name: "Machine",
    reason: "populate",
    before: [],
    after: ["AirSense 11 AutoSet"],
    added: ["AirSense 11 AutoSet"],
    removed: [],
  };

  it("finds the clears, which are the only kind", () => {
    expect(unsupportedWrites([populate, clear])).toEqual([clear]);
    expect(unsupportedWrites([populate])).toEqual([]);
  });

  it("says why, and does not offer the nearest thing that works", () => {
    // Five payloads were tried against a throwaway field: an empty list is
    // ignored, and every other shape leaves one blank option behind.
    expect(CLEAR_UNSUPPORTED).toContain("answers 200 to an empty options list");
    expect(CLEAR_UNSUPPORTED).toContain("blank choice");
    expect(CLEAR_UNSUPPORTED).toContain("ADR-0015");
  });
});

describe("whether a plan gets sent at all", () => {
  const catalogue = realCatalogue();
  const current = parseUserFields(LIVE_RESPONSE);

  it("proceeds when there is nothing in the way", () => {
    expect(
      applyDecision(planApply(current, catalogue, { replace: true }))
    ).toEqual({ kind: "proceed" });
  });

  it("proceeds when there is nothing to do either", () => {
    expect(
      applyDecision({ writes: [], refusals: [], warnings: [], unchanged: [] })
    ).toEqual({ kind: "proceed" });
  });

  it("stops on a refusal and says nothing was written", () => {
    const decision = applyDecision(planApply(current, catalogue));

    expect(decision.kind).toBe("refused");
    expect(decision.kind === "refused" && decision.message).toContain(
      "nothing was written"
    );
    expect(decision.kind === "refused" && decision.message).toContain(
      "--replace"
    );
  });

  it("counts the refusals, because one field refusing stops them all", () => {
    const decision = applyDecision(
      planApply([...current, dropdown(9, "Mask", ["Typed by hand"])], catalogue)
    );

    expect(decision.kind === "refused" && decision.message).toMatch(
      /^2 refusals/
    );
  });

  it("stops on a clear before any request, not partway through the writes", () => {
    const decision = applyDecision(
      planApply(current, catalogue, { replace: true, clear: ["Humidifier"] })
    );

    expect(decision.kind).toBe("impossible");
    expect(decision.kind === "impossible" && decision.message).toContain(
      "Humidifier"
    );
    expect(decision.kind === "impossible" && decision.message).toContain(
      CLEAR_UNSUPPORTED
    );
  });

  it("says nothing about a clear for a field that is already empty", () => {
    // Nothing to remove means no write, so there is nothing this transport
    // cannot carry out.
    const plan = planApply(
      [...current, dropdown(9, "Sleep Position", [])],
      catalogue,
      { replace: true, clear: ["Sleep Position"] }
    );

    expect(plan.unchanged).toContain("Sleep Position");
    expect(applyDecision(plan)).toEqual({ kind: "proceed" });
  });
});

describe("finding this component on the instance", () => {
  it("finds it by the setting it defines, not by a theme id", () => {
    const lookup = findComponent(
      themesResponse([
        { id: 4, name: "Brand Header", other: true },
        { id: 19, name: "Profile Links", value: [], default: [] },
      ])
    );

    expect(lookup.kind).toBe("one");
    expect(lookup.kind === "one" && lookup.component.id).toBe(19);
    expect(lookup.kind === "one" && lookup.component.name).toBe(
      "Profile Links"
    );
  });

  it("reports the Mappings the component is actually using", () => {
    const value = [field("Machine", [mapping("AirSense 11", "https://a")])];
    const lookup = findComponent(
      themesResponse([{ id: 19, name: "Profile Links", value, default: value }])
    );

    expect(lookup.kind === "one" && lookup.component.fields).toEqual(value);
    expect(lookup.kind === "one" && lookup.component.overridden).toBe(false);
  });

  it("notices an admin override, which freezes that site's Mappings", () => {
    const lookup = findComponent(
      themesResponse([
        {
          id: 19,
          name: "Profile Links",
          value: [field("Machine", [mapping("Typed by hand", "https://a")])],
          default: [field("Machine", [mapping("AirSense 11", "https://a")])],
        },
      ])
    );

    expect(lookup.kind === "one" && lookup.component.overridden).toBe(true);
  });

  it("says so when no theme defines the setting", () => {
    expect(
      findComponent(
        themesResponse([{ id: 4, name: "Brand Header", other: true }])
      ).kind
    ).toBe("none");
    expect(findComponent({ themes: [] }).kind).toBe("none");
  });

  it("says so when two themes define it, because which one wins is undefined", () => {
    const lookup = findComponent(
      themesResponse([
        { id: 19, name: "Profile Links" },
        { id: 21, name: "Profile Links (copy)" },
      ])
    );

    expect(lookup.kind).toBe("many");
    expect(lookup.kind === "many" && lookup.components).toEqual([
      { id: 19, name: "Profile Links" },
      { id: 21, name: "Profile Links (copy)" },
    ]);
  });

  it("refuses a themes response it does not recognise", () => {
    expect(() => findComponent({ theme: [] })).toThrow(/"themes" array/);
  });

  it("refuses a malformed Mapping rather than dropping it", () => {
    // A dropped Mapping would be reported as one the instance is missing, and
    // "deploy the theme" is not the remedy for a malformed setting.
    expect(() =>
      findComponent(
        themesResponse([
          { id: 19, name: "Profile Links", value: [{ mappings: [] }] },
        ])
      )
    ).toThrow(/no user_field_name/);
    expect(() =>
      findComponent(
        themesResponse([
          {
            id: 19,
            name: "Profile Links",
            value: [{ user_field_name: "Machine", mappings: [{ value: "x" }] }],
          },
        ])
      )
    ).toThrow(/without a value and a url/);
  });
});

describe("how far the instance's component is from the catalogue", () => {
  const shipped = [
    field("Machine", [
      mapping("AirSense 11 AutoSet", "https://www.cpap.com/products/a"),
      mapping("AirMini AutoSet", "https://www.cpap.com/products/b"),
    ]),
  ];

  it("is silent when they agree", () => {
    expect(componentDrift(shipped, shipped)).toEqual([]);
  });

  it("names the field when the component carries no Mappings for it", () => {
    const notes = componentDrift([], shipped);

    expect(notes).toHaveLength(1);
    expect(notes[0].detail).toContain('carries no Mappings for "Machine"');
    expect(notes[0].detail).toContain("Unmatched Value");
  });

  it("counts both sides and names what differs", () => {
    const live = [
      field("Machine", [
        mapping("AirSense 11 AutoSet", "https://www.cpap.com/products/a"),
        mapping("Typed by hand", "https://www.cpap.com/products/z"),
      ]),
    ];
    const notes = componentDrift(live, shipped);

    expect(notes[0].detail).toContain("the instance has 2 Mappings");
    expect(notes[0].detail).toContain("the checked-out catalogue has 2");
    expect(notes[0].detail).toContain("1 Mapping the instance does not have");
    expect(notes[0].detail).toContain('"AirMini AutoSet"');
    expect(notes[0].detail).toContain("1 the instance has and the catalogue");
    expect(notes[0].detail).toContain('"Typed by hand"');
  });

  it("notices a Mapping that points somewhere else", () => {
    const live = [
      field("Machine", [
        mapping("AirSense 11 AutoSet", "https://sleeping.com/products/a"),
        mapping("AirMini AutoSet", "https://www.cpap.com/products/b"),
      ]),
    ];

    expect(componentDrift(live, shipped)[0].detail).toContain(
      "1 pointing somewhere else"
    );
  });

  it("mentions a field the instance maps and the catalogue does not", () => {
    const live = [
      ...shipped,
      field("Humidifier", [
        mapping("HC150", "https://www.cpap.com/products/h"),
      ]),
    ];
    const notes = componentDrift(live, shipped);

    expect(notes).toHaveLength(1);
    expect(notes[0].user_field_name).toBe("Humidifier");
    expect(notes[0].detail).toContain("does not touch that field");
  });

  it("is the state the test instance is actually in today", () => {
    // Theme 19 tracks the branch, and the commit it has checked out predates the
    // generated default — so the component reports an empty setting while the
    // catalogue on disk carries 55 Mappings. Writing the Dropdown Options now
    // would produce an Unmatched Value for every one of them.
    const catalogue = realCatalogue();
    const notes = componentDrift([], renderFieldMappings(catalogue));

    expect(notes.map((note) => note.user_field_name)).toEqual([
      "Machine",
      "Mask",
    ]);

    for (const note of notes) {
      expect(note.detail).toContain("no Mappings");
    }
  });
});

describe("reading the write back", () => {
  const targets = [
    { user_field_name: "Machine", options: ["AirSense 11", "AirMini"] },
  ];

  it("is silent when the instance holds exactly what was asked for", () => {
    expect(
      readbackMismatches(
        [dropdown(2, "Machine", ["AirSense 11", "AirMini"])],
        targets
      )
    ).toEqual([]);
  });

  it("catches a write the instance accepted and discarded", () => {
    // The failure this exists for: an empty options list is answered 200 and
    // changes nothing, so the run is green and the site is untouched.
    const mismatches = readbackMismatches(
      [dropdown(4, "Humidifier", ["DreamStation Heated Humidifier"])],
      [{ user_field_name: "Humidifier", options: [] }]
    );

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].actual).toEqual(["DreamStation Heated Humidifier"]);
    expect(mismatches[0].detail).toContain("a 200 is not confirmation");
  });

  it("catches an option the instance silently deduplicated", () => {
    const mismatches = readbackMismatches(
      [dropdown(2, "Machine", ["Gamma", "Delta"])],
      [{ user_field_name: "Machine", options: ["Gamma", "Gamma", "Delta"] }]
    );

    expect(mismatches[0].detail).toContain("holds 2 options");
    expect(mismatches[0].detail).toContain("the catalogue calls for 3");
  });

  it("catches the same options in a different order", () => {
    // Order is part of the value: it is what a User scrolls through.
    const mismatches = readbackMismatches(
      [dropdown(2, "Machine", ["AirMini", "AirSense 11"])],
      targets
    );

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].detail).toContain("in a different order");
  });

  it("catches a field that is no longer there", () => {
    const mismatches = readbackMismatches([], targets);

    expect(mismatches[0].actual).toBeNull();
    expect(mismatches[0].detail).toContain("not on the instance any more");
  });

  it("catches two fields answering to one name", () => {
    const mismatches = readbackMismatches(
      [
        dropdown(2, "Machine", ["AirSense 11", "AirMini"]),
        dropdown(9, "Machine", ["AirSense 11", "AirMini"]),
      ],
      targets
    );

    expect(mismatches[0].actual).toBeNull();
    expect(mismatches[0].detail).toContain("no single option list");
  });

  it("checks every field the catalogue covers, not only the ones written", () => {
    const mismatches = readbackMismatches(
      [dropdown(2, "Machine", ["AirSense 11", "AirMini"])],
      [...targets, { user_field_name: "Mask", options: ["Mirage FX"] }]
    );

    expect(mismatches.map((mismatch) => mismatch.user_field_name)).toEqual([
      "Mask",
    ]);
  });

  it("says plainly when there is nothing to report", () => {
    expect(renderReadback([])).toContain("exactly the options it calls for");
  });
});

describe("the two digests that have to agree", () => {
  const digest = "a".repeat(64);

  it("is silent when they do", () => {
    expect(digestDisagreement(digest, digest)).toBeNull();
  });

  it("prints both, because which one is stale is the whole question", () => {
    const message = digestDisagreement(digest, "b".repeat(64));

    expect(message).toContain(digest);
    expect(message).toContain("b".repeat(64));
    expect(message).toContain("pnpm build:settings");
  });
});

describe("what a person is shown before authorising anything", () => {
  it("puts the refusals first, since they are why nothing happens", () => {
    const plan = planApply(parseUserFields(LIVE_RESPONSE), realCatalogue());
    const rendered = renderPlan(plan);

    expect(rendered.startsWith("REFUSED Machine (would-remove-options)")).toBe(
      true
    );
    expect(rendered).toContain("Machine");
  });

  it("names each option it would remove and what it is probably a spelling of", () => {
    const rendered = renderPlan(
      planApply(parseUserFields(LIVE_RESPONSE), realCatalogue())
    );

    expect(rendered).toContain(
      `- "AirCurve™ 11 VAuto with HumidAir™" — probably the instance's ` +
        `spelling of "AirCurve 11 VAuto with HumidAir"`
    );
  });

  it("prints added and removed in full rather than as a count", () => {
    const plan = planApply(parseUserFields(LIVE_RESPONSE), realCatalogue(), {
      replace: true,
    });
    const rendered = renderPlan(plan);
    const machine = plan.writes.find(
      (write) => write.user_field_name === "Machine"
    );

    for (const option of machine?.added ?? []) {
      expect(rendered).toContain(`+ "${option}"`);
    }

    for (const option of machine?.removed ?? []) {
      expect(rendered).toContain(`- "${option}"`);
    }
  });

  it("names a field that is already correct instead of passing over it", () => {
    const rendered = renderPlan(
      planApply(
        [dropdown(2, "Machine", ["AirSense 11"])],
        [
          {
            userFieldName: "Machine",
            value: "AirSense 11",
            handle: "a",
            status: "ACTIVE",
            url: "https://www.cpap.com/products/a",
          },
        ],
        { managedFields: ["Machine"] }
      )
    );

    expect(rendered).toContain("UNCHANGED Machine");
  });

  it("says nothing at all about a plan with nothing in it", () => {
    expect(
      renderPlan({ writes: [], refusals: [], warnings: [], unchanged: [] })
    ).toBe("");
  });

  it("warns loudly when the component is not installed at all", () => {
    const rendered = renderComponent({ kind: "none" }, []);

    expect(rendered).toContain("not installed here");
    expect(rendered).toContain("resolve");
  });

  it("warns when the setting has been overridden through the admin UI", () => {
    const lookup = findComponent(
      themesResponse([
        {
          id: 19,
          name: "Profile Links",
          value: [field("Machine", [mapping("Typed", "https://a")])],
          default: [],
        },
      ])
    );

    expect(renderComponent(lookup, [])).toContain("ADR-0008");
  });
});

describe("the whole decision against the instance as it stands", () => {
  it("refuses, and with replace produces two writes the readback confirms", () => {
    const catalogue = realCatalogue();
    const current = parseUserFields(LIVE_RESPONSE);
    const targets = dropdownOptionsFor(catalogue);

    expect(planApply(current, catalogue).writes).toEqual([]);

    const plan = planApply(current, catalogue, { replace: true });

    expect(plan.refusals).toEqual([]);
    expect(plan.writes.map((write) => write.user_field_name)).toEqual([
      "Machine",
      "Mask",
    ]);

    // What the instance would hold afterwards, built the way the command builds
    // each request, and then read back the way the command reads it.
    const after = current.map((entry) => {
      const write = plan.writes.find((candidate) => candidate.id === entry.id);

      return write
        ? ({
            ...entry,
            options: writePayload(entry, write.after).user_field.options,
          } as LiveUserField)
        : entry;
    });

    expect(readbackMismatches(after, targets)).toEqual([]);
  });

  it("is safe to run twice: the second run writes nothing", () => {
    const catalogue = realCatalogue();
    const targets = dropdownOptionsFor(catalogue);
    const applied: LiveUserField[] = [
      dropdown(2, "Machine", [...targets[0].options]),
      dropdown(3, "Mask", [...targets[1].options]),
      dropdown(4, "Humidifier", ["DreamStation Heated Humidifier"]),
    ];
    const second = planApply(applied, catalogue, { replace: true });

    expect(second.writes).toEqual([]);
    expect(second.refusals).toEqual([]);
    expect(second.unchanged).toEqual(["Machine", "Mask"]);
    expect(readbackMismatches(applied, targets)).toEqual([]);
    expect(second.warnings.map((warning) => warning.user_field_name)).toEqual([
      "Humidifier",
    ]);
  });

  it("leaves Humidifier alone when only Machine and Mask are being written", () => {
    const catalogue = realCatalogue();
    const plan = planApply(parseUserFields(LIVE_RESPONSE), catalogue, {
      replace: true,
    });

    expect(
      plan.writes.some((write) => write.user_field_name === "Humidifier")
    ).toBe(false);
    expect(unsupportedWrites(plan.writes)).toEqual([]);
  });

  it("stops before any request when Humidifier clearing is asked for", () => {
    const catalogue = realCatalogue();
    const plan = planApply(parseUserFields(LIVE_RESPONSE), catalogue, {
      replace: true,
      clear: ["Humidifier"],
    });

    expect(plan.writes.map((write) => write.reason)).toContain("clear");
    expect(unsupportedWrites(plan.writes).map((write) => write.id)).toEqual([
      4,
    ]);
  });
});

describe("what this step is not allowed to do", () => {
  const lib = readFileSync(LIB_FILE, "utf8");
  const command = readFileSync(COMMAND_FILE, "utf8");

  it("decides everything without a network or a filesystem", () => {
    expect([...lib.matchAll(/from "(node:[^"]+)"/g)]).toEqual([]);

    for (const forbidden of [
      "fetch(",
      "process.env",
      "writeFile",
      "readFile",
      "Date.",
      "Math.random",
    ]) {
      expect(lib).not.toContain(forbidden);
    }
  });

  it("never puts the API key anywhere but a request header", () => {
    expect(command).toContain(`"Api-Key": credentials.key`);
    // Not into a URL, a message, or a log line: no interpolation, no
    // concatenation, nowhere the key could be formatted into a string.
    expect(command).not.toMatch(/\$\{[^}]*\bkey\b[^}]*\}/);
    expect(command).not.toMatch(/\bkey\b\s*\+/);
    expect(command).not.toMatch(/write\([^)]*\bkey\b/);
  });

  it("does not repeat a response body back, only Discourse's own errors", () => {
    expect(command).toContain(".errors.join");
    expect(command).not.toMatch(/\$\{text\}/);
  });

  it("reads the catalogue through the reader that checks its digest", () => {
    expect(command).toContain("readResolvedProducts(catalogueText)");
    expect(command).not.toContain('split("\\n")');
  });

  it("re-reads the instance after writing instead of trusting the responses", () => {
    expect(command).toContain("parseUserFields(");
    expect(command).toContain("readbackMismatches(after, targets)");
  });

  it("consults the decision before the write loop rather than inside it", () => {
    // What the decision *is* is tested above, against plans. This is the one
    // thing only the shell can get wrong: consulting it too late.
    const decided = command.indexOf("applyDecision(plan)");
    const writeLoop = command.indexOf("for (const write of plan.writes)");

    expect(decided).toBeGreaterThan(-1);
    expect(writeLoop).toBeGreaterThan(decided);
    expect(command).toContain(`if (decision.kind !== "proceed")`);
  });

  it("re-decides nothing the plan already decided", () => {
    // The plan is all-or-nothing by construction, so the command's job is to
    // execute `writes` in order or print `refusals`. A second opinion here would
    // be a second place for the destructive rule to live.
    expect(command).not.toContain('"would-remove-options"');
    expect(command).not.toContain("reason ===");
    expect(command).not.toContain("write.removed");
    expect(command).not.toContain("write.added");
    expect(command).toContain("writePayload(field, write.after)");
  });

  it("takes its credentials from the ignored .env, like the other commands", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["apply:catalogue"]).toContain(
      "--env-file-if-exists=.env"
    );
    expect(pkg.scripts["apply:catalogue"]).toContain(
      "scripts/apply-catalogue.ts"
    );
    // Named through the shared constants rather than spelled out again here, so
    // a variable cannot be renamed in one place and read from the other.
    expect(command).toContain("process.env[BASE_URL_VAR]");
    expect(command).toContain("process.env[API_KEY_VAR]");
    expect(command).toContain("process.env[API_USERNAME_VAR]");
    expect(BASE_URL_VAR).toBe("DISCOURSE_BASE_URL");
    expect(API_KEY_VAR).toBe("DISCOURSE_API_KEY");
  });

  it("needs nothing from Shopify, so a rotated token cannot block a deploy", () => {
    expect(command).not.toContain("SHOPIFY");
    expect(command).not.toContain("shopify");
  });
});
