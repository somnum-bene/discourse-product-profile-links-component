import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assignedCollectionUrl,
  buildCatalogue,
  COLLECTION_LINK_SUFFIX,
  collectionHandleFromUrl,
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
  collectionHandlesFrom,
  collectionLinksCsv,
  collectionsByHandleQuery,
  collectionsFromByHandleResponse,
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
  ASSIGNMENT_TABS,
  assignmentRowsFrom,
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
    legacyValue: "4872",
    legacyText: "AirCurve 10 VAuto with HumidAir",
    suggestedTitle: "AirCurve 10 VAuto BiLevel Machine",
    suggestedUrl:
      "https://www.sleeping.com/products/aircurve-10-vauto-bilevel-machine",
  },
  {
    // The same product again under a second legacy value. The sheet is a
    // migration map, so this is the common case rather than the odd one.
    userFieldName: "Machine",
    legacyValue: "6092",
    legacyText: "AirCurve 10 Vauto USA C2C CO",
    suggestedTitle: "AirCurve 10 VAuto BiLevel Machine",
    suggestedUrl:
      "https://www.sleeping.com/products/aircurve-10-vauto-bilevel-machine",
  },
  {
    userFieldName: "Machine",
    legacyValue: "6240",
    legacyText: "Aircurve 11 asv",
    suggestedTitle: "AirCurve 11 ASV",
    suggestedUrl: "https://www.sleeping.com/products/aircurve-11-asv",
  },
  {
    // A real row, and the reason handles cannot simply be assumed: its
    // Suggested URL is a search results page, not a product.
    userFieldName: "Machine",
    legacyValue: "5213",
    legacyText: "ResMed AirCurve 10 ASV",
    suggestedTitle: "ResMed AirCurve 10 ASV BiLevel Machine",
    suggestedUrl:
      "https://www.sleeping.com/search?q=resmed+aircurve&_pos=4&_psq=resmed+air&_ss=e&_v=1.0",
  },
  {
    userFieldName: "Mask",
    legacyValue: "3301",
    legacyText: "Amara Full Face Mask",
    suggestedTitle: "Amara Full Face CPAP Mask",
    suggestedUrl:
      "https://www.sleeping.com/products/amara-full-face-cpap-mask-with-headgear",
  },
  {
    userFieldName: "Mask",
    legacyValue: "3002",
    legacyText: "Morf Nasal Mask",
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
          legacyValue: "9999",
          legacyText: "Something legacy",
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

  it("asks for each collection under its own alias, and only for its handle", () => {
    const query = collectionsByHandleQuery(["bipap-machines", "apap-machines"]);

    expect(query).toContain(
      'c0: collectionByIdentifier(identifier: { handle: "bipap-machines" })'
    );
    expect(query).toContain(
      'c1: collectionByIdentifier(identifier: { handle: "apap-machines" })'
    );
    // Existence, and deliberately not reachability: whether the public page
    // serves is Catalogue Verify's question (ADR-0017), and asking for
    // anything more here would invite this command to answer it badly.
    expect(query).not.toContain("onlineStoreUrl");
    expect(query).not.toContain("products");
  });

  it("refuses to send a collection query with nothing to ask about", () => {
    // A GraphQL document with no selections is a syntax error, so an empty
    // batch would spend a request to be told so.
    expect(() => collectionsByHandleQuery([])).toThrow(CatalogueRefreshError);
    expect(() => collectionsByHandleQuery([])).toThrow(/collection query/);
  });
});

