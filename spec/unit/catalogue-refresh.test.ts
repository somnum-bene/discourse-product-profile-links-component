import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCatalogue,
  COLLECTION_LINK_SUFFIX,
  type CollectionLink,
  type ProductRecord,
  type ResolvedProduct,
  type SheetRow,
} from "../../scripts/lib/build-catalogue";
import {
  CATALOGUE_FILE,
  CatalogueRefreshError,
  COLLECTION_LINK_COLUMNS,
  COLLECTION_LINKS_FILE,
  collectionLinksCsv,
  curatesTitles,
  declaredDigest,
  digestOf,
  divisionFieldsOf,
  DIVISIONS,
  divisionSurveyQuery,
  EXCLUSION_REASONS,
  handleBatches,
  handlesFromSheetRows,
  mergeProducts,
  productsByHandleQuery,
  productsFromByHandleResponse,
  readCollectionLinks,
  readResolvedProducts,
  renderReviewDocument,
  resolvedProductsCsv,
  REVIEW_FILE,
  SHOPIFY_API_VERSION,
  shopifyEndpoint,
  type SurveyedProduct,
  surveyPageFromResponse,
  TOKEN_VAR,
} from "../../scripts/lib/catalogue-refresh";
import {
  exportFileName,
  SHEET_TABS,
  sheetRowsFrom,
} from "../../scripts/lib/sheet-export";

// The fixtures are real: the sheet rows are lines from the committed Sheet
// Exports, and the product records are what the cpap.com Shopify catalogue
// actually answered on 2026-08-05, trimmed to the fields the pipeline reads.
// Suggested URLs still point at sleeping.com, exactly as the spreadsheet holds
// them, because that is what proves no shipped URL comes from that column.

const MACHINES_TAG = "Catalog-Merchant-Division-Machines";
const MASKS_TAG = "Catalog-Merchant-Division-Masks";

const SHEET_ROWS: SheetRow[] = [
  {
    userFieldName: "Machine",
    suggestedTitle: "AirCurve 10 VAuto BiLevel Machine",
    suggestedUrl:
      "https://www.sleeping.com/products/aircurve-10-vauto-bilevel-machine",
  },
  {
    // The same product again under a second legacy value. The sheet is a
    // migration map, so this is the common case rather than the odd one.
    userFieldName: "Machine",
    suggestedTitle: "AirCurve 10 VAuto BiLevel Machine",
    suggestedUrl:
      "https://www.sleeping.com/products/aircurve-10-vauto-bilevel-machine",
  },
  {
    userFieldName: "Machine",
    suggestedTitle: "AirCurve 11 ASV",
    suggestedUrl: "https://www.sleeping.com/products/aircurve-11-asv",
  },
  {
    // A real row, and the reason handles cannot simply be assumed: its
    // Suggested URL is a search results page, not a product.
    userFieldName: "Machine",
    suggestedTitle: "ResMed AirCurve 10 ASV BiLevel Machine",
    suggestedUrl:
      "https://www.sleeping.com/search?q=resmed+aircurve&_pos=4&_psq=resmed+air&_ss=e&_v=1.0",
  },
  {
    userFieldName: "Mask",
    suggestedTitle: "Amara Full Face CPAP Mask",
    suggestedUrl:
      "https://www.sleeping.com/products/amara-full-face-cpap-mask-with-headgear",
  },
  {
    userFieldName: "Mask",
    suggestedTitle: "Morf Nasal Mask",
    suggestedUrl: "https://www.sleeping.com/products/morf-nasal-mask",
  },
];

const AIRCURVE_10: SurveyedProduct = {
  handle: "aircurve-10-vauto-bilevel-machine",
  title: "ResMed AirCurve 10 VAuto BiPAP Machine",
  status: "ACTIVE",
  tags: ["AirSense10", MACHINES_TAG, "Live Product", "Rx-Required"],
  onlineStoreUrl:
    "https://www.cpap.com/products/aircurve-10-vauto-bilevel-machine",
  totalInventory: 27,
  divisionFields: ["Machine"],
};

