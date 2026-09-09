import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCatalogue,
  COLLECTION_LINK_SUFFIX,
  type CollectionLink,
  DISPOSITION_OUTCOMES,
  type DispositionRow,
  dropdownOptionsFor,
  earnsCollectionLink,
  type ExcludedProduct,
  type FieldMapping,
  type FieldOptions,
  type ProductRecord,
  renderFieldMappings,
  type ResolvedProduct,
  type SheetRow,
  undeliveredValues,
} from "../../scripts/lib/build-catalogue";
import { MANAGED_FIELDS } from "../../scripts/lib/plan-apply.ts";
import type { AssignmentRow } from "../../scripts/lib/sheet-export.ts";

// The fixtures are the real rows and the real Shopify facts found while
// planning PSD-68, so the suite encodes the failures that actually happened
// rather than invented ones. Suggested URLs are left pointing at sleeping.com
// exactly as the spreadsheet holds them, which is also what proves the shipped
// URL never comes from that column (ADR-0009).

const MACHINE_ROWS: SheetRow[] = [
  {
    userFieldName: "Machine",
    legacyValue: "4872",
    legacyText:
      "AirCurve 10 VAuto BiLevel Machine with HumidAir Heated Humidifier",
    suggestedTitle: "AirCurve 10 VAuto BiLevel Machine",
    suggestedUrl:
      "https://www.sleeping.com/products/aircurve-10-vauto-bilevel-machine",
  },
  {
    // The same title again, one of many rows the legacy migration map carries
    // per product — a second legacy value, the same suggested product.
    userFieldName: "Machine",
    legacyValue: "6092",
    legacyText: "AirCurve 10 Vauto USA C2C CO",
    suggestedTitle: "AirCurve 10 VAuto BiLevel Machine",
    suggestedUrl:
      "https://www.sleeping.com/products/aircurve-10-vauto-bilevel-machine",
  },
  {
    userFieldName: "Machine",
    legacyValue: "4801",
    legacyText: "AirSense 11 AutoSet CPAP Machine",
    suggestedTitle: "AirSense 11 AutoSet",
    suggestedUrl:
      "https://www.sleeping.com/products/resmed-airsense-11-autoset",
  },
  {
    userFieldName: "Machine",
    legacyValue: "6240",
    legacyText: "Aircurve 11 asv",
    suggestedTitle: "AirCurve 11 ASV",
    suggestedUrl: "https://www.sleeping.com/products/aircurve-11-asv",
  },
  {
    // The one Suggested URL in the sheet that points at a search results page,
    // so there is no slug to join on at all.
    userFieldName: "Machine",
    legacyValue: "5213",
    legacyText: "ResMed AirCurve 10 ASV",
    suggestedTitle: "ResMed AirCurve 10 ASV BiLevel Machine",
    suggestedUrl:
      "https://www.sleeping.com/search?q=resmed+aircurve&_pos=4&_psq=resmed+air&_ss=e&_v=1.0",
  },
  {
    // One of the four retired catch-all rows. The Suggested Title names no
    // equipment, so this row's Collection Link is built from its `Text` — and
    // the seventeen other rows sharing this title each build their own from
    // theirs, which is why derivation walks rows and not titles (ADR-0020).
    userFieldName: "Machine",
    legacyValue: "5851",
    legacyText: "DreamStation Auto CPAP Machine",
    suggestedTitle: "CPAP Machines (Discontinued)",
    suggestedUrl: "https://www.sleeping.com/collections/cpap-machines",
  },
];

const MASK_ROWS: SheetRow[] = [
  {
    userFieldName: "Mask",
    legacyValue: "3001",
    legacyText: "Mirage FX Nasal Mask with Headgear",
    suggestedTitle: "Mirage FX Nasal CPAP Mask",
    suggestedUrl:
      "https://www.sleeping.com/products/resmed-mirage-fx-nasal-cpap-mask",
  },
  {
    userFieldName: "Mask",
    legacyValue: "3002",
    legacyText: "Morf Nasal Mask",
    suggestedTitle: "Morf Nasal Mask",
    suggestedUrl: "https://www.sleeping.com/products/morf-nasal-mask",
  },
  {
    userFieldName: "Mask",
    legacyValue: "3003",
    legacyText: "Viva Nasal Mask",
    suggestedTitle: "Viva Nasal CPAP Mask",
    suggestedUrl: "https://www.sleeping.com/products/viva-nasal-cpap-mask",
  },
  {
    userFieldName: "Mask",
    legacyValue: "3004",
    legacyText: "SleepWeaver Elan",
    suggestedTitle: "SleepWeaver Elan Nasal CPAP Mask",
    suggestedUrl:
      "https://www.sleeping.com/products/circadiance-sleepweaver-elan-soft-cloth-nasal-cpap-mask",
  },
  {
    // The sheet's last Mask row is genuinely empty in both Suggested columns.
    // It still carries a legacy value, which is the point of the row.
    userFieldName: "Mask",
    legacyValue: "3005",
    legacyText: "Unlisted mask",
    suggestedTitle: "",
    suggestedUrl: "",
  },
];

const PRODUCTS: ProductRecord[] = [
  {
    handle: "aircurve-10-vauto-bilevel-machine",
    title: "ResMed AirCurve 10 VAuto BiLevel Machine with HumidAir",
    status: "ACTIVE",
    tags: ["Catalog-Merchant-Division-Machines"],
    onlineStoreUrl:
      "https://www.cpap.com/products/aircurve-10-vauto-bilevel-machine",
  },
  {
    // Shopify's title carries the manufacturer and the product category; the
    // sheet's curated title does not, and the sheet's is what a user sees.
    handle: "resmed-airsense-11-autoset",
    title: "ResMed AirSense 11 AutoSet CPAP Machine",
    status: "ACTIVE",
    tags: [],
    onlineStoreUrl: "https://www.cpap.com/products/resmed-airsense-11-autoset",
  },
  {
    // ACTIVE with seven units in stock at $3,299, and never published to the
    // Online Store sales channel — which is why its URL 404s while its slug
    // was always correct. HTTP status alone would have diagnosed this as a bad
    // slug and sent someone looking for a better one (ADR-0009).
    handle: "aircurve-11-asv",
    title: "ResMed AirCurve 11 ASV BiLevel Machine",
    status: "ACTIVE",
    tags: [],
    onlineStoreUrl: null,
  },
  {
    handle: "resmed-aircurve-10-asv-bilevel-machine",
    title: "ResMed AirCurve 10 ASV BiLevel Machine",
    status: "ACTIVE",
    tags: [],
    onlineStoreUrl:
      "https://www.cpap.com/products/resmed-aircurve-10-asv-bilevel-machine",
  },
  {
    handle: "resmed-mirage-fx-nasal-cpap-mask",
    title: "ResMed Mirage FX Nasal CPAP Mask",
    status: "ACTIVE",
    tags: [],
    onlineStoreUrl:
      "https://www.cpap.com/products/resmed-mirage-fx-nasal-cpap-mask",
  },
  {
    // Archived and tagged at once, which is why precedence between the two has
    // to be decided rather than discovered.
    handle: "morf-nasal-mask",
    title: "Morf Nasal Mask",
    status: "ARCHIVED",
    tags: ["Discontinued"],
    onlineStoreUrl: null,
  },
  {
    // A real 404 row standing in for the third exclusion reason: still ACTIVE
    // and still published, but tagged. The tag is the authoritative signal, so
    // it has to exclude on its own without help from status or publication.
    handle: "viva-nasal-cpap-mask",
    title: "Viva Nasal CPAP Mask",
    status: "ACTIVE",
    tags: ["Discontinued", "Catalog-Merchant-Division-Masks"],
    onlineStoreUrl: "https://www.cpap.com/products/viva-nasal-cpap-mask",
  },
];

const SHEET_ROWS = [...MACHINE_ROWS, ...MASK_ROWS];

const BIPAP = "https://www.cpap.com/collections/bipap-machines";
const CPAP_MACHINES = "https://www.cpap.com/collections/cpap-machines";
const NASAL_MASKS = "https://www.cpap.com/collections/nasal-cpap-masks";

/** An assignment row with the columns this transform ignores left empty. */
function assignment(row: Partial<AssignmentRow>): AssignmentRow {
  return {
    field: "Machine",
    legacyPnums: "",
    legacyText: "",
    baseNameSource: "Suggested Title",
    profileLinkValue: "",
    recommendedCollectionTitle: "",
    recommendedCollectionUrl: "",
    confidence: "High",
    rationale: "",
    override: "",
    disposition: "collection",
    ...row,
  };
}

// The curated half of every Collection Link, covering each of the five
// exclusion reasons that earns one exactly once: `unpublished` (6240),
// `discontinued-suffix` (5851), `not-active` (3002), `discontinued-tag` (3003)
// and `no-matching-product` (3004). The two reasons that earn none — the blank
// Mask row and any ambiguous match — deliberately have no row here, because a
// row for them is not what stops them shipping.
const ASSIGNMENTS: AssignmentRow[] = [
  assignment({
    field: "Machine",
    legacyPnums: "6240",
    legacyText: "Aircurve 11 asv",
    profileLinkValue: "AirCurve 11 ASV (Discontinued)",
    recommendedCollectionUrl: BIPAP,
  }),
  assignment({
    field: "Machine",
    legacyPnums: "5851",
    legacyText: "DreamStation Auto CPAP Machine",
    baseNameSource: "Text",
    profileLinkValue: "DreamStation Auto CPAP Machine (Discontinued)",
    recommendedCollectionUrl: CPAP_MACHINES,
  }),
  assignment({
    field: "Mask",
    legacyPnums: "3002",
    legacyText: "Morf Nasal Mask",
    profileLinkValue: "Morf Nasal Mask (Discontinued)",
    recommendedCollectionUrl: NASAL_MASKS,
  }),
  assignment({
    field: "Mask",
    legacyPnums: "3003",
    legacyText: "Viva Nasal Mask",
    profileLinkValue: "Viva Nasal CPAP Mask (Discontinued)",
    recommendedCollectionUrl: NASAL_MASKS,
  }),
  assignment({
    field: "Mask",
    legacyPnums: "3004",
    legacyText: "SleepWeaver Elan",
    profileLinkValue: "SleepWeaver Elan Nasal CPAP Mask (Discontinued)",
    recommendedCollectionUrl: NASAL_MASKS,
  }),
];

