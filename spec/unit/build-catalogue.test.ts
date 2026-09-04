import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCatalogue,
  COLLECTION_LINK_SUFFIX,
  type CollectionLink,
  dropdownOptionsFor,
  type ExcludedProduct,
  type FieldMapping,
  type FieldOptions,
  type ProductRecord,
  renderFieldMappings,
  type ResolvedProduct,
  type SheetRow,
} from "../../scripts/lib/build-catalogue";
import { MANAGED_FIELDS } from "../../scripts/lib/plan-apply.ts";

// The fixtures are the real rows and the real Shopify facts found while
// planning PSD-68, so the suite encodes the failures that actually happened
// rather than invented ones. Suggested URLs are left pointing at sleeping.com
// exactly as the spreadsheet holds them, which is also what proves the shipped
// URL never comes from that column (ADR-0009).

const MACHINE_ROWS: SheetRow[] = [
  {
    userFieldName: "Machine",
    suggestedTitle: "AirCurve 10 VAuto BiLevel Machine",
    suggestedUrl:
      "https://www.sleeping.com/products/aircurve-10-vauto-bilevel-machine",
  },
  {
    // The same title again, one of many rows the legacy migration map carries
    // per product — a second legacy value, the same suggested product.
    userFieldName: "Machine",
    suggestedTitle: "AirCurve 10 VAuto BiLevel Machine",
    suggestedUrl:
      "https://www.sleeping.com/products/aircurve-10-vauto-bilevel-machine",
  },
  {
    userFieldName: "Machine",
    suggestedTitle: "AirSense 11 AutoSet",
    suggestedUrl:
      "https://www.sleeping.com/products/resmed-airsense-11-autoset",
  },
  {
    userFieldName: "Machine",
    suggestedTitle: "AirCurve 11 ASV",
    suggestedUrl: "https://www.sleeping.com/products/aircurve-11-asv",
  },
  {
    // The one Suggested URL in the sheet that points at a search results page,
    // so there is no slug to join on at all.
    userFieldName: "Machine",
    suggestedTitle: "ResMed AirCurve 10 ASV BiLevel Machine",
    suggestedUrl:
      "https://www.sleeping.com/search?q=resmed+aircurve&_pos=4&_psq=resmed+air&_ss=e&_v=1.0",
  },
  {
    userFieldName: "Machine",
    suggestedTitle: "CPAP Machines (Discontinued)",
    suggestedUrl: "https://www.sleeping.com/collections/cpap-machines",
  },
];