describe("reading a collection response", () => {
  /** A collection response as Shopify sends it, aliases and all. */
  function collectionResponse(
    nodes: readonly (Record<string, unknown> | null)[]
  ): unknown {
    const data: Record<string, unknown> = {};

    for (const [index, node] of nodes.entries()) {
      data[`c${index}`] = node;
    }

    return { data };
  }

  it("admits the collections Shopify holds and drops the ones it does not", () => {
    const admitted = collectionsFromByHandleResponse(
      collectionResponse([
        { handle: "bipap-machines" },
        null,
        { handle: "nasal-cpap-masks" },
      ]),
      ["bipap-machines", "machines-that-never-were", "nasal-cpap-masks"]
    );

    expect(admitted).toEqual(["bipap-machines", "nasal-cpap-masks"]);
  });

  it("reads the handle back out of the answer rather than echoing the request", () => {
    // An answer naming a different collection than the one asked for must not
    // be admitted under the asked-for name, or a curated URL would be verified
    // by a collection that is not the one it points at.
    expect(
      collectionsFromByHandleResponse(
        collectionResponse([{ handle: "something-else" }]),
        ["bipap-machines"]
      )
    ).toEqual(["something-else"]);
  });

  it("stops when an alias the query asked for is missing entirely", () => {
    expect(() =>
      collectionsFromByHandleResponse(collectionResponse([]), [
        "bipap-machines",
      ])
    ).toThrow(/has no "c0" for handle "bipap-machines"/);
  });

  it("names the handle it was actually asking about when a node is malformed", () => {
    // The misses are dropped on the way through, so the surviving nodes no
    // longer line up with the batch by position. A reader that recovered the
    // handle by index would name the wrong collection here — and only ever
    // after a miss, which is the one moment the message has to be right.
    expect(() =>
      collectionsFromByHandleResponse(
        collectionResponse([null, { handle: 7 }]),
        ["gone-collection", "bipap-machines"]
      )
    ).toThrow(/c1 \("bipap-machines"\) came back without a string "handle"/);
  });

  it("has nothing to admit when the batch came back entirely empty", () => {
    expect(
      collectionsFromByHandleResponse(collectionResponse([null]), ["gone"])
    ).toEqual([]);
  });
});

describe("collectionHandlesFrom", () => {
  it("asks about exactly the collections the derivation will look for", () => {
    const assignments = ASSIGNMENT_TABS.flatMap((tab) =>
      assignmentRowsFrom(
        tab,
        readFileSync(join("data", exportFileName(tab)), "utf8")
      )
    );

    const handles = collectionHandlesFrom(assignments);

    expect(handles.length).toBeGreaterThan(0);
    expect(handles).toEqual([...handles].sort());
    expect(new Set(handles).size).toBe(handles.length);

    // Every handle the derivation will check admission against is one this
    // asked Shopify about. A command that worked the handles out some other way
    // could admit a collection the transform never consults, or miss one it
    // does.
    for (const assignment of assignments) {
      if (assignment.disposition !== "collection") {
        continue;
      }

      expect(handles).toContain(
        collectionHandleFromUrl(assignedCollectionUrl(assignment))
      );
    }
  });

  it("skips the dispositions that produce no link", () => {
    // The `resolves-to-product` rows carry prose in the URL column rather than
    // a URL, which is the shape of thing this quietly skips — and asking about
    // a collection nothing will link to would spend a request on an answer
    // nothing reads.
    const assignments = ASSIGNMENT_TABS.flatMap((tab) =>
      assignmentRowsFrom(
        tab,
        readFileSync(join("data", exportFileName(tab)), "utf8")
      )
    );
    const undisposed = assignments.filter(
      (row) => row.disposition !== "collection"
    );

    expect(undisposed.length).toBeGreaterThan(0);
    expect(collectionHandlesFrom(undisposed)).toEqual([]);
  });
});