/**
 * The one row behind most of the fault cases below: `AirCurve 11 ASV` is
 * `unpublished`, so it earns a link, and it is used on its own so that a fault
 * asserted here is the one the case is about rather than the catch-all row
 * beside it going unassigned.
 */
const ASV_ROW: SheetRow[] = MACHINE_ROWS.filter(
  (row) => row.legacyValue === "6240"
);

/**
 * A second legacy identifier for the same Suggested Title as `ASV_ROW`, and so
 * a second row deriving the same Collection Link value.
 *
 * The legacy migration map carries several of these per product, which is why
 * ADR-0020 has rows sharing a real Suggested Title collapse to one Mapping. It
 * is also what makes a per-row decision unenforceable: the two rows are one
 * value downstream, and one value has one answer.
 */
const ASV_SIBLING: SheetRow = {
  userFieldName: "Machine",
  legacyValue: "6241",
  legacyText: "Aircurve 11 ASV c2c",
  suggestedTitle: "AirCurve 11 ASV",
  suggestedUrl: "https://www.sleeping.com/products/aircurve-11-asv",
};

const ADMITTED_COLLECTIONS = [
  "bipap-machines",
  "cpap-machines",
  "nasal-cpap-masks",
];

/**
 * What the fixtures above derive to, spelled out rather than computed, so that
 * a change in the transform shows up here as a diff a reader can judge. The
 * Machine catch-all takes its name from `Text` and the other four take theirs
 * from the Suggested Title, which is the whole of ADR-0020's derivation rule.
 */
const COLLECTION_LINKS: CollectionLink[] = [
  {
    userFieldName: "Machine",
    value: "AirCurve 11 ASV (Discontinued)",
    url: BIPAP,
  },
  {
    userFieldName: "Machine",
    value: "DreamStation Auto CPAP Machine (Discontinued)",
    url: CPAP_MACHINES,
  },
  {
    userFieldName: "Mask",
    value: "Morf Nasal Mask (Discontinued)",
    url: NASAL_MASKS,
  },
  {
    userFieldName: "Mask",
    value: "SleepWeaver Elan Nasal CPAP Mask (Discontinued)",
    url: NASAL_MASKS,
  },
  {
    userFieldName: "Mask",
    value: "Viva Nasal CPAP Mask (Discontinued)",
    url: NASAL_MASKS,
  },
];

function build(
  rows: SheetRow[] = SHEET_ROWS,
  products = PRODUCTS,
  assignments: AssignmentRow[] = ASSIGNMENTS,
  admittedCollections: string[] = ADMITTED_COLLECTIONS
) {
  return buildCatalogue({
    sheetRows: rows,
    products,
    assignments,
    admittedCollections,
  });
}

function valuesFor(
  entries: { userFieldName: string; value: string }[],
  userFieldName: string
): string[] {
  return entries
    .filter((entry) => entry.userFieldName === userFieldName)
    .map((entry) => entry.value);
}

/**
 * One disposition row, found by the pair it is keyed on. A miss throws rather
 * than returning undefined, because every assertion below is about what a row
 * says and an absent row would make `toMatchObject` pass on nothing.
 */
function dispositionFor(
  dispositions: DispositionRow[],
  userFieldName: string,
  legacyValue: string
): DispositionRow {
  const found = dispositions.find(
    (row) =>
      row.userFieldName === userFieldName && row.legacyValue === legacyValue
  );

  if (!found) {
    throw new Error(
      `expected a disposition row for ${userFieldName} ${legacyValue}, got ` +
        dispositions
          .map((row) => `${row.userFieldName} ${row.legacyValue}`)
          .join(", ")
    );
  }

  return found;
}

function exclusionFor(
  exclusions: ExcludedProduct[],
  value: string
): ExcludedProduct {
  const found = exclusions.find((exclusion) => exclusion.value === value);

  if (!found) {
    throw new Error(
      `expected an Excluded Product for "${value}", got ${exclusions
        .map((exclusion) => exclusion.value)
        .join(", ")}`
    );
  }

  return found;
}

describe("buildCatalogue", () => {
  it("drops a Suggested Title suffixed (Discontinued) and says why", () => {
    const { catalogue, exclusions } = build();

    expect(valuesFor(catalogue, "Machine")).not.toContain(
      "CPAP Machines (Discontinued)"
    );

    const excluded = exclusionFor(exclusions, "CPAP Machines (Discontinued)");

    expect(excluded.reason).toBe("discontinued-suffix");
    // The detail is a reviewer's only account of why a title was dropped, and
    // this reason no longer means the title gets no Profile Link — ADR-0020
    // supersedes ADR-0012 and sends it on as a Collection Link.
    expect(excluded.detail).toContain("naming no equipment");
    expect(excluded.detail).toContain("ADR-0020");
  });

  it("collapses a repeated Suggested Title to one entry", () => {
    const { catalogue } = build();

    const occurrences = valuesFor(catalogue, "Machine").filter(
      (value) => value === "AirCurve 10 VAuto BiLevel Machine"
    );

    expect(occurrences).toHaveLength(1);
  });

  it("excludes an archived product, reporting the tag it also carries", () => {
    const { catalogue, exclusions } = build();

    expect(valuesFor(catalogue, "Mask")).not.toContain("Morf Nasal Mask");

    const excluded = exclusionFor(exclusions, "Morf Nasal Mask");

    expect(excluded.reason).toBe("not-active");
    expect(excluded.detail).toContain("ARCHIVED");
    expect(excluded.detail).toContain("tagged Discontinued");
    expect(excluded.handle).toBe("morf-nasal-mask");
  });

  it("excludes a product that is ACTIVE and in stock but unpublished", () => {
    const { catalogue, exclusions } = build();

    expect(valuesFor(catalogue, "Machine")).not.toContain("AirCurve 11 ASV");

    const excluded = exclusionFor(exclusions, "AirCurve 11 ASV");

    expect(excluded.reason).toBe("unpublished");
    expect(excluded.detail).toContain("ACTIVE");
    expect(excluded.detail).toContain("not published to the Online Store");
  });

  it("excludes a live, published product carrying the Discontinued tag", () => {
    const { catalogue, exclusions } = build();

    expect(valuesFor(catalogue, "Mask")).not.toContain("Viva Nasal CPAP Mask");

    const excluded = exclusionFor(exclusions, "Viva Nasal CPAP Mask");

    expect(excluded.reason).toBe("discontinued-tag");
    expect(excluded.detail).toContain("ACTIVE");
  });

  it("gives each admission failure its own distinct reason", () => {
    const { exclusions } = build();

    const reasons = new Map(
      exclusions.map((exclusion) => [exclusion.value, exclusion.reason])
    );

    expect(reasons.get("Morf Nasal Mask")).toBe("not-active");
    expect(reasons.get("AirCurve 11 ASV")).toBe("unpublished");
    expect(reasons.get("Viva Nasal CPAP Mask")).toBe("discontinued-tag");
  });

  it("rejects a blank Suggested Title", () => {
    const { catalogue, exclusions } = build();

    expect(catalogue.every((entry) => entry.value !== "")).toBe(true);

    const excluded = exclusionFor(exclusions, "");

    expect(excluded.reason).toBe("blank-title");
    expect(excluded.userFieldName).toBe("Mask");
  });

  it("falls back to a title match when the Suggested URL names no product", () => {
    const { catalogue } = build();

    const resolved = catalogue.find(
      (entry) => entry.value === "ResMed AirCurve 10 ASV BiLevel Machine"
    );

    expect(resolved?.handle).toBe("resmed-aircurve-10-asv-bilevel-machine");
    expect(resolved?.url).toBe(
      "https://www.cpap.com/products/resmed-aircurve-10-asv-bilevel-machine"
    );
  });

  it("falls back to a title match when the slug matches no handle", () => {
    const rows: SheetRow[] = [
      {
        userFieldName: "Machine",
        legacyValue: "5213",
        legacyText: "ResMed AirCurve 10 ASV",
        suggestedTitle: "ResMed AirCurve 10 ASV BiLevel Machine",
        suggestedUrl: "https://www.sleeping.com/products/a-slug-nobody-carries",
      },
    ];

    const { catalogue, exclusions } = build(rows);

    expect(exclusions).toHaveLength(0);
    expect(catalogue[0].handle).toBe("resmed-aircurve-10-asv-bilevel-machine");
  });

  it("fails with its own reason when neither the slug nor the title matches", () => {
    const { catalogue, exclusions } = build();

    expect(valuesFor(catalogue, "Mask")).not.toContain(
      "SleepWeaver Elan Nasal CPAP Mask"
    );

    const excluded = exclusionFor(
      exclusions,
      "SleepWeaver Elan Nasal CPAP Mask"
    );

    expect(excluded.reason).toBe("no-matching-product");
    expect(excluded.handle).toBe(
      "circadiance-sleepweaver-elan-soft-cloth-nasal-cpap-mask"
    );
  });

  it("refuses to choose when a title matches more than one product", () => {
    const rows: SheetRow[] = [
      {
        userFieldName: "Mask",
        legacyValue: "3100",
        legacyText: "Numa Full Face Mask",
        suggestedTitle: "Numa Full Face CPAP Mask",
        suggestedUrl:
          "https://www.sleeping.com/collections/full-face-cpap-masks",
      },
    ];
    const twins: ProductRecord[] = [
      {
        handle: "numa-full-face-cpap-mask",
        title: "Numa Full Face CPAP Mask",
        status: "ACTIVE",
        tags: [],
        onlineStoreUrl:
          "https://www.cpap.com/products/numa-full-face-cpap-mask",
      },
      {
        handle: "numa-full-face-cpap-mask-fitpack",
        title: "numa full face cpap mask",
        status: "ACTIVE",
        tags: [],
        onlineStoreUrl:
          "https://www.cpap.com/products/numa-full-face-cpap-mask-fitpack",
      },
    ];

    const { catalogue, exclusions } = build(rows, twins);

    expect(catalogue).toHaveLength(0);
    expect(exclusions[0].reason).toBe("ambiguous-title-match");
    expect(exclusions[0].detail).toContain("numa-full-face-cpap-mask-fitpack");
  });

  it("takes every URL from Shopify and never from the spreadsheet", () => {
    const { catalogue } = build();

    const byHandle = new Map(
      PRODUCTS.map((product) => [product.handle, product.onlineStoreUrl])
    );

    for (const entry of catalogue) {
      expect(entry.url).toBe(byHandle.get(entry.handle));
      expect(entry.url).not.toContain("sleeping.com");
      expect(entry.url.startsWith("https://www.cpap.com/products/")).toBe(true);
    }
  });

  it("keeps the Suggested Title verbatim where Shopify's title differs", () => {
    const { catalogue } = build();

    const resolved = catalogue.find(
      (entry) => entry.handle === "resmed-airsense-11-autoset"
    );

    expect(resolved?.value).toBe("AirSense 11 AutoSet");
    expect(resolved?.value).not.toBe("ResMed AirSense 11 AutoSet CPAP Machine");
  });

  it("orders titles alphabetically without regard to case", () => {
    const rows: SheetRow[] = [
      {
        userFieldName: "Mask",
        legacyValue: "3201",
        legacyText: "airfit N30i",
        suggestedTitle: "airfit N30i Nasal CPAP Mask",
        suggestedUrl: "https://www.sleeping.com/products/lower",
      },
      {
        userFieldName: "Mask",
        legacyValue: "3202",
        legacyText: "AirFit N20",
        suggestedTitle: "AirFit N20 Nasal CPAP Mask",
        suggestedUrl: "https://www.sleeping.com/products/upper",
      },
      {
        userFieldName: "Mask",
        legacyValue: "3203",
        legacyText: "Brevida",
        suggestedTitle: "Brevida Nasal Pillow CPAP Mask",
        suggestedUrl: "https://www.sleeping.com/products/brevida",
      },
    ];
    const products: ProductRecord[] = ["lower", "upper", "brevida"].map(
      (handle) => ({
        handle,
        title: handle,
        status: "ACTIVE" as const,
        tags: [],
        onlineStoreUrl: `https://www.cpap.com/products/${handle}`,
      })
    );

    const { catalogue } = build(rows, products);

    expect(valuesFor(catalogue, "Mask")).toEqual([
      "AirFit N20 Nasal CPAP Mask",
      "airfit N30i Nasal CPAP Mask",
      "Brevida Nasal Pillow CPAP Mask",
    ]);
  });

  it("orders fields as the Sheet Exports presented them", () => {
    const { catalogue } = build();

    const fields = [...new Set(catalogue.map((entry) => entry.userFieldName))];

    expect(fields).toEqual(["Machine", "Mask"]);

    const reversed = build([...MASK_ROWS, ...MACHINE_ROWS]);

    expect([
      ...new Set(reversed.catalogue.map((entry) => entry.userFieldName)),
    ]).toEqual(["Mask", "Machine"]);
  });

  it("yields the same order however the rows within a field arrive", () => {
    const shuffled = [
      ...[...MACHINE_ROWS].reverse(),
      ...[...MASK_ROWS].reverse(),
    ];

    expect(build(shuffled).catalogue).toEqual(build().catalogue);
    expect(build(shuffled).exclusions).toEqual(build().exclusions);
  });
});

