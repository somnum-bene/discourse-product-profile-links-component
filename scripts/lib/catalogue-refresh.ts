// Everything the Catalogue Refresh decides, kept away from everything it does.
// The command is a shell: read the committed files, post two kinds of GraphQL
// query, write the ones it owns. Which handles to ask about, what a well-formed
// answer looks like, what the catalogue and collection-links files say, and what
// the review document reports are all decided here, where a test can reach them.
//
// `buildCatalogue` judges the products. This file never re-judges them: it asks
// Shopify for facts, hands them over, and reports what came back. The one place
// that would be tempting is the review document, which is why it draws its
// notions of "the same title" and "the product this URL names" from the
// transform itself rather than keeping its own.

import { createHash } from "node:crypto";
import {
  COLLECTION_LINK_SUFFIX,
  type CollectionLink,
  type ExcludedProduct,
  type ExclusionReason,
  handleFromSuggestedUrl,
  normalizeTitle,
  type ProductRecord,
  type ProductStatus,
  type ResolvedProduct,
  type SheetRow,
} from "./build-catalogue.ts";
import { parseCsv, SHEET_TABS } from "./sheet-export.ts";

/** The shop to query. A bare host — `example.myshopify.com`, no scheme, no path. */
export const SHOP_DOMAIN_VAR = "SHOPIFY_SHOP_DOMAIN";

/**
 * The Admin API access token. Read from the ignored `.env` by the command and
 * never passed into this file, so that no function here could log it even by
 * accident. Everything below builds query text; the command adds the header.
 */
export const TOKEN_VAR = "SHOPIFY_API_TOKEN";

/**
 * Pinned rather than floating. `2026-07` is the current stable version, and a
 * version that moved on its own could change a field's meaning between a
 * catalogue someone approved and the next refresh.
 */
export const SHOPIFY_API_VERSION = "2026-07";

/** The Resolved Product Catalogue: committed, and one of two inputs to `build`. */
export const CATALOGUE_FILE = "data/resolved-products.csv";

/**
 * The Collection Links: committed, and the second input to `build`. A sibling of
 * the Resolved Product Catalogue rather than part of it — a Resolved Product
 * requires a real handle and a real product status, and a collection has
 * neither, so widening the catalogue file would mean relaxing its reader for
 * every row (ADR-0021).
 *
 * Hand-seeded today. When derivation lands it is written by the same refresh
 * that writes the catalogue, which is why it already carries a digest.
 */
export const COLLECTION_LINKS_FILE = "data/collection-links.csv";

/**
 * The review document. `.ig.` is ignored, because this is a working document
 * regenerated on every refresh rather than a record of the repository's state —
 * the catalogue file is that record.
 */
export const REVIEW_FILE = ".ig.catalogue-review.md";

/** Products per by-handle request. Shopify charges one point each. */
export const HANDLES_PER_REQUEST = 100;

/** Products per survey page, and the page ceiling. Both divisions are one page. */
export const SURVEY_PAGE_SIZE = 250;
export const MAX_SURVEY_PAGES = 10;

/**
 * Anything wrong enough to stop the run before it writes. The command catches
 * only this type, so a programming mistake still surfaces as a crash.
 */
export class CatalogueRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogueRefreshError";
  }
}

/**
 * A Custom User Field paired with the Shopify tag that marks the part of the
 * catalogue it draws from. The tags are how the review document answers "what
 * does cpap.com sell that the spreadsheet never mentions", which is a question
 * the sheet alone cannot answer.
 *
 * Whether these are the right divisions to count against is an open question
 * for product — the review document names the tag it used so the answer can be
 * checked rather than assumed.
 */
export interface Division {
  userFieldName: string;
  tag: string;
}

export const DIVISIONS: readonly Division[] = [
  { userFieldName: "Machine", tag: "Catalog-Merchant-Division-Machines" },
  { userFieldName: "Mask", tag: "Catalog-Merchant-Division-Masks" },
];

/**
 * A product as Shopify described it. The extra two facts over `ProductRecord`
 * are ones the transform has no opinion about but a human reviewer needs: stock
 * on hand, because an unpublished product with inventory behind it is a
 * merchandising oversight rather than a retired line, and which divisions the
 * product sits in, because that is what makes the reverse discrepancy countable.
 */
export interface SurveyedProduct extends ProductRecord {
  totalInventory: number;
  divisionFields: string[];
}

/** One page of a division survey, and where the next one starts. */
export interface SurveyPage {
  products: SurveyedProduct[];
  endCursor: string | null;
  hasNextPage: boolean;
}

export interface ReviewInput {
  catalogue: readonly ResolvedProduct[];
  exclusions: readonly ExcludedProduct[];
  sheetRows: readonly SheetRow[];
  products: readonly SurveyedProduct[];
  digest: string;
}

/** The catalogue file's columns, in order. The reader requires exactly these. */
export const CATALOGUE_COLUMNS = [
  "user_field_name",
  "value",
  "handle",
  "status",
  "url",
] as const;