describe("collectionHandleFromUrl", () => {
  it("names the handle a curated collection URL identifies", () => {
    expect(
      collectionHandleFromUrl("https://www.cpap.com/collections/bipap-machines")
    ).toBe("bipap-machines");
  });

  it("ignores a query string and a fragment", () => {
    expect(
      collectionHandleFromUrl(
        "https://www.cpap.com/collections/apap-machines?page=2#top"
      )
    ).toBe("apap-machines");
  });

  it("returns nothing for a cell that names no collection", () => {
    // The `resolves-to-product` rows hold exactly this, and an empty answer is
    // what turns into an `unadmitted-collection` fault rather than a request.
    expect(collectionHandleFromUrl("n/a — same as existing value 5232")).toBe(
      ""
    );
    expect(collectionHandleFromUrl("")).toBe("");
  });

  it("does not mistake a product URL for a collection", () => {
    // A Collection Link pointing at a product page is a Resolved Product in the
    // wrong file (ADR-0021), and this is the half of that guard that runs
    // before Shopify is asked anything.
    expect(
      collectionHandleFromUrl("https://www.cpap.com/products/aircurve-11-asv")
    ).toBe("");
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
    expect(declaredDigest(changed, CATALOGUE_FILE)).not.toBe(
      declaredDigest(first, CATALOGUE_FILE)
    );
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

  it("refuses a row that is not as wide as the header says", () => {
    // The same guard as the Collection Links reader gets, from the same
    // helper. Both files are digested CSV read by the same three commands, and
    // an extra column on a row is not a smaller fault in one than the other.
    const body =
      "user_field_name,value,handle,status,url\n" +
      "Machine,A,a,ACTIVE,https://www.cpap.com/products/a,JUNK\n";

    expect(() =>
      readResolvedProducts(`# sha256 ${digestOf(body)}\n${body}`)
    ).toThrow(/6 fields where the header declares 5/);
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

  it("is what a refresh derives from the committed exports", () => {
    // The closest a test can get to running `pnpm refresh:catalogue`, which
    // needs a Shopify token and so is never run here. No row of this file is
    // hand-authored any more: a refresh derives every one from the committed
    // option tables and the committed Collection Assignment, so the file has to
    // come back out byte for byte, digest included. A derivation that reordered
    // the rows, altered a value or recomputed a different digest would show up
    // as a spurious diff on the next real run, and this is what catches it.
    //
    // Two substitutions stand in for the two things only a live run knows.
    //
    // The products are rebuilt from the committed Resolved Product Catalogue,
    // which is the record of what the last real run found Shopify holding.
    // That is what makes the same titles resolve here as resolved there, and
    // therefore the same ones fall through to a Collection Link.
    //
    // `admittedCollections` is every handle the table names, which is what the
    // 2026-09-04 verification of all nine found. Admission is asked of Shopify
    // on a real run; here it is granted, so that this test measures derivation
    // and the admission check is measured on its own.
    const sheetRows = SHEET_TABS.flatMap((tab) =>
      sheetRowsFrom(
        tab,
        readFileSync(join("data", exportFileName(tab)), "utf8")
      )
    );
    const assignments = ASSIGNMENT_TABS.flatMap((tab) =>
      assignmentRowsFrom(
        tab,
        readFileSync(join("data", exportFileName(tab)), "utf8")
      )
    );
    const committedText = readFileSync(COLLECTION_LINKS_FILE, "utf8");
    const products: ProductRecord[] = readResolvedProducts(
      readFileSync(CATALOGUE_FILE, "utf8")
    ).map((entry) => ({
      handle: entry.handle,
      title: entry.value,
      status: entry.status,
      tags: [],
      onlineStoreUrl: entry.url,
    }));

    const { collectionLinks, collectionFaults } = buildCatalogue({
      sheetRows,
      products,
      assignments,
      admittedCollections: collectionHandlesFrom(assignments),
    });

    // Nothing was blocked by a collection Shopify would not admit, by a
    // disagreement with the curated value, or by an undecided row. Those are
    // the faults that would mean the committed file is missing a row it should
    // hold, and none of them survives a correct derivation.
    //
    // `unassigned-legacy-value` is deliberately not asserted away. Five of them
    // are real as of the 2026-09-04 refresh: three products retired at Shopify
    // after the curation pass, so five legacy values now earn a Collection Link
    // that nobody has assigned one to yet. That is the standing mechanism
    // working — a product that retires in six months does exactly this — and it
    // is reported in the review document rather than fixed here.
    expect(
      collectionFaults.filter(
        (fault) => fault.problem !== "unassigned-legacy-value"
      )
    ).toEqual([]);
    expect(collectionLinks.length).toBeGreaterThan(50);
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

  it("refuses a row that is not as wide as the header says", () => {
    // The header check cannot see this: it is the same fault one line further
    // down. An extra field used to be discarded without a word, so a row with
    // a stray trailing column read clean and shipped.
    const wide =
      "user_field_name,value,url\n" +
      "Machine,A (Discontinued),https://www.cpap.com/collections/cpap-machines,JUNK\n";
    const narrow = "user_field_name,value,url\nMachine,A (Discontinued)\n";

    expect(() =>
      readCollectionLinks(`# sha256 ${digestOf(wide)}\n${wide}`)
    ).toThrow(/4 fields where the header declares 3/);
    expect(() =>
      readCollectionLinks(`# sha256 ${digestOf(narrow)}\n${narrow}`)
    ).toThrow(/2 fields where the header declares 3/);
  });

  it("refuses two rows carrying the same value for one field", () => {
    // Both rows shipped, and the component then reported `duplicate-value` on
    // every page load and resolved whichever came first — so row order decided
    // which URL a member got, which is not a decision anyone made.
    const body =
      "user_field_name,value,url\n" +
      "Machine,A (Discontinued),https://www.cpap.com/collections/cpap-machines\n" +
      "Machine,A (Discontinued),https://www.cpap.com/collections/bipap-machines\n";

    expect(() =>
      readCollectionLinks(`# sha256 ${digestOf(body)}\n${body}`)
    ).toThrow(/repeats the value/);
  });

  it("allows the same value under two different fields", () => {
    // A Mapping is keyed within a field, not globally: Machine and Mask are
    // separate namespaces and a value living in both is not a collision.
    const body =
      "user_field_name,value,url\n" +
      "Machine,A (Discontinued),https://www.cpap.com/collections/cpap-machines\n" +
      "Mask,A (Discontinued),https://www.cpap.com/collections/nasal-cpap-masks\n";

    expect(
      readCollectionLinks(`# sha256 ${digestOf(body)}\n${body}`)
    ).toHaveLength(2);
  });

  it("refuses a value that is the suffix and nothing else", () => {
    // It passed the non-empty check and the suffix check, round-tripped
    // through `csvLine`, and shipped a Profile Link whose anchor text was
    // `(Discontinued)`. ADR-0020 reverses ADR-0012 on the strength of the
    // value naming the equipment, so a value that names none is the one thing
    // the suffix rule cannot be allowed to admit.
    for (const value of [" (Discontinued)", "(Discontinued)"]) {
      const body = `user_field_name,value,url\nMachine,"${value}",https://www.cpap.com/collections/cpap-machines\n`;

      expect(() =>
        readCollectionLinks(`# sha256 ${digestOf(body)}\n${body}`)
      ).toThrow(CatalogueRefreshError);
    }
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
    assignments: [],
    admittedCollections: [],
  });
  const review = renderReviewDocument({
    catalogue: built.catalogue,
    exclusions: built.exclusions,
    collectionLinks: built.collectionLinks,
    collectionFaults: built.collectionFaults,
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

  it("lists every Collection Link that will ship", () => {
    // The document is what a human approves, and it said "every Mapping" while
    // showing only the Resolved Products. Three of the 58 shipped Mappings
    // were absent from it, which is worse than never mentioning them: an
    // approver told they are seeing everything has no reason to look further.
    const withLinks = renderReviewDocument({
      catalogue: built.catalogue,
      exclusions: built.exclusions,
      collectionLinks: [
        {
          userFieldName: "Machine",
          value: "DreamStation Auto CPAP Machine (Discontinued)",
          url: "https://www.cpap.com/collections/cpap-machines",
        },
      ],
      collectionFaults: [],
      sheetRows: SHEET_ROWS,
      products: PRODUCTS,
      digest: "0".repeat(64),
    });

    expect(withLinks).toContain("## Collection Links — 1");
    expect(withLinks).toContain(
      "DreamStation Auto CPAP Machine (Discontinued)"
    );
    expect(withLinks).toContain(
      "https://www.cpap.com/collections/cpap-machines"
    );
    // The count line has to add up to what ships, not to one of the two files.
    expect(withLinks).toContain(
      `- Mappings: ${built.catalogue.length + 1} ` +
        `(${built.catalogue.length} Resolved Products, 1 Collection Links)`
    );
  });

  it("says so plainly when there are no Collection Links", () => {
    // `None.` rather than an absent section: "we looked and there were none"
    // and "nobody asked" are different facts, and only one of them is fine.
    expect(review).toContain("## Collection Links — 0");
    expect(review).toContain("None.");
  });

  it("is the same document twice, because there is no clock in it", () => {
    const again = renderReviewDocument({
      catalogue: built.catalogue,
      exclusions: built.exclusions,
      collectionLinks: built.collectionLinks,
      collectionFaults: built.collectionFaults,
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
      assignments: [],
      admittedCollections: [],
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
        collectionLinks: after.collectionLinks,
        collectionFaults: after.collectionFaults,
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

  it("derives the Collection Links rather than reading them back in", () => {
    // The file used to be hand-seeded, and the refresh read it through
    // `readCollectionLinks` and handed the rows straight back out. Nothing is
    // seeded now: the command reads the Collection Assignment instead and the
    // transform derives every row. Reading the output file as an input again
    // would make a stale row survive a refresh that no longer derives it, which
    // is the whole failure this ticket removed.
    expect(command).not.toContain("readCollectionLinks");
    expect(command).toContain("assignmentRowsFrom(tab, csvText)");
    expect(command).toContain("collectionLinksCsv(collectionLinks)");
  });
});