describe("Collection Links as the third output", () => {
  it("derives them alongside the catalogue and the Excluded Products", () => {
    const result = build();

    expect(result.collectionLinks).toEqual(COLLECTION_LINKS);
    expect(result.collectionFaults).toEqual([]);
    expect(result.catalogue.length).toBeGreaterThan(0);
    expect(result.exclusions.length).toBeGreaterThan(0);
  });

  it("derives one for each of the five reasons that earns one, and no others", () => {
    // The five that earn a link and the two that do not, asserted against the
    // exclusions this same build produced rather than against a list restated
    // here — the point is that the two sets agree (ADR-0020).
    const { exclusions, collectionLinks, collectionFaults } = build();

    expect(collectionFaults).toEqual([]);
    expect(
      [...new Set(exclusions.map((entry) => entry.reason))].sort()
    ).toEqual([
      "blank-title",
      "discontinued-suffix",
      "discontinued-tag",
      "no-matching-product",
      "not-active",
      "unpublished",
    ]);

    // One link per exclusion whose reason earns one — and the blank Mask row,
    // which earns none, is the difference between the two counts.
    expect(collectionLinks).toHaveLength(
      exclusions.filter((entry) => earnsCollectionLink(entry.reason)).length
    );
    expect(collectionLinks).toHaveLength(5);
  });

  it("leaves a blank title and an ambiguous match excluded and unlinked", () => {
    // Both are `false` in the earns-a-link table and for opposite reasons: a
    // blank row has nothing to name, and an ambiguous match is evidence the
    // equipment is still sold and the sheet is wrong, so a plausible link there
    // would bury a fixable fault (ADR-0020).
    const twins: ProductRecord[] = [
      ...PRODUCTS,
      {
        handle: "morf-nasal-mask-clone",
        title: "Morf Nasal Mask",
        status: "ACTIVE",
        tags: [],
        onlineStoreUrl: "https://www.cpap.com/products/morf-nasal-mask-clone",
      },
    ];
    const rows = MASK_ROWS.map((row) =>
      row.legacyValue === "3002" ? { ...row, suggestedUrl: "" } : row
    );

    const { exclusions, collectionLinks, collectionFaults } = build(
      rows,
      twins
    );

    expect(exclusions.map((entry) => entry.reason).sort()).toEqual(
      expect.arrayContaining(["ambiguous-title-match", "blank-title"])
    );
    expect(collectionLinks.map((link) => link.value)).not.toContain(
      "Morf Nasal Mask (Discontinued)"
    );
    // And neither of them is a fault: a reason that earns no link is not a
    // link that failed to derive.
    expect(collectionFaults).toEqual([]);
  });

  it("takes the base name from the Suggested Title when it names a product", () => {
    const { collectionLinks } = build();

    expect(
      collectionLinks.find((link) => link.value.startsWith("AirCurve 11 ASV"))
    ).toEqual({
      userFieldName: "Machine",
      value: "AirCurve 11 ASV (Discontinued)",
      url: BIPAP,
    });
  });

  it("falls back to the legacy display text on a retired catch-all title", () => {
    // `CPAP Machines (Discontinued)` names no equipment, so the member sees the
    // machine they actually owned rather than the category they were bucketed
    // into. This is the only exception to ADR-0010 there is.
    const { collectionLinks } = build();

    expect(collectionLinks.map((link) => link.value)).toContain(
      "DreamStation Auto CPAP Machine (Discontinued)"
    );
    expect(collectionLinks.map((link) => link.value)).not.toContain(
      "CPAP Machines (Discontinued)"
    );
  });

  it("does not collapse the catch-all rows, which share one Suggested Title", () => {
    // The vacuous-pass trap on the collapse rule, from the other side: the
    // eighteen real rows behind `CPAP Machines (Discontinued)` must produce
    // eighteen links, and a derivation walking Excluded Products would produce
    // one. Three rows here, three different `Text` values, three links.
    const catchAll = MACHINE_ROWS.filter(
      (row) => row.legacyValue === "5851"
    )[0];
    const rows: SheetRow[] = [
      catchAll,
      {
        ...catchAll,
        legacyValue: "5852",
        legacyText: "System One REMstar Pro",
      },
      { ...catchAll, legacyValue: "5853", legacyText: "M Series Auto CPAP" },
    ];
    const assignments = rows.map((row) =>
      assignment({
        legacyPnums: row.legacyValue,
        legacyText: row.legacyText,
        baseNameSource: "Text",
        profileLinkValue: `${row.legacyText}${COLLECTION_LINK_SUFFIX}`,
        recommendedCollectionUrl: CPAP_MACHINES,
      })
    );

    const { exclusions, collectionLinks } = build(rows, PRODUCTS, assignments);

    expect(exclusions).toHaveLength(1);
    expect(collectionLinks.map((link) => link.value)).toEqual([
      "DreamStation Auto CPAP Machine (Discontinued)",
      "M Series Auto CPAP (Discontinued)",
      "System One REMstar Pro (Discontinued)",
    ]);
  });

  it("collapses legacy values that share a real Suggested Title", () => {
    // The other half of the same rule. Two legacy values, one curated title,
    // one Mapping — because a Mapping is keyed on its value and two rows for
    // one value is a `duplicate-value` Config Problem, not two links.
    const rows: SheetRow[] = MACHINE_ROWS.filter(
      (row) => row.legacyValue === "6240"
    ).flatMap((row) => [
      row,
      { ...row, legacyValue: "6241", legacyText: "AirCurve 11 ASV USA" },
    ]);

    const { collectionLinks, collectionFaults } = build(rows, PRODUCTS, [
      assignment({
        legacyPnums: "6240, 6241",
        legacyText: "Aircurve 11 asv",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: BIPAP,
      }),
    ]);

    expect(collectionFaults).toEqual([]);
    expect(collectionLinks).toEqual([
      {
        userFieldName: "Machine",
        value: "AirCurve 11 ASV (Discontinued)",
        url: BIPAP,
      },
    ]);
  });

  it("never doubles a suffix the base name already carried", () => {
    // A legacy `Text` that already ends in the suffix — the spreadsheet holds
    // several — must not become `… (Discontinued) (Discontinued)`. The carried
    // form is stripped in whatever casing it arrived in and the canonical bytes
    // re-appended, because ` (discontinued)` is a value that resolves for
    // nobody while looking right in a diff.
    const catchAll = MACHINE_ROWS.filter(
      (row) => row.legacyValue === "5851"
    )[0];
    const rows: SheetRow[] = [
      {
        ...catchAll,
        legacyText: "DreamStation Auto CPAP Machine (Discontinued)",
      },
      {
        ...catchAll,
        legacyValue: "5852",
        legacyText: "System One REMstar Pro (discontinued)",
      },
    ];

    const { collectionLinks } = build(
      rows,
      PRODUCTS,
      rows.map((row) =>
        assignment({
          legacyPnums: row.legacyValue,
          legacyText: row.legacyText,
          baseNameSource: "Text",
          profileLinkValue: `${row.legacyText.replace(
            / *\((?:D|d)iscontinued\)$/,
            ""
          )}${COLLECTION_LINK_SUFFIX}`,
          recommendedCollectionUrl: CPAP_MACHINES,
        })
      )
    );

    expect(collectionLinks.map((link) => link.value)).toEqual([
      "DreamStation Auto CPAP Machine (Discontinued)",
      "System One REMstar Pro (Discontinued)",
    ]);

    for (const link of collectionLinks) {
      expect(
        link.value.endsWith(
          `${COLLECTION_LINK_SUFFIX}${COLLECTION_LINK_SUFFIX}`
        )
      ).toBe(false);
    }
  });

  it("prefers an Override to the recommendation", () => {
    const override = "https://www.cpap.com/collections/apap-machines";
    const { collectionLinks } = build(
      ASV_ROW,
      PRODUCTS,
      [
        assignment({
          legacyPnums: "6240",
          profileLinkValue: "AirCurve 11 ASV (Discontinued)",
          recommendedCollectionUrl: BIPAP,
          override,
        }),
      ],
      [...ADMITTED_COLLECTIONS, "apap-machines"]
    );

    expect(collectionLinks).toEqual([
      {
        userFieldName: "Machine",
        value: "AirCurve 11 ASV (Discontinued)",
        url: override,
      },
    ]);
  });

  it("falls through an empty Override to the recommendation", () => {
    // An empty cell is an empty cell, not a decision to link nowhere.
    expect(build().collectionLinks).toEqual(COLLECTION_LINKS);
  });

  it("derives none, and reports every owed link, on an empty assignment table", () => {
    // The vacuous-pass guard's mirror image: every assertion above walks a
    // derived list, so this one pins what an empty table actually costs — five
    // reported faults, not a quiet zero.
    const { collectionLinks, collectionFaults } = build(
      SHEET_ROWS,
      PRODUCTS,
      []
    );

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults).toHaveLength(5);
    expect(new Set(collectionFaults.map((fault) => fault.problem))).toEqual(
      new Set(["unassigned-legacy-value"])
    );
  });

  it("orders them by field then value, as it orders the other two outputs", () => {
    const { collectionLinks } = build([...MASK_ROWS, ...MACHINE_ROWS]);

    expect(
      collectionLinks.map((link) => `${link.userFieldName} ${link.value}`)
    ).toEqual([
      "Mask Morf Nasal Mask (Discontinued)",
      "Mask SleepWeaver Elan Nasal CPAP Mask (Discontinued)",
      "Mask Viva Nasal CPAP Mask (Discontinued)",
      "Machine AirCurve 11 ASV (Discontinued)",
      "Machine DreamStation Auto CPAP Machine (Discontinued)",
    ]);
  });

  it("carries no product handle and no product status", () => {
    // A collection has neither, which is why this is its own type rather than
    // a flag on a Resolved Product: admitting a sentinel handle or status
    // would mean relaxing `readResolvedProducts` for every row (ADR-0021).
    const [link] = build().collectionLinks;

    expect(Object.keys(link).sort()).toEqual(["url", "userFieldName", "value"]);
  });

  it("names the suffix on exact bytes, because resolution is an exact match", () => {
    // One leading space, one capital `D`, no variants. `resolveProfileLinks`
    // looks the User's stored value up in a map keyed by the Mapping value, so
    // ` (discontinued)` or `(Discontinued)` unspaced is not a near miss — it is
    // a value that resolves for nobody (ADR-0020).
    expect(COLLECTION_LINK_SUFFIX).toBe(" (Discontinued)");

    const { collectionLinks } = build();

    expect(collectionLinks.length).toBeGreaterThan(0);

    for (const link of collectionLinks) {
      expect(link.value.endsWith(COLLECTION_LINK_SUFFIX)).toBe(true);
      expect(link.value.endsWith(" (discontinued)")).toBe(false);
    }
  });
});

