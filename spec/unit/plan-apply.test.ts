import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type CollectionLink,
  dropdownOptionsFor,
  type ResolvedProduct,
} from "../../scripts/lib/build-catalogue";
import {
  CATALOGUE_FILE,
  readResolvedProducts,
} from "../../scripts/lib/catalogue-refresh";
import {
  MANAGED_FIELDS,
  planApply,
  PlanApplyError,
  type UserFieldDefinition,
} from "../../scripts/lib/plan-apply";
import { SHEET_TABS } from "../../scripts/lib/sheet-export";

/**
 * `Machine` and `Mask` as `https://tyler-test.discourse.group` defined them on
 * 2026-08-05, read from `/admin/config/user_fields.json` and trimmed to the
 * keys this step reasons about, plus a third field the instance also happens
 * to define that this pipeline does not manage at all — a leftover from
 * before ADR-0022 dropped `Humidifier` from scope, standing in generically for
 * "a Custom User Field on the instance this pipeline has no opinion about".
 *
 * `Machine` and `Mask` are the real thing rather than a tidy invention because
 * every hard case in this file is already in them: `Machine`'s two options are
 * the catalogue's own products spelled with trademark symbols, and `Mask`'s
 * single option matches a Mapping exactly.
 */
const TEST_INSTANCE: UserFieldDefinition[] = [
  {
    id: 2,
    name: "Machine",
    field_type: "dropdown",
    options: [
      "AirCurve™ 11 VAuto with HumidAir™",
      "AirMini AutoSet™ Travel CPAP Machine",
    ],
  },
  {
    id: 3,
    name: "Mask",
    field_type: "dropdown",
    options: ["Mirage FX Nasal CPAP Mask"],
  },
  {
    id: 4,
    name: "Sleep Position",
    field_type: "dropdown",
    options: ["Side Sleeper", "Back Sleeper", "Stomach Sleeper"],
  },
];

function product(userFieldName: string, value: string): ResolvedProduct {
  return {
    userFieldName,
    value,
    handle: value.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    status: "ACTIVE",
    url: `https://www.cpap.com/products/${value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`,
  };
}

/** Two fields, two values each — small enough to assert every list in full. */
const CATALOGUE: ResolvedProduct[] = [
  product("Machine", "AirSense 11 AutoSet"),
  product("Machine", "AirSense 11 Elite"),
  product("Mask", "AirFit N30i Nasal Mask"),
  product("Mask", "AirFit P10 Nasal Pillow Mask"),
];

const MACHINE_TARGET = ["AirSense 11 AutoSet", "AirSense 11 Elite"];
const MASK_TARGET = ["AirFit N30i Nasal Mask", "AirFit P10 Nasal Pillow Mask"];

function dropdown(
  id: number,
  name: string,
  options: string[]
): UserFieldDefinition {
  return { id, name, field_type: "dropdown", options };
}

/** The two fields the small catalogue covers, defined and empty. */
function emptyFields(): UserFieldDefinition[] {
  return [dropdown(2, "Machine", []), dropdown(3, "Mask", [])];
}

const TWO_FIELDS = ["Machine", "Mask"];

function realCatalogue(): ResolvedProduct[] {
  return readResolvedProducts(readFileSync(CATALOGUE_FILE, "utf8"));
}

describe("the fields this pipeline covers", () => {
  it("is the Sheet Export allowlist, in its order", () => {
    expect(MANAGED_FIELDS).toEqual(["Machine", "Mask"]);
    expect(MANAGED_FIELDS).toEqual(SHEET_TABS.map((tab) => tab.userFieldName));
  });
});

describe("populating fields that are empty", () => {
  it("writes every target option, in the catalogue's order", () => {
    const plan = planApply(emptyFields(), CATALOGUE, [], {
      managedFields: TWO_FIELDS,
    });

    expect(plan.refusals).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.writes).toEqual([
      {
        id: 2,
        user_field_name: "Machine",
        reason: "populate",
        before: [],
        after: MACHINE_TARGET,
        added: MACHINE_TARGET,
        removed: [],
      },
      {
        id: 3,
        user_field_name: "Mask",
        reason: "populate",
        before: [],
        after: MASK_TARGET,
        added: MASK_TARGET,
        removed: [],
      },
    ]);
  });

  it("needs no replace, because nothing is taken away", () => {
    const plan = planApply(emptyFields(), CATALOGUE, [], {
      managedFields: TWO_FIELDS,
    });

    expect(plan.writes).toHaveLength(2);
  });

  it("treats a null option list the same as an empty one", () => {
    const plan = planApply(
      [
        { id: 2, name: "Machine", field_type: "dropdown", options: null },
        { id: 3, name: "Mask", field_type: "dropdown" },
      ],
      CATALOGUE,
      [],
      { managedFields: TWO_FIELDS }
    );

    expect(plan.refusals).toEqual([]);
    expect(plan.writes.map((write) => write.reason)).toEqual([
      "populate",
      "populate",
    ]);
  });

  it("writes the options `dropdownOptionsFor` gives it and nothing else", () => {
    const plan = planApply(emptyFields(), CATALOGUE, [], {
      managedFields: TWO_FIELDS,
    });
    const expected = dropdownOptionsFor(CATALOGUE);

    expect(plan.writes.map((write) => write.after)).toEqual(
      expected.map((field) => field.options)
    );
  });
});