const MASK_ROWS: SheetRow[] = [
  {
    userFieldName: "Mask",
    suggestedTitle: "Mirage FX Nasal CPAP Mask",
    suggestedUrl:
      "https://www.sleeping.com/products/resmed-mirage-fx-nasal-cpap-mask",
  },
  {
    userFieldName: "Mask",
    suggestedTitle: "Morf Nasal Mask",
    suggestedUrl: "https://www.sleeping.com/products/morf-nasal-mask",
  },
  {
    userFieldName: "Mask",
    suggestedTitle: "Viva Nasal CPAP Mask",
    suggestedUrl: "https://www.sleeping.com/products/viva-nasal-cpap-mask",
  },
  {
    userFieldName: "Mask",
    suggestedTitle: "SleepWeaver Elan Nasal CPAP Mask",
    suggestedUrl:
      "https://www.sleeping.com/products/circadiance-sleepweaver-elan-soft-cloth-nasal-cpap-mask",
  },
  {
    // The sheet's last Mask row is genuinely empty in both columns.
    userFieldName: "Mask",
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

// Two hand-seeded Collection Links, one per Managed Field, shaped like the rows
// the committed file carries. The Machine one is the legacy catch-all the
// spreadsheet holds as `CPAP Machines (Discontinued)` — the value it becomes
// comes from the sheet's `Text` column rather than the retired title, and the
// derivation that does that is a later step (ADR-0020). Here they are given.
const COLLECTION_LINKS: CollectionLink[] = [
  {
    userFieldName: "Machine",
    value: "DreamStation Auto CPAP Machine (Discontinued)",
    url: "https://www.cpap.com/collections/cpap-machines",
  },
  {
    userFieldName: "Mask",
    value: "Mirage FX Nasal CPAP Mask (Discontinued)",
    url: "https://www.cpap.com/collections/nasal-cpap-masks",
  },
];

function build(
  rows: SheetRow[] = SHEET_ROWS,
  products = PRODUCTS,
  collectionLinks: CollectionLink[] = []
) {
  return buildCatalogue({ sheetRows: rows, products, collectionLinks });
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
        suggestedTitle: "airfit N30i Nasal CPAP Mask",
        suggestedUrl: "https://www.sleeping.com/products/lower",
      },
      {
        userFieldName: "Mask",
        suggestedTitle: "AirFit N20 Nasal CPAP Mask",
        suggestedUrl: "https://www.sleeping.com/products/upper",
      },
      {
        userFieldName: "Mask",
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
  it("returns them alongside the catalogue and the Excluded Products", () => {
    const result = build(SHEET_ROWS, PRODUCTS, COLLECTION_LINKS);

    expect(result.collectionLinks).toEqual(COLLECTION_LINKS);
    expect(result.catalogue.length).toBeGreaterThan(0);
    expect(result.exclusions.length).toBeGreaterThan(0);
  });

  it("carries no product handle and no product status", () => {
    // A collection has neither, which is why this is its own type rather than
    // a flag on a Resolved Product: admitting a sentinel handle or status
    // would mean relaxing `readResolvedProducts` for every row (ADR-0021).
    const [link] = build(
      SHEET_ROWS,
      PRODUCTS,
      COLLECTION_LINKS
    ).collectionLinks;

    expect(Object.keys(link).sort()).toEqual(["url", "userFieldName", "value"]);
  });

  it("is empty rather than absent when none are given", () => {
    expect(build().collectionLinks).toEqual([]);
  });

  it("orders them by field then value, as it orders the other two outputs", () => {
    const scrambled: CollectionLink[] = [
      {
        userFieldName: "Mask",
        value: "Zest Nasal CPAP Mask (Discontinued)",
        url: "https://www.cpap.com/collections/nasal-cpap-masks",
      },
      ...COLLECTION_LINKS,
    ].reverse();

    const { collectionLinks } = build(SHEET_ROWS, PRODUCTS, scrambled);

    expect(
      collectionLinks.map((link) => `${link.userFieldName} ${link.value}`)
    ).toEqual([
      "Machine DreamStation Auto CPAP Machine (Discontinued)",
      "Mask Mirage FX Nasal CPAP Mask (Discontinued)",
      "Mask Zest Nasal CPAP Mask (Discontinued)",
    ]);
  });

  it("names the suffix on exact bytes, because resolution is an exact match", () => {
    // One leading space, one capital `D`, no variants. `resolveProfileLinks`
    // looks the User's stored value up in a map keyed by the Mapping value, so
    // ` (discontinued)` or `(Discontinued)` unspaced is not a near miss — it is
    // a value that resolves for nobody (ADR-0020).
    expect(COLLECTION_LINK_SUFFIX).toBe(" (Discontinued)");

    for (const link of COLLECTION_LINKS) {
      expect(link.value.endsWith(COLLECTION_LINK_SUFFIX)).toBe(true);
      expect(link.value.endsWith(" (discontinued)")).toBe(false);
    }
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
      { userFieldName: "Vendor", suggestedTitle: "", suggestedUrl: "" },
      { userFieldName: "Vendor", suggestedTitle: "  ", suggestedUrl: "" },
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
    const { catalogue, collectionLinks } = build(
      SHEET_ROWS,
      PRODUCTS,
      COLLECTION_LINKS
    );
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
      url: "https://www.cpap.com/collections/cpap-machines",
    });
    expect(fields[1].mappings.at(-1)).toEqual({
      value: "Mirage FX Nasal CPAP Mask (Discontinued)",
      url: "https://www.cpap.com/collections/nasal-cpap-masks",
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
      {
        value: "DreamStation Auto CPAP Machine (Discontinued)",
        url: "https://www.cpap.com/collections/cpap-machines",
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
    expect(machineLinkOnly).toHaveLength(1);

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
    const { catalogue, collectionLinks } = build(
      SHEET_ROWS,
      PRODUCTS,
      COLLECTION_LINKS
    );
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
    const { catalogue, collectionLinks } = build(
      SHEET_ROWS,
      PRODUCTS,
      COLLECTION_LINKS
    );
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

    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bDate\b|\bprocess\b/);
  });
});