describe("Collection Links that cannot be derived", () => {
  it("reports a collection Shopify does not admit rather than shipping it", () => {
    const { collectionLinks, collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl:
          "https://www.cpap.com/collections/machines-that-never-were",
      }),
    ]);

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults).toEqual([
      {
        userFieldName: "Machine",
        legacyValues: ["6240"],
        value: "AirCurve 11 ASV (Discontinued)",
        problem: "unadmitted-collection",
        detail: expect.stringContaining("machines-that-never-were"),
      },
    ]);
  });

  it("checks the Override against Shopify, not the recommendation it replaced", () => {
    // The precedence rule and the admission check have to agree about which
    // URL is the one that ships, or a refresh verifies the recommendation and
    // then ships the override.
    const { collectionLinks, collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: BIPAP,
        override: "https://www.cpap.com/collections/machines-that-never-were",
      }),
    ]);

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults[0].problem).toBe("unadmitted-collection");
  });

  it("ships the canonical collection URL, not the cell a curator pasted", () => {
    // A query string and a fragment pass `collectionHandleFromUrl` on purpose,
    // because neither changes which collection resolves — but that admits the
    // cell, it does not mean the cell is what ships. A curator copying the
    // page out of a browser brings `?utm_source=…` with it, and the Mapping
    // URL is what every member holding this value clicks.
    const { collectionLinks } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: `${BIPAP}?utm_source=sheet&sscid=abc#erid5131`,
      }),
    ]);

    expect(collectionLinks).toEqual([
      {
        userFieldName: "Machine",
        value: "AirCurve 11 ASV (Discontinued)",
        url: BIPAP,
      },
    ]);
  });

  it("reports a cell that names no collection at all", () => {
    const { collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: "n/a — resolves to existing mapped product",
      }),
    ]);

    expect(collectionFaults[0].problem).toBe("unadmitted-collection");
    expect(collectionFaults[0].detail).toContain("names no collection handle");
  });

  it("reports a disagreement with the curated Profile Link Value", () => {
    // The oracle in `spec/unit/collection-assignment.test.ts` holds the
    // committed table to ADR-0020's rule; this transform applies the same rule
    // to the same data. A disagreement means one of the two is wrong, and this
    // cannot say which — so it reports rather than reconciling in its own
    // favour.
    const { collectionLinks, collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV BiLevel (Discontinued)",
        recommendedCollectionUrl: BIPAP,
      }),
    ]);

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults[0]).toMatchObject({
      legacyValues: ["6240"],
      value: "AirCurve 11 ASV (Discontinued)",
      problem: "curation-disagreement",
    });
  });

  it("reports an undecided row rather than resolving it to no link", () => {
    const { collectionLinks, collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: BIPAP,
        disposition: "undecided",
      }),
    ]);

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults[0].problem).toBe("undecided-disposition");
  });

  it("says nothing about a plain-text row", () => {
    // A decision somebody recorded, so not a fault.
    const { collectionLinks, collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "n/a",
        recommendedCollectionUrl: "n/a — same as existing value 5232",
        disposition: "plain-text",
      }),
    ]);

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults).toEqual([]);
  });

  it("reports a resolves-to-product row whose product is no longer sold", () => {
    // The row asserts the store still sells the title, and reaching this loop
    // at all means the refresh excluded that title for a reason that earns a
    // link. Both cannot hold, and honouring the row would drop the value to
    // plain text with no Mapping and nobody told.
    const { collectionLinks, collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "n/a",
        recommendedCollectionUrl: "n/a — same as existing value 5232",
        disposition: "resolves-to-product",
      }),
    ]);

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults).toHaveLength(1);
    expect(collectionFaults[0]).toMatchObject({
      legacyValues: ["6240"],
      problem: "stale-product-resolution",
    });
  });

  it("reports two legacy values that collapse onto one value and disagree", () => {
    const rows: SheetRow[] = MACHINE_ROWS.filter(
      (row) => row.legacyValue === "6240"
    ).flatMap((row) => [row, { ...row, legacyValue: "6241" }]);

    const { collectionLinks, collectionFaults } = build(rows, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: BIPAP,
      }),
      assignment({
        legacyPnums: "6241",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: CPAP_MACHINES,
      }),
    ]);

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults[0]).toMatchObject({
      legacyValues: ["6240", "6241"],
      value: "AirCurve 11 ASV (Discontinued)",
      problem: "conflicting-collection",
    });
  });

  it("reports a base name that is nothing but the suffix", () => {
    const catchAll = MACHINE_ROWS.filter(
      (row) => row.legacyValue === "5851"
    )[0];

    const { collectionLinks, collectionFaults } = build(
      [{ ...catchAll, legacyText: "(Discontinued)" }],
      PRODUCTS,
      [
        assignment({
          legacyPnums: "5851",
          baseNameSource: "Text",
          profileLinkValue: COLLECTION_LINK_SUFFIX,
          recommendedCollectionUrl: CPAP_MACHINES,
        }),
      ]
    );

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults[0].problem).toBe("no-base-name");
  });

  it("counts an absent link per suffix-only row, not one for the field", () => {
    // A row that derives no value joins no group, so two of them in one field
    // are two absent links. They both carry `value: ""`, which is the one key
    // `undeliveredValues` cannot dedupe on.
    const catchAll = MACHINE_ROWS.filter(
      (row) => row.legacyValue === "5851"
    )[0];

    const { collectionFaults } = build(
      [
        { ...catchAll, legacyText: "(Discontinued)" },
        { ...catchAll, legacyValue: "5852", legacyText: "(Discontinued)" },
      ],
      PRODUCTS,
      [
        assignment({
          legacyPnums: "5851, 5852",
          baseNameSource: "Text",
          profileLinkValue: COLLECTION_LINK_SUFFIX,
          recommendedCollectionUrl: CPAP_MACHINES,
        }),
      ]
    );

    expect(collectionFaults.map((fault) => fault.problem)).toEqual([
      "no-base-name",
      "no-base-name",
    ]);
    expect(undeliveredValues(collectionFaults)).toBe(2);
  });

  it("refuses a collection URL whose path carries more than the handle", () => {
    // The handle reads as `bipap-machines`, which Shopify admits, while the
    // URL that would ship is a page that does not exist. Validating one string
    // and shipping another is the one thing the admission check cannot catch,
    // so the shape is refused before it is ever asked about (ADR-0016).
    const { collectionLinks, collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: `${BIPAP}/typo`,
      }),
    ]);

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults[0].problem).toBe("unadmitted-collection");
    expect(collectionFaults[0].detail).toContain("names no collection handle");
  });

  it("refuses a collection URL at somebody else's origin", () => {
    // `bipap-machines` exists, so the admission check would pass on the
    // handle alone and ship a link to another store.
    const { collectionLinks, collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl:
          "https://example.com/collections/bipap-machines",
      }),
    ]);

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults[0].problem).toBe("unadmitted-collection");
  });

  it("reports two assignment rows that claim one legacy value differently", () => {
    // The assignment tab is seeded one-to-one from the option tables, so this
    // is a curation mistake — and one that would otherwise ship the row the
    // sheet happened to list first.
    const { collectionLinks, collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: BIPAP,
      }),
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: CPAP_MACHINES,
      }),
    ]);

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults).toHaveLength(1);
    expect(collectionFaults[0].problem).toBe("duplicate-assignment");
    expect(collectionFaults[0].legacyValues).toEqual(["6240"]);
    expect(collectionFaults[0].detail).toContain(BIPAP);
    expect(collectionFaults[0].detail).toContain(CPAP_MACHINES);
  });

  it("lets a repeated claim through when it decides the same thing", () => {
    // A duplicate that changes nothing that ships is not something a curator
    // can act on, and the fault channel only stays worth reading while
    // everything in it is.
    const claim = {
      legacyPnums: "6240",
      profileLinkValue: "AirCurve 11 ASV (Discontinued)",
      recommendedCollectionUrl: BIPAP,
    };

    const { collectionLinks, collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment(claim),
      assignment({ ...claim, rationale: "said twice, decided once" }),
    ]);

    expect(collectionFaults).toEqual([]);
    expect(collectionLinks).toEqual([
      {
        userFieldName: "Machine",
        value: "AirCurve 11 ASV (Discontinued)",
        url: BIPAP,
      },
    ]);
  });

  it("lets a repeated non-`collection` claim through whatever it recommends", () => {
    // Two `plain-text` rows differing in the value and the collection they
    // recommend. Neither cell is read under that disposition — no link ships
    // either way — so they agree on the only thing that reaches a member.
    // Reporting it would hand a curator a fault with no edit that clears it.
    const claim = { legacyPnums: "6240", disposition: "plain-text" } as const;

    const { collectionLinks, collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment({ ...claim, recommendedCollectionUrl: BIPAP }),
      assignment({
        ...claim,
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: CPAP_MACHINES,
      }),
    ]);

    expect(collectionFaults).toEqual([]);
    expect(collectionLinks).toEqual([]);
  });

  it("still reports two rows that claim one legacy value with different dispositions", () => {
    // The disposition is compared whatever it is: `plain-text` against
    // `collection` is the difference between a link and none, which is the
    // most consequential disagreement two rows can hold.
    const { collectionFaults } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: BIPAP,
      }),
      assignment({ legacyPnums: "6240", disposition: "plain-text" }),
    ]);

    expect(collectionFaults.map((fault) => fault.problem)).toEqual([
      "duplicate-assignment",
    ]);
  });

  it("ships nothing for a value when only some of its rows earned a link", () => {
    // The sharp case. Both rows derive `AirCurve 11 ASV (Discontinued)`, so
    // they collapse to one Mapping — and a Mapping is keyed on its value and
    // cannot tell which legacy identifier a member arrived by. Shipping 6240's
    // link would hand it to 6241 as well, which nobody assigned.
    const { collectionLinks, collectionFaults } = build(
      [...ASV_ROW, ASV_SIBLING],
      PRODUCTS,
      [
        assignment({
          legacyPnums: "6240",
          profileLinkValue: "AirCurve 11 ASV (Discontinued)",
          recommendedCollectionUrl: BIPAP,
        }),
      ]
    );

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults.map((fault) => fault.problem)).toEqual([
      "divided-value",
      "unassigned-legacy-value",
    ]);
    expect(collectionFaults[0].legacyValues).toEqual(["6240", "6241"]);
  });

  it("counts one absent link for a value that reported two problems", () => {
    // The same divided value, asked the question the CLI and the review
    // document ask: how many Collection Links are missing. Two faults, one
    // Mapping — and counting reasons as links would tell an operator to go
    // find a second one that was never owed.
    const { collectionFaults } = build([...ASV_ROW, ASV_SIBLING], PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: BIPAP,
      }),
    ]);

    expect(collectionFaults).toHaveLength(2);
    expect(undeliveredValues(collectionFaults)).toBe(1);
  });

  it("counts an absent link per value, not per field", () => {
    // Two fields can hold the same value, and a Mapping lives in one field, so
    // the pair is the key rather than the value alone.
    expect(
      undeliveredValues([
        {
          userFieldName: "Machine",
          legacyValues: ["1"],
          value: "Foo (Discontinued)",
          problem: "unassigned-legacy-value",
          detail: "",
        },
        {
          userFieldName: "Mask",
          legacyValues: ["2"],
          value: "Foo (Discontinued)",
          problem: "unassigned-legacy-value",
          detail: "",
        },
      ])
    ).toBe(2);
  });

  it("ships nothing for a value one of whose rows was curated to plain text", () => {
    // A recorded `plain-text` is a decision, not a problem — but it is a
    // decision the shared value has to honour, and it cannot honour both.
    const { collectionLinks, collectionFaults } = build(
      [...ASV_ROW, ASV_SIBLING],
      PRODUCTS,
      [
        assignment({
          legacyPnums: "6240",
          profileLinkValue: "AirCurve 11 ASV (Discontinued)",
          recommendedCollectionUrl: BIPAP,
        }),
        assignment({
          legacyPnums: "6241",
          disposition: "plain-text",
        }),
      ]
    );

    expect(collectionLinks).toEqual([]);
    expect(collectionFaults).toHaveLength(1);
    expect(collectionFaults[0].problem).toBe("divided-value");
    expect(collectionFaults[0].detail).toContain("6240 did");
    expect(collectionFaults[0].detail).toContain("6241 did");
  });

  it("ships one link for a value whose rows all earned the same one", () => {
    // The mirror of the two above, so that `divided-value` is read as the
    // rows disagreeing rather than as there being more than one of them.
    const { collectionLinks, collectionFaults } = build(
      [...ASV_ROW, ASV_SIBLING],
      PRODUCTS,
      [
        assignment({
          legacyPnums: "6240, 6241",
          profileLinkValue: "AirCurve 11 ASV (Discontinued)",
          recommendedCollectionUrl: BIPAP,
        }),
      ]
    );

    expect(collectionFaults).toEqual([]);
    expect(collectionLinks).toEqual([
      {
        userFieldName: "Machine",
        value: "AirCurve 11 ASV (Discontinued)",
        url: BIPAP,
      },
    ]);
  });
});