describe("a field already holding the right options", () => {
  it("yields no writes, and is named rather than passed over in silence", () => {
    const plan = planApply(
      [
        dropdown(2, "Machine", MACHINE_TARGET),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      [],
      { managedFields: TWO_FIELDS }
    );

    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toEqual([]);
    expect(plan.unchanged).toEqual(["Machine", "Mask"]);
  });

  it("is what makes a second run safe, replace or not", () => {
    const applied = [
      dropdown(2, "Machine", MACHINE_TARGET),
      dropdown(3, "Mask", MASK_TARGET),
    ];

    for (const replace of [false, true]) {
      const plan = planApply(applied, CATALOGUE, [], {
        managedFields: TWO_FIELDS,
        replace,
      });

      expect(plan.writes).toEqual([]);
      expect(plan.refusals).toEqual([]);
    }
  });

  it("counts order as part of the value", () => {
    const plan = planApply(
      [
        dropdown(2, "Machine", [...MACHINE_TARGET].reverse()),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      [],
      { managedFields: TWO_FIELDS }
    );

    expect(plan.unchanged).toEqual(["Mask"]);
    expect(plan.writes).toEqual([
      {
        id: 2,
        user_field_name: "Machine",
        reason: "reorder",
        before: [...MACHINE_TARGET].reverse(),
        after: MACHINE_TARGET,
        added: [],
        removed: [],
      },
    ]);
  });
});

describe("adding to a field without removing anything", () => {
  it("is a write that needs no replace, and says it added rather than replaced", () => {
    const plan = planApply(
      [
        dropdown(2, "Machine", ["AirSense 11 Elite"]),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      [],
      { managedFields: TWO_FIELDS }
    );

    expect(plan.refusals).toEqual([]);
    expect(plan.writes).toEqual([
      {
        id: 2,
        user_field_name: "Machine",
        reason: "extend",
        before: ["AirSense 11 Elite"],
        after: MACHINE_TARGET,
        added: ["AirSense 11 AutoSet"],
        removed: [],
      },
    ]);
  });
});

describe("refusing a write that would remove an option", () => {
  const withStray = () => [
    dropdown(2, "Machine", ["AirSense 11 AutoSet", "Something A Person Typed"]),
    dropdown(3, "Mask", MASK_TARGET),
  ];

  it("refuses without replace, and names the option that triggered it", () => {
    const plan = planApply(withStray(), CATALOGUE, [], {
      managedFields: TWO_FIELDS,
    });

    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].user_field_name).toBe("Machine");
    expect(plan.refusals[0].reason).toBe("would-remove-options");
    expect(plan.refusals[0].detail).toContain('"Something A Person Typed"');
    expect(plan.refusals[0].removes).toEqual([
      { option: "Something A Person Typed", sameProductAs: null },
    ]);
  });

  it("shows the before-and-after the refusal is protecting", () => {
    const [refusal] = planApply(withStray(), CATALOGUE, [], {
      managedFields: TWO_FIELDS,
    }).refusals;

    expect(refusal.before).toEqual([
      "AirSense 11 AutoSet",
      "Something A Person Typed",
    ]);
    expect(refusal.after).toEqual(MACHINE_TARGET);
  });

  it("writes nothing at all, not even the fields that were fine", () => {
    const plan = planApply(withStray(), CATALOGUE, [], {
      managedFields: TWO_FIELDS,
    });

    expect(plan.writes).toEqual([]);
  });

  it("proceeds with replace, and reports the removal as a replacement", () => {
    const plan = planApply(withStray(), CATALOGUE, [], {
      managedFields: TWO_FIELDS,
      replace: true,
    });

    expect(plan.refusals).toEqual([]);
    expect(plan.writes).toEqual([
      {
        id: 2,
        user_field_name: "Machine",
        reason: "replace",
        before: ["AirSense 11 AutoSet", "Something A Person Typed"],
        after: MACHINE_TARGET,
        added: ["AirSense 11 Elite"],
        removed: ["Something A Person Typed"],
      },
    ]);
  });

  it("keeps an option the catalogue still carries, wherever it came from", () => {
    const plan = planApply(
      [
        dropdown(2, "Machine", ["AirSense 11 Elite", "AirSense 11 AutoSet"]),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      [],
      { managedFields: TWO_FIELDS }
    );

    expect(plan.refusals).toEqual([]);
    expect(plan.writes[0].removed).toEqual([]);
  });

  it("names the target an option is probably a respelling of", () => {
    const plan = planApply(
      [
        dropdown(2, "Machine", ["AirSense™ 11 AutoSet™"]),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      [],
      { managedFields: TWO_FIELDS }
    );

    expect(plan.refusals[0].removes).toEqual([
      {
        option: "AirSense™ 11 AutoSet™",
        sameProductAs: "AirSense 11 AutoSet",
      },
    ]);
  });

  it("still refuses the respelling — the hint is a report, not a match", () => {
    const plan = planApply(
      [
        dropdown(2, "Machine", ["AirSense™ 11 AutoSet™"]),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      [],
      { managedFields: TWO_FIELDS }
    );

    expect(plan.refusals[0].reason).toBe("would-remove-options");
    expect(plan.writes).toEqual([]);

    const replaced = planApply(
      [
        dropdown(2, "Machine", ["AirSense™ 11 AutoSet™"]),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      [],
      { managedFields: TWO_FIELDS, replace: true }
    );

    expect(replaced.writes[0].after).toEqual(MACHINE_TARGET);
    expect(replaced.writes[0].removed).toEqual(["AirSense™ 11 AutoSet™"]);
  });

  it("treats a case difference as a removal, because Discourse does", () => {
    const plan = planApply(
      [
        dropdown(2, "Machine", ["airsense 11 autoset", "AirSense 11 Elite"]),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      [],
      { managedFields: TWO_FIELDS }
    );

    expect(plan.refusals[0].removes).toEqual([
      { option: "airsense 11 autoset", sameProductAs: "AirSense 11 AutoSet" },
    ]);
  });
});

/**
 * An instance that received the April 2026 run: the products of the day, plus
 * the four retired legacy catch-all titles the run wrote as Dropdown Options.
 *
 * The links beside them are a fixture, and deliberately not what
 * `data/collection-links.csv` ships. ADR-0020 retires those four titles as
 * values — "a row that carried one now takes its own legacy name instead" — so
 * the shipped file carries `DreamStation CPAP Machine (Discontinued)` and never
 * `CPAP Machines (Discontinued)`. Reading the fixture off that file would pin
 * whatever the last Catalogue Refresh produced, which is that command's question
 * rather than this one's.
 *
 * What is pinned here is the reporting: a value the Mappings carry and the
 * options do not, whichever value that turns out to be. Today none of the four
 * is one, because no option this pipeline has ever written carries the
 * generated ` (Discontinued)` suffix — so on real data these four are removed
 * with no retention behind them, and the test below on a near-spelling is that
 * same rule seen from the side the shipped data is actually on.
 */
const CATCH_ALLS = [
  {
    userFieldName: "Machine",
    value: "CPAP Machines (Discontinued)",
    url: "https://www.cpap.com/collections/cpap-machines",
  },
  {
    userFieldName: "Mask",
    value: "CPAP Masks (Discontinued)",
    url: "https://www.cpap.com/collections/cpap-masks",
  },
  {
    userFieldName: "Mask",
    value: "Full Face CPAP Masks (Discontinued)",
    url: "https://www.cpap.com/collections/full-face-cpap-masks",
  },
  {
    userFieldName: "Mask",
    value: "Nasal CPAP Masks (Discontinued)",
    url: "https://www.cpap.com/collections/nasal-cpap-masks",
  },
] as const;

const CATCH_ALL_LINKS: CollectionLink[] = CATCH_ALLS.map((entry) => ({
  userFieldName: entry.userFieldName,
  value: entry.value,
  url: entry.url,
}));

function legacyInstance(): UserFieldDefinition[] {
  return [
    dropdown(2, "Machine", [...MACHINE_TARGET, "CPAP Machines (Discontinued)"]),
    dropdown(3, "Mask", [
      ...MASK_TARGET,
      "CPAP Masks (Discontinued)",
      "Full Face CPAP Masks (Discontinued)",
      "Nasal CPAP Masks (Discontinued)",
    ]),
  ];
}

describe("an option removed while its Mapping stays", () => {
  it("says both halves in one message", () => {
    const plan = planApply(legacyInstance(), CATALOGUE, CATCH_ALL_LINKS, {
      managedFields: TWO_FIELDS,
      replace: true,
    });
    const [machine] = plan.retained;

    expect(machine.user_field_name).toBe("Machine");
    expect(machine.value).toBe("CPAP Machines (Discontinued)");
    expect(machine.url).toBe("https://www.cpap.com/collections/cpap-machines");
    expect(machine.detail).toContain("removed as a Dropdown Option");
    expect(machine.detail).toContain("retained as a Mapping");
    expect(machine.detail).toContain("CPAP Machines (Discontinued)");
    expect(machine.detail).toContain(
      "https://www.cpap.com/collections/cpap-machines"
    );
  });

  it("names every catch-all the write takes away", () => {
    const plan = planApply(legacyInstance(), CATALOGUE, CATCH_ALL_LINKS, {
      managedFields: TWO_FIELDS,
      replace: true,
    });

    expect(plan.retained.map((entry) => entry.value)).toEqual([
      "CPAP Machines (Discontinued)",
      "CPAP Masks (Discontinued)",
      "Full Face CPAP Masks (Discontinued)",
      "Nasal CPAP Masks (Discontinued)",
    ]);
    expect(plan.writes.flatMap((write) => write.removed)).toEqual(
      plan.retained.map((entry) => entry.value)
    );
  });

  it("says it while the operator is still deciding, not after", () => {
    // No `replace`, so the plan refuses and writes nothing. This is the moment
    // the disposition exists for: the operator is reading a list of removals
    // and choosing whether to authorise it.
    const plan = planApply(legacyInstance(), CATALOGUE, CATCH_ALL_LINKS, {
      managedFields: TWO_FIELDS,
    });

    expect(plan.writes).toEqual([]);
    expect(plan.refusals.map((refusal) => refusal.reason)).toEqual([
      "would-remove-options",
      "would-remove-options",
    ]);
    expect(plan.retained).toHaveLength(4);
  });

  it("is not one of the dispositions that already existed", () => {
    const plan = planApply(legacyInstance(), CATALOGUE, CATCH_ALL_LINKS, {
      managedFields: TWO_FIELDS,
      replace: true,
    });

    expect(plan.warnings).toEqual([]);
    expect(plan.unchanged).toEqual([]);
    expect(plan.refusals).toEqual([]);
    expect(plan.retained).toHaveLength(4);
  });

  /** One removal a link covers, one it does not. */
  function mixedRemovals(): UserFieldDefinition[] {
    return [
      dropdown(2, "Machine", [
        ...MACHINE_TARGET,
        "CPAP Machines (Discontinued)",
        "Typed by hand",
      ]),
      dropdown(3, "Mask", MASK_TARGET),
    ];
  }

  it("refuses exactly as it did, whatever the links say", () => {
    // AC 6 protects the decision, not the prose. Everything the refusal *does*
    // — refuse, name every removal, empty the writes, demand `replace` — is
    // identical with and without the links.
    const links = planApply(mixedRemovals(), CATALOGUE, CATCH_ALL_LINKS, {
      managedFields: TWO_FIELDS,
    });
    const without = planApply(mixedRemovals(), CATALOGUE, [], {
      managedFields: TWO_FIELDS,
    });

    expect(links.writes).toEqual([]);
    expect(links.refusals.map((refusal) => refusal.reason)).toEqual(
      without.refusals.map((refusal) => refusal.reason)
    );
    expect(links.refusals[0].removes).toEqual(without.refusals[0].removes);
    expect(links.refusals[0].before).toEqual(without.refusals[0].before);
    expect(links.refusals[0].after).toEqual(without.refusals[0].after);
    expect(links.refusals[0].removes.map((removal) => removal.option)).toEqual([
      "CPAP Machines (Discontinued)",
      "Typed by hand",
    ]);
    expect(links.retained.map((entry) => entry.value)).toEqual([
      "CPAP Machines (Discontinued)",
    ]);
  });

  it("does not tell the operator two opposite things about one value", () => {
    // The blanket "removing one silently stops every User holding it from
    // getting a Profile Link" is false of a covered value, and the retention
    // printed alongside says so outright.
    const [refusal] = planApply(mixedRemovals(), CATALOGUE, CATCH_ALL_LINKS, {
      managedFields: TWO_FIELDS,
    }).refusals;

    expect(refusal.detail).toContain(
      '"CPAP Machines (Discontinued)" is still carried as a Collection Link'
    );
    expect(refusal.detail).toContain("takes away the option and not the");
    expect(refusal.detail).toContain(
      "Removing any of the rest silently stops every User holding it"
    );
  });

  it("keeps the old refusal wording when no link covers anything", () => {
    const [refusal] = planApply(mixedRemovals(), CATALOGUE, [], {
      managedFields: TWO_FIELDS,
    }).refusals;

    expect(refusal.detail).toContain(
      "Removing one silently stops every User holding it from getting a " +
        "Profile Link"
    );
    expect(refusal.detail).toContain("Pass replace to authorise it.");
    expect(refusal.detail).not.toContain("Collection Link");
  });

  it("claims no remainder when a link covers every removal", () => {
    // The mixed wording narrows the blanket claim to "the rest". With nothing
    // uncovered there is no rest, and carrying that clause anyway tells the
    // operator a Profile Link is at stake when none is — the same
    // self-contradiction the covered/uncovered split exists to remove, just
    // pointing the other way.
    const [refusal] = planApply(
      [
        dropdown(2, "Machine", [
          ...MACHINE_TARGET,
          "CPAP Machines (Discontinued)",
        ]),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      CATCH_ALL_LINKS,
      { managedFields: TWO_FIELDS }
    ).refusals;

    expect(refusal.detail).not.toContain("the rest");
    expect(refusal.detail).toContain(
      "It is still carried as a Collection Link"
    );
    expect(refusal.detail).toContain("No User holding it stops getting a");
  });

  it("still demands replace when every removal is covered, and says why", () => {
    // The case where the refusal looks unjustified, so it owes an answer to
    // "then why am I being stopped?" — ADR-0013's, not silence.
    const plan = planApply(
      [
        dropdown(2, "Machine", [
          ...MACHINE_TARGET,
          "CPAP Machines (Discontinued)",
        ]),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      CATCH_ALL_LINKS,
      { managedFields: TWO_FIELDS }
    );

    expect(plan.refusals[0].reason).toBe("would-remove-options");
    expect(plan.writes).toEqual([]);
    expect(plan.refusals[0].detail).toContain(
      "authorised by what it takes out of the list and not by how harmless " +
        "it looks (ADR-0013)"
    );
  });

  it("matches a value the way the runtime resolves it, trimming both sides", () => {
    // `readLinkConfig` trims the Mapping value and `resolveProfileLinks` trims
    // the stored value before the lookup, so an option that differs only by
    // surrounding whitespace still resolves and is not a lost Profile Link.
    const plan = planApply(
      [
        dropdown(2, "Machine", [
          ...MACHINE_TARGET,
          "  CPAP Machines (Discontinued)  ",
        ]),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      CATCH_ALL_LINKS,
      { managedFields: TWO_FIELDS, replace: true }
    );

    expect(plan.retained.map((entry) => entry.value)).toEqual([
      "  CPAP Machines (Discontinued)  ",
    ]);
  });

  it("still refuses a value that differs by more than whitespace", () => {
    const plan = planApply(
      [
        dropdown(2, "Machine", [
          ...MACHINE_TARGET,
          "CPAP machines (discontinued)",
        ]),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      CATCH_ALL_LINKS,
      { managedFields: TWO_FIELDS, replace: true }
    );

    expect(plan.retained).toEqual([]);
  });

  it("does not claim a Collection Link the value is only nearly spelled as", () => {
    // The Mapping is keyed on `CPAP Machines (Discontinued)`. A User holding
    // `CPAP Machines` really does lose their Profile Link, so reporting this
    // removal as retained would promise a link that never appears.
    const plan = planApply(
      [
        dropdown(2, "Machine", [...MACHINE_TARGET, "CPAP Machines"]),
        dropdown(3, "Mask", MASK_TARGET),
      ],
      CATALOGUE,
      CATCH_ALL_LINKS,
      { managedFields: TWO_FIELDS, replace: true }
    );

    expect(plan.writes[0].removed).toEqual(["CPAP Machines"]);
    expect(plan.retained).toEqual([]);
  });

  it("reports a retention whichever branch decided the removal", () => {
    // `clear` is the third place a removal is decided, and it is decided about
    // a field the catalogue has no Mappings for — which is exactly the field a
    // Collection Link can be the only Mapping on.
    const plan = planApply(
      [...emptyFields(), dropdown(4, "Vendor", ["Acme CPAP (Discontinued)"])],
      CATALOGUE,
      [
        {
          userFieldName: "Vendor",
          value: "Acme CPAP (Discontinued)",
          url: "https://www.cpap.com/collections/cpap-machines",
        },
      ],
      { managedFields: [...TWO_FIELDS, "Vendor"], clear: ["Vendor"] }
    );

    expect(plan.retained.map((entry) => entry.value)).toEqual([
      "Acme CPAP (Discontinued)",
    ]);
  });

  it("has nothing to say about a plan that removes nothing", () => {
    const plan = planApply(emptyFields(), CATALOGUE, CATCH_ALL_LINKS, {
      managedFields: TWO_FIELDS,
    });

    expect(plan.writes.map((write) => write.reason)).toEqual([
      "populate",
      "populate",
    ]);
    expect(plan.retained).toEqual([]);
  });
});

describe("a field whose only Mappings are Collection Links", () => {
  /**
   * The options come from the products alone, so a field can carry Mappings and
   * emit no target at all — the state ADR-0020's standing mechanism reaches on
   * its own the day a field's last product retires. The warnings for a field
   * with no targets have to tell that apart from a field with nothing behind it,
   * because they say what does and does not resolve.
   */
  const VENDOR_LINK = {
    userFieldName: "Vendor",
    value: "Acme CPAP (Discontinued)",
    url: "https://www.cpap.com/collections/cpap-machines",
  };
  const THREE = [...TWO_FIELDS, "Vendor"];

  function warningFor(fields: UserFieldDefinition[]): string {
    const plan = planApply(
      [...emptyFields(), ...fields],
      CATALOGUE,
      [VENDOR_LINK],
      {
        managedFields: THREE,
      }
    );
    const warning = plan.warnings.find(
      (entry) => entry.user_field_name === "Vendor"
    );

    expect(warning).toBeDefined();

    return warning?.detail ?? "";
  }

  it("does not say the catalogue has no Mappings when it has links", () => {
    const detail = warningFor([]);

    expect(detail).not.toContain("has no Mappings for it");
    expect(detail).toContain("1 Collection Link");
    expect(detail).toContain("resolve for nobody");
  });

  it("keeps the old wording for a field nothing covers at all", () => {
    const withLinks = warningFor([]);
    const withoutLinks = planApply([...emptyFields()], CATALOGUE, [], {
      managedFields: THREE,
    }).warnings.find((entry) => entry.user_field_name === "Vendor");

    expect(withoutLinks?.detail).toContain(
      "the catalogue has no Mappings for it, and the instance does not define it"
    );
    expect(withoutLinks?.detail).not.toEqual(withLinks);
  });

  it("does not claim an option resolves nowhere when a link covers it", () => {
    const detail = warningFor([
      dropdown(4, "Vendor", ["Acme CPAP (Discontinued)"]),
    ]);

    expect(detail).not.toContain("gets no Profile Link");
    expect(detail).toContain("a Collection Link covers every one of them");
    expect(detail).toContain("never shown to a User choosing one");
  });

  it("counts the covered options with the noun, not as a bare number", () => {
    const detail = warningFor([
      dropdown(4, "Vendor", ["Acme CPAP (Discontinued)", "Typed by hand"]),
    ]);

    expect(detail).toContain("its other 1 option is each covered by a");
    expect(detail).not.toContain("covers its other 1.");
  });

  it("treats a whitespace-only difference as covered, as the runtime does", () => {
    const detail = warningFor([
      dropdown(4, "Vendor", ["  Acme CPAP (Discontinued)"]),
    ]);

    expect(detail).toContain("a Collection Link covers every one of them");
    expect(detail).not.toContain("gets no Profile Link");
  });

  it("names only the options no Mapping covers when some are covered", () => {
    const detail = warningFor([
      dropdown(4, "Vendor", ["Acme CPAP (Discontinued)", "Typed by hand"]),
    ]);

    expect(detail).toContain("1 option no Mapping covers");
    expect(detail).toContain('"Typed by hand"');
    expect(detail).not.toContain('"Acme CPAP (Discontinued)"');
    expect(detail).toContain("gets no Profile Link");
  });

  it("says the same thing as before when the field has no links", () => {
    const plan = planApply(
      [...emptyFields(), dropdown(4, "Vendor", ["Typed by hand"])],
      CATALOGUE,
      [],
      { managedFields: THREE }
    );
    const warning = plan.warnings.find(
      (entry) => entry.user_field_name === "Vendor"
    );

    expect(warning?.detail).toContain(
      "the catalogue has no Mappings for it, so every User who picks one gets " +
        "no Profile Link"
    );
  });
});

describe("a field the catalogue has no Mappings for", () => {
  // Not a real Managed Field — invented and named explicitly via
  // `managedFields` so this scenario (a field this pipeline is scoped to but
  // the catalogue has nothing for) stays exercised without tying it to any
  // one real field's history.
  const THREE_FIELDS = [...TWO_FIELDS, "Vendor"];
  const vendor = () => [
    ...emptyFields(),
    dropdown(4, "Vendor", ["Acme Supply Co"]),
  ];

  it("is left alone, and warned about", () => {
    const plan = planApply(vendor(), CATALOGUE, [], {
      managedFields: THREE_FIELDS,
    });

    expect(plan.writes.map((write) => write.user_field_name)).toEqual([
      "Machine",
      "Mask",
    ]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0].user_field_name).toBe("Vendor");
    expect(plan.warnings[0].detail).toContain("Acme Supply Co");
    expect(plan.warnings[0].detail).toContain("no Profile Link");
  });

  it("is not cleared by replace", () => {
    const plan = planApply(vendor(), CATALOGUE, [], {
      managedFields: THREE_FIELDS,
      replace: true,
    });

    expect(
      plan.writes.some((write) => write.user_field_name === "Vendor")
    ).toBe(false);
  });

  it("clears to empty when it is named, and only then", () => {
    const plan = planApply(vendor(), CATALOGUE, [], {
      managedFields: THREE_FIELDS,
      clear: ["Vendor"],
    });

    expect(plan.refusals).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.writes[0]).toEqual({
      id: 4,
      user_field_name: "Vendor",
      reason: "clear",
      before: ["Acme Supply Co"],
      after: [],
      added: [],
      removed: ["Acme Supply Co"],
    });
  });

  it("needs no replace to clear — naming the field is the authorisation", () => {
    const plan = planApply(vendor(), CATALOGUE, [], {
      managedFields: THREE_FIELDS,
      clear: ["Vendor"],
      replace: false,
    });

    expect(plan.refusals).toEqual([]);
    expect(plan.writes[0].reason).toBe("clear");
  });

  it("is already clear, and is named rather than written to again", () => {
    const plan = planApply(
      [...emptyFields(), dropdown(4, "Vendor", [])],
      CATALOGUE,
      [],
      { managedFields: THREE_FIELDS, clear: ["Vendor"] }
    );

    expect(plan.writes.map((write) => write.user_field_name)).toEqual([
      "Machine",
      "Mask",
    ]);
    expect(plan.unchanged).toContain("Vendor");
  });

  it("warns rather than refuses when the instance does not define it", () => {
    const plan = planApply(emptyFields(), CATALOGUE, [], {
      managedFields: THREE_FIELDS,
    });

    expect(plan.refusals).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0].user_field_name).toBe("Vendor");
    expect(plan.warnings[0].detail).toContain("does not define it");
  });

  it("does not warn about a field outside the pipeline's scope", () => {
    const plan = planApply(
      [...emptyFields(), dropdown(9, "Location", ["Anywhere"])],
      CATALOGUE,
      [],
      { managedFields: THREE_FIELDS }
    );

    expect(plan.warnings.map((warning) => warning.user_field_name)).toEqual([
      "Vendor",
    ]);
  });
});

describe("refusing to clear the wrong thing", () => {
  it("refuses a name the instance does not define", () => {
    const plan = planApply(emptyFields(), CATALOGUE, [], {
      clear: ["Vendor"],
      managedFields: TWO_FIELDS,
    });

    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toBe("clear-target-missing");
    expect(plan.refusals[0].detail).toContain("Vendor");
    expect(plan.writes).toEqual([]);
  });

  it("refuses a field the catalogue populates", () => {
    const plan = planApply(emptyFields(), CATALOGUE, [], {
      clear: ["Machine"],
      managedFields: TWO_FIELDS,
    });

    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toBe("clear-target-mapped");
    expect(plan.refusals[0].user_field_name).toBe("Machine");
    expect(plan.writes).toEqual([]);
  });

  it("refuses a field that cannot hold options", () => {
    const plan = planApply(
      [
        ...emptyFields(),
        { id: 4, name: "Vendor", field_type: "text", options: null },
      ],
      CATALOGUE,
      [],
      { clear: ["Vendor"] }
    );

    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toBe("field-not-dropdown");
    expect(plan.refusals[0].detail).toContain("text field");
  });

  it("throws when the same field is named twice", () => {
    // Matched on the message as well as the type, the way the duplicate-value
    // sibling is. `planApply` has several `PlanApplyError`s reachable from
    // this call, so the type alone would be satisfied by a different refusal
    // firing first — and then this would go on passing while the duplicate
    // check it names had stopped running.
    expect(() =>
      planApply(emptyFields(), CATALOGUE, [], {
        clear: ["Vendor", "Vendor"],
      })
    ).toThrow(PlanApplyError);
    expect(() =>
      planApply(emptyFields(), CATALOGUE, [], {
        clear: ["Vendor", "Vendor"],
      })
    ).toThrow(/twice/);
  });
});

describe("a field the plan cannot reason about", () => {
  it("refuses when the catalogue names a field the instance does not define", () => {
    const plan = planApply([dropdown(3, "Mask", [])], CATALOGUE, [], {
      managedFields: TWO_FIELDS,
    });

    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].user_field_name).toBe("Machine");
    expect(plan.refusals[0].reason).toBe("field-missing");
    expect(plan.refusals[0].after).toEqual(MACHINE_TARGET);
    expect(plan.writes).toEqual([]);
  });

  it("refuses when the field is not a dropdown", () => {
    const plan = planApply(
      [
        { id: 2, name: "Machine", field_type: "text", options: null },
        dropdown(3, "Mask", []),
      ],
      CATALOGUE,
      [],
      { managedFields: TWO_FIELDS }
    );

    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toBe("field-not-dropdown");
    expect(plan.writes).toEqual([]);
  });

  it("refuses when two fields share the name", () => {
    const plan = planApply(
      [
        dropdown(2, "Machine", []),
        dropdown(7, "Machine", []),
        dropdown(3, "Mask", []),
      ],
      CATALOGUE,
      [],
      { managedFields: TWO_FIELDS }
    );

    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].reason).toBe("field-ambiguous");
    expect(plan.refusals[0].detail).toContain("ids 2, 7");
    expect(plan.writes).toEqual([]);
  });

  it("warns when the duplicate is a field it was not going to touch", () => {
    const plan = planApply(
      [
        ...emptyFields(),
        dropdown(4, "Vendor", ["Acme Supply Co"]),
        dropdown(8, "Vendor", []),
      ],
      CATALOGUE,
      [],
      { managedFields: [...TWO_FIELDS, "Vendor"] }
    );

    expect(plan.refusals).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0].detail).toContain("ids 4, 8");
  });
});