/**
 * The collection-links file's columns, in order. Three, not five: the two the
 * catalogue carries and this file does not are exactly the two facts a
 * collection has no answer for.
 */
export const COLLECTION_LINK_COLUMNS = [
  "user_field_name",
  "value",
  "url",
] as const;

const DIGEST_PREFIX = "# sha256 ";
const DIGEST_LINE = /^# sha256 ([0-9a-f]{64})$/;

/**
 * Shopify handles are lowercase slugs. A `/products/…` path segment that is not
 * one did not come from a Shopify product URL, so rather than send it and let
 * the join quietly report "no matching product", the run stops and names it —
 * the Sheet Exports are committed, so this is a reviewable fact about the
 * spreadsheet rather than a transient failure.
 */
const HANDLE_SHAPE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Every status this command knows how to think about. A status outside this list
 * stops the run rather than being read as "not active": a new status is Shopify
 * telling us something about a product that nobody has decided what to do with
 * yet, and guessing is how a link to a product that should not be linked ships.
 */
const STATUSES: readonly ProductStatus[] = [
  "ACTIVE",
  "ARCHIVED",
  "DRAFT",
  "UNLISTED",
];

/**
 * Why each exclusion reason exists, in a shape the compiler checks. Adding a
 * reason to `ExclusionReason` without explaining it here is a type error, which
 * is the point: the review document is the only place anyone learns what a
 * reason means, and a reason nobody documented is a reason nobody can act on.
 */
const REASON_DESCRIPTIONS: Record<ExclusionReason, string> = {
  "blank-title":
    "The spreadsheet row has no Suggested Title. Nothing to map, and nothing to fix here — the row exists for the legacy value in its `Value` column.",
  "discontinued-suffix":
    "The Suggested Title ends in `(Discontinued)`. These are legacy catch-alls for equipment with no current equivalent, and they link to a category page rather than a product, so they are out of scope for Profile Links (ADR-0012).",
  "no-matching-product":
    "Neither the handle in the Suggested URL nor the Suggested Title itself found a product in the Shopify catalogue. Either the product is gone, or the curated title has drifted from the one Shopify carries.",
  "ambiguous-title-match":
    "The Suggested URL named no product and the Suggested Title matched more than one, so there is no single answer. Picking one would ship a confident wrong link.",
  "not-active":
    "Shopify reports the product as something other than `ACTIVE` — `ARCHIVED`, `DRAFT`, or `UNLISTED`, which means buyable by direct link but hidden from storefront browsing. The sheet decides which products belong in the list; Shopify decides which of them are still real (ADR-0010). The status Shopify gave is in the last column.",
  unpublished:
    "The product is live in Shopify but was never published to the Online Store sales channel, so it has no storefront URL to link to. This is a merchandising gap, not a data problem — check the stock column below.",
  "discontinued-tag":
    "Shopify carries the authoritative `Discontinued` tag on the product. This is a different fact from the `(Discontinued)` title suffix above: this one comes from the catalogue, that one from the legacy spreadsheet.",
};

/** Every exclusion reason, in the order the review document reports them. */
export const EXCLUSION_REASONS: readonly ExclusionReason[] = Object.keys(
  REASON_DESCRIPTIONS
) as ExclusionReason[];

const PRODUCT_FIELDS = `handle
    title
    status
    tags
    onlineStoreUrl
    totalInventory`;

/**
 * Every handle the join will look for, deduplicated and sorted. Sorted because
 * the request order decides nothing and an unstable order makes two runs
 * needlessly hard to compare.
 *
 * A row whose Suggested URL names no product contributes nothing here: those
 * rows fall through to the transform's title match, which needs the surveyed
 * products rather than a targeted fetch.
 */
export function handlesFromSheetRows(rows: readonly SheetRow[]): string[] {
  const handles = new Set<string>();

  for (const row of rows) {
    const handle = handleFromSuggestedUrl(row.suggestedUrl);

    if (!handle) {
      continue;
    }

    if (!HANDLE_SHAPE.test(handle)) {
      throw new CatalogueRefreshError(
        `the Suggested URL "${row.suggestedUrl}" yields "${handle}", which is ` +
          `not a Shopify product handle. Refusing to guess what it meant.`
      );
    }

    handles.add(handle);
  }

  return [...handles].sort();
}

/** Splits the handles into requests. Order is preserved, so batching is stable. */
export function handleBatches(
  handles: readonly string[],
  size: number = HANDLES_PER_REQUEST
): string[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new CatalogueRefreshError(
      `a request has to carry at least one handle, not ${size}`
    );
  }

  const batches: string[][] = [];

  for (let index = 0; index < handles.length; index += size) {
    batches.push(handles.slice(index, index + size));
  }

  return batches;
}

/**
 * The Admin GraphQL endpoint for a shop. The domain has to be a bare host: a
 * value carrying a scheme or a path would silently produce a URL pointing
 * somewhere other than Shopify, and the token goes to whatever this returns.
 */