describe("renderFieldMappings", () => {
  it("produces the profile_link_fields structure the setting expects", () => {
    const fields = renderFieldMappings(build().catalogue, [], MANAGED_FIELDS);

    expect(fields.map((field) => field.user_field_name)).toEqual([
      "Machine",
      "Mask",
    ]);
    expect(fields[0].mappings).toEqual([
      {
        value: "AirCurve 10 VAuto BiLevel Machine",
        url: "https://www.cpap.com/products/aircurve-10-vauto-bilevel-machine",
      },
      {
        value: "AirSense 11 AutoSet",
        url: "https://www.cpap.com/products/resmed-airsense-11-autoset",
      },
      {
        value: "ResMed AirCurve 10 ASV BiLevel Machine",
        url: "https://www.cpap.com/products/resmed-aircurve-10-asv-bilevel-machine",
      },
    ]);
  });

  it("omits a Custom User Field with nothing behind it rather than shipping an empty one", () => {
    // A tab with no Suggested columns at all contributes rows that are blank
    // by construction (`sheetRowsFrom` never gives them a title to begin
    // with). A Field Mapping with no Mappings is a Config Problem, which is
    // worse than the field simply being absent (ADR-0012).
    const blankRows: SheetRow[] = [
      {
        userFieldName: "Vendor",
        legacyValue: "9001",
        legacyText: "ResMed",
        suggestedTitle: "",
        suggestedUrl: "",
      },
      {
        userFieldName: "Vendor",
        legacyValue: "9002",
        legacyText: "Philips",
        suggestedTitle: "  ",
        suggestedUrl: "",
      },
    ];

    const { catalogue, exclusions } = build([...MACHINE_ROWS, ...blankRows]);
    const fields = renderFieldMappings(catalogue, [], MANAGED_FIELDS);

    expect(fields.map((field) => field.user_field_name)).toEqual(["Machine"]);
    expect(
      exclusions.some(
        (exclusion) =>
          exclusion.userFieldName === "Vendor" &&
          exclusion.reason === "blank-title"
      )
    ).toBe(true);
  });

  it("emits the Collection Links it is handed, after each field's products", () => {
    const { catalogue, collectionLinks } = build();
    const fields = renderFieldMappings(
      catalogue,
      collectionLinks,
      MANAGED_FIELDS
    );

    expect(fields.map((field) => field.user_field_name)).toEqual([
      "Machine",
      "Mask",
    ]);
    expect(fields[0].mappings.at(-1)).toEqual({
      value: "DreamStation Auto CPAP Machine (Discontinued)",
      url: CPAP_MACHINES,
    });
    expect(fields[1].mappings.at(-1)).toEqual({
      value: "Viva Nasal CPAP Mask (Discontinued)",
      url: NASAL_MASKS,
    });
  });

  it("emits a Collection Link for a field with no products at all", () => {
    // The field is absent from the products entirely, so this is the case where
    // the second array decides whether the field ships at all. An empty
    // mappings list would be a Config Problem; a field with one Collection Link
    // in it is a field that resolves for the Users holding that value.
    const fields = renderFieldMappings([], COLLECTION_LINKS, MANAGED_FIELDS);

    expect(fields.map((field) => field.user_field_name)).toEqual([
      "Machine",
      "Mask",
    ]);
    expect(fields[0].mappings).toEqual([
      { value: "AirCurve 11 ASV (Discontinued)", url: BIPAP },
      {
        value: "DreamStation Auto CPAP Machine (Discontinued)",
        url: CPAP_MACHINES,
      },
    ]);
  });

  it("keeps a Collection-Link-only field in its declared position", () => {
    // The regression Copilot caught on #47. Grouping a concatenation takes its
    // field order from the order fields are first encountered, so every
    // product-backed field came out ahead of a field carrying only Collection
    // Links — `Mask` before `Machine` here, though `MANAGED_FIELDS` declares
    // `Machine` first and the component renders Field Mappings in the order it
    // receives them. Latent while both seeded fields have products, and wrong
    // the moment one does not, which is the case this sink exists to support.
    const { catalogue } = build();
    const maskOnly = catalogue.filter(
      (entry) => entry.userFieldName === "Mask"
    );
    const machineLinkOnly = COLLECTION_LINKS.filter(
      (link) => link.userFieldName === "Machine"
    );

    expect(maskOnly.length).toBeGreaterThan(0);
    expect(machineLinkOnly).toHaveLength(2);

    const fields = renderFieldMappings(
      maskOnly,
      machineLinkOnly,
      MANAGED_FIELDS
    );

    expect(fields.map((field) => field.user_field_name)).toEqual([
      "Machine",
      "Mask",
    ]);
  });

  it("ships only the products when handed an empty second array", () => {
    // An empty list has to be passed, not omitted: the parameter takes no
    // default, so a caller who has no Collection Links says so rather than
    // silently dropping them (ADR-0021).
    const { catalogue } = build();
    const values = renderFieldMappings(catalogue, [], MANAGED_FIELDS).flatMap(
      (field) =>
        field.mappings.map(
          (mapping) => `${field.user_field_name} ${mapping.value}`
        )
    );

    expect(values).toEqual(
      catalogue.map((entry) => `${entry.userFieldName} ${entry.value}`)
    );
    expect(values.some((value) => value.includes(COLLECTION_LINK_SUFFIX))).toBe(
      false
    );
  });
});