// ACTIVE, in stock, and never published to the Online Store. This one product
// is why `unpublished` is a separate outcome from `not-active`.
const AIRCURVE_11_ASV: SurveyedProduct = {
  handle: "aircurve-11-asv",
  title: "AirCurve 11 ASV",
  status: "ACTIVE",
  tags: ["AirSense11", MACHINES_TAG, "Missing Images/Media"],
  onlineStoreUrl: null,
  totalInventory: 7,
  divisionFields: ["Machine"],
};

const AMARA: SurveyedProduct = {
  handle: "amara-full-face-cpap-mask-with-headgear",
  title: "Amara Full Face CPAP Mask",
  status: "ACTIVE",
  tags: [MASKS_TAG, "Discontinued"],
  onlineStoreUrl:
    "https://www.cpap.com/products/amara-full-face-cpap-mask-with-headgear",
  totalInventory: 4,
  divisionFields: ["Mask"],
};

const MORF: SurveyedProduct = {
  handle: "morf-nasal-mask",
  title: "Morf Nasal Mask",
  status: "ARCHIVED",
  tags: [MASKS_TAG, "Discontinued"],
  onlineStoreUrl: null,
  totalInventory: 0,
  divisionFields: ["Mask"],
};

// On sale, in the Masks division, and named nowhere in the spreadsheet.
const NOVA: SurveyedProduct = {
  handle: "nova-nasal-cpap-mask",
  title: "Nova Nasal CPAP Mask",
  status: "ACTIVE",
  tags: [MASKS_TAG],
  onlineStoreUrl: "https://www.cpap.com/products/nova-nasal-cpap-mask",
  totalInventory: 1407,
  divisionFields: ["Mask"],
};

const PRODUCTS: SurveyedProduct[] = [
  AIRCURVE_10,
  AIRCURVE_11_ASV,
  AMARA,
  MORF,
  NOVA,
];

/** A by-handle response as Shopify sends it, aliases and all. */
function byHandleResponse(
  nodes: readonly (Record<string, unknown> | null)[]
): unknown {
  const data: Record<string, unknown> = {};

  for (const [index, node] of nodes.entries()) {
    data[`p${index}`] = node;
  }

  return { data, extensions: { cost: { actualQueryCost: nodes.length } } };
}

function shopifyNode(
  product: SurveyedProduct,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    handle: product.handle,
    title: product.title,
    status: product.status,
    tags: product.tags,
    onlineStoreUrl: product.onlineStoreUrl,
    totalInventory: product.totalInventory,
    ...overrides,
  };
}

function surveyResponse(
  nodes: readonly Record<string, unknown>[],
  pageInfo: Record<string, unknown> = { hasNextPage: false, endCursor: null }
): unknown {
  return { data: { products: { pageInfo, nodes } } };
}

const CATALOGUE: ResolvedProduct[] = [
  {
    userFieldName: "Machine",
    value: "AirCurve 10 VAuto BiLevel Machine",
    handle: "aircurve-10-vauto-bilevel-machine",
    status: "ACTIVE",
    url: "https://www.cpap.com/products/aircurve-10-vauto-bilevel-machine",
  },
  {
    // A comma inside a Mapping value. The Suggested Titles carry these, so the
    // catalogue file has to quote and the reader has to unquote.
    userFieldName: "Mask",
    value: "DreamWear Full Face Mask (S, M, L)",
    handle: "dreamwear-full-face-cpap-mask-with-headgear",
    status: "ACTIVE",
    url: "https://www.cpap.com/products/dreamwear-full-face-cpap-mask-with-headgear",
  },
];

describe("handlesFromSheetRows", () => {
  it("returns the handles the join will look for, deduplicated and sorted", () => {
    expect(handlesFromSheetRows(SHEET_ROWS)).toEqual([
      "aircurve-10-vauto-bilevel-machine",
      "aircurve-11-asv",
      "amara-full-face-cpap-mask-with-headgear",
      "morf-nasal-mask",
    ]);
  });

  it("skips a row whose Suggested URL names no product", () => {
    const searchRow = SHEET_ROWS.filter((row) =>
      row.suggestedUrl.includes("/search")
    );

    expect(searchRow).toHaveLength(1);
    expect(handlesFromSheetRows(searchRow)).toEqual([]);
  });

  it("refuses a Suggested URL whose product segment is not a handle", () => {
    expect(() =>
      handlesFromSheetRows([
        {
          userFieldName: "Machine",
          suggestedTitle: "Something",
          suggestedUrl: "https://www.sleeping.com/products/Not A Handle",
        },
      ])
    ).toThrow(CatalogueRefreshError);
  });

  it("has nothing to look for when there are no rows", () => {
    expect(handlesFromSheetRows([])).toEqual([]);
  });
});