export function shopifyEndpoint(shopDomain: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(shopDomain)) {
    throw new CatalogueRefreshError(
      `${SHOP_DOMAIN_VAR} should be a bare host such as ` +
        `"example.myshopify.com", not "${shopDomain}". The access token is ` +
        `sent to this address, so it is not guessed at.`
    );
  }

  return `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

/**
 * One request asking for every product in a batch by handle, each under its own
 * alias. `productByIdentifier` answers `null` for a handle that does not exist,
 * which is the answer the transform needs — it reports the miss with the title
 * it was looking for, and this file does not have to.
 */
export function productsByHandleQuery(handles: readonly string[]): string {
  if (handles.length === 0) {
    throw new CatalogueRefreshError(
      "refusing to send a by-handle query with no handles in it"
    );
  }

  const lookups = handles
    .map(
      (handle, index) =>
        `  p${index}: productByIdentifier(identifier: { handle: ${JSON.stringify(
          handle
        )} }) {\n    ${PRODUCT_FIELDS}\n  }`
    )
    .join("\n");

  return `query ProductsByHandle {\n${lookups}\n}\n`;
}

/**
 * One page of the products a division currently sells. Only `ACTIVE` products
 * are asked for: the question this answers is "what is on sale that the
 * spreadsheet never mentions", and an archived product is not on sale.
 *
 * Sorted by title so that pagination is stable — a cursor into a default-sorted
 * list can skip or repeat rows if the catalogue changes mid-walk.
 */
export function divisionSurveyQuery(
  division: Division,
  cursor: string | null
): string {
  const search = `tag:'${division.tag}' AND status:active`;
  const after = cursor === null ? "" : `, after: ${JSON.stringify(cursor)}`;

  return (
    `query DivisionSurvey {\n` +
    `  products(first: ${SURVEY_PAGE_SIZE}${after}, sortKey: TITLE, query: ${JSON.stringify(
      search
    )}) {\n` +
    `    pageInfo {\n      hasNextPage\n      endCursor\n    }\n` +
    `    nodes {\n    ${PRODUCT_FIELDS}\n    }\n` +
    `  }\n}\n`
  );
}

/**
 * The products in a by-handle response, in the order the handles were asked
 * for. A missing product is `null` and simply absent from the result; a missing
 * *alias* is a different thing — the response is not the shape this query asked
 * for — and stops the run.
 */
export function productsFromByHandleResponse(
  body: unknown,
  handles: readonly string[]
): SurveyedProduct[] {
  const data = dataOf(body, "the by-handle query");
  const products: SurveyedProduct[] = [];

  for (const [index, handle] of handles.entries()) {
    const alias = `p${index}`;

    if (!(alias in data)) {
      throw new CatalogueRefreshError(
        `the by-handle response has no "${alias}" for handle "${handle}". ` +
          `Shopify answered something other than the query that was sent.`
      );
    }

    const node = data[alias];

    if (node === null) {
      continue;
    }

    products.push(productFrom(node, `${alias} ("${handle}")`));
  }

  return products;
}

/** One page of a division survey, with the products tagged as belonging to it. */
export function surveyPageFromResponse(
  body: unknown,
  division: Division
): SurveyPage {
  const data = dataOf(body, `the ${division.tag} survey`);
  const products = data["products"];

  if (!isRecord(products)) {
    throw new CatalogueRefreshError(
      `the ${division.tag} survey response has no "products" object`
    );
  }

  const pageInfo = products["pageInfo"];
  const nodes = products["nodes"];

  if (!isRecord(pageInfo) || typeof pageInfo["hasNextPage"] !== "boolean") {
    throw new CatalogueRefreshError(
      `the ${division.tag} survey response has no usable "pageInfo"`
    );
  }

  if (!Array.isArray(nodes)) {
    throw new CatalogueRefreshError(
      `the ${division.tag} survey response has no "nodes" array`
    );
  }

  return {
    products: nodes.map((node, index) =>
      productFrom(node, `${division.tag} node ${index + 1}`)
    ),
    endCursor: nullableString(
      pageInfo["endCursor"],
      `the ${division.tag} survey response has a non-string "endCursor"`
    ),
    hasNextPage: pageInfo["hasNextPage"],
  };
}

/**
 * One list of products from several, deduplicated by handle and sorted by it.
 * The by-handle fetch and the division surveys overlap heavily by design — a
 * curated product is usually also on sale — and the transform must see each
 * product once, or the title fallback would call it ambiguous.
 */
export function mergeProducts(
  ...lists: readonly SurveyedProduct[][]
): SurveyedProduct[] {
  const byHandle = new Map<string, SurveyedProduct>();

  for (const list of lists) {
    for (const product of list) {
      const existing = byHandle.get(product.handle);

      if (!existing) {
        byHandle.set(product.handle, product);
        continue;
      }

      // The same product reached us twice, once per source. Keep the union of
      // the divisions it was found under so the report does not depend on which
      // query happened to see it first.
      byHandle.set(product.handle, {
        ...existing,
        divisionFields: [
          ...new Set([...existing.divisionFields, ...product.divisionFields]),
        ].sort(),
      });
    }
  }

  return [...byHandle.values()].sort((a, b) =>
    a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0
  );
}

/** The Custom User Fields whose division tags a product carries. */
export function divisionFieldsOf(tags: readonly string[]): string[] {
  const lowered = new Set(tags.map((tag) => tag.trim().toLowerCase()));

  return DIVISIONS.filter((division) =>
    lowered.has(division.tag.toLowerCase())
  ).map((division) => division.userFieldName);
}

/** The sha256 of the catalogue file's body — everything below the digest line. */
export function digestOf(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * The Resolved Product Catalogue as a file. The first line is a digest of
 * everything under it, so a later command can say which catalogue it is working
 * from and notice a file that was edited by hand rather than regenerated.
 */
export function resolvedProductsCsv(
  catalogue: readonly ResolvedProduct[]
): string {
  const rows = catalogue.map((entry) =>
    csvLine([
      entry.userFieldName,
      entry.value,
      entry.handle,
      entry.status,
      entry.url,
    ])
  );
  const body = `${[csvLine([...CATALOGUE_COLUMNS]), ...rows].join("\n")}\n`;

  return `${DIGEST_PREFIX}${digestOf(body)}\n${body}`;
}

/**
 * The Collection Links as a file, in the same digested shape as the catalogue.
 * It carries a digest for the same reason the catalogue does: a curated
 * decision is approved once and then read by two more commands.
 */
export function collectionLinksCsv(
  collectionLinks: readonly CollectionLink[]
): string {
  const rows = collectionLinks.map((entry) =>
    csvLine([entry.userFieldName, entry.value, entry.url])
  );
  const body = `${[csvLine([...COLLECTION_LINK_COLUMNS]), ...rows].join("\n")}\n`;

  return `${DIGEST_PREFIX}${digestOf(body)}\n${body}`;
}

/**
 * The digest a digested file declares, without reading the rest of it. The file
 * name is only ever used to say which file the message is about — the catalogue
 * by default, since that is the one three commands ask about.
 */
export function declaredDigest(text: string, file = CATALOGUE_FILE): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const match = DIGEST_LINE.exec(firstLine);

  if (!match) {
    throw new CatalogueRefreshError(
      `${file} should start with a "${DIGEST_PREFIX}<64 hex digits>" ` +
        `line. It starts with ${JSON.stringify(firstLine)}.`
    );
  }

  return match[1];
}

/**
 * Everything below a digested file's first line, having checked that it is what
 * the first line says it is.
 */
function verifiedBody(text: string, file: string): string {
  const declared = declaredDigest(text, file);
  const newline = text.indexOf("\n");
  const body = text.slice(newline + 1);
  const found = digestOf(body);

  if (found !== declared) {
    throw new CatalogueRefreshError(
      `${file} does not match its own digest.\n` +
        `  declared: ${declared}\n` +
        `  found:    ${found}\n` +
        `The file has been edited or truncated since it was generated. ` +
        `Regenerate it rather than repairing it by hand.`
    );
  }

  return body;
}

/**
 * A digested file's data rows, having checked its header is exactly the columns
 * expected. The header check is what stops a column being added, renamed or
 * reordered from silently shifting what every field below it means.
 */
function dataRowsOf(
  text: string,
  file: string,
  columns: readonly string[]
): string[][] {
  const rows = parseCsv(verifiedBody(text, file));
  const [header, ...dataRows] = rows;

  if (
    !header ||
    header.length !== columns.length ||
    !header.every((column, index) => column === columns[index])
  ) {
    throw new CatalogueRefreshError(
      `${file} has an unexpected header row.\n` +
        `  expected: ${JSON.stringify(columns)}\n` +
        `  found:    ${JSON.stringify(header ?? [])}`
    );
  }

  return dataRows;
}

const COLLECTION_URL_ORIGIN = "https://www.cpap.com";
const COLLECTION_URL_PREFIX = "/collections/";

/**
 * Refuses anything that is not an `https://www.cpap.com/collections/…` URL.
 *
 * This is the only hand-entered URL in the pipeline. A Resolved Product's URL
 * is Shopify's own `onlineStoreUrl` (ADR-0009) and so is a URL by
 * construction; a Collection Link's is typed by a curator into a committed
 * file. It also has the widest blast radius of any string here, because
 * Discourse refuses the whole `profile_link_fields` value rather than the one
 * Mapping it dislikes (ADR-0016) — one typo takes every Profile Link down, not
 * just this one.
 *
 * Shape only, and deliberately not existence: whether Shopify admits the
 * collection is a different question, asked on refresh against Shopify itself
 * (ADR-0020, and #37's "a collection Shopify does not admit is reported rather
 * than shipped"). This check is the cheap, offline half, and it is the half
 * that runs on every read.
 */
function assertCollectionUrl(url: string, where: string): void {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new CatalogueRefreshError(
      `${where} has the url ${JSON.stringify(url)}, which is not a URL.`
    );
  }

  if (parsed.origin !== COLLECTION_URL_ORIGIN) {
    throw new CatalogueRefreshError(
      `${where} has the url ${JSON.stringify(url)}, whose origin is ` +
        `${JSON.stringify(parsed.origin)} rather than ` +
        `${JSON.stringify(COLLECTION_URL_ORIGIN)}. A Profile Link points at ` +
        `cpap.com over https or it is somebody else's store.`
    );
  }

  if (
    !parsed.pathname.startsWith(COLLECTION_URL_PREFIX) ||
    parsed.pathname === COLLECTION_URL_PREFIX
  ) {
    throw new CatalogueRefreshError(
      `${where} has the url ${JSON.stringify(url)}, whose path is ` +
        `${JSON.stringify(parsed.pathname)} rather than ` +
        `${JSON.stringify(COLLECTION_URL_PREFIX)} and a collection handle. A ` +
        `Collection Link that points at a product page is a Resolved Product ` +
        `in the wrong file (ADR-0021).`
    );
  }
}