describe("dropdownOptionsFor", () => {
  it("cannot be handed a Collection Link at all", () => {
    // The guarantee, as the compiler enforces it: a `CollectionLink` has no
    // `handle` and no `status`, so it is not assignable to `ResolvedProduct`
    // and no call to this function can offer one. It is a type error rather
    // than a runtime filter because a filter is something every future caller
    // has to remember, and the first one that forgets offers a discontinued
    // machine to a User choosing theirs (ADR-0021). `pnpm lint:types` is where
    // this line is checked; the assertion below states the same fact at
    // runtime, so the shape is pinned even for a reader who never runs it.
    // @ts-expect-error a Collection Link is not a Resolved Product
    const forced: ResolvedProduct[] = [COLLECTION_LINKS[0]];

    expect(forced[0]).not.toHaveProperty("handle");
    expect(forced[0]).not.toHaveProperty("status");
  });

  it("offers no Collection Link value even when both come from one build", () => {
    const { catalogue, collectionLinks } = build();
    const offered = dropdownOptionsFor(catalogue);

    for (const link of collectionLinks) {
      const field = offered.find(
        (entry) => entry.user_field_name === link.userFieldName
      );

      // The field is there — this is a value missing from a list that exists,
      // not a whole field quietly absent.
      expect(field).toBeDefined();
      expect(field?.options).not.toContain(link.value);
    }

    // And the same values are in the Mappings, so the asymmetry is the whole
    // of the difference between the two sinks.
    const mapped = renderFieldMappings(
      catalogue,
      collectionLinks,
      MANAGED_FIELDS
    ).flatMap((field) => field.mappings.map((mapping) => mapping.value));

    for (const link of collectionLinks) {
      expect(mapped).toContain(link.value);
    }
  });
});

// The drift this component is worst at surfacing: a Dropdown Option with no
// Mapping behind it produces no Profile Link, no Config Problem, and nothing in
// the console unless Debug Mode is on. This makes generation-time divergence
// unshippable. It does not make deployed drift impossible — that is the
// readback's job (ADR-0011).
// The relation checked here is that Dropdown Options are a subset of Mapping
// values, not that the two sinks are identical. ADR-0011's failure mode is a
// Dropdown Option with no Mapping behind it: a member selects it and no
// Profile Link appears. The reverse — a Mapping with no Dropdown Option — has
// no failure mode, because nobody can select a value that is not offered.
// ADR-0021 depends on that asymmetry, so this assertion must stay a subset
// check, not equality: a future change that "fixes" it back to equality would
// fail the moment ADR-0021's kind of Mapping exists.
function crossSinkMismatches(
  fields: FieldMapping[],
  options: FieldOptions[]
): string[] {
  const mismatches: string[] = [];

  for (const forField of options) {
    const field = fields.find(
      (entry) => entry.user_field_name === forField.user_field_name
    );

    if (!field) {
      mismatches.push(`${forField.user_field_name} has no Field Mappings`);
      continue;
    }

    const values = new Set(field.mappings.map((mapping) => mapping.value));
    const orphaned = forField.options.filter((option) => !values.has(option));

    if (orphaned.length > 0) {
      mismatches.push(
        `${forField.user_field_name}: [${orphaned.join(", ")}] has no Mapping`
      );
    }
  }

  return mismatches;
}