describe("handleBatches", () => {
  it("splits into requests, preserving order", () => {
    expect(handleBatches(["a", "b", "c", "d", "e"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
  });

  it("leaves no empty trailing batch when the split is exact", () => {
    expect(handleBatches(["a", "b", "c", "d"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("refuses a batch size that would never finish", () => {
    expect(() => handleBatches(["a"], 0)).toThrow(CatalogueRefreshError);
  });
});

describe("shopifyEndpoint", () => {
  it("addresses the pinned API version on the given shop", () => {
    expect(shopifyEndpoint("example.myshopify.com")).toBe(
      `https://example.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`
    );
  });

  it("refuses a domain carrying a scheme", () => {
    expect(() => shopifyEndpoint("https://example.myshopify.com")).toThrow(
      CatalogueRefreshError
    );
  });

  it("refuses a domain carrying a path, which is where a token would leak", () => {
    expect(() => shopifyEndpoint("example.com/evil")).toThrow(
      CatalogueRefreshError
    );
  });
});

describe("the queries it sends", () => {
  it("asks for each handle under its own alias", () => {
    const query = productsByHandleQuery(["aircurve-11-asv", "morf-nasal-mask"]);

    expect(query).toContain(
      'p0: productByIdentifier(identifier: { handle: "aircurve-11-asv" })'
    );
    expect(query).toContain(
      'p1: productByIdentifier(identifier: { handle: "morf-nasal-mask" })'
    );
  });

  it("asks for every field the pipeline reads and no more", () => {
    const query = productsByHandleQuery(["aircurve-11-asv"]);

    for (const field of [
      "handle",
      "title",
      "status",
      "tags",
      "onlineStoreUrl",
      "totalInventory",
    ]) {
      expect(query).toContain(field);
    }
  });

  it("refuses to send a by-handle query with nothing to ask about", () => {
    expect(() => productsByHandleQuery([])).toThrow(CatalogueRefreshError);
  });

  it("surveys a division for live products only, sorted for stable paging", () => {
    const query = divisionSurveyQuery(DIVISIONS[0], null);

    expect(query).toContain(MACHINES_TAG);
    expect(query).toContain("status:active");
    expect(query).toContain("sortKey: TITLE");
    expect(query).not.toContain("after:");
  });

  it("carries the cursor on every page after the first", () => {
    expect(divisionSurveyQuery(DIVISIONS[0], "cursor-abc")).toContain(
      'after: "cursor-abc"'
    );
  });
});

describe("reading a by-handle response", () => {
  it("returns the products Shopify knew about", () => {
    const body = byHandleResponse([
      shopifyNode(AIRCURVE_10),
      shopifyNode(AIRCURVE_11_ASV),
    ]);

    expect(
      productsFromByHandleResponse(body, [
        AIRCURVE_10.handle,
        AIRCURVE_11_ASV.handle,
      ])
    ).toEqual([AIRCURVE_10, AIRCURVE_11_ASV]);
  });

  it("treats a null node as a product that does not exist, not as a failure", () => {
    const body = byHandleResponse([shopifyNode(AIRCURVE_10), null]);
    const found = productsFromByHandleResponse(body, [
      AIRCURVE_10.handle,
      "gone-from-the-catalogue",
    ]);

    expect(found).toEqual([AIRCURVE_10]);
  });

  it("refuses a response missing an alias it asked for", () => {
    const body = byHandleResponse([shopifyNode(AIRCURVE_10)]);

    expect(() =>
      productsFromByHandleResponse(body, [
        AIRCURVE_10.handle,
        "aircurve-11-asv",
      ])
    ).toThrow(/no "p1"/);
  });

  it("refuses a GraphQL error even though Shopify sent it with HTTP 200", () => {
    const body = {
      errors: [{ message: "Throttled" }],
      data: { p0: null },
    };

    expect(() =>
      productsFromByHandleResponse(body, ["aircurve-11-asv"])
    ).toThrow(/Throttled/);
  });

  it("accepts UNLISTED, which the live catalogue actually uses", () => {
    const body = byHandleResponse([
      shopifyNode(AIRCURVE_11_ASV, { status: "UNLISTED" }),
    ]);
    const [product] = productsFromByHandleResponse(body, [
      AIRCURVE_11_ASV.handle,
    ]);

    expect(product?.status).toBe("UNLISTED");
  });

  it("refuses a status it has never seen rather than guessing it is inadmissible", () => {
    const body = byHandleResponse([
      shopifyNode(AIRCURVE_10, { status: "SOMETHING_NEW" }),
    ]);

    expect(() =>
      productsFromByHandleResponse(body, [AIRCURVE_10.handle])
    ).toThrow(/SOMETHING_NEW/);
  });

  it("refuses a product missing a field it judges on", () => {
    const node = shopifyNode(AIRCURVE_10);
    delete node["totalInventory"];

    expect(() =>
      productsFromByHandleResponse(byHandleResponse([node]), [
        AIRCURVE_10.handle,
      ])
    ).toThrow(/totalInventory/);
  });
});

describe("reading a survey page", () => {
  it("returns the page's products and where the next one starts", () => {
    const body = surveyResponse([shopifyNode(NOVA)], {
      hasNextPage: true,
      endCursor: "cursor-abc",
    });

    expect(surveyPageFromResponse(body, DIVISIONS[1])).toEqual({
      products: [NOVA],
      hasNextPage: true,
      endCursor: "cursor-abc",
    });
  });

  it("accepts a null cursor on the last page", () => {
    const page = surveyPageFromResponse(
      surveyResponse([shopifyNode(NOVA)]),
      DIVISIONS[1]
    );

    expect(page.hasNextPage).toBe(false);
    expect(page.endCursor).toBeNull();
  });

  it("refuses a response with no nodes array", () => {
    expect(() =>
      surveyPageFromResponse(
        { data: { products: { pageInfo: { hasNextPage: false } } } },
        DIVISIONS[1]
      )
    ).toThrow(/nodes/);
  });

  it("refuses a cursor that is neither a string nor null", () => {
    expect(() =>
      surveyPageFromResponse(
        surveyResponse([], { hasNextPage: true, endCursor: 7 }),
        DIVISIONS[1]
      )
    ).toThrow(/endCursor/);
  });
});

describe("divisionFieldsOf", () => {
  it("maps a division tag to its Custom User Field", () => {
    expect(divisionFieldsOf([MACHINES_TAG, "Rx-Required"])).toEqual([
      "Machine",
    ]);
  });

  it("ignores the neighbouring divisions that are not ours", () => {
    expect(
      divisionFieldsOf([
        "Catalog-Merchant-Division-Machine-Parts",
        "Catalog-Merchant-Division-Mask-Parts",
      ])
    ).toEqual([]);
  });
});

describe("mergeProducts", () => {
  it("gives the transform each product once, sorted by handle", () => {
    const merged = mergeProducts([NOVA, AIRCURVE_10], [AIRCURVE_10]);

    expect(merged.map((product) => product.handle)).toEqual([
      AIRCURVE_10.handle,
      NOVA.handle,
    ]);
  });

  it("keeps the union of the divisions a product was found under", () => {
    const asMask: SurveyedProduct = {
      ...AIRCURVE_10,
      divisionFields: ["Mask"],
    };
    const [merged] = mergeProducts([AIRCURVE_10], [asMask]);

    expect(merged?.divisionFields).toEqual(["Machine", "Mask"]);
  });

  it("has nothing to merge when nothing was found", () => {
    expect(mergeProducts([], [])).toEqual([]);
  });
});

describe("the catalogue file", () => {
  it("writes a digest line, a header row and one row per Mapping", () => {
    const lines = resolvedProductsCsv(CATALOGUE).split("\n");

    expect(lines[0]).toMatch(/^# sha256 [0-9a-f]{64}$/);
    expect(lines[1]).toBe("user_field_name,value,handle,status,url");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("");
  });

  it("quotes a Mapping value containing a comma", () => {
    expect(resolvedProductsCsv(CATALOGUE)).toContain(
      '"DreamWear Full Face Mask (S, M, L)"'
    );
  });

  it("round-trips every Mapping unchanged", () => {
    expect(readResolvedProducts(resolvedProductsCsv(CATALOGUE))).toEqual(
      CATALOGUE
    );
  });

  it("is identical for identical input, and different for different input", () => {
    const first = resolvedProductsCsv(CATALOGUE);
    const changed = resolvedProductsCsv([
      CATALOGUE[0],
      { ...CATALOGUE[1], url: "https://www.cpap.com/products/something-else" },
    ]);

    expect(resolvedProductsCsv(CATALOGUE)).toBe(first);
    expect(declaredDigest(changed)).not.toBe(declaredDigest(first));
  });

  it("refuses a file with no digest line", () => {
    expect(() =>
      readResolvedProducts("user_field_name,value,handle,status,url\n")
    ).toThrow(/# sha256/);
  });

  it("refuses a file edited by hand after it was generated", () => {
    const tampered = resolvedProductsCsv(CATALOGUE).replace(
      "aircurve-10-vauto-bilevel-machine,ACTIVE",
      "aircurve-10-vauto-bilevel-machine,DRAFT"
    );

    expect(() => readResolvedProducts(tampered)).toThrow(
      /does not match its own digest/
    );
  });

  it("refuses a file whose columns are not the ones it writes", () => {
    const body = "value,url\nA,https://www.cpap.com/products/a\n";

    expect(() =>
      readResolvedProducts(`# sha256 ${digestOf(body)}\n${body}`)
    ).toThrow(/unexpected header row/);
  });

  it("refuses a row whose status is not a Shopify status", () => {
    const body =
      "user_field_name,value,handle,status,url\n" +
      "Machine,A,a,LIVE,https://www.cpap.com/products/a\n";

    expect(() =>
      readResolvedProducts(`# sha256 ${digestOf(body)}\n${body}`)
    ).toThrow(/LIVE/);
  });

  it("refuses a row with an empty field, which no Mapping may have", () => {
    const body =
      "user_field_name,value,handle,status,url\n" + "Machine,A,a,ACTIVE,\n";

    expect(() =>
      readResolvedProducts(`# sha256 ${digestOf(body)}\n${body}`)
    ).toThrow(/empty field/);
  });
});

describe("the collection-links file", () => {
  const LINKS: CollectionLink[] = [
    {
      userFieldName: "Machine",
      value: "DreamStation Auto CPAP Machine (Discontinued)",
      url: "https://www.cpap.com/collections/cpap-machines",
    },
    {
      userFieldName: "Mask",
      value: "DreamWear Full Face Mask (S, M, L) (Discontinued)",
      url: "https://www.cpap.com/collections/full-face-cpap-masks",
    },
  ];

  it("is a digest line, a header, and one row per Collection Link", () => {
    const lines = collectionLinksCsv(LINKS).split("\n");

    expect(lines[0]).toMatch(/^# sha256 [0-9a-f]{64}$/);
    expect(lines[1]).toBe("user_field_name,value,url");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("");
  });

  it("carries no handle and no status column", () => {
    // The two columns the catalogue has and this file does not are exactly the
    // two facts a collection has no answer for (ADR-0021).
    expect(COLLECTION_LINK_COLUMNS).toEqual([
      "user_field_name",
      "value",
      "url",
    ]);
    expect(collectionLinksCsv(LINKS)).not.toContain("ACTIVE");
  });

  it("round-trips every Collection Link unchanged", () => {
    expect(readCollectionLinks(collectionLinksCsv(LINKS))).toEqual(LINKS);
  });

  it("is a fixed point of the refresh that writes it", () => {
    // The closest a test can get to running `pnpm refresh:catalogue`, which
    // needs a Shopify token and so is never run here. The command's own
    // sequence is read the file, hand the rows to `buildCatalogue`, format the
    // third output, write it back — so the committed file has to come back out
    // byte for byte, digest included. A refresh that reordered the rows,
    // altered a value or recomputed a different digest would show up as a
    // spurious diff on the first real run, and this is what would catch it.
    //
    // The sheet rows are the real committed exports rather than this file's
    // fixtures, because the field order the sort uses comes from them.
    const sheetRows = SHEET_TABS.flatMap((tab) =>
      sheetRowsFrom(
        tab,
        readFileSync(join("data", exportFileName(tab)), "utf8")
      )
    );
    const committedText = readFileSync(COLLECTION_LINKS_FILE, "utf8");

    const { collectionLinks } = buildCatalogue({
      sheetRows,
      products: PRODUCTS as ProductRecord[],
      collectionLinks: readCollectionLinks(committedText),
    });

    expect(collectionLinksCsv(collectionLinks)).toBe(committedText);
  });

  it("reads the file this repository commits", () => {
    const committed = readCollectionLinks(
      readFileSync(COLLECTION_LINKS_FILE, "utf8")
    );

    expect(committed.length).toBeGreaterThan(0);

    for (const link of committed) {
      expect(link.value.endsWith(COLLECTION_LINK_SUFFIX)).toBe(true);
      expect(link.url.startsWith("https://www.cpap.com/collections/")).toBe(
        true
      );
    }
  });

  it("refuses a file with no digest line, naming this file rather than the catalogue", () => {
    expect(() => readCollectionLinks("user_field_name,value,url\n")).toThrow(
      new RegExp(COLLECTION_LINKS_FILE.replace(/[.]/g, "\\."))
    );
  });

  it("refuses a file edited by hand after it was generated", () => {
    const tampered = collectionLinksCsv(LINKS).replace(
      "cpap-machines",
      "bipap-machines"
    );

    expect(() => readCollectionLinks(tampered)).toThrow(
      /does not match its own digest/
    );
  });

  it("refuses a file whose columns are not the ones it writes", () => {
    const body = "user_field_name,value,handle,status,url\n";

    expect(() =>
      readCollectionLinks(`# sha256 ${digestOf(body)}\n${body}`)
    ).toThrow(/unexpected header row/);
  });

  it("refuses a row with an empty field", () => {
    const body = "user_field_name,value,url\nMachine,A (Discontinued),\n";

    expect(() =>
      readCollectionLinks(`# sha256 ${digestOf(body)}\n${body}`)
    ).toThrow(/empty field/);
  });

  it("refuses a url that is not an https cpap.com collection page", () => {
    // The only hand-entered URL in the pipeline, and the one with the widest
    // blast radius: Discourse refuses the whole `profile_link_fields` value
    // rather than the Mapping it dislikes (ADR-0016), so one typo here takes
    // every Profile Link down. `not a url at all` used to read clean and reach
    // settings.yml.
    const refused = [
      "not a url at all",
      "www.cpap.com/collections/cpap-machines",
      "http://www.cpap.com/collections/cpap-machines",
      "https://cpap.com/collections/cpap-machines",
      "https://www.sleeping.com/collections/cpap-machines",
      "https://www.cpap.com/products/resmed-airsense-11-autoset",
      "https://www.cpap.com/collections/",
    ];

    for (const url of refused) {
      const body = `user_field_name,value,url\nMachine,A (Discontinued),${url}\n`;

      expect(() =>
        readCollectionLinks(`# sha256 ${digestOf(body)}\n${body}`)
      ).toThrow(CatalogueRefreshError);
    }
  });

  it("accepts a collection url with a handle", () => {
    const url = "https://www.cpap.com/collections/bipap-machines";
    const body = `user_field_name,value,url\nMachine,A (Discontinued),${url}\n`;

    expect(readCollectionLinks(`# sha256 ${digestOf(body)}\n${body}`)).toEqual([
      { userFieldName: "Machine", value: "A (Discontinued)", url },
    ]);
  });

  it("refuses a value that does not end in the suffix, exactly", () => {
    // Three near misses, each of which resolves for nobody while looking right
    // in a diff: resolution is an exact trimmed string match against what the
    // User holds, so the leading space and the capital `D` are load-bearing.
    for (const value of [
      "DreamStation Auto CPAP Machine",
      "DreamStation Auto CPAP Machine (discontinued)",
      "DreamStation Auto CPAP Machine(Discontinued)",
    ]) {
      const body = `user_field_name,value,url\nMachine,"${value}",https://www.cpap.com/collections/cpap-machines\n`;

      expect(() =>
        readCollectionLinks(`# sha256 ${digestOf(body)}\n${body}`)
      ).toThrow(/does not end in " \(Discontinued\)"/);
    }
  });

  it("accepts the suffix and nothing more than the suffix", () => {
    const body = `user_field_name,value,url\nMachine,A (Discontinued),https://www.cpap.com/collections/cpap-machines\n`;

    expect(readCollectionLinks(`# sha256 ${digestOf(body)}\n${body}`)).toEqual([
      {
        userFieldName: "Machine",
        value: "A (Discontinued)",
        url: "https://www.cpap.com/collections/cpap-machines",
      },
    ]);
  });
});

describe("curatesTitles", () => {
  it("is true for both current tabs, which both have Suggested columns", () => {
    // No current SHEET_TABS entry has `titleColumn: null` — `user_humidifier`
    // was the one that did, until ADR-0022 retired it — so the `false` branch
    // of `tab.titleColumn !== null` has no real tab to exercise it against
    // right now. It stays rather than being deleted because a future tab
    // exporting for provenance only (see sheet-export.ts's `SheetTab.titleColumn`
    // doc comment) would be in exactly that state, and `readSheetTab` /
    // `sheetRowsFrom` are still tested against a synthetic tab shaped that way
    // in spec/unit/sheet-export.test.ts.
    expect(curatesTitles("Machine")).toBe(true);
    expect(curatesTitles("Mask")).toBe(true);
  });

  it("throws for a field SHEET_TABS has never heard of, rather than guessing", () => {
    // `DIVISIONS` is a separate, hand-written list from `SHEET_TABS`. A future
    // field added to one and not the other must not silently read as
    // "curates titles" just because `undefined !== null`.
    expect(() => curatesTitles("Humidifier")).toThrow(CatalogueRefreshError);
    expect(() => curatesTitles("Humidifier")).toThrow(/names no tab/);
  });
});

describe("the review document", () => {
  const built = buildCatalogue({
    sheetRows: SHEET_ROWS,
    products: PRODUCTS as ProductRecord[],
    collectionLinks: [],
  });
  const review = renderReviewDocument({
    catalogue: built.catalogue,
    exclusions: built.exclusions,
    sheetRows: SHEET_ROWS,
    products: PRODUCTS,
    digest: "0".repeat(64),
  });

  it("lists every Mapping with the URL that will ship", () => {
    expect(built.catalogue).toHaveLength(1);
    expect(review).toContain("## Machine — 1 Mappings");
    expect(review).toContain(
      "https://www.cpap.com/products/aircurve-10-vauto-bilevel-machine"
    );
  });

  it("names every exclusion reason, including the ones nothing fell under", () => {
    for (const reason of EXCLUSION_REASONS) {
      expect(review).toContain(`### \`${reason}\``);
    }

    expect(review).toContain("### `ambiguous-title-match` — 0");
    expect(review).toContain("None.");
  });

  it("reports each excluded Suggested Title with the reason Shopify gave", () => {
    expect(review).toContain(
      "| Machine | AirCurve 11 ASV | aircurve-11-asv | status ACTIVE; not published to the Online Store |"
    );
    expect(review).toContain("status ARCHIVED; tagged Discontinued");
  });

  it("says a field with no curated Mappings is a problem, not silence", () => {
    // Both Mask titles in the fixtures are excluded, so the field ends up with
    // no Mappings the same way a broken tab would, and that must not read like
    // the "no Suggested columns at all" case (ADR-0012), which no current tab
    // is in.
    expect(
      built.catalogue.some((entry) => entry.userFieldName === "Mask")
    ).toBe(false);
    expect(review).toContain("## Mask — no Mappings, and that is a problem");
  });

  it("reports the disagreement in both directions", () => {
    expect(review).toContain(
      "Suggested Titles the live catalogue will not back"
    );
    expect(review).toContain("Live products the spreadsheet never names — 1");
    expect(review).toContain("Nova Nasal CPAP Mask");
  });

  it("reports a product in stock that nobody published to the storefront", () => {
    expect(review).toContain(
      "## In stock but not published to the Online Store — 1"
    );
    expect(review).toContain(
      "| AirCurve 11 ASV | aircurve-11-asv | 7 | Machine |"
    );
  });

  it("counts what the sheet asked for beside what shipped", () => {
    // Three distinct Machine titles across four rows, one Mapping out of them.
    expect(review).toContain("| Machine | 3 | 1 | 2 | 2 | 0 |");

    // The Mask row is the one that pins down "live products in the division":
    // the fixtures hold an archived mask carrying the division tag, and counting
    // it would report three products on sale where there are two.
    expect(review).toContain("| Mask | 2 | 0 | 2 | 2 | 1 |");
  });

  it("is the same document twice, because there is no clock in it", () => {
    const again = renderReviewDocument({
      catalogue: built.catalogue,
      exclusions: built.exclusions,
      sheetRows: SHEET_ROWS,
      products: PRODUCTS,
      digest: "0".repeat(64),
    });

    expect(again).toBe(review);
    expect(review).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("turns a product archived upstream into a reviewable diff, not a silent change", () => {
    const archived: SurveyedProduct = { ...AIRCURVE_10, status: "ARCHIVED" };
    const after = buildCatalogue({
      sheetRows: SHEET_ROWS,
      products: [archived, ...PRODUCTS.slice(1)] as ProductRecord[],
      collectionLinks: [],
    });

    const before = resolvedProductsCsv(built.catalogue).split("\n");
    const now = resolvedProductsCsv(after.catalogue).split("\n");

    // The Mapping's row is gone and the digest line moved with it, so the file
    // says out loud that the catalogue changed.
    expect(
      before.filter((line) => line.includes(AIRCURVE_10.handle))
    ).toHaveLength(1);
    expect(
      now.filter((line) => line.includes(AIRCURVE_10.handle))
    ).toHaveLength(0);
    expect(now[0]).not.toBe(before[0]);

    expect(
      renderReviewDocument({
        catalogue: after.catalogue,
        exclusions: after.exclusions,
        sheetRows: SHEET_ROWS,
        products: [archived, ...PRODUCTS.slice(1)],
        digest: "0".repeat(64),
      })
    ).toContain(
      "| Machine | AirCurve 10 VAuto BiLevel Machine | aircurve-10-vauto-bilevel-machine | status ARCHIVED |"
    );
  });
});

describe("what each file is allowed to do", () => {
  // Read relative to the repository root, which is vitest's working directory.
  // `import.meta.url` would be the obvious way to resolve these and does not
  // typecheck here — the shared Discourse tsconfig builds to CommonJS output,
  // where the meta-property is not allowed.
  const lib = readFileSync("scripts/lib/catalogue-refresh.ts", "utf8");
  const command = readFileSync("scripts/refresh-catalogue.ts", "utf8");

  it("keeps the decisions away from the network and the filesystem", () => {
    // `node:crypto` is the one builtin the transform layer needs, because the
    // digest is part of what the catalogue file says rather than part of writing
    // it. Anything else here would be logic that no test could reach.
    const builtins = [...lib.matchAll(/from "(node:[^"]+)"/g)].map(
      (match) => match[1]
    );

    expect(builtins).toEqual(["node:crypto"]);
    expect(lib).not.toContain("fetch(");
    expect(lib).not.toContain("writeFile");
  });

  it("never lets the command name the credential it uses", () => {
    expect(command).not.toContain(`"${TOKEN_VAR}"`);
    expect(command).toContain("process.env[TOKEN_VAR]");
  });

  it("builds no query, no endpoint and no file format of its own", () => {
    for (const forbidden of [
      "productByIdentifier",
      "graphql.json",
      "admin/api",
      "sortKey",
      "sha256",
    ]) {
      expect(command).not.toContain(forbidden);
    }

    // Where the two files go is part of what the pipeline is, not part of
    // writing them: `build` and `apply` read the catalogue by the same constant.
    expect(command).not.toContain(CATALOGUE_FILE);
    expect(command).not.toContain(COLLECTION_LINKS_FILE);
    expect(command).not.toContain(REVIEW_FILE);
    expect(command).toContain("writeFile(CATALOGUE_FILE, csv)");
    expect(command).toContain("writeFile(COLLECTION_LINKS_FILE, linksCsv)");
    expect(command).toContain("writeFile(REVIEW_FILE, review)");
  });

  it("reads the Collection Links through the reader that verifies their digest", () => {
    // The file is hand-seeded and committed, so a refresh re-reads it through
    // the same guards that will check it back in rather than parsing the CSV
    // again — the suffix check included. The write loop itself is the one part
    // of this pipeline no test covers, so which reader and which writer the
    // command reaches for is asserted here.
    expect(command).toContain("readCollectionLinks(");
    expect(command).toContain("collectionLinksCsv(collectionLinks)");
    expect(command).toContain("collectionLinks: seededCollectionLinks");
  });
});