/**
 * The Collection Links a file holds, refusing anything that is not exactly what
 * `collectionLinksCsv` writes.
 *
 * The suffix is checked here, on exact bytes. A Collection Link's value is the
 * string a User's stored value is matched against and the anchor text they
 * read, so ` (discontinued)` or `(Discontinued)` without its leading space is
 * not a near miss — it is a different value, which resolves for nobody while
 * looking right in a diff.
 */
export function readCollectionLinks(text: string): CollectionLink[] {
  const dataRows = dataRowsOf(
    text,
    COLLECTION_LINKS_FILE,
    COLLECTION_LINK_COLUMNS
  );

  return dataRows.map((row, index) => {
    const [userFieldName, value, url] = row;
    const where = `${COLLECTION_LINKS_FILE} row ${index + 2}`;

    if (!userFieldName || !value || !url) {
      throw new CatalogueRefreshError(
        `${where} has an empty field: ${JSON.stringify(row)}`
      );
    }

    if (!value.endsWith(COLLECTION_LINK_SUFFIX)) {
      throw new CatalogueRefreshError(
        `${where} has the value ${JSON.stringify(value)}, which does not end ` +
          `in ${JSON.stringify(COLLECTION_LINK_SUFFIX)}. Every Collection ` +
          `Link says so in its own value, because the value is also the ` +
          `anchor text a User reads (ADR-0020).`
      );
    }

    assertCollectionUrl(url, where);

    return { userFieldName, value, url };
  });
}