describe("the cross-sink assertion", () => {
  it("finds every Dropdown Option backed by a Mapping value, per field", () => {
    const { catalogue } = build();

    expect(
      crossSinkMismatches(
        renderFieldMappings(catalogue, [], MANAGED_FIELDS),
        dropdownOptionsFor(catalogue)
      )
    ).toEqual([]);
  });

  it("fails when a single value drifts, so the assertion above is known to work", () => {
    // The injected fault is the one that actually happened: the test instance's
    // hand-entered Machine options carry trademark symbols the Suggested Titles
    // do not, and under an exact trimmed-string match those are unrelated
    // strings that look equivalent side by side (ADR-0011).
    const { catalogue } = build();
    const fields = renderFieldMappings(catalogue, [], MANAGED_FIELDS);
    const doctored: FieldMapping[] = fields.map((field) => ({
      user_field_name: field.user_field_name,
      mappings: field.mappings.map((mapping, index) =>
        field.user_field_name === "Machine" && index === 0
          ? { ...mapping, value: `${mapping.value}™` }
          : mapping
      ),
    }));

    const mismatches = crossSinkMismatches(
      doctored,
      dropdownOptionsFor(catalogue)
    );

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("Machine");
  });

  it("fails when a whole field's Mappings go missing", () => {
    const { catalogue } = build();
    const fields = renderFieldMappings(catalogue, [], MANAGED_FIELDS).filter(
      (field) => field.user_field_name !== "Mask"
    );

    const mismatches = crossSinkMismatches(
      fields,
      dropdownOptionsFor(catalogue)
    );

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("Mask");
    expect(mismatches[0]).toContain("no Field Mappings");
  });

  it("passes when a Mapping has no corresponding Dropdown Option", () => {
    // This is the relaxation the assertion exists to permit: a Collection
    // Link (ADR-0021) is a Mapping with deliberately no Dropdown Option, and
    // that must not read as drift.
    const { catalogue } = build();

    expect(
      crossSinkMismatches(
        renderFieldMappings(catalogue, [], MANAGED_FIELDS),
        dropdownOptionsFor(catalogue).filter(
          (entry) => entry.user_field_name !== "Mask"
        )
      )
    ).toEqual([]);
  });

  it("passes on a real Collection Link, which is expected to be absent from the options", () => {
    // The same relaxation on the real thing rather than a doctored list. Both
    // Collection Links below are Mappings and neither is a Dropdown Option,
    // and that is not drift: nobody can select a value that is not offered, so
    // a Mapping without an Option has no failure mode. ADR-0011's failure mode
    // runs the other way — an Option with no Mapping is an Unmatched Value —
    // and the check above still bites on it.
    //
    // Do not "fix" this back into an equality assertion. Equality was only ever
    // the cheapest way to get `Options ⊆ Mapping values` when every catalogue
    // entry was a product, and restoring it would silently re-couple the two
    // sinks and make Collection Links unshippable.
    const { catalogue, collectionLinks } = build();
    const fields = renderFieldMappings(
      catalogue,
      collectionLinks,
      MANAGED_FIELDS
    );
    const options = dropdownOptionsFor(catalogue);

    expect(crossSinkMismatches(fields, options)).toEqual([]);

    // Stated so the test above cannot pass by there being nothing asymmetric
    // in the fixture.
    const mappingCount = fields.reduce(
      (total, field) => total + field.mappings.length,
      0
    );
    const optionCount = options.reduce(
      (total, field) => total + field.options.length,
      0
    );

    expect(mappingCount).toBe(optionCount + COLLECTION_LINKS.length);
  });
});

/**
 * The disposition table: one row per legacy option value, and the only artifact
 * that crosses into the non-public repository that does the member-level join
 * (#28). Everything asserted here is asserted about a legacy identifier,
 * because that is the column the join is keyed on and the string a migrated
 * member is actually holding.
 *
 * The single rule the whole table turns on: a row with a URL carries the value
 * that ships as a Mapping, and a row without one carries the member's own
 * legacy display text verbatim. There is no third case, and no row is omitted.
 */
