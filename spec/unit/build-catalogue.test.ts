import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCatalogue,
  COLLECTION_LINK_SUFFIX,
  type CollectionLink,
  dropdownOptionsFor,
  earnsCollectionLink,
  type ExcludedProduct,
  type FieldMapping,
  type FieldOptions,
  type ProductRecord,
  renderFieldMappings,
  type ResolvedProduct,
  type SheetRow,
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

  it("derives none, and no faults, when the assignment table is empty", () => {
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

  it("says nothing about plain-text and resolves-to-product rows", () => {
    // Both are decisions somebody recorded, so neither is a fault. A
    // `resolves-to-product` row is not dropped either — its legacy identifier
    // still carries the live product's value downstream, just not from here.
    for (const disposition of ["plain-text", "resolves-to-product"] as const) {
      const { collectionLinks, collectionFaults } = build(ASV_ROW, PRODUCTS, [
        assignment({
          legacyPnums: "6240",
          profileLinkValue: "n/a",
          recommendedCollectionUrl: "n/a — same as existing value 5232",
          disposition,
        }),
      ]);

      expect(collectionLinks).toEqual([]);
      expect(collectionFaults).toEqual([]);
    }
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