describe("the order options are written in", () => {
  /**
   * `buildCatalogue` sorts case-insensitively, which is the order a person reads
   * a dropdown in. Code point order is not the same order — every capital letter
   * sorts before every lowercase one — so a plan that re-sorted its target list
   * would agree with the catalogue on this fixture only by accident.
   */
  const MIXED_CASE = [
    product("Machine", "airSense 11 AutoSet"),
    product("Machine", "AirSense 11 Elite"),
  ];

  it("is the catalogue's, not one this step decides for itself", () => {
    const plan = planApply([dropdown(2, "Machine", [])], MIXED_CASE, [], {
      managedFields: ["Machine"],
    });

    expect(plan.writes[0].after).toEqual([
      "airSense 11 AutoSet",
      "AirSense 11 Elite",
    ]);
    expect(plan.writes[0].after).not.toEqual([...plan.writes[0].after].sort());
  });

  it("is the order `dropdownOptionsFor` gave it, on the real catalogue too", () => {
    const catalogue = realCatalogue();
    const plan = planApply(TEST_INSTANCE, catalogue, [], { replace: true });

    expect(plan.writes.map((write) => write.after)).toEqual(
      dropdownOptionsFor(catalogue).map((field) => field.options)
    );
  });
});

describe("a catalogue this step cannot use", () => {
  it("never sees an empty option list, because none can be produced", () => {
    const catalogue = realCatalogue();

    expect(dropdownOptionsFor(catalogue).length).toBeGreaterThan(0);

    for (const field of dropdownOptionsFor(catalogue)) {
      expect(field.options.length).toBeGreaterThan(0);
    }

    expect(
      dropdownOptionsFor([product("Machine", "AirSense 11 AutoSet")])
    ).toEqual([
      { user_field_name: "Machine", options: ["AirSense 11 AutoSet"] },
    ]);
    expect(dropdownOptionsFor([])).toEqual([]);
  });

  it("throws on an option list the transform should never have produced", () => {
    const twice = [
      product("Machine", "AirSense 11 AutoSet"),
      product("Machine", "AirSense 11 AutoSet"),
    ];

    expect(() =>
      planApply(emptyFields(), twice, [], { managedFields: TWO_FIELDS })
    ).toThrow(PlanApplyError);
    expect(() =>
      planApply(emptyFields(), twice, [], { managedFields: TWO_FIELDS })
    ).toThrow(/twice/);
  });

  it("plans nothing at all for an empty catalogue, and warns about each field", () => {
    const plan = planApply(TEST_INSTANCE, [], []);

    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toEqual([]);
    expect(plan.warnings.map((warning) => warning.user_field_name)).toEqual(
      MANAGED_FIELDS
    );
  });
});