/**
 * The catalogue a file holds, refusing anything that is not exactly what
 * `resolvedProductsCsv` writes. The digest check is the reason this exists: a
 * catalogue is approved by a human once and then read by two more commands, so
 * an edit made to the file afterwards has to be loud.
 */
export function readResolvedProducts(text: string): ResolvedProduct[] {
  const dataRows = dataRowsOf(text, CATALOGUE_FILE, CATALOGUE_COLUMNS);

  return dataRows.map((row, index) => {
    const [userFieldName, value, handle, status, url] = row;
    const where = `${CATALOGUE_FILE} row ${index + 2}`;

    if (!userFieldName || !value || !handle || !url) {
      throw new CatalogueRefreshError(
        `${where} has an empty field: ${JSON.stringify(row)}`
      );
    }

    if (!isStatus(status)) {
      throw new CatalogueRefreshError(
        `${where} has status ${JSON.stringify(status)}, which is not one of ` +
          `${STATUSES.join(", ")}`
      );
    }

    return { userFieldName, value, handle, status, url };
  });
}

/**
 * The review document: what would ship, what would not and why, and where the
 * spreadsheet and the live catalogue disagree. It is the thing a human approves
 * before anything is applied, so it reports facts and does not summarise them
 * away — every Mapping, every exclusion, both directions of the disagreement.
 *
 * There is deliberately no timestamp. A refresh that changes nothing produces
 * the same document, which is what makes a change in it worth reading.
 */
export function renderReviewDocument({
  catalogue,
  exclusions,
  sheetRows,
  products,
  digest,
}: ReviewInput): string {
  const named = new Set<string>([
    ...catalogue.map((entry) => entry.handle),
    ...exclusions.map((entry) => entry.handle).filter(Boolean),
  ]);
  const unnamed = products.filter(
    (product) =>
      product.status === "ACTIVE" &&
      product.divisionFields.length > 0 &&
      !named.has(product.handle)
  );
  const inStockUnpublished = products.filter(
    (product) =>
      product.onlineStoreUrl === null &&
      product.totalInventory > 0 &&
      product.status === "ACTIVE"
  );
  const fields = DIVISIONS.map((division) =>
    summarize(division, { catalogue, exclusions, sheetRows, products, unnamed })
  );

  const sections: string[] = [
    `# Catalogue review`,
    `The Resolved Product Catalogue below was built from the committed Sheet ` +
      `Exports and the live cpap.com Shopify catalogue. Nothing reaches a ` +
      `Discourse instance until someone approves it.`,
    [
      `- Catalogue digest: \`${digest}\``,
      `- Catalogue file: \`${CATALOGUE_FILE}\``,
      `- Mappings: ${catalogue.length}`,
      `- Excluded Suggested Titles: ${exclusions.length}`,
      `- Shopify Admin API ${SHOPIFY_API_VERSION}, read-only, ${products.length} products seen`,
    ].join("\n"),
    `Regenerating this document from unchanged inputs produces an identical ` +
      `file — there is no timestamp in it on purpose, so anything that changes ` +
      `here is a change in the catalogue. The one thing that moves on its own is ` +
      `the stock column: those are the quantities Shopify held at the moment of ` +
      `the query, and a trading store changes them between one refresh and the ` +
      `next. The catalogue file carries no stock and so does not move.`,
    renderCounts(fields),
    ...fields.map(renderFieldSection),
    renderExclusions(exclusions),
    renderDisagreement(exclusions, unnamed),
    renderInStockUnpublished(inStockUnpublished),
  ];

  return `${sections.join("\n\n")}\n`;
}

