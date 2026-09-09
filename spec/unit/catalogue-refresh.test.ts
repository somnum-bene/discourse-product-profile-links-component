import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assignedCollectionUrl,
  buildCatalogue,
  COLLECTION_LINK_SUFFIX,
  collectionHandleFromUrl,
  type CollectionLink,
  type DispositionRow,
  type ProductRecord,
  type ResolvedProduct,
  type SheetRow,
  undeliveredValues,
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
  DISPOSITION_COLUMNS,
  DISPOSITION_FILE,
  dispositionTableCsv,
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
  readDispositionTable,
  readResolvedProducts,
  renderReviewDocument,
  resolvedProductsCsv,
  REVIEW_FILE,
  SHOPIFY_API_VERSION,
  shopifyEndpoint,
  type SurveyedProduct,
  surveyPageFromResponse,
  TOKEN_VAR,
  undecidedAssignments,
} from "../../scripts/lib/catalogue-refresh";
import {
  ASSIGNMENT_TABS,
  type AssignmentRow,
  assignmentRowsFrom,
  EMAIL_SHAPED,
  exportFileName,
  SHEET_TABS,
  sheetRowsFrom,
} from "../../scripts/lib/sheet-export";

/** An assignment row with the columns this suite ignores left empty. */
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
    for (const row of assignments) {
      if (row.disposition !== "collection") {
        continue;
      }

      expect(handles).toContain(
        collectionHandleFromUrl(assignedCollectionUrl(row))
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

describe("undecidedAssignments", () => {
  it("flags only the rows still undecided", () => {
    // All four words the schema allows, one row each, so a decided disposition
    // slipping through would be caught here rather than by an accident of
    // which fixture happened to be missing.
    const undecided = assignment({
      legacyPnums: "6240",
      disposition: "undecided",
    });

    const rows = [
      assignment({ legacyPnums: "3002", disposition: "collection" }),
      assignment({ legacyPnums: "3003", disposition: "plain-text" }),
      assignment({ legacyPnums: "3004", disposition: "resolves-to-product" }),
      undecided,
    ];

    expect(undecidedAssignments(rows)).toEqual([undecided]);
  });

  it("does not treat resolves-to-product as undecided", () => {
    // The gap #38 exists to close: a row that was never a Collection Link
    // candidate at all is still a curator's decision, and a check that
    // conflated the two would block a release on rows already correctly
    // curated.
    const rows = [
      assignment({ legacyPnums: "6377", disposition: "resolves-to-product" }),
      assignment({ legacyPnums: "6378", disposition: "resolves-to-product" }),
    ];

    expect(undecidedAssignments(rows)).toEqual([]);
  });

  it("passes an empty table, which does not by itself prove the check works", () => {
    // Pinned separately from the two tests above on purpose. "No undecided
    // rows" and "no rows at all" both return `[]` here, and a suite that only
    // asserted the empty case would pass just as well against a function that
    // never detected anything.
    expect(undecidedAssignments([])).toEqual([]);
  });

  it("refuses a Disposition it was not taught, rather than silently treating it as decided", () => {
    // `DISPOSITIONS` is the only thing standing between "unrecognised" and
    // "this compiles", so this reaches the guard the same way an actual fifth
    // value would: past the type system, the way `assignmentRowsFrom`'s own
    // `as AssignmentRow[]` cast lets an unvalidated Disposition through in
    // the first place.
    const rows = [
      assignment({ disposition: "not-a-real-disposition" as never }),
    ];

    expect(() => undecidedAssignments(rows)).toThrow(
      /Unrecognised Disposition/
    );
  });

  it("the committed Collection Assignment has none, today", () => {
    const assignments = ASSIGNMENT_TABS.flatMap((tab) =>
      assignmentRowsFrom(
        tab,
        readFileSync(join("data", exportFileName(tab)), "utf8")
      )
    );

    expect(assignments.length).toBeGreaterThan(0);
    expect(undecidedAssignments(assignments)).toEqual([]);
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

  it("returns nothing for a path carrying more than the handle", () => {
    // The handle a looser parser reads here is `bipap-machines`, which Shopify
    // admits — so the admission check would pass while the URL that ships is a
    // page that does not exist. Refusing the shape is what keeps the string
    // Shopify is asked about and the string a member clicks the same one.
    expect(
      collectionHandleFromUrl(
        "https://www.cpap.com/collections/bipap-machines/typo"
      )
    ).toBe("");
    expect(
      collectionHandleFromUrl(
        "https://www.cpap.com/collections/bipap-machines/"
      )
    ).toBe("");
    expect(collectionHandleFromUrl("https://www.cpap.com/collections/")).toBe(
      ""
    );
    expect(
      collectionHandleFromUrl("https://www.cpap.com/products/airsense-11")
    ).toBe("");
  });

  it("returns nothing for a collection at another origin", () => {
    // `bipap-machines` exists at cpap.com, so a parser reading the handle out
    // of any origin would admit somebody else's store on the strength of it.
    expect(
      collectionHandleFromUrl("https://example.com/collections/bipap-machines")
    ).toBe("");
    expect(
      collectionHandleFromUrl(
        "https://cpap.com.evil.test/collections/bipap-machines"
      )
    ).toBe("");
    expect(
      collectionHandleFromUrl("http://www.cpap.com/collections/bipap-machines")
    ).toBe("");
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
    ).toThrow(/line 2 should be the header row/);
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
    ).toThrow(/row 2, column 5 is empty — it names no url/);
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
    // last refresh found Shopify admitting — all of them. The count is left
    // uncounted here on purpose: it is one curated row away from changing, and
    // a number in a comment is a number that goes stale silently. Admission is
    // asked of Shopify on a real run; here it is granted, so that this test
    // measures derivation and the admission check is measured on its own.
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
    // `unassigned-legacy-value` is deliberately not asserted away, and this
    // test declines to say how many of them there are. It is the one fault the
    // committed data can grow on its own: a product retiring at Shopify after
    // the curation pass turns its legacy values into links nobody has assigned
    // yet. That is the standing mechanism working, reported in the review
    // document rather than fixed here — so asserting a count would make an
    // ordinary catalogue movement fail this file, and asserting the count that
    // happened to hold on the day it was written would go stale in silence.
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
    ).toThrow(/line 2 should be the header row/);
  });

  it("refuses a row with an empty field", () => {
    const body = "user_field_name,value,url\nMachine,A (Discontinued),\n";

    expect(() =>
      readCollectionLinks(`# sha256 ${digestOf(body)}\n${body}`)
    ).toThrow(/row 2, column 3 is empty — it names no url/);
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

describe("the disposition table file", () => {
  const CPAP_MACHINES = "https://www.cpap.com/collections/cpap-machines";
  const ROWS: DispositionRow[] = [
    {
      userFieldName: "Machine",
      legacyValue: "4872",
      legacyText: "AirCurve 10 VAuto BiLevel Machine with HumidAir",
      value: "AirCurve 10 VAuto BiLevel Machine",
      url: "https://www.cpap.com/products/aircurve-10-vauto-bilevel-machine",
      disposition: "resolves-to-product",
    },
    {
      userFieldName: "Machine",
      legacyValue: "5851",
      legacyText: "DreamStation Auto CPAP Machine",
      value: "DreamStation Auto CPAP Machine (Discontinued)",
      url: CPAP_MACHINES,
      disposition: "collection",
    },
    {
      userFieldName: "Mask",
      legacyValue: "3005",
      legacyText: "Unlisted mask",
      value: "Unlisted mask",
      url: "",
      disposition: "blank-title",
    },
  ];

  /** A file body as the reader wants it, digest and all. */
  function digested(body: string): string {
    return `# sha256 ${digestOf(body)}\n${body}`;
  }

  const HEADER =
    "user_field_name,legacy_value,legacy_text,value,url,disposition";

  it("is a digest line, a header, and one row per legacy value", () => {
    const lines = dispositionTableCsv(ROWS).split("\n");

    expect(lines[0]).toMatch(/^# sha256 [0-9a-f]{64}$/);
    expect(lines[1]).toBe(HEADER);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe("");
  });

  it("carries the user field name as well as the five columns asked for", () => {
    // The legacy identifier is only unique within a field, and the non-public
    // side has to emit the custom field name as one of its three columns. A
    // table without it would make the join guess at both.
    expect(DISPOSITION_COLUMNS).toEqual([
      "user_field_name",
      "legacy_value",
      "legacy_text",
      "value",
      "url",
      "disposition",
    ]);
  });

  it("round-trips every row unchanged, empty URL included", () => {
    expect(readDispositionTable(dispositionTableCsv(ROWS))).toEqual(ROWS);
  });

  it("refuses a row that names no value", () => {
    // An empty value is the one field this file cannot carry. The whole point
    // of a row with no URL is that it still tells the non-public side what to
    // write, so a blank there is a member's equipment quietly deleted.
    const body = `${HEADER}\nMask,3005,Unlisted mask,,,blank-title\n`;

    expect(() => readDispositionTable(digested(body))).toThrow(
      /names no value/
    );
  });

  it("refuses a disposition this repository has no word for", () => {
    const body = `${HEADER}\nMask,3005,Unlisted mask,Unlisted mask,,retired\n`;

    expect(() => readDispositionTable(digested(body))).toThrow(
      /column 6 \(`disposition`\) is not one of/
    );
  });

  it("refuses a linked disposition with no URL", () => {
    const body = `${HEADER}\nMachine,6240,Aircurve 11 asv,AirCurve 11 ASV (Discontinued),,collection\n`;

    expect(() => readDispositionTable(digested(body))).toThrow(
      /`collection` and carries no URL/
    );
  });

  it("refuses an unlinked disposition carrying a URL", () => {
    // The pairing runs both ways. A `plain-text` row with a URL is a curator's
    // decision being overruled by a link nobody assigned.
    const body = `${HEADER}\nMachine,6240,Aircurve 11 asv,Aircurve 11 asv,${CPAP_MACHINES},plain-text\n`;

    expect(() => readDispositionTable(digested(body))).toThrow(
      /`plain-text` and its column 5 \(`url`\) is not empty/
    );
  });

  it("refuses an unlinked row whose value is not the legacy text", () => {
    // Where the suffix would land if anyone appended it. A value that is not
    // the member's own text, with no Mapping behind it, is a string invented
    // for a member to hold that resolves for nobody.
    const body = `${HEADER}\nMachine,6240,Aircurve 11 asv,Aircurve 11 asv (Discontinued),,plain-text\n`;

    expect(() => readDispositionTable(digested(body))).toThrow(
      /carries no URL, so its column 4 \(`value`\) has to hold what/
    );
  });

  it("refuses a file edited by hand after it was generated", () => {
    const tampered = dispositionTableCsv(ROWS).replace("5851", "5852");

    expect(() => readDispositionTable(tampered)).toThrow(
      /does not match its own digest/
    );
  });

  it("refuses to write a table with no rows at all", () => {
    // The vacuous pass, refused at the boundary rather than only floored in a
    // test. Every legacy option value earns a row, so none means the Sheet
    // Exports arrived empty — and `MAX_DATA_ROWS` cannot notice that, because
    // it only has a ceiling. An empty table is not a small version of this
    // file: it is a claim that no member holds any equipment, and it would be
    // valid, digested and correctly shaped.
    expect(() => dispositionTableCsv([])).toThrow(CatalogueRefreshError);
    expect(() => dispositionTableCsv([])).toThrow(
      /no member holds any equipment/
    );
  });

  it("refuses to read a table with no rows either", () => {
    // Same rule on the way back in. A header-only file is a valid, digested,
    // correctly-shaped artifact, so nothing else about it would complain.
    const body = `${HEADER}\n`;

    expect(() => readDispositionTable(digested(body))).toThrow(
      /no member holds any equipment/
    );
  });

  it("refuses to write a row that names no value", () => {
    // The writer and the reader have to agree, and this is where they used to
    // not: a legacy row with an empty `Text` and no Suggested Title derives a
    // blank value, which this would happily write and `readDispositionTable`
    // would then refuse. A file that passes every gate that produced it and
    // fails the one that consumes it is the worse of the two failures.
    const nameless: DispositionRow[] = [
      {
        userFieldName: "Mask",
        legacyValue: "5854",
        legacyText: "",
        value: "",
        url: "",
        disposition: "blank-title",
      },
    ];

    expect(() => dispositionTableCsv(nameless)).toThrow(
      /row 2, column 3 \(`legacy_text`\) holds only whitespace/
    );
  });

  it("refuses to write a row whose value is only whitespace", () => {
    // What the removed `.trim()` used to give for free. Nothing upstream trims
    // the display text any more — it is carried verbatim on purpose — so
    // `"   "` arrives as three real characters instead of collapsing to `""`,
    // and it is worse than an empty value: it looks populated in every diff
    // and every reader while naming nothing.
    const whitespace: DispositionRow[] = [
      {
        userFieldName: "Mask",
        legacyValue: "3006",
        legacyText: "   ",
        value: "   ",
        url: "",
        disposition: "blank-title",
      },
    ];

    expect(() => dispositionTableCsv(whitespace)).toThrow(
      /row 2, column 3 \(`legacy_text`\) holds only whitespace/
    );
  });

  it("round-trips a value whose padding is real, rather than tidying it", () => {
    // The other side of the same rule: whitespace *around* a name is preserved
    // end to end, because the far side cannot un-trim what we trimmed.
    const padded: DispositionRow[] = [
      {
        userFieldName: "Mask",
        legacyValue: "3006",
        legacyText: "  Unlisted mask  ",
        value: "  Unlisted mask  ",
        url: "",
        disposition: "blank-title",
      },
    ];

    expect(readDispositionTable(dispositionTableCsv(padded))).toEqual(padded);
  });

  it("refuses to read a row whose value is only whitespace", () => {
    // `dataRowsOf` cannot see this one — it refuses an absent field, and this
    // field is present. Writer and reader share the check, so they share the
    // wording too.
    const body = `${HEADER}\nMask,3006,"   ","   ",,blank-title\n`;

    expect(() => readDispositionTable(digested(body))).toThrow(
      /row 2, column 3 \(`legacy_text`\) holds only whitespace/
    );
  });

  /**
   * The writer is held to every rule the reader is, because the command calls
   * it before any write precisely so a refusal costs nothing — and that only
   * holds if the refusal is complete. `DispositionRow` cannot encode the
   * value/URL correlation in its type, so nothing but a check enforces it, and
   * a check on one side only is a gate reporting success on the way out and
   * failure on the way in, with a committed file in between.
   */
  describe("the pairing rules, enforced on the way out as well as in", () => {
    /** One row, overridden into whichever violation is under test. */
    function rowWith(overrides: Partial<DispositionRow>): DispositionRow[] {
      return [
        {
          userFieldName: "Machine",
          legacyValue: "6240",
          legacyText: "Aircurve 11 asv",
          value: "AirCurve 11 ASV (Discontinued)",
          url: CPAP_MACHINES,
          disposition: "collection",
          ...overrides,
        },
      ];
    }

    it("refuses to write a linked disposition with no URL", () => {
      expect(() => dispositionTableCsv(rowWith({ url: "" }))).toThrow(
        /`collection` and carries no URL/
      );
    });

    it("refuses to write an unlinked disposition carrying a URL", () => {
      expect(() =>
        dispositionTableCsv(
          rowWith({ disposition: "plain-text", value: "Aircurve 11 asv" })
        )
      ).toThrow(/`plain-text` and its column 5 \(`url`\) is not empty/);
    });

    it("refuses to write an unlinked value that is not the legacy text", () => {
      // Where an appended suffix would land. The reader caught this and the
      // writer did not, so a regression could have committed it.
      expect(() =>
        dispositionTableCsv(
          rowWith({
            disposition: "plain-text",
            value: "Aircurve 11 asv (Discontinued)",
            url: "",
          })
        )
      ).toThrow(/its column 4 \(`value`\) has to hold what/);
    });

    it("refuses to write a disposition this repository has no word for", () => {
      expect(() =>
        dispositionTableCsv(
          rowWith({ disposition: "retired" as DispositionRow["disposition"] })
        )
      ).toThrow(/column 6 \(`disposition`\) is not one of/);
    });

    it("refuses a URL that is only whitespace", () => {
      // The gap between the two checks either side of it: `dataRowsOf` lets
      // `url` be blank, the whitespace check skips `url` for that reason, and
      // `"   " !== ""` — so a resolving disposition pointing nowhere sailed
      // through both. `""` is the sentinel every consumer reads as "no link",
      // so the column gets no third state.
      expect(() => dispositionTableCsv(rowWith({ url: "   " }))).toThrow(
        /carries whitespace/
      );
    });

    it("refuses a URL padded around a real one", () => {
      expect(() =>
        dispositionTableCsv(rowWith({ url: ` ${CPAP_MACHINES} ` }))
      ).toThrow(/carries whitespace/);
    });

    it("refuses an unlinked value the runtime would resolve anyway", () => {
      // The consequence of carrying the legacy text verbatim, which is right
      // for its own reasons (ADR-0023). Resolution is a trimmed match on both
      // sides, so a padded legacy text resolves the Mapping its trimmed form
      // names — the member gets a link while the row says they get none.
      //
      // Refused rather than reconciled: whether the row wanted
      // `resolves-to-product` or the padding was an accident is a curator's
      // answer, and this is the artifact where a silent guess reaches a member.
      const collision: DispositionRow[] = [
        {
          userFieldName: "Machine",
          legacyValue: "4801",
          legacyText: "AirSense 11 AutoSet",
          value: "AirSense 11 AutoSet",
          url: "https://www.cpap.com/products/resmed-airsense-11-autoset",
          disposition: "resolves-to-product",
        },
        {
          userFieldName: "Machine",
          legacyValue: "9001",
          legacyText: "  AirSense 11 AutoSet  ",
          value: "  AirSense 11 AutoSet  ",
          url: "",
          disposition: "plain-text",
        },
      ];

      expect(() => dispositionTableCsv(collision)).toThrow(
        /trims to the same string as that of row 2/
      );
    });

    it("allows an unlinked value that only looks similar", () => {
      // The check is a trimmed equality, not a fuzzy one. A different name is
      // a different value, and refusing those would make the guard unusable.
      const near: DispositionRow[] = [
        {
          userFieldName: "Machine",
          legacyValue: "4801",
          legacyText: "AirSense 11 AutoSet",
          value: "AirSense 11 AutoSet",
          url: "https://www.cpap.com/products/resmed-airsense-11-autoset",
          disposition: "resolves-to-product",
        },
        {
          userFieldName: "Machine",
          legacyValue: "9001",
          legacyText: "AirSense 11 AutoSet Card-to-Cloud",
          value: "AirSense 11 AutoSet Card-to-Cloud",
          url: "",
          disposition: "plain-text",
        },
      ];

      expect(readDispositionTable(dispositionTableCsv(near))).toHaveLength(2);
    });

    it("lets the same value collide across two different fields", () => {
      // Mappings are keyed per Custom User Field, so a Machine value and a
      // Mask value that read the same resolve independently and neither
      // shadows the other.
      const acrossFields: DispositionRow[] = [
        {
          userFieldName: "Machine",
          legacyValue: "4801",
          legacyText: "Bedside Unit",
          value: "Bedside Unit",
          url: "https://www.cpap.com/products/bedside-unit",
          disposition: "resolves-to-product",
        },
        {
          userFieldName: "Mask",
          legacyValue: "9001",
          legacyText: "Bedside Unit",
          value: "Bedside Unit",
          url: "",
          disposition: "plain-text",
        },
      ];

      expect(
        readDispositionTable(dispositionTableCsv(acrossFields))
      ).toHaveLength(2);
    });

    it("reports a structural fault without echoing the row", () => {
      // Deliberately *not* an email address. An email would be stopped by the
      // scan above, so a test using one would pass with the echo restored and
      // prove nothing about this rule. The scan is a tripwire for one shape of
      // member data, not a filter for member data; a name sails straight
      // through it. So the diagnostics carry coordinates and nothing else, and
      // this is the case that holds them to it.
      const name = "Marjorie Fenwick-Abara";
      const short =
        `${HEADER}\n` + `Machine,6240,${name},v,,plain-text,extra\n`;
      const blank = `${HEADER}\n` + `Machine,6240,${name},,,plain-text\n`;

      for (const body of [short, blank]) {
        expect(() =>
          readDispositionTable(`# sha256 ${digestOf(body)}\n${body}`)
        ).toThrow(/^(?!.*Marjorie)/s);
      }

      // And still says enough to find the cell.
      expect(() =>
        readDispositionTable(`# sha256 ${digestOf(blank)}\n${blank}`)
      ).toThrow(/row 2, column 4 is empty — it names no value/);
    });

    it("reports a missing header row without echoing what it found", () => {
      // The header diagnostic prints `found:` to explain which columns it got,
      // which is worth keeping — but a file whose header row is absent hands
      // it a data row to print. The scan runs first so this refuses as
      // contamination rather than as a header, and prints neither.
      //
      // A *line*, not a row: the scan reads the raw text before the digest is
      // verified, so line 1 is the digest line and the contaminated row is
      // line 2. It cannot number in rows without assuming the file structure
      // that is precisely what is still in doubt.
      const body =
        `Machine,6240,someone@example.com,v,,plain-text\n` +
        `Machine,6241,Other,Other,,plain-text\n`;

      expect(() =>
        readDispositionTable(`# sha256 ${digestOf(body)}\n${body}`)
      ).toThrow(/line 2, column 3 holds something shaped like an email/);
      expect(() =>
        readDispositionTable(`# sha256 ${digestOf(body)}\n${body}`)
      ).toThrow(/^(?!.*someone@example\.com)/s);
    });

    it("refuses a contaminated file that has no digest line at all", () => {
      // The earliest reachable diagnostic in the whole read path, and it used
      // to quote line 1. "No digest line" *means* a data row is line 1, so the
      // one case that reaches this refusal is the one case where quoting it
      // prints file content — the two are the same condition, which is what
      // makes it worth a test rather than a tidy-up.
      const body =
        `Machine,6240,someone@example.com,v,,plain-text\n` +
        `Machine,6241,Other,Other,,plain-text\n`;

      expect(() => readDispositionTable(body)).toThrow(
        /line 1, column 3 holds something shaped like an email/
      );
      expect(() => readDispositionTable(body)).toThrow(
        /^(?!.*someone@example\.com)/s
      );
    });

    it("names no line content when a digest line is merely absent", () => {
      // The ordinary case, with nothing contaminated in it: the refusal still
      // has to be useful. It says which file, which line, and exactly what was
      // expected there — everything except the bytes it found.
      const body = "user_field_name,legacy_value\nMachine,6240\n";

      expect(() => readDispositionTable(body)).toThrow(
        /should start with a "# sha256 <64 hex digits>" line on line 1/
      );
      expect(() => readDispositionTable(body)).toThrow(
        /^(?!.*user_field_name,legacy_value)/s
      );
    });

    it("redacts for the four commands that ask for a digest directly", () => {
      // `refresh`, `apply`, `verify` and `build:settings` each call
      // `declaredDigest` on a file they have just read, without going through
      // any reader. A guard placed at the top of `dataRowsOf` would cover one
      // path of the five, so the redaction lives in the function itself.
      const contaminated = `Machine,6240,someone@example.com,v\n`;

      expect(() => declaredDigest(contaminated, CATALOGUE_FILE)).toThrow(
        /^(?!.*someone@example\.com)/s
      );
      expect(() => declaredDigest(contaminated, CATALOGUE_FILE)).toThrow(
        /data\/resolved-products\.csv should start with/
      );
    });

    it("refuses two rows claiming the same legacy value", () => {
      // The pair is this table's key. Two rows under it hand the non-public
      // side two different pieces of equipment for one member and nothing to
      // choose between them, so it picks — silently, and not necessarily the
      // same way twice.
      const duplicated: DispositionRow[] = [
        ...rowWith({}),
        ...rowWith({
          disposition: "plain-text",
          value: "Aircurve 11 asv",
          url: "",
        }),
      ];

      expect(() => dispositionTableCsv(duplicated)).toThrow(
        /row 3 repeats the column 2 \(`legacy_value`\) and column 1 \(`user_field_name`\) already claimed by row 2/
      );
    });

    it("refuses a repeated legacy value on the way in as well", () => {
      // Hand-assembled rather than round-tripped, because the writer now
      // refuses this and a round-trip could never produce it. The reader is
      // the gate that runs against a file someone edited.
      const body =
        `${HEADER}\n` +
        `Machine,6240,Aircurve 11 asv,Aircurve 11 asv,,plain-text\n` +
        `Machine,6240,Aircurve 11 asv,Aircurve 11 asv,,plain-text\n`;

      expect(() =>
        readDispositionTable(`# sha256 ${digestOf(body)}\n${body}`)
      ).toThrow(/row 3 repeats the column 2 \(`legacy_value`\)/);
    });

    it("lets one legacy value appear under two different fields", () => {
      // The near-miss that has to stay legal. The key is the pair, not the
      // identifier: the two option tables number their rows independently, so
      // a Machine 6240 and a Mask 6240 are unrelated and both are real.
      const sameIdentifier: DispositionRow[] = [
        ...rowWith({}),
        ...rowWith({
          userFieldName: "Mask",
          legacyText: "Some mask",
          value: "Some mask",
          url: "",
          disposition: "plain-text",
        }),
      ];

      expect(
        readDispositionTable(dispositionTableCsv(sameIdentifier))
      ).toHaveLength(2);
    });

    it("refuses a legacy value carrying whitespace", () => {
      // The join key the far side matches exactly. Padding here finds no
      // member at all, which is a miss rather than an error — the failure this
      // table cannot afford, because nothing in this repository can observe it.
      expect(() =>
        dispositionTableCsv(rowWith({ legacyValue: " 6240 " }))
      ).toThrow(/column 2 \(`legacy_value`\) carries whitespace/);
    });

    it("says the same thing whichever side of the boundary refuses", () => {
      // The point of one shared validator: identical rules, identical wording,
      // no drift. Only the row number differs, and only because the writer
      // counts rows it has not written yet.
      const bad = rowWith({ url: "" });
      let onWrite = "";
      let onRead = "";

      try {
        dispositionTableCsv(bad);
      } catch (error) {
        onWrite = (error as Error).message;
      }

      const body =
        `${HEADER}\nMachine,6240,Aircurve 11 asv,` +
        `AirCurve 11 ASV (Discontinued),,collection\n`;

      try {
        readDispositionTable(digested(body));
      } catch (error) {
        onRead = (error as Error).message;
      }

      expect(onWrite).not.toBe("");
      expect(onRead).toBe(onWrite);
    });
  });

  /**
   * The no-echo rule, checked across every refusal rather than argued once.
   *
   * `scripts/README.md` records it as a property of this whole boundary, and it
   * was true of the two earliest diagnostics while nine refusals below them
   * still printed the cell — the coordinate-only rewrite reached the function
   * being edited at the time and stopped there. A table is what stops that
   * being a per-round discovery.
   *
   * The canary is a **name**, and that is the load-bearing choice. An email
   * address is caught by `EMAIL_SHAPED` before any of these refusals runs, so
   * every case below would pass with the echo fully restored — which is how an
   * earlier version of this test passed for the wrong reason. A name is what
   * the tripwire cannot see, and a legacy display text is where one would
   * land.
   */
  describe("what a refusal is allowed to say", () => {
    const CANARY = "Marjorie Fenwick-Abara";

    function rowWith(overrides: Partial<DispositionRow>): DispositionRow {
      return {
        userFieldName: "Machine",
        legacyValue: "6240",
        legacyText: "Aircurve 11 asv",
        value: "AirCurve 11 ASV (Discontinued)",
        url: CPAP_MACHINES,
        disposition: "collection",
        ...overrides,
      };
    }

    /** Every way this boundary can refuse a row, each carrying the canary. */
    const refusals: readonly (readonly [string, () => unknown])[] = [
      [
        "a column holding only whitespace",
        () =>
          dispositionTableCsv([
            rowWith({ legacyValue: CANARY, legacyText: "  " }),
          ]),
      ],
      [
        "a url carrying whitespace",
        () => dispositionTableCsv([rowWith({ url: ` ${CANARY} ` })]),
      ],
      [
        "a join key carrying whitespace",
        () => dispositionTableCsv([rowWith({ legacyValue: ` ${CANARY} ` })]),
      ],
      [
        "a disposition it has no word for",
        () =>
          dispositionTableCsv([
            rowWith({ disposition: CANARY as DispositionRow["disposition"] }),
          ]),
      ],
      [
        "an unlinked row carrying a url",
        () =>
          dispositionTableCsv([
            rowWith({
              disposition: "plain-text",
              url: CANARY,
              value: "Aircurve 11 asv",
            }),
          ]),
      ],
      [
        "an unlinked value that is not the legacy text",
        () =>
          dispositionTableCsv([
            rowWith({ disposition: "plain-text", url: "", value: CANARY }),
          ]),
      ],
      [
        "an unlinked row the runtime would resolve anyway",
        () =>
          dispositionTableCsv([
            rowWith({ legacyValue: "1", value: CANARY }),
            rowWith({
              legacyValue: "2",
              disposition: "plain-text",
              url: "",
              legacyText: ` ${CANARY} `,
              value: ` ${CANARY} `,
            }),
          ]),
      ],
      [
        "two rows claiming the same key",
        () =>
          dispositionTableCsv([
            rowWith({ legacyValue: CANARY }),
            rowWith({
              legacyValue: CANARY,
              disposition: "plain-text",
              url: "",
              value: "Aircurve 11 asv",
            }),
          ]),
      ],
      [
        "a file that has lost its header row",
        () =>
          readDispositionTable(
            digested(`"Machine","6240","${CANARY}","AirFit","","plain-text"\n`)
          ),
      ],
      [
        "a committed row with a blank column",
        () =>
          readDispositionTable(
            digested(
              `${HEADER}\n"Machine","${CANARY}","","x","","plain-text"\n`
            )
          ),
      ],
      [
        "a committed row with a padded join key",
        () =>
          readDispositionTable(
            digested(
              `${HEADER}\n"Machine"," ${CANARY} ","x","x","","plain-text"\n`
            )
          ),
      ],
    ];

    it("uses a canary the email guard cannot see", () => {
      // If this ever fails, every case below is being caught by the tripwire
      // and none of them is proving anything about the refusal it names.
      expect(EMAIL_SHAPED.test(CANARY)).toBe(false);
    });

    for (const [what, refuse] of refusals) {
      it(`quotes no cell when it refuses ${what}`, () => {
        let message = "";

        try {
          refuse();
        } catch (error) {
          message = (error as Error).message;
        }

        expect(message).not.toBe("");
        expect(message).not.toContain(CANARY);
        // The coordinate is the entire diagnostic once the value is gone, so a
        // refusal naming neither would satisfy the line above by saying
        // nothing a reader could act on.
        expect(message).toMatch(/(row|line) \d+/);
      });
    }
  });

  it("writes an empty URL without complaint, which is the only blank it allows", () => {
    expect(dispositionTableCsv([ROWS[2]])).toContain(
      "Mask,3005,Unlisted mask,Unlisted mask,,blank-title"
    );
  });

  it("refuses to write a cell shaped like an email address", () => {
    // The precedent is `readSheetTab`'s own refusal, and this artifact is the
    // one that crosses to the side that holds member data, so the tripwire
    // points outward as well as in.
    expect(() => dispositionTableCsv(withLeak())).toThrow(
      CatalogueRefreshError
    );
    expect(() => dispositionTableCsv(withLeak())).toThrow(
      /shaped like an email address/
    );
  });

  it("does not echo the cell it is refusing to write", () => {
    // A guard that logged the thing it is refusing to admit would have written
    // it into the repository by way of the error message. The row and column
    // are enough to find it in the source it came from.
    let message = "";

    try {
      dispositionTableCsv(withLeak());
    } catch (error) {
      message = (error as Error).message;
    }

    // Row 5 rather than row 4: the header is row 1, so the fourth data row is
    // the fifth line a person opening the file would count to.
    expect(message).not.toContain(LEAKED);
    expect(message).toContain("row 5");
    expect(message).toContain("column 3");
  });

  const LEAKED = "someone@example.com";

  /** The three good rows with a fourth that must never reach the file. */
  function withLeak(): DispositionRow[] {
    return [
      ...ROWS,
      {
        userFieldName: "Mask",
        legacyValue: "9001",
        legacyText: LEAKED,
        value: LEAKED,
        url: "",
        disposition: "plain-text",
      },
    ];
  }
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
    dispositions: built.dispositions,
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

  it("counts absent Collection Links apart from the problems behind them", () => {
    // Two numbers, because they are two facts: legacy values sharing a
    // Suggested Title collapse to one Mapping, so a value can be one absent
    // link and several reported problems. An approver reading the problem count
    // as a link count goes looking for a link that was never owed.
    //
    // These fixtures happen to be one-to-one — every fault is its own value —
    // which is what makes the labels load-bearing rather than the arithmetic:
    // the summary has to say which number is which even when they agree.
    const problems = built.collectionFaults.length;

    expect(problems).toBeGreaterThan(0);
    expect(undeliveredValues(built.collectionFaults)).toBe(problems);
    expect(review).toContain(
      `- Collection Links that could not be derived: ${problems} ` +
        `(${problems} reported problems)`
    );
    expect(review).toContain(
      `## Collection Links not derived — ${problems} ` +
        `(${problems} reported problems)`
    );
  });

  it("heads the section with links owed, not problems reported", () => {
    // The heading is the number an approver scrolls to rather than reads past,
    // and it is the one place the fixtures above cannot tell the two numbers
    // apart. Two faults on one derived value are one Mapping that will not
    // ship: a `divided-value` group reports itself on top of the row it held
    // back, and the heading has to say one link and two reasons.
    const collapsed = [
      {
        userFieldName: "Machine",
        legacyValues: ["6240"],
        value: "AirCurve 11 ASV (Discontinued)",
        problem: "unassigned-legacy-value" as const,
        detail: "nobody claims this legacy value",
      },
      {
        userFieldName: "Machine",
        legacyValues: ["6240", "6241"],
        value: "AirCurve 11 ASV (Discontinued)",
        problem: "divided-value" as const,
        detail: "only some of these rows earned a link",
      },
    ];

    const rendered = renderReviewDocument({
      catalogue: built.catalogue,
      exclusions: built.exclusions,
      collectionLinks: built.collectionLinks,
      collectionFaults: collapsed,
      dispositions: built.dispositions,
      sheetRows: SHEET_ROWS,
      products: PRODUCTS,
      digest: "0".repeat(64),
    });

    expect(undeliveredValues(collapsed)).toBe(1);
    expect(rendered).toContain(
      "## Collection Links not derived — 1 (2 reported problems)"
    );
  });

  it("says one problem in the singular", () => {
    const single = [
      {
        userFieldName: "Machine",
        legacyValues: ["6240"],
        value: "AirCurve 11 ASV (Discontinued)",
        problem: "unassigned-legacy-value" as const,
        detail: "nobody claims this legacy value",
      },
    ];

    const rendered = renderReviewDocument({
      catalogue: built.catalogue,
      exclusions: built.exclusions,
      collectionLinks: built.collectionLinks,
      collectionFaults: single,
      dispositions: built.dispositions,
      sheetRows: SHEET_ROWS,
      products: PRODUCTS,
      digest: "0".repeat(64),
    });

    expect(rendered).toContain(
      "## Collection Links not derived — 1 (1 reported problem)"
    );
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
      dispositions: built.dispositions,
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

  /**
   * The disposition section's own assertions.
   *
   * Everything else in this describe passed `dispositions` through and never
   * looked at what came out, so a regression in these counts stayed green —
   * which is not hypothetical: the prose in this section shipped claiming
   * `undecided` and `collection-link-fault` were "the last two rows" of a table
   * that puts the curator's four words first, and no test noticed. These are
   * the numbers a reviewer reads to decide whether an unexpected number of
   * members lost a link (#28), so they are worth pinning.
   */
  describe("the disposition table section", () => {
    // Two of the fixture's six legacy values resolve; the other four earn a
    // Collection Link and get none, because this document is rendered with no
    // assignment rows behind it.
    const linked = built.dispositions.filter((row) => row.url !== "").length;
    const unlinked = built.dispositions.length - linked;

    it("heads the section with the legacy values it covers", () => {
      expect(linked).toBeGreaterThan(0);
      expect(unlinked).toBeGreaterThan(0);
      expect(review).toContain(
        `## Disposition table — ${built.dispositions.length} legacy values`
      );
      expect(review).toContain(
        `- Disposition table: \`data/disposition-table.csv\`, ` +
          `${built.dispositions.length} legacy values`
      );
    });

    it("splits the values by whether a Profile Link resolves", () => {
      expect(review).toContain(
        `${linked} of these resolve a Profile Link and ${unlinked} do not`
      );
    });

    it("counts every disposition, including the ones nothing fell under", () => {
      // An absent row and a zero say different things: a zero is the pipeline
      // reporting that nothing reached that outcome, and an absent row is a
      // reader wondering whether the outcome still exists.
      expect(review).toContain("| `resolves-to-product` | 2 | yes |");
      expect(review).toContain("| `collection-link-fault` | 4 | no |");
      expect(review).toContain("| `collection` | 0 | yes |");
      expect(review).toContain("| `plain-text` | 0 | no |");
      expect(review).toContain("| `undecided` | 0 | no |");
      expect(review).toContain("| `blank-title` | 0 | no |");
      expect(review).toContain("| `ambiguous-title-match` | 0 | no |");
    });

    it("names the two fault-side dispositions rather than pointing at rows", () => {
      // The regression this section shipped with. Pointing at positions in a
      // table that is deliberately ordered another way sent a reviewer to
      // `ambiguous-title-match` — which is evidence the Sheet Export is wrong
      // (ADR-0020), not an undelivered link, and a different job entirely.
      expect(review).toContain(
        "`undecided` and `collection-link-fault` are the section above"
      );
      expect(review).not.toContain("The last two rows are the section above");
    });

    it("says one value in the singular", () => {
      const one = renderReviewDocument({
        catalogue: built.catalogue,
        exclusions: built.exclusions,
        collectionLinks: built.collectionLinks,
        collectionFaults: built.collectionFaults,
        dispositions: built.dispositions.slice(0, 1),
        sheetRows: SHEET_ROWS,
        products: PRODUCTS,
        digest: "0".repeat(64),
      });

      expect(one).toContain("1 of these resolves a Profile Link and 0 do not");
    });
  });

  it("is the same document twice, because there is no clock in it", () => {
    const again = renderReviewDocument({
      catalogue: built.catalogue,
      exclusions: built.exclusions,
      collectionLinks: built.collectionLinks,
      collectionFaults: built.collectionFaults,
      dispositions: built.dispositions,
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
        dispositions: after.dispositions,
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

  it("gives the disposition validators no way to quote a cell", () => {
    /** A top-level function's source, declaration to closing brace. */
    function bodyOf(name: string): string {
      const start = lib.indexOf(`function ${name}(`);
      const end = lib.indexOf("\n}\n", start);

      expect(start).not.toBe(-1);
      expect(end).not.toBe(-1);

      return lib.slice(start, end);
    }

    // Blunt on purpose. Inside these three every string in scope came out of
    // the file, so there is nothing here that `JSON.stringify` could be
    // quoting except a cell — which makes a ban cheaper to keep than a
    // judgement about which columns are safe, and it was exactly that
    // judgement ("a legacy identifier, a product name and a URL is all they
    // hold") that left nine refusals printing one.
    //
    // The canary table above pins the refusals that exist today; this pins the
    // ones added later, which is the half a table of cases cannot cover
    // because a new refusal arrives without a case.
    //
    // `dataRowsOf` is deliberately not on this list: its header diagnostic
    // quotes the *expected* column names, which are a constant of this
    // repository rather than file content. What it must not echo is pinned by
    // the canary table instead.
    for (const validator of [
      "assertDispositionRow",
      "assertNoResolvingCollisions",
      "assertNoDuplicateKeys",
    ]) {
      expect(bodyOf(validator)).not.toContain("JSON.stringify");
    }
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
    expect(command).not.toContain(DISPOSITION_FILE);
    expect(command).not.toContain(REVIEW_FILE);
    expect(command).toContain("writeFile(CATALOGUE_FILE, csv)");
    expect(command).toContain("writeFile(COLLECTION_LINKS_FILE, linksCsv)");
    expect(command).toContain("writeFile(DISPOSITION_FILE, dispositionCsv)");
    expect(command).toContain("writeFile(REVIEW_FILE, review)");
  });

  it("still writes the disposition table, which nothing else would notice", () => {
    // `main` cannot run without a Shopify token, so this source-level contract
    // is the only thing standing between the command and a silently dropped
    // write. Every other test around this artifact would stay green: the
    // formatter tests call `dispositionTableCsv` directly, and
    // `spec/unit/disposition-table.test.ts` compares the committed file against
    // a fresh derivation — neither asks whether the command still emits it. The
    // file would simply stop being regenerated and go stale, which for the one
    // artifact another repository consumes is the quietest possible failure.
    expect(command).toContain("dispositionTableCsv(dispositions)");
    expect(command).toContain("writeFile(DISPOSITION_FILE, dispositionCsv)");
  });

  it("builds the disposition table before it writes anything", () => {
    // The refusals in `dispositionTableCsv` are only free if nothing has been
    // written when one fires. A refusal after the catalogue had been
    // regenerated would leave the two files disagreeing, with the handoff
    // missing and no obvious sign of it.
    expect(command.indexOf("dispositionTableCsv(dispositions)")).toBeLessThan(
      command.indexOf("await writeFile(CATALOGUE_FILE, csv)")
    );
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