describe("the test instance as it stands today", () => {
  it("refuses without replace, naming the trademark spellings", () => {
    const plan = planApply(TEST_INSTANCE, realCatalogue(), []);

    expect(plan.writes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0].user_field_name).toBe("Machine");
    expect(plan.refusals[0].reason).toBe("would-remove-options");
    expect(plan.refusals[0].removes).toEqual([
      {
        option: "AirCurve™ 11 VAuto with HumidAir™",
        sameProductAs: "AirCurve 11 VAuto with HumidAir",
      },
      {
        option: "AirMini AutoSet™ Travel CPAP Machine",
        sameProductAs: "AirMini AutoSet Travel CPAP Machine",
      },
    ]);
  });

  it("does not refuse over Mask, whose one option is in the catalogue", () => {
    const plan = planApply(TEST_INSTANCE, realCatalogue(), []);

    expect(
      plan.refusals.map((refusal) => refusal.user_field_name)
    ).not.toContain("Mask");
  });

  it("writes both mapped fields with replace, and does not touch anything else", () => {
    const catalogue = realCatalogue();
    const plan = planApply(TEST_INSTANCE, catalogue, [], { replace: true });

    expect(plan.refusals).toEqual([]);
    expect(plan.writes.map((write) => write.user_field_name)).toEqual([
      "Machine",
      "Mask",
    ]);
    expect(plan.writes.map((write) => write.reason)).toEqual([
      "replace",
      "extend",
    ]);
    expect(plan.writes.map((write) => write.after)).toEqual(
      dropdownOptionsFor(catalogue).map((field) => field.options)
    );
    expect(plan.writes[0].removed).toEqual([
      "AirCurve™ 11 VAuto with HumidAir™",
      "AirMini AutoSet™ Travel CPAP Machine",
    ]);
    expect(plan.writes[1].removed).toEqual([]);
    expect(plan.writes[1].added).toHaveLength(plan.writes[1].after.length - 1);
  });

  const withSleepPosition = [...MANAGED_FIELDS, "Sleep Position"];

  it("warns that the Sleep Position options resolve nothing, and names them", () => {
    const plan = planApply(TEST_INSTANCE, realCatalogue(), [], {
      replace: true,
      managedFields: withSleepPosition,
    });

    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0].user_field_name).toBe("Sleep Position");

    for (const option of TEST_INSTANCE[2].options ?? []) {
      expect(plan.warnings[0].detail).toContain(option);
    }
  });

  it("clears Sleep Position only when it is named, alongside the two writes", () => {
    const plan = planApply(TEST_INSTANCE, realCatalogue(), [], {
      replace: true,
      clear: ["Sleep Position"],
      managedFields: withSleepPosition,
    });

    expect(plan.refusals).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.writes.map((write) => write.user_field_name)).toEqual([
      "Sleep Position",
      "Machine",
      "Mask",
    ]);
    expect(plan.writes[0].after).toEqual([]);
    expect(plan.writes[0].removed).toHaveLength(3);
  });

  it("is idempotent — applying the plan's own result plans nothing", () => {
    const catalogue = realCatalogue();
    const first = planApply(TEST_INSTANCE, catalogue, [], {
      replace: true,
      clear: ["Sleep Position"],
      managedFields: withSleepPosition,
    });

    const applied: UserFieldDefinition[] = TEST_INSTANCE.map((field) => {
      const write = first.writes.find(
        (candidate) => candidate.user_field_name === field.name
      );

      return write ? { ...field, options: write.after } : field;
    });

    const second = planApply(applied, catalogue, [], {
      replace: true,
      clear: ["Sleep Position"],
      managedFields: withSleepPosition,
    });

    expect(second.writes).toEqual([]);
    expect(second.refusals).toEqual([]);
    expect(second.unchanged).toEqual(["Sleep Position", "Machine", "Mask"]);

    const withoutFlags = planApply(applied, catalogue, [], {
      managedFields: withSleepPosition,
    });

    expect(withoutFlags.writes).toEqual([]);
    expect(withoutFlags.refusals).toEqual([]);
  });

  it("offers exactly the values the shipped Mappings cover", () => {
    const catalogue = realCatalogue();
    const plan = planApply(TEST_INSTANCE, catalogue, [], { replace: true });
    const mappings = dropdownOptionsFor(catalogue);

    for (const write of plan.writes) {
      const target = mappings.find(
        (field) => field.user_field_name === write.user_field_name
      );

      expect(write.after).toEqual(target?.options);
    }
  });
});

describe("what the plan is allowed to do", () => {
  const source = readFileSync("scripts/lib/plan-apply.ts", "utf8");

  it("touches nothing outside itself — no network, no filesystem, no clock", () => {
    expect([...source.matchAll(/from "(node:[^"]+)"/g)]).toEqual([]);

    for (const forbidden of [
      "fetch(",
      "process.env",
      "writeFile",
      "readFile",
      "Date.",
      "Math.random",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("derives the Dropdown Options rather than accepting them", () => {
    expect(source).toContain("dropdownOptionsFor([...catalogue])");
    expect(source).not.toContain("options: readonly FieldOptions");
  });

  it("never writes when it refuses", () => {
    expect(source).toContain("refusals.length > 0 ? [] : writes");
  });
});