/** One Custom User Field's row of the count table and its own section. */
interface FieldSummary {
  division: Division;
  /**
   * Whether the field's spreadsheet tab curates Suggested Titles at all. This is
   * what separates the two ways a field can end up with no Mappings, and they
   * are opposites: a tab with no Suggested columns has no Mappings by design,
   * while an empty `Mask` would mean every curated title failed to resolve.
   * Reporting the same sentence for both would hide the second.
   */
  curatesTitles: boolean;
  sheetTitles: number;
  entries: ResolvedProduct[];
  excluded: number;
  live: number;
  unnamed: number;
}

/**
 * Whether the named field's spreadsheet tab curates Suggested Titles at all.
 * Shared with the command's own summary line, so "does this field curate
 * titles" is decided once rather than re-derived from `SHEET_TABS` wherever
 * it is needed.
 *
 * Throws for a field `SHEET_TABS` has never heard of, rather than guessing:
 * `DIVISIONS` is a separate, hand-written list, so a future field added to one
 * and not the other is a programming mistake, and `undefined !== null` would
 * silently misclassify it as curating titles instead of surfacing the gap.
 */
export function curatesTitles(userFieldName: string): boolean {
  const tab = SHEET_TABS.find(
    (candidate) => candidate.userFieldName === userFieldName
  );

  if (!tab) {
    throw new CatalogueRefreshError(
      `"${userFieldName}" names no tab in SHEET_TABS. Every field this ` +
        `reasons about has to be in the allowlist somewhere, or this is being ` +
        `asked about a field the Sheet Export does not know.`
    );
  }

  return tab.titleColumn !== null;
}

function summarize(
  division: Division,
  {
    catalogue,
    exclusions,
    sheetRows,
    products,
    unnamed,
  }: {
    catalogue: readonly ResolvedProduct[];
    exclusions: readonly ExcludedProduct[];
    sheetRows: readonly SheetRow[];
    products: readonly SurveyedProduct[];
    unnamed: readonly SurveyedProduct[];
  }
): FieldSummary {
  const field = division.userFieldName;
  const titles = new Set(
    sheetRows
      .filter((row) => row.userFieldName === field && row.suggestedTitle.trim())
      .map((row) => normalizeTitle(row.suggestedTitle))
  );

  return {
    division,
    curatesTitles: curatesTitles(field),
    sheetTitles: titles.size,
    entries: catalogue.filter((entry) => entry.userFieldName === field),
    excluded: exclusions.filter((entry) => entry.userFieldName === field)
      .length,
    // `ACTIVE` only, and not simply "every product carrying the tag": the
    // by-handle fetch brings back archived products, which also carry their
    // division tag, and counting those would overstate what is on sale.
    live: products.filter(
      (product) =>
        product.status === "ACTIVE" && product.divisionFields.includes(field)
    ).length,
    unnamed: unnamed.filter((product) => product.divisionFields.includes(field))
      .length,
  };
}