describe("the disposition table as the fifth output", () => {
  /**
   * What the standard fixtures come to, spelled out rather than computed, for
   * the same reason `COLLECTION_LINKS` is: a change in the transform should
   * arrive here as a diff a reader can judge rather than as a formula that
   * moved with it.
   */
  const DISPOSITIONS: DispositionRow[] = [
    {
      userFieldName: "Machine",
      legacyValue: "4801",
      legacyText: "AirSense 11 AutoSet CPAP Machine",
      value: "AirSense 11 AutoSet",
      url: "https://www.cpap.com/products/resmed-airsense-11-autoset",
      disposition: "resolves-to-product",
    },
    {
      userFieldName: "Machine",
      legacyValue: "4872",
      legacyText:
        "AirCurve 10 VAuto BiLevel Machine with HumidAir Heated Humidifier",
      value: "AirCurve 10 VAuto BiLevel Machine",
      url: "https://www.cpap.com/products/aircurve-10-vauto-bilevel-machine",
      disposition: "resolves-to-product",
    },
    {
      // The second legacy value for the same Suggested Title. The catalogue
      // collapses the two to one Mapping; this table must not collapse them,
      // because two members holding two different identifiers both need a row.
      userFieldName: "Machine",
      legacyValue: "5213",
      legacyText: "ResMed AirCurve 10 ASV",
      value: "ResMed AirCurve 10 ASV BiLevel Machine",
      url: "https://www.cpap.com/products/resmed-aircurve-10-asv-bilevel-machine",
      disposition: "resolves-to-product",
    },
    {
      // The catch-all row: its value is built from `Text`, not from the
      // Suggested Title, which names no equipment (ADR-0020).
      userFieldName: "Machine",
      legacyValue: "5851",
      legacyText: "DreamStation Auto CPAP Machine",
      value: "DreamStation Auto CPAP Machine (Discontinued)",
      url: CPAP_MACHINES,
      disposition: "collection",
    },
    {
      userFieldName: "Machine",
      legacyValue: "6092",
      legacyText: "AirCurve 10 Vauto USA C2C CO",
      value: "AirCurve 10 VAuto BiLevel Machine",
      url: "https://www.cpap.com/products/aircurve-10-vauto-bilevel-machine",
      disposition: "resolves-to-product",
    },
    {
      userFieldName: "Machine",
      legacyValue: "6240",
      legacyText: "Aircurve 11 asv",
      value: "AirCurve 11 ASV (Discontinued)",
      url: BIPAP,
      disposition: "collection",
    },
    {
      userFieldName: "Mask",
      legacyValue: "3001",
      legacyText: "Mirage FX Nasal Mask with Headgear",
      value: "Mirage FX Nasal CPAP Mask",
      url: "https://www.cpap.com/products/resmed-mirage-fx-nasal-cpap-mask",
      disposition: "resolves-to-product",
    },
    {
      userFieldName: "Mask",
      legacyValue: "3002",
      legacyText: "Morf Nasal Mask",
      value: "Morf Nasal Mask (Discontinued)",
      url: NASAL_MASKS,
      disposition: "collection",
    },
    {
      userFieldName: "Mask",
      legacyValue: "3003",
      legacyText: "Viva Nasal Mask",
      value: "Viva Nasal CPAP Mask (Discontinued)",
      url: NASAL_MASKS,
      disposition: "collection",
    },
    {
      userFieldName: "Mask",
      legacyValue: "3004",
      legacyText: "SleepWeaver Elan",
      value: "SleepWeaver Elan Nasal CPAP Mask (Discontinued)",
      url: NASAL_MASKS,
      disposition: "collection",
    },
    {
      // No Suggested Title to resolve and none to build a name from, so the
      // member keeps what the bulletin board showed them and gets no link.
      userFieldName: "Mask",
      legacyValue: "3005",
      legacyText: "Unlisted mask",
      value: "Unlisted mask",
      url: "",
      disposition: "blank-title",
    },
  ];

  it("is every legacy option value, once each, and nothing else", () => {
    expect(build().dispositions).toEqual(DISPOSITIONS);
  });

  it("covers both Managed Fields and invents no third one", () => {
    // Humidifier is out of scope entirely (#42/ADR-0022), and the way it stays
    // out is that the table walks the Sheet Exports — whose allowlist has two
    // entries — rather than a field list of its own.
    expect([
      ...new Set(build().dispositions.map((row) => row.userFieldName)),
    ]).toEqual(["Machine", "Mask"]);
  });

  it("carries a value and a URL exactly together", () => {
    // The one invariant the downstream join relies on. A URL with no value
    // would be a link with no anchor text to match a member against; a value
    // with no URL would be this table claiming a Mapping that does not ship.
    const { dispositions, catalogue, collectionLinks } = build();
    const shipped = new Set(
      [...catalogue, ...collectionLinks].map(
        (entry) => `${entry.userFieldName}\u0000${entry.value}`
      )
    );

    for (const row of dispositions) {
      const key = `${row.userFieldName}\u0000${row.value}`;

      expect(row.value).not.toBe("");

      if (row.url === "") {
        expect(row.value).toBe(row.legacyText);
        expect(shipped.has(key)).toBe(false);
      } else {
        expect(shipped.has(key)).toBe(true);
      }
    }
  });

  it("appends no suffix to a value that earns no link", () => {
    // The suffix exists because a Collection Link's value is its anchor text
    // (ADR-0020). An unlinked value has no anchor text, so a suffix there
    // labels nothing and manufactures a string that looks like a Collection
    // Link and resolves for nobody — the exact failure this epic removes.
    const unlinked = build().dispositions.filter((row) => row.url === "");

    expect(unlinked.length).toBeGreaterThan(0);

    for (const row of unlinked) {
      expect(row.value.endsWith(COLLECTION_LINK_SUFFIX)).toBe(false);
    }
  });

  it("resolves a resolves-to-product row to the product, never to `n/a`", () => {
    // The one-cell mistake that produces a plausible-looking artifact. PNums
    // 6377 and 6378 carry `n/a` in `Profile Link Value` — the row saying it
    // proposes no *new* value, not that the identifier has no value — and
    // passing that through would emit a Profile Link literally called `n/a`,
    // which stores fine, renders nothing, and is indistinguishable to a member
    // from the bug this epic removes.
    //
    // Nothing parses the `5232` out of the row's prose, either. The legacy row
    // carries its own `Suggested Title`, and that title is the join to the
    // catalogue, so the resolution is structural.
    const nonMagnetic: SheetRow = {
      userFieldName: "Mask",
      legacyValue: "6377",
      legacyText: "AirFit™ F20 Non Magnetic Complete Mask System - LGE",
      suggestedTitle: "Mirage FX Nasal CPAP Mask",
      suggestedUrl:
        "https://www.sleeping.com/products/resmed-mirage-fx-nasal-cpap-mask",
    };
    const { dispositions } = build([...SHEET_ROWS, nonMagnetic], PRODUCTS, [
      ...ASSIGNMENTS,
      assignment({
        field: "Mask",
        legacyPnums: "6377",
        legacyText: "AirFit™ F20 Non Magnetic Complete Mask System - LGE",
        baseNameSource: "n/a",
        profileLinkValue: "n/a",
        recommendedCollectionTitle: "n/a — resolves to existing mapped product",
        recommendedCollectionUrl: "n/a — same as existing value 3001",
        disposition: "resolves-to-product",
      }),
    ]);

    expect(dispositionFor(dispositions, "Mask", "6377")).toEqual({
      userFieldName: "Mask",
      legacyValue: "6377",
      legacyText: "AirFit™ F20 Non Magnetic Complete Mask System - LGE",
      value: "Mirage FX Nasal CPAP Mask",
      url: "https://www.cpap.com/products/resmed-mirage-fx-nasal-cpap-mask",
      disposition: "resolves-to-product",
    });
  });

  it("keeps the legacy text and no URL for a plain-text row", () => {
    const { dispositions } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: BIPAP,
        disposition: "plain-text",
      }),
    ]);

    expect(dispositionFor(dispositions, "Machine", "6240")).toEqual({
      userFieldName: "Machine",
      legacyValue: "6240",
      legacyText: "Aircurve 11 asv",
      value: "Aircurve 11 asv",
      url: "",
      disposition: "plain-text",
    });
  });

  it("keeps the legacy text and no URL for an undecided row", () => {
    // `undecided` blocks the ship (#38/ADR-0021), which is a gate's job. What
    // this table does with it is refuse to lose the member's value over it.
    const { dispositions } = build(ASV_ROW, PRODUCTS, [
      assignment({
        legacyPnums: "6240",
        profileLinkValue: "AirCurve 11 ASV (Discontinued)",
        recommendedCollectionUrl: BIPAP,
        disposition: "undecided",
      }),
    ]);

    expect(dispositionFor(dispositions, "Machine", "6240")).toMatchObject({
      value: "Aircurve 11 asv",
      url: "",
      disposition: "undecided",
    });
  });

  it("says `collection-link-fault` where a link was owed and withheld", () => {
    // Every reason a link goes undelivered reads the same way to a member —
    // no link — and differently to a curator, which is what the review
    // document is for. Here it needs one word, and it must not be a word that
    // reads as a decision somebody made.
    const { dispositions, collectionFaults } = build(ASV_ROW, PRODUCTS, []);

    expect(collectionFaults.map((fault) => fault.problem)).toEqual([
      "unassigned-legacy-value",
    ]);
    expect(dispositionFor(dispositions, "Machine", "6240")).toMatchObject({
      value: "Aircurve 11 asv",
      url: "",
      disposition: "collection-link-fault",
    });
  });

  it("reports an ambiguous title match as itself, not as plain text", () => {
    // ADR-0020 treats an ambiguous match as evidence the equipment is still
    // sold and the Sheet Export is wrong. Folding it into `plain-text` would
    // file a fixable data fault as a curator's settled decision.
    const twin: ProductRecord = {
      handle: "morf-nasal-mask-second",
      title: "Morf Nasal Mask",
      status: "ACTIVE",
      tags: [],
      onlineStoreUrl: "https://www.cpap.com/products/morf-nasal-mask-second",
    };
    const morf = MASK_ROWS.filter((row) => row.legacyValue === "3002").map(
      (row) => ({ ...row, suggestedUrl: "" })
    );
    const { dispositions } = build(morf, [...PRODUCTS, twin], ASSIGNMENTS);

    expect(dispositionFor(dispositions, "Mask", "3002")).toMatchObject({
      value: "Morf Nasal Mask",
      url: "",
      disposition: "ambiguous-title-match",
    });
  });

  it("keeps a curator's plain-text apart from its sibling's withheld link", () => {
    // A `divided-value` group: two legacy values derive one value, one earned a
    // link and one was told not to, so neither ships. The two rows must not
    // read the same — one is a decision that was honoured, the other is a link
    // a member is now missing.
    const { dispositions, collectionFaults } = build(
      [...ASV_ROW, ASV_SIBLING],
      PRODUCTS,
      [
        assignment({
          legacyPnums: "6240",
          profileLinkValue: "AirCurve 11 ASV (Discontinued)",
          recommendedCollectionUrl: BIPAP,
        }),
        assignment({
          legacyPnums: "6241",
          profileLinkValue: "AirCurve 11 ASV (Discontinued)",
          recommendedCollectionUrl: BIPAP,
          disposition: "plain-text",
        }),
      ]
    );

    expect(collectionFaults.map((fault) => fault.problem)).toEqual([
      "divided-value",
    ]);
    expect(dispositionFor(dispositions, "Machine", "6241")).toMatchObject({
      disposition: "plain-text",
      url: "",
    });
    expect(dispositionFor(dispositions, "Machine", "6240")).toMatchObject({
      disposition: "collection-link-fault",
      url: "",
    });
  });

  it("reports what ships when a curated row says plain-text of a live product", () => {
    // The awkward case, decided rather than left to fall out. A curator writes
    // `plain-text` against a legacy value whose Suggested Title still resolves
    // to a live product — so the catalogue carries that title as a Mapping
    // whatever the curated row says, because the catalogue is built from the
    // sheet and Shopify and never consults the Collection Assignment.
    //
    // The table reports `resolves-to-product` with the URL, which is what a
    // member will actually get. Reporting `plain-text` with no URL would make
    // this artifact disagree with the `settings.yml` it is joined against, and
    // a table that is wrong about whether a link renders is worse than one
    // that is silent about a curator being overruled.
    //
    // It *is* silent about it, and that is the known cost: the mirror case —
    // `resolves-to-product` against a title that stopped resolving — is
    // reported loudly as `stale-product-resolution`, and this direction has no
    // fault of its own. Giving it one means a new `CollectionLinkProblem`,
    // which is its own ticket; this test is here so the behaviour is a decision
    // on the record rather than an accident nobody wrote down.
    const { dispositions, collectionFaults } = build(
      MACHINE_ROWS.filter((row) => row.legacyValue === "4801"),
      PRODUCTS,
      [
        assignment({
          legacyPnums: "4801",
          profileLinkValue: "AirSense 11 AutoSet (Discontinued)",
          recommendedCollectionUrl: CPAP_MACHINES,
          disposition: "plain-text",
        }),
      ]
    );

    expect(collectionFaults).toEqual([]);
    expect(dispositionFor(dispositions, "Machine", "4801")).toMatchObject({
      value: "AirSense 11 AutoSet",
      url: "https://www.cpap.com/products/resmed-airsense-11-autoset",
      disposition: "resolves-to-product",
    });
  });

  it("hands over the legacy display text byte for byte, padding included", () => {
    // `sheetRowsFrom` preserves this cell deliberately, and the table is where
    // that care would otherwise be thrown away. Trimming it would be this
    // pipeline tidying member-authored content — the same thing appending
    // ` (Discontinued)` to an unlinked value would be, refused on the same
    // grounds. And a trimmed value cannot be un-trimmed downstream, so the raw
    // bytes leave the choice with the repository doing the writing.
    //
    // The identifier is the exception, because it is a join key: it is trimmed
    // here and by `deriveCollectionLinks` and `legacyValuesOf`, so a padded
    // cell cannot key one map and miss another.
    const padded: SheetRow = {
      userFieldName: "Mask",
      legacyValue: "  3006  ",
      legacyText: "  Unlisted mask with trailing space  ",
      suggestedTitle: "",
      suggestedUrl: "",
    };
    const { dispositions } = build([padded], PRODUCTS, []);

    expect(dispositions).toEqual([
      {
        userFieldName: "Mask",
        legacyValue: "3006",
        legacyText: "  Unlisted mask with trailing space  ",
        value: "  Unlisted mask with trailing space  ",
        url: "",
        disposition: "blank-title",
      },
    ]);
  });

  it("emits a disposition this repository has a word for", () => {
    for (const row of build().dispositions) {
      expect(DISPOSITION_OUTCOMES).toContain(row.disposition);
    }
  });

  it("carries no column a member could be identified by", () => {
    // The whole point of the artifact. Every column is either a legacy option
    // identifier, a product name, or a URL — nothing is keyed to a person, and
    // the shape is what enforces it rather than a scan of the contents.
    for (const row of build().dispositions) {
      expect(Object.keys(row).sort()).toEqual([
        "disposition",
        "legacyText",
        "legacyValue",
        "url",
        "userFieldName",
        "value",
      ]);
    }
  });
});

describe("the module's isolation", () => {
  it("reaches for no network, no filesystem, and no clock", () => {
    // Asserted against the source because purity is the property the three
    // commands around this module depend on: if it can read or fetch, a
    // decision can hide in a shell that nothing tests.
    // Read relative to the repository root, which is vitest's working
    // directory. `import.meta.url` would be the obvious way to resolve it and
    // does not typecheck here — the shared Discourse tsconfig builds to
    // CommonJS output, where the meta-property is not allowed.
    const source = readFileSync("scripts/lib/build-catalogue.ts", "utf8");

    // `import type` is admitted and a value import is not, which is the same
    // line `sheet-export.ts` draws for the same reason. A type is erased before
    // anything runs, so it can carry a shape across the boundary without
    // carrying a behaviour — and the two files type-import each other, which
    // would be a cycle if either import were real.
    expect(source).not.toMatch(/^\s*import (?!type )/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bDate\b|\bprocess\b/);
  });
});