function renderCounts(fields: readonly FieldSummary[]): string {
  return [
    `## Counts per Custom User Field`,
    tableRow([
      `Custom User Field`,
      `Suggested Titles in the sheet`,
      `Mappings`,
      `Excluded`,
      `Live products in the division`,
      `Live products the sheet never names`,
    ]),
    tableRow(["---", "---", "---", "---", "---", "---"]),
    ...fields.map((field) =>
      tableRow([
        field.division.userFieldName,
        `${field.sheetTitles}`,
        `${field.entries.length}`,
        `${field.excluded}`,
        `${field.live}`,
        `${field.unnamed}`,
      ])
    ),
    `"Live products in the division" counts \`ACTIVE\` products carrying the ` +
      `division tag: ${DIVISIONS.map((division) => `\`${division.tag}\``).join(
        ", "
      )}. Whether those are the right divisions to measure against is a product ` +
      `question, which is why the tag is printed rather than assumed.`,
  ].join("\n");
}

function renderFieldSection(field: FieldSummary): string {
  const name = field.division.userFieldName;
  const tab = `user_${name.toLowerCase()}`;

  if (field.entries.length === 0 && !field.curatesTitles) {
    return [
      `## ${name} — no Mappings, and that is expected`,
      `The \`${tab}\` tab of the spreadsheet has no Suggested Title or ` +
        `Suggested URL columns at all, so there is nothing to map. The Custom ` +
        `User Field stays in place with no Mappings behind it rather than ` +
        `shipping an entry with an empty mapping list, which would be a ` +
        `configuration problem (ADR-0012).`,
      `Shopify currently sells ${field.live} ${name.toLowerCase()} products, so ` +
        `a list is possible if product wants one. That is a decision, not a ` +
        `missing piece of work.`,
    ].join("\n\n");
  }

  if (field.entries.length === 0) {
    return [
      `## ${name} — no Mappings, and that is a problem`,
      `The \`${tab}\` tab curates ${field.sheetTitles} Suggested Titles and not ` +
        `one of them resolved to a linkable product. That is not the case of a ` +
        `field with no Suggested columns at all: something has changed about ` +
        `the tab, the handles or the catalogue. Read the exclusions below ` +
        `before applying anything.`,
    ].join("\n\n");
  }

  return [
    `## ${name} — ${field.entries.length} Mappings`,
    tableRow([
      `Mapping value (Suggested Title, verbatim)`,
      `Profile Link URL (Shopify \`onlineStoreUrl\`)`,
      `Handle`,
    ]),
    tableRow(["---", "---", "---"]),
    ...field.entries.map((entry) =>
      tableRow([entry.value, entry.url, entry.handle])
    ),
  ].join("\n");
}

function renderExclusions(exclusions: readonly ExcludedProduct[]): string {
  const sections = EXCLUSION_REASONS.map((reason) => {
    const matching = exclusions.filter((entry) => entry.reason === reason);
    const heading = `### \`${reason}\` — ${matching.length}`;
    const description = REASON_DESCRIPTIONS[reason];

    if (matching.length === 0) {
      return [heading, description, `None.`].join("\n\n");
    }

    return [
      heading,
      description,
      [
        tableRow([
          `Custom User Field`,
          `Suggested Title`,
          `Handle`,
          `What Shopify reported`,
        ]),
        tableRow(["---", "---", "---", "---"]),
        ...matching.map((entry) =>
          tableRow([
            entry.userFieldName,
            entry.value || `_(blank)_`,
            entry.handle || `_(none)_`,
            entry.detail,
          ])
        ),
      ].join("\n"),
    ].join("\n\n");
  });

  return [
    `## Excluded Suggested Titles — ${exclusions.length}`,
    `Every Suggested Title the spreadsheet offers that produced no Mapping, ` +
      `under the reason it produced none. Every reason is listed even when ` +
      `nothing fell under it, so an empty section is a fact rather than an ` +
      `omission.`,
    ...sections,
  ].join("\n\n");
}

function renderDisagreement(
  exclusions: readonly ExcludedProduct[],
  unnamed: readonly SurveyedProduct[]
): string {
  // The sheet decides membership and Shopify decides validity (ADR-0010), so
  // these two lists are not symmetrical in what they oblige anyone to do. The
  // first is a list of curated titles that will not ship; the second is a list
  // of products nobody has curated, which is only a problem if product says so.
  const sheetOnly = exclusions.filter(
    (entry) =>
      entry.reason !== "blank-title" && entry.reason !== "discontinued-suffix"
  );

  const sections = [
    `## The sheet and the live catalogue disagree in both directions`,
    `### Suggested Titles the live catalogue will not back — ${sheetOnly.length}`,
    `Curated titles that Shopify cannot supply a storefront link for. Each one ` +
      `is a Dropdown Option a user could select and get no Profile Link from, ` +
      `which is why they are excluded from both sinks rather than only from the ` +
      `Mappings.`,
  ];

  if (sheetOnly.length === 0) {
    sections.push(`None.`);
  } else {
    sections.push(
      [
        tableRow([`Custom User Field`, `Suggested Title`, `Reason`, `Detail`]),
        tableRow(["---", "---", "---", "---"]),
        ...sheetOnly.map((entry) =>
          tableRow([
            entry.userFieldName,
            entry.value || `_(blank)_`,
            `\`${entry.reason}\``,
            entry.detail,
          ])
        ),
      ].join("\n")
    );
  }

  sections.push(
    `### Live products the spreadsheet never names — ${unnamed.length}`,
    `Products cpap.com currently sells in these divisions that no Suggested ` +
      `Title or Suggested URL in the spreadsheet points at. They are out of ` +
      `scope by construction — the sheet defines membership — and are listed ` +
      `so the gap is a decision rather than a discovery.`,
    `The list is unfiltered on purpose. It includes machine-and-mask bundles, ` +
      `replacement parts and internal records, so it is not a count of products ` +
      `missing from the list — it is everything the division tag covers, which is ` +
      `also the evidence for whether the tag is the right thing to measure ` +
      `against.`
  );

  if (unnamed.length === 0) {
    sections.push(`None.`);
  } else {
    sections.push(
      [
        tableRow([`Division`, `Shopify title`, `Handle`, `Stock`]),
        tableRow(["---", "---", "---", "---"]),
        ...unnamed.map((product) =>
          tableRow([
            product.divisionFields.join(", "),
            product.title,
            product.handle,
            `${product.totalInventory}`,
          ])
        ),
      ].join("\n")
    );
  }

  return sections.join("\n\n");
}

function renderInStockUnpublished(
  products: readonly SurveyedProduct[]
): string {
  const sections = [
    `## In stock but not published to the Online Store — ${products.length}`,
    `\`ACTIVE\` products with inventory on hand and no storefront URL. Nothing ` +
      `in this pipeline can link to them, and nothing in this pipeline can fix ` +
      `that: publishing a product to the Online Store sales channel is a ` +
      `merchandising action.`,
  ];

  if (products.length === 0) {
    sections.push(`None.`);
  } else {
    sections.push(
      [
        tableRow([`Shopify title`, `Handle`, `Stock`, `Divisions`]),
        tableRow(["---", "---", "---", "---"]),
        ...products.map((product) =>
          tableRow([
            product.title,
            product.handle,
            `${product.totalInventory}`,
            product.divisionFields.join(", ") || `_(none of the three)_`,
          ])
        ),
      ].join("\n")
    );
  }

  return sections.join("\n\n");
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.map(cell).join(" | ")} |`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/**
 * A CSV field, quoted only where it has to be. Suggested Titles carry commas —
 * `DreamWear Full Face Mask (S, M, L)` and its relatives — so this is not a
 * theoretical case.
 */
function csvLine(fields: readonly string[]): string {
  return fields
    .map((field) =>
      /[",\r\n]/.test(field) || field !== field.trim()
        ? `"${field.replace(/"/g, '""')}"`
        : field
    )
    .join(",");
}

/**
 * The `data` of a GraphQL response, refusing an error the transport called a
 * success. Shopify answers HTTP 200 with an `errors` array for a throttled or
 * malformed query, so a run that only checked the status code would carry on
 * with no products and report every curated title as missing.
 */
function dataOf(body: unknown, what: string): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new CatalogueRefreshError(
      `${what} returned something that is not a JSON object`
    );
  }

  const errors = body["errors"];

  if (errors !== undefined && errors !== null) {
    throw new CatalogueRefreshError(
      `${what} was refused by Shopify: ${describeErrors(errors)}`
    );
  }

  const data = body["data"];

  if (!isRecord(data)) {
    throw new CatalogueRefreshError(`${what} returned no "data" object`);
  }

  return data;
}

function describeErrors(errors: unknown): string {
  if (!Array.isArray(errors)) {
    return JSON.stringify(errors);
  }

  return errors
    .map((error) =>
      isRecord(error) && typeof error["message"] === "string"
        ? error["message"]
        : JSON.stringify(error)
    )
    .join("; ");
}

/**
 * One product, checked field by field. Every one of these is used to decide
 * whether a link ships, so a field that arrived as the wrong type — or did not
 * arrive at all, which is what a renamed field looks like — stops the run
 * instead of being read as a falsy value.
 */
function productFrom(node: unknown, where: string): SurveyedProduct {
  if (!isRecord(node)) {
    throw new CatalogueRefreshError(`${where} is not a product object`);
  }

  const handle = node["handle"];
  const title = node["title"];
  const status = node["status"];
  const tags = node["tags"];
  const totalInventory = node["totalInventory"];
  const onlineStoreUrl = nullableString(
    node["onlineStoreUrl"],
    `${where} has a non-string, non-null onlineStoreUrl`
  );

  if (typeof handle !== "string" || handle === "") {
    throw new CatalogueRefreshError(`${where} has no handle`);
  }

  if (typeof title !== "string") {
    throw new CatalogueRefreshError(`${where} has no title`);
  }

  if (!isStatus(status)) {
    throw new CatalogueRefreshError(
      `${where} has status ${JSON.stringify(status)}, which is not one of ` +
        `${STATUSES.join(", ")}`
    );
  }

  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    throw new CatalogueRefreshError(`${where} has no tags array`);
  }

  if (typeof totalInventory !== "number") {
    throw new CatalogueRefreshError(`${where} has no totalInventory`);
  }

  return {
    handle,
    title,
    status,
    tags: tags as string[],
    onlineStoreUrl,
    totalInventory,
    divisionFields: divisionFieldsOf(tags as string[]),
  };
}

/**
 * A field that is legitimately either a string or `null` — Shopify uses `null`
 * for "no storefront URL" and "no further pages", and both of those are facts
 * rather than absences. Anything else is a response this command did not ask
 * for, which is why the type check is not a coercion.
 */
function nullableString(value: unknown, message: string): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (value !== null) {
    throw new CatalogueRefreshError(message);
  }

  return null;
}

function isStatus(value: unknown): value is ProductStatus {
  return STATUSES.includes(value as ProductStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
