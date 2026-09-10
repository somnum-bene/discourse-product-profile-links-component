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
  assignedCollectionUrl,
  COLLECTION_LINK_SUFFIX,
  COLLECTION_URL_ORIGIN,
  COLLECTION_URL_PREFIX,
  collectionHandleFromUrl,
  type CollectionLink,
  type CollectionLinkFault,
  type CollectionLinkProblem,
  DISPOSITION_OUTCOMES,
  type DispositionOutcome,
  type DispositionRow,
  earnsCollectionLink,
  type ExcludedProduct,
  type ExclusionReason,
  handleFromSuggestedUrl,
  normalizeTitle,
  type ProductRecord,
  type ProductStatus,
  type ResolvedProduct,
  resolvesALink,
  resolvingValues,
  type SheetRow,
  undeliveredValues,
} from "./build-catalogue.ts";
import {
  type AssignmentRow,
  EMAIL_SHAPED,
  MANAGED_FIELDS,
  parseCsv,
  SHEET_TABS,
} from "./sheet-export.ts";

/**
 * How long any one request may take before it is abandoned. Same value and
 * same reason as `catalogue-verify.ts`, which had the only bounded request in
 * the repository: a hung endpoint otherwise blocks indefinitely with nothing
 * on stdout to say why.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

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
 * Written by the same refresh that writes the catalogue, and derived from the
 * Excluded Products and the Collection Assignment rather than hand-authored,
 * which is why it carries a digest of its own.
 */
export const COLLECTION_LINKS_FILE = "data/collection-links.csv";

/**
 * The disposition table: committed, and read by nothing in this repository.
 *
 * It is the one artifact that crosses into the non-public repository that holds
 * member data (#28). Every other output here feeds a Discourse instance; this
 * one feeds a join against a member export, performed somewhere this repository
 * never sees, which is what allows the member-level work to happen without
 * member data ever landing here.
 *
 * Committed for the same reason the catalogue is, and more sharply: the far side
 * consumes a reviewed artifact rather than the output of a command it cannot
 * run. It carries a digest of its own, so a file edited by hand between the
 * review and the join is loud rather than silent.
 */
export const DISPOSITION_FILE = "data/disposition-table.csv";

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
  /**
   * The Collection Links, which ship as Mappings and so belong in the document
   * that approves what ships. Required, not optional: an approver told they
   * are seeing every Mapping has to be seeing every Mapping.
   */
  collectionLinks: readonly CollectionLink[];
  /**
   * The Collection Links that could not be derived. Required for the same
   * reason as the ones that could, and more sharply: these are the values a
   * member is holding that would resolve to nothing, and a document reporting
   * only the successes would read best exactly when it matters most.
   */
  collectionFaults: readonly CollectionLinkFault[];
  /**
   * The disposition table. Required, because it is the one output of a refresh
   * that leaves this repository, and the review document is where a refresh is
   * approved — an approver who was never shown what crosses the boundary is
   * approving the half that stays.
   */
  dispositions: readonly DispositionRow[];
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

/**
 * The disposition table's columns, in order. Six, not the five #28 names: the
 * legacy identifier is only unique within a Custom User Field, and
 * the non-public side has to emit that field's name as one of the three columns
 * Discourse asked for, so a table without it would leave the join deriving it.
 */
export const DISPOSITION_COLUMNS = [
  "user_field_name",
  "legacy_value",
  "legacy_text",
  "value",
  "url",
  "disposition",
] as const;

/**
 * The one column of the disposition table that may be empty. A row with no URL
 * is the point of the fourth acceptance criterion — a value dispositioned
 * `plain-text`, or excluded for a blank or ambiguous title, appears with no URL
 * rather than being omitted — so the reader admits a blank here and nowhere
 * else. `value` is deliberately not on this list: a row that names no value is
 * a member's equipment quietly deleted.
 */
const DISPOSITION_BLANKABLE = ["url"];

/**
 * Where a column sits, for a refusal about it to point at.
 *
 * Every refusal in this file locates a cell and declines to quote it, which
 * makes the coordinate the entire diagnostic rather than a convenience beside
 * the value. So it is derived from `DISPOSITION_COLUMNS` rather than written
 * into the prose: a hand-numbered coordinate that drifted when a column moved
 * would send a reader to the wrong cell with nothing else to go on, and the
 * usual defence against that — printing the value too — is the one thing these
 * messages may not do. The parameter takes the tuple's element type, so a
 * column renamed in one place stops compiling in the other.
 */
function columnAt(name: (typeof DISPOSITION_COLUMNS)[number]): string {
  return `column ${DISPOSITION_COLUMNS.indexOf(name) + 1} (\`${name}\`)`;
}

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
    "The Suggested Title ends in `(Discontinued)`. These are legacy catch-alls naming no equipment at all, so the title is retired as a value and each row takes its own legacy name instead. Exclusion here does not mean no Profile Link: this reason earns a Collection Link (ADR-0020, superseding ADR-0012), and one per row rather than one per title — the four titles below stand for every member bucketed under them.",
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

  for (const [index, row] of rows.entries()) {
    const handle = handleFromSuggestedUrl(row.suggestedUrl);

    if (!handle) {
      continue;
    }

    if (!HANDLE_SHAPE.test(handle)) {
      // Neither the URL nor the handle it yields is quoted, on the same terms
      // as every other refusal that touches a workbook cell. This one is
      // narrow — the cell has to hold `/products/` and then a segment that is
      // not a handle, which free text rarely manages — but narrow is a
      // statement about how often it fires, not about what it prints when it
      // does. `userFieldName` comes from `SHEET_TABS` and is this
      // repository's own word for the field, not anything the tab said.
      throw new CatalogueRefreshError(
        `row ${index + 1} of the exports, under ${row.userFieldName}, has a ` +
          `Suggested URL that names a product whose handle does not match ` +
          `${HANDLE_SHAPE.source}. Refusing to guess what it meant, and not ` +
          `reporting the cell.`
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
 * One request asking a `…ByIdentifier` field about a batch of handles, each
 * under its own alias.
 *
 * Both by-handle queries this file sends have exactly this shape, and both need
 * the same guard on an empty batch — a GraphQL document with no selections is a
 * syntax error, so an empty batch would spend a request to be told so. The
 * alias prefix is what the paired reader walks, so the two are handed the same
 * `Lookup` rather than each spelling `p` or `c` in two places.
 */
interface Lookup {
  /** The operation name, for Shopify's logs and for a readable failure. */
  operation: string;
  /** The `…ByIdentifier` root field to ask. */
  field: string;
  /** The alias prefix each handle's result is returned under. */
  prefix: string;
  /** The selection set, already indented for the body of an alias. */
  selection: string;
  /** What this batch is, for the empty-batch refusal. */
  what: string;
}

const PRODUCT_LOOKUP: Lookup = {
  operation: "ProductsByHandle",
  field: "productByIdentifier",
  prefix: "p",
  selection: PRODUCT_FIELDS,
  what: "by-handle",
};

/**
 * Only the handle is asked for. Whether the collection's public page serves is
 * a different question with a different answer — a collection can exist in the
 * admin, be unpublished to the Online Store, and still 404 for a member — and
 * that question is Catalogue Verify's, deliberately (ADR-0017). This one asks
 * the narrow thing it can answer honestly: does the collection exist.
 */
const COLLECTION_LOOKUP: Lookup = {
  operation: "CollectionsByHandle",
  field: "collectionByIdentifier",
  prefix: "c",
  selection: "handle",
  what: "collection",
};

function byHandleQuery(lookup: Lookup, handles: readonly string[]): string {
  if (handles.length === 0) {
    throw new CatalogueRefreshError(
      `refusing to send a ${lookup.what} query with no handles in it`
    );
  }

  const lookups = handles
    .map(
      (handle, index) =>
        `  ${lookup.prefix}${index}: ${lookup.field}(identifier: { handle: ` +
        `${JSON.stringify(handle)} }) {\n    ${lookup.selection}\n  }`
    )
    .join("\n");

  return `query ${lookup.operation} {\n${lookups}\n}\n`;
}

/**
 * Each handle in a batch that came back as something, paired with the alias it
 * came back under. The misses are dropped, so the result is shorter than the
 * batch and its indices mean nothing — which is why the handle and the alias
 * travel with the node rather than being looked up again by position. A caller
 * indexing `handles` by the position of a surviving node would name the wrong
 * handle in its own failure message, and would do it only once a miss had
 * happened, which is the one moment the message matters.
 *
 * `productByIdentifier` and `collectionByIdentifier` both answer `null` for a
 * handle that does not exist, which is the answer the callers need — the
 * transform reports the miss with the title it was looking for, and this file
 * does not have to. A missing *alias* is a different thing entirely: the
 * response is not the shape the query asked for, and that stops the run.
 */
function nodesFromByHandleResponse(
  lookup: Lookup,
  body: unknown,
  handles: readonly string[]
): { alias: string; handle: string; node: unknown }[] {
  const data = dataOf(body, `the ${lookup.what} query`);
  const found: { alias: string; handle: string; node: unknown }[] = [];

  for (const [index, handle] of handles.entries()) {
    const alias = `${lookup.prefix}${index}`;

    if (!(alias in data)) {
      throw new CatalogueRefreshError(
        `the ${lookup.what} response has no "${alias}" for handle ` +
          `"${handle}". Shopify answered something other than the query that ` +
          `was sent.`
      );
    }

    const node = data[alias];

    if (node !== null) {
      found.push({ alias, handle, node });
    }
  }

  return found;
}

/** One request asking for every product in a batch by handle. */
export function productsByHandleQuery(handles: readonly string[]): string {
  return byHandleQuery(PRODUCT_LOOKUP, handles);
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

/** The products in a by-handle response, in the order the handles were asked for. */
export function productsFromByHandleResponse(
  body: unknown,
  handles: readonly string[]
): SurveyedProduct[] {
  return nodesFromByHandleResponse(PRODUCT_LOOKUP, body, handles).map(
    ({ alias, handle, node }) => productFrom(node, `${alias} ("${handle}")`)
  );
}

/**
 * Every collection handle the Collection Link join will look for, deduplicated
 * and sorted. The sibling of `handlesFromSheetRows`, and sorted for the same
 * reason: the request order decides nothing, and an unstable one makes two runs
 * needlessly hard to compare.
 *
 * Only `collection` rows are asked about. The other three dispositions produce
 * no link, so a request for their collections would spend a Shopify call on an
 * answer nothing reads — and the `resolves-to-product` rows carry prose in that
 * column rather than a URL, which is the shape of thing this quietly skips.
 *
 * Nothing here refuses a malformed handle, and that is the difference from the
 * product side. A Suggested URL that yields a non-handle is a Sheet Export
 * defect that would otherwise be reported as an ordinary miss, so it stops the
 * run; a curated collection that Shopify will not admit is exactly what
 * `unadmitted-collection` exists to report, and reporting one link is better
 * than aborting the other eighty (ADR-0020).
 */
export function collectionHandlesFrom(
  assignments: readonly AssignmentRow[]
): string[] {
  const handles = new Set<string>();

  for (const assignment of assignments) {
    if (assignment.disposition !== "collection") {
      continue;
    }

    const handle = collectionHandleFromUrl(assignedCollectionUrl(assignment));

    if (handle && HANDLE_SHAPE.test(handle)) {
      handles.add(handle);
    }
  }

  return [...handles].sort();
}

/**
 * The Collection Assignment rows still `undecided`, in Sheet order. `undecided`
 * is an absence of evidence rather than a preference, so it blocks a release
 * the way an Unresolved URL does (ADR-0021), and it blocks in both places: a
 * Catalogue Refresh exits non-zero when the Sheet it just read holds one
 * (issue #38, see `refresh-catalogue.ts`), and the standalone check exits
 * non-zero when the committed file does. A refresh still exits zero for the
 * drift faults — `unassigned-legacy-value`, `unadmitted-collection`,
 * `stale-product-resolution`, `curation-disagreement` — which are reported and
 * deliberately not fatal, because they describe a Sheet that has moved rather
 * than a decision nobody has made.
 *
 * This function is what both of them ask. The standalone check runs it over
 * `data/collection-assignment.csv` alone, with no Shopify call and no Excluded
 * Product to join against.
 *
 * A `switch` rather than `=== "undecided"`, so a fifth `Disposition` added to
 * `DISPOSITIONS` fails to compile here instead of silently reading as decided.
 * `resolves-to-product` sits beside `plain-text` and `collection` on purpose:
 * all three are a curator's recorded decision, and only the absence of one
 * blocks anything.
 */
export function undecidedAssignments(
  assignments: readonly AssignmentRow[]
): AssignmentRow[] {
  return assignments.filter((assignment) => {
    switch (assignment.disposition) {
      case "collection":
      case "plain-text":
      case "resolves-to-product":
        return false;
      case "undecided":
        return true;
      default: {
        // Not just documentation: this repository's tsconfig sets neither
        // `strict` nor `noImplicitReturns`, so `Array.prototype.filter`'s
        // `unknown`-returning predicate type would happily accept a case that
        // fell through and returned nothing — which `filter` then treats as
        // `false`, silently letting a fifth `Disposition` read as decided.
        // Assigning to `never` is what actually forces the compiler to
        // reject a case this switch does not handle.
        const exhaustive: never = assignment.disposition;
        throw new CatalogueRefreshError(
          `Unrecognised Disposition ${JSON.stringify(exhaustive)}. ` +
            `undecidedAssignments has not been taught what it means.`
        );
      }
    }
  });
}

/**
 * Whether a cell is an `https:` URL, which is the only thing the disposition
 * table's `url` column may hold besides nothing.
 *
 * Shape only, and deliberately looser than `collectionHandleFromUrl`: this
 * column carries product URLs and collection URLs alike, so it cannot insist on
 * `/collections/`. `https:` rather than any scheme, because these are links
 * Discourse renders for a member to click and the scheme is part of where they
 * land — the same reason `collectionHandleFromUrl` compares `origin`.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** The disposition a legacy value carries when it earned a link and has none. */
export const COLLECTION_LINK_FAULT = "collection-link-fault";

/**
 * The rows of the disposition table that earned a Collection Link and did not
 * get one — the other half of the gate `undecidedAssignments` opens, and the
 * half that catches the case an `undecided` row cannot.
 *
 * `undecided` is a curator saying nobody has looked yet, so it only ever exists
 * where somebody typed the word. A legacy value that newly starts earning a
 * Collection Link — a product Shopify stops selling six months from now — has
 * no Collection Assignment row at all, and an absent row types nothing. It
 * derives `unassigned-legacy-value`, lands here as a `collection-link-fault`,
 * and every other gate stays green: a Catalogue Refresh reports it and exits
 * zero on purpose, and the assignment half of the check reads the curated tab,
 * where the row it is looking for does not exist.
 *
 * The result is the exact outcome ADR-0021 says was rejected — a newly
 * discontinued product silently degrading to no Profile Link, "with nothing to
 * show it had". This is the something to show it.
 *
 * Every one of the nine `CollectionLinkProblem`s reaches the table under this
 * one disposition and every one of them means the same thing, so the gate
 * blocks on the disposition rather than enumerating the reasons behind it: a
 * tenth added later is covered without being listed.
 */
export function unfinishedCollectionLinks(
  rows: readonly DispositionRow[]
): DispositionRow[] {
  return rows.filter((row) => row.disposition === COLLECTION_LINK_FAULT);
}

/** One request asking whether Shopify admits each collection in a batch. */
export function collectionsByHandleQuery(handles: readonly string[]): string {
  return byHandleQuery(COLLECTION_LOOKUP, handles);
}

/**
 * The handles Shopify admitted, out of the batch that was asked about.
 *
 * The handle is read back out of the response rather than echoed from the
 * request, so an answer naming a different collection than the one asked for
 * would not be admitted under the asked-for name.
 */
export function collectionsFromByHandleResponse(
  body: unknown,
  handles: readonly string[]
): string[] {
  return nodesFromByHandleResponse(COLLECTION_LOOKUP, body, handles).map(
    ({ alias, handle, node }) => {
      if (!isRecord(node) || typeof node["handle"] !== "string") {
        throw new CatalogueRefreshError(
          `${alias} ("${handle}") came back without a string "handle"`
        );
      }

      return node["handle"];
    }
  );
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
  const text = `${DIGEST_PREFIX}${digestOf(body)}\n${body}`;

  // Held to its reader, for the reason `dispositionTableCsv` is. A writer
  // enforcing a subset of its reader's rules is a gate that reports success on
  // the way out and failure on the way in, and the file in between is already
  // committed — `refresh-catalogue.ts` writes this one first, so a file the
  // reader would reject leaves the repository holding a regenerated catalogue
  // that no later command can load.
  //
  // Round-tripped rather than restating the rules, so the two cannot drift:
  // whatever `readResolvedProducts` insists on is what this refuses to emit.
  readResolvedProducts(text);

  return text;
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
  const text = `${DIGEST_PREFIX}${digestOf(body)}\n${body}`;

  // Same round-trip, same reason. This reader is the stricter of the two: it
  // holds every value to carrying `COLLECTION_LINK_SUFFIX` and every URL to
  // being a cpap.com collection URL, and a derivation change that broke either
  // would otherwise be written here and only refused on the next read.
  readCollectionLinks(text);

  return text;
}

/**
 * The disposition table as a file, in the same digested shape as the other two.
 *
 * It validates rather than serialising, and it validates with
 * `assertDispositionRow` — the same function the reader uses, so this cannot
 * emit a file `readDispositionTable` would reject. That is not a nicety: the
 * command calls this *before* any write precisely so a refusal costs nothing,
 * which only holds if the refusal is complete. A writer enforcing a subset of
 * its reader's rules is a gate that reports success on the way out and failure
 * on the way in, and the file in between is already committed.
 *
 * Nothing in the pipeline *intends* to put member data in these columns — a
 * legacy identifier, a product name and a URL is what they are for — so the
 * email check inside that validator is a tripwire rather than a filter, and a
 * tripwire belongs at the boundary it guards. `readSheetTab` carries the same
 * one facing the other way, refusing to let member data *in* from the
 * spreadsheet.
 *
 * Intent is the whole of that claim, though, which is why no refusal in here
 * leans on it. `legacy_text` is free text a curator typed into a bulletin
 * board years ago and this pipeline carries verbatim (ADR-0023), and on an
 * unlinked row `value` is a copy of it. Those two columns hold whatever that
 * option table holds, so the refusals name coordinates and quote nothing.
 */
export function dispositionTableCsv(
  dispositions: readonly DispositionRow[]
): string {
  const rows = dispositions.map((entry) => [
    entry.userFieldName,
    entry.legacyValue,
    entry.legacyText,
    entry.value,
    entry.url,
    entry.disposition,
  ]);

  // A refusal rather than a floor in a test, because a test only guards the
  // file on its way into the repository and this guards it on its way out of
  // the transform. Every legacy option value in the Sheet Exports produces a
  // row, so no rows means no legacy values — a truncated or emptied export,
  // which `MAX_DATA_ROWS` cannot notice because it only has a ceiling. Writing
  // it anyway produces a valid, digested, correctly-shaped file that says every
  // member's equipment resolves to nothing, and that is the one output of this
  // pipeline whose emptiness reads as an answer rather than as an error.
  if (rows.length === 0) {
    throw new CatalogueRefreshError(
      emptyTableMessage(
        "this one would have none, so the exports arrived empty"
      )
    );
  }

  for (const [index, row] of rows.entries()) {
    assertDispositionRow(row, `${DISPOSITION_FILE} row ${index + 2}`);
  }

  assertNoResolvingCollisions(dispositions, DISPOSITION_FILE);
  assertNoDuplicateKeys(dispositions, DISPOSITION_FILE);
  // Last of the whole-table rules, because it is the only one with no
  // coordinate to give. A row that contradicts itself and a table that has
  // lost a field can both be true at once, and the row is the more actionable
  // of the two: it names a line to go and look at, where this names an
  // absence. Reporting the specific fault before the summary judgement is
  // also what keeps a fixture exercising one field from meeting this rule
  // instead of the one it is about.
  assertEveryFieldRepresented(dispositions, "the exports arrived with none");

  const body = `${[
    csvLine([...DISPOSITION_COLUMNS]),
    ...rows.map((row) => csvLine(row)),
  ].join("\n")}\n`;

  return `${DIGEST_PREFIX}${digestOf(body)}\n${body}`;
}

/**
 * The disposition table a file holds, refusing anything that is not exactly
 * what `dispositionTableCsv` writes.
 *
 * Read by one command, and by nothing downstream — the far side of it is a
 * different repository — and that is precisely why it exists. The file is
 * reviewed once and then consumed by a join this repository cannot see, so the
 * checks that would normally be a reader's incidental strictness are the only
 * ones the artifact will ever get: the digest and the six columns here, and then
 * everything `assertDispositionRow` insists on, which is the same list the
 * writer is held to. A gate running here is a gate that runs before the file
 * leaves.
 *
 * The one command is `pnpm check:collection-assignment`, which reads the
 * committed table to hold it against the committed Collection Assignment. That
 * is the release gate on the artifact, not a consumer of it: it reads the file
 * to refuse it, and no code in this repository does anything with a
 * `DispositionRow` afterwards.
 */
export function readDispositionTable(text: string): DispositionRow[] {
  const dataRows = dataRowsOf(
    text,
    DISPOSITION_FILE,
    DISPOSITION_COLUMNS,
    DISPOSITION_BLANKABLE
  );

  if (dataRows.length === 0) {
    throw new CatalogueRefreshError(emptyTableMessage("It holds none"));
  }

  const rows = dataRows.map((row, index) => {
    const [userFieldName, legacyValue, legacyText, value, url] = row;
    const disposition = assertDispositionRow(
      row,
      `${DISPOSITION_FILE} row ${index + 2}`
    );

    return { userFieldName, legacyValue, legacyText, value, url, disposition };
  });

  assertNoResolvingCollisions(rows, DISPOSITION_FILE);
  assertNoDuplicateKeys(rows, DISPOSITION_FILE);
  assertEveryFieldRepresented(rows, "it holds none");

  return rows;
}

/**
 * Every rule one row of the disposition table obeys, in the one place both
 * sides of the boundary call.
 *
 * Shared rather than written twice, because the two callers are a writer and
 * the reader of what it wrote, and rules kept in two places drift into a
 * writer that emits what its own reader rejects — a file that passes every
 * gate that produced it and fails the one that consumes it. That already
 * happened once here with the blank-value rule, which is why the shape is now
 * a single validator rather than a habit of keeping them in step.
 *
 * It takes the row as raw fields rather than a `DispositionRow` for the same
 * reason: the reader has six strings out of a CSV and the writer has six
 * strings on their way in, so one signature serves both, and the narrowed
 * `DispositionOutcome` comes back out for the reader to build its row from.
 * `DispositionRow` cannot encode the value/URL correlation in its type, so it
 * has to be enforced somewhere, and somewhere had better be once.
 */
function assertDispositionRow(
  row: readonly string[],
  where: string
): DispositionOutcome {
  const [userFieldName, legacyValue, legacyText, value, url, disposition] = row;

  // Reported by row and column and never by content: this is the tripwire that
  // keeps member data out of the one file that leaves, and a refusal that
  // logged the cell would have published it in the error message.
  // `readSheetTab` carries the same guard facing the other way.
  //
  // The same rule binds every refusal below it, and not as a matter of style.
  // This guard catches one *shape* of member data, so passing it says an email
  // address is not present and nothing more — a name, an address or a member
  // id goes straight through. Treating a clean pass as licence to quote the
  // cell would turn the tripwire into a filter it was never able to be, which
  // is why the refusals below name coordinates and leave the reader to open
  // the file. `columnAt` derives those coordinates so they cannot drift, since
  // there is no value printed beside them to fall back on. The two columns
  // carried verbatim from the bulletin board — `legacy_text` and, on an
  // unlinked row, `value` — are where a contaminated cell would actually land,
  // and they are the two the pairing refusals used to print.
  const offending = row.findIndex((field) => EMAIL_SHAPED.test(field));

  if (offending !== -1) {
    throw new CatalogueRefreshError(
      `${where}, column ${offending + 1} holds something shaped like an ` +
        `email address. This file is the interface to the repository that ` +
        `joins against member data, and it carries no member data of any kind.`
    );
  }

  // Whitespace-only counts as blank, and it has to be said explicitly because
  // nothing upstream trims any more: the display text is carried verbatim on
  // purpose, so `"   "` arrives as three real characters rather than
  // collapsing to `""` on the way. A name of spaces renders as nothing and
  // matches nothing, and it is worse than an empty one because it looks
  // populated in every diff and every reader. `dataRowsOf` cannot catch it
  // either — the field is present.
  const blank = row.findIndex(
    (field, at) => field.trim() === "" && DISPOSITION_COLUMNS[at] !== "url"
  );

  if (blank !== -1) {
    throw new CatalogueRefreshError(
      `${where}, column ${blank + 1} (\`${DISPOSITION_COLUMNS[blank]}\`) ` +
        `holds only whitespace, so it names nothing. Only \`url\` may be ` +
        `empty, and every other column has to hold something that is not just ` +
        `whitespace. A row with no URL carries the legacy display text as its ` +
        `value, so a blank one means its option-table row has an empty ` +
        `\`Text\` and nothing names the equipment at all — a member's ` +
        `equipment quietly deleted.`
    );
  }

  // The join column, held to the two names this repository has. Two separate
  // jobs happen to want it: the far side joins on this column and a name it
  // has never heard of finds no member, and `check-collection-assignment.ts`
  // prints this cell to locate a `collection-link-fault` row it is refusing,
  // in a public CI job. `assertEveryFieldRepresented` asks the other half of
  // the question — that no field is missing — and a superset check cannot
  // notice a row naming a field that does not exist.
  //
  // Not quoted, on the same terms as every refusal here: what the cell holds
  // is what this check could not vouch for.
  if (!MANAGED_FIELDS.includes(userFieldName ?? "")) {
    throw new CatalogueRefreshError(
      `${where}, ${columnAt("user_field_name")} does not name a Managed ` +
        `Field. One of ${MANAGED_FIELDS.join(" or ")} is expected, and what ` +
        `the cell holds instead is not reported. The repository on the far ` +
        `side joins on this column, so a name it has never heard of drops ` +
        `every member holding one of the row's values.`
    );
  }

  // `url` is the one column allowed to be empty, which makes `""` the sentinel
  // every consumer reads as "no link" — `resolvingValues`, the review
  // document's counts, and the committed-file gate all test it exactly. So the
  // column has to be *either* empty or a real URL, with no third state: a
  // whitespace-only cell is not empty and not a URL, and it would slip past
  // both the blank check (which skips this column) and the pairing check
  // (because `"   " !== ""`), leaving a resolving disposition pointing nowhere.
  // Padding around a real URL is refused on the same grounds this file refuses
  // it around a value — the bytes are the interface.
  if (url !== url.trim()) {
    throw new CatalogueRefreshError(
      `${where}, ${columnAt("url")} carries whitespace. This ` +
        `column is either empty or a URL and there is no third state: every ` +
        `consumer reads an empty \`url\` as "no Profile Link resolves", so a ` +
        `cell of spaces is a linked row pointing nowhere that no check ` +
        `downstream would question.`
    );
  }

  // And the other half of "either empty or a real URL", which the whitespace
  // check alone does not give. Without this the column accepts any text at
  // all: a row dispositioned `collection` whose `url` reads as a person's name
  // passes every rule above, the pairing check below (which only asks whether
  // the cell is empty) and the writer, and reaches the non-public repository
  // as a Profile Link target.
  //
  // That is the shape this table exists to make impossible. It is the one
  // artifact crossing the boundary, and a cell that drifted onto a neighbouring
  // column in a workbook whose other tabs hold member data is exactly how
  // something that is not a URL arrives here.
  //
  // The cell is not quoted, for the reason every refusal on this boundary does
  // not quote one: what it holds is what the check could not vouch for.
  if (url !== "" && !isHttpsUrl(url)) {
    throw new CatalogueRefreshError(
      `${where}, ${columnAt("url")} is neither empty nor an \`https:\` URL. ` +
        `A resolving row's URL is what a member's Profile Link opens, so a ` +
        `cell that is not one is a link to nothing at best. What the cell ` +
        `holds is not reported.`
    );
  }

  // The same rule for the same reason one column over, and this is the column
  // it matters most in: `legacy_value` is the join key. The non-public side
  // matches it against the identifier in its member export (CONTEXT.md), which
  // is an exact match on a bare identifier, so a padded key joins to nothing
  // and the member's row is simply not found — a silent miss rather than an
  // error, on the one artifact whose failures this repository cannot observe.
  // `dispositionTable` trims it on the way in for exactly this reason; saying
  // so here is what stops a hand-edit from undoing that quietly, and it is what
  // lets the duplicate check below compare the raw bytes and mean it.
  if (legacyValue !== legacyValue.trim()) {
    throw new CatalogueRefreshError(
      `${where}, ${columnAt("legacy_value")} carries whitespace. ` +
        `This column is the join key the non-public side matches against its ` +
        `member export, and that match is exact, so a padded key finds no ` +
        `member rather than failing.`
    );
  }

  if (!isDispositionOutcome(disposition)) {
    throw new CatalogueRefreshError(
      `${where}, ${columnAt("disposition")} is not one of ` +
        `${DISPOSITION_OUTCOMES.join(", ")}. The non-public side reads this ` +
        `column to decide what to do with the row, so a word it has never ` +
        `heard of is a row it cannot act on. What the cell holds instead is ` +
        `not quoted, and this is the refusal least able to afford quoting it: ` +
        `it fires exactly when the column does not hold one of the words ` +
        `above, which is the case when the columns have shifted and it holds ` +
        `another column's content.`
    );
  }

  // The pairing, asked of the transform rather than restated here. A copy of
  // the rule kept beside the check could refuse a row the transform had just
  // produced, or admit one whose value nothing ships — and it is the second
  // that reaches a member.
  if (resolvesALink(disposition)) {
    if (url === "") {
      throw new CatalogueRefreshError(
        `${where} is \`${disposition}\` and carries no URL. That disposition ` +
          `means a Mapping ships for this value, so a row saying so with ` +
          `nowhere to point is a Profile Link that renders nothing — the ` +
          `failure this whole effort exists to remove.`
      );
    }
  } else if (url !== "") {
    throw new CatalogueRefreshError(
      `${where} is \`${disposition}\` and its ${columnAt("url")} is not ` +
        `empty. That disposition means no Profile Link ships for the value, ` +
        `so a URL beside it is a link nobody assigned — and on a ` +
        `\`plain-text\` row it is a curator's decision overruled.`
    );
  } else if (value !== legacyText) {
    throw new CatalogueRefreshError(
      `${where} carries no URL, so its ${columnAt("value")} has to hold what ` +
        `its ${columnAt("legacy_text")} holds, and the two differ. A value ` +
        `with no Mapping behind it is a string invented for a member to hold ` +
        `that resolves for nobody, and the member's own text is the one ` +
        `string that is theirs to keep (ADR-0020 puts the suffix on anchor ` +
        `text, and an unlinked value has none). These are the two columns ` +
        `carried verbatim from the bulletin board, which is what makes them ` +
        `the two this refusal most has to leave unquoted.`
    );
  }

  return disposition;
}

/**
 * Refuses an unlinked row whose value the runtime would resolve anyway.
 *
 * The per-row rules cannot see this one, because it is not a fact about a row:
 * it is a fact about a row *against every other row*. An unlinked row says the
 * member keeps their text and gets no Profile Link. Resolution is a **trimmed**
 * match on both sides, though (`javascripts/discourse/lib/profile-links.ts`
 * trims each Mapping value into `urlsByValue` and trims the stored value before
 * the lookup), so a legacy text of `"  AirSense 11 AutoSet  "` resolves the
 * `AirSense 11 AutoSet` Mapping perfectly well. The member gets a link and this
 * table says they get none — the row contradicts what it describes.
 *
 * It compares against the table's own linked rows rather than against
 * `settings.yml`, and the two are the same set: every Mapping this repository
 * ships is some linked row's value, because both sinks are built from the same
 * catalogue and Collection Links. So the check needs no second input, which is
 * what lets the writer run it as well as the reader — and the writer is the one
 * that matters, since it runs before anything is committed.
 *
 * Refused rather than reconciled. Which of the two the row should have been is
 * a curator's answer: the collision may be a legacy name that happens to match
 * a product exactly, in which case the row wants `resolves-to-product`, or it
 * may be padding nobody noticed. Deciding here would pick one silently, and
 * this is the artifact where a silent guess reaches a member.
 *
 * The exposure exists *because* the legacy text is now carried verbatim. While
 * it was trimmed the two could not disagree, and trimming was the wrong fix for
 * a different reason (see ADR-0023 and `DispositionRow`).
 */
function assertNoResolvingCollisions(
  rows: readonly DispositionRow[],
  file: string
): void {
  // Keyed to the *row number* rather than the row, because that number is
  // what a refusal here is allowed to say. Pointing a reader at the other row
  // locates everything quoting the two values used to, and carries none of it.
  const resolvable = new Map<string, number>();

  for (const [index, row] of rows.entries()) {
    if (row.url !== "") {
      resolvable.set(`${row.userFieldName}\u0000${row.value.trim()}`, index);
    }
  }

  for (const [index, row] of rows.entries()) {
    if (row.url !== "") {
      continue;
    }

    const collides = resolvable.get(
      `${row.userFieldName}\u0000${row.value.trim()}`
    );

    if (collides !== undefined) {
      throw new CatalogueRefreshError(
        `${file} row ${index + 2} is \`${row.disposition}\`, so it says its ` +
          `legacy value resolves no Profile Link — but its ` +
          `${columnAt("value")} trims to the same string as that of row ` +
          `${collides + 2}, which ships a Mapping. Resolution is a trimmed ` +
          `match on both sides, so the member would get that link and this ` +
          `row says they get none. Which of the two is meant is a curator's ` +
          `answer and not one this can take.`
      );
    }
  }
}

/**
 * Refuses two rows that claim the same legacy option value.
 *
 * `user_field_name` and `legacy_value` are the primary key of this table. The
 * non-public side joins on them — one member holds one identifier per field, so
 * one identifier has to name one answer — and the whole artifact is a promise
 * that looking a key up yields a single row. Two rows under one key breaks the
 * promise in the worst available way: not an error on the far side but a pick,
 * arbitrary and invisible, between two different pieces of equipment to write
 * into a member's profile.
 *
 * It is checkable here and nowhere else. `buildCatalogue` builds a `Map` keyed
 * this way to look outcomes up, so a duplicate silently keeps the last row and
 * both emitted rows inherit one row's outcome; but that file is a pure
 * transform that reports faults and never throws (see `byField`, which ranks an
 * unknown field first rather than throwing, and gives the reason), so a refusal
 * does not belong in it. The transform's job is to describe what the inputs
 * say. Refusing to ship it is this boundary's, alongside every other rule the
 * writer and the reader are both held to.
 *
 * Compares raw rather than trimmed, and that is load-bearing rather than lazy:
 * `assertDispositionRow` has already refused any `legacy_value` carrying
 * whitespace by the time this runs, so trimmed and raw are the same string and
 * a check that trimmed here would be describing a state that cannot reach it.
 */
function assertNoDuplicateKeys(
  rows: readonly DispositionRow[],
  file: string
): void {
  const seen = new Map<string, number>();

  for (const [index, row] of rows.entries()) {
    const key = `${row.userFieldName}\u0000${row.legacyValue}`;
    const first = seen.get(key);

    if (first !== undefined) {
      throw new CatalogueRefreshError(
        `${file} row ${index + 2} repeats the ${columnAt("legacy_value")} ` +
          `and ${columnAt("user_field_name")} already claimed by row ` +
          `${first + 2}. That pair is this table's key: the non-public side ` +
          `looks a member's identifier up in it and expects one row, so two ` +
          `rows mean it picks one of them for that member with nothing to ` +
          `choose on. A repeated identifier is a defect in the Sheet Export ` +
          `rather than something to reconcile here.`
      );
    }

    seen.set(key, index);
  }
}

/**
 * Refuses a table that has lost a whole Managed Field.
 *
 * The empty-table refusal beside this one is the same argument at the only
 * scale it could see: a table with no rows is a claim that no member holds any
 * equipment. But the table covers two fields, and nothing made the row count
 * per-field, so one field could vanish while the other kept the file
 * populated. `readSheetTab` accepts a tab holding a header row and no data —
 * an export truncated to its header, or a range that slid — and such a tab
 * contributes no rows here, so the version of this failure that actually
 * arrives is one field wide.
 *
 * It is the worse half of the two, not the smaller one. An empty file is
 * conspicuous: nobody reviews a header-only artifact and calls it fine. A file
 * missing every Machine row looks entirely normal — right shape, valid digest,
 * hundreds of rows — and says, in the only vocabulary the far side reads, that
 * no member has a machine. Every Machine value then joins to nothing and is
 * dropped, silently, on the one artifact whose failures this repository cannot
 * observe.
 *
 * Held to `SHEET_TABS` because that is the list that decides what a Managed
 * Field is. A field there with no rows is either a truncated export or a field
 * newly added and not yet exported, and both want a human rather than a
 * default. Naming the missing ones quotes `SHEET_TABS` and never the file, so
 * the no-echo rule is untouched: what is printed is this repository's own
 * vocabulary, and the fact being reported is an absence, which has no cell.
 */
function assertEveryFieldRepresented(
  rows: readonly DispositionRow[],
  holds: string
): void {
  const present = new Set(rows.map((row) => row.userFieldName));
  const missing = SHEET_TABS.filter(
    (tab) => !present.has(tab.userFieldName)
  ).map((tab) => tab.userFieldName);

  if (missing.length > 0) {
    throw new CatalogueRefreshError(
      `${DISPOSITION_FILE}: every legacy option value of every Managed Field ` +
        `earns a row, and ${holds} for ${missing.join(" or ")}. A table ` +
        `missing a whole field is not a smaller version of this file. It is a ` +
        `claim that no member holds equipment of that kind — and unlike an ` +
        `empty table it is a claim that looks well-formed, because every ` +
        `other field's rows are still there to make it look so. The far side ` +
        `joins on this column, so those members' values find no row and are ` +
        `dropped. Check the committed \`data/user_*.csv\` for a tab exported ` +
        `down to its header row.`
    );
  }
}

/**
 * Why an empty disposition table is refused, said the same way on both sides.
 * `holds` differs because the remedy does — a writer sends someone to the Sheet
 * Exports, a reader to the file in front of them — but the reason does not.
 */
function emptyTableMessage(holds: string): string {
  return (
    `${DISPOSITION_FILE}: every legacy option value in the Sheet Exports ` +
    `earns a row, and ${holds}. An empty table is not a small version of this ` +
    `file, it is a claim that no member holds any equipment — valid, ` +
    `digested, correctly shaped and entirely wrong. Check the committed ` +
    `\`data/user_*.csv\` first.`
  );
}

/**
 * Whether a string is one of the dispositions the table may emit.
 *
 * Named for the wider vocabulary rather than sharing `sheet-export.ts`'s
 * `isDisposition`, which admits the curator's four and refuses the three the
 * table adds. Two predicates called the same thing with different answers would
 * make "widens and never narrows" impossible to read off the code.
 */
function isDispositionOutcome(value: string): value is DispositionOutcome {
  return (DISPOSITION_OUTCOMES as readonly string[]).includes(value);
}

/**
 * The digest a digested file declares, without reading the rest of it.
 *
 * `file` says which file a failure is about, and it is required. It used to
 * default to the catalogue, which was fine while the catalogue was the only
 * digested file and became a trap the moment it was not: `declaredDigest(
 * linksCsv)` type-checks and then blames `data/resolved-products.csv` for a
 * fault in `data/collection-links.csv`. That is the same defaulted-parameter
 * footgun `renderFieldMappings` and `CatalogueInput` both refuse, in the same
 * module, so it does not get an exception here.
 *
 * The refusal does **not** quote the line it found, and this is the earliest
 * point in every read path, so that matters more here than anywhere else. A
 * file missing its digest line presents its *first data row* as line 1 — that
 * is what "missing" looks like — and quoting it published a row of whatever the
 * file holds before a single other check had run. On the disposition table that
 * is the one artifact that leaves this repository, and this function is the
 * first thing its reader calls.
 *
 * Four commands call it directly, without going through `dataRowsOf`, so the
 * redaction belongs in here rather than in a guard placed in front of it:
 * `refresh`, `apply`, `verify` and `build:settings` each ask a file for its
 * digest before doing anything else. A scan sitting at the top of the reader
 * would have covered one path of the five.
 *
 * Nothing is lost. The line number is always 1, the expectation is spelled out
 * in full, and the reader is one keystroke from the line the message is about.
 * What the echo added was the ability to read file content out of a terminal,
 * which is not a diagnostic feature.
 */
export function declaredDigest(text: string, file: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const match = DIGEST_LINE.exec(firstLine);

  if (!match) {
    throw new CatalogueRefreshError(
      `${file} should start with a "${DIGEST_PREFIX}<64 hex digits>" ` +
        `line on line 1, and does not. Its first line is not quoted here: a ` +
        `file with no digest line presents a data row as its first, and this ` +
        `runs before anything has checked what that row holds.`
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
 * expected and that every row below it is that wide and fully populated.
 *
 * The header check stops a column being added, renamed or reordered from
 * silently shifting what every field below it means. It cannot stop a column
 * added to a *row*, which is the same fault one line further down: an extra
 * field used to be discarded without a word, so `Machine,A (Discontinued),
 * https://…/x,JUNK` read clean. Both readers wanted both checks and each had
 * written the second one itself, in the same words.
 *
 * What stays with the callers is what only they know: the status enum for the
 * catalogue, the suffix and the collection URL for the Collection Links.
 *
 * `blankable` names the columns a blank is meaningful in, and it is required
 * rather than defaulted for the reason `declaredDigest` takes its `file` that
 * way: a defaulted `[]` type-checks at a call site that meant to allow one, and
 * the failure is a reader silently refusing a file its own writer produces.
 * Two of the three callers pass nothing, and say so.
 */
/**
 * Where an offset sits in CSV text: its physical line, and its field within
 * the record that line belongs to.
 *
 * A walk rather than a parse, and that is the point of it. It is used by the
 * one refusal that runs before anything has established the text is even
 * well-formed CSV — before the digest, before the header — so it cannot
 * delegate to `parseCsv`, which throws on an unbalanced quote and would
 * replace a refusal that names a location with one that names none. Counting
 * cannot fail: whatever the text is, every byte before the offset either
 * toggles the quote state, ends a line, ends a field, or does not.
 *
 * It tracks quotes by the same rules `parseCsv` does, so the two agree about
 * which commas and newlines are structural. `""` inside a quoted field toggles
 * twice and nets out, which is the correct answer for a position.
 *
 * The two coordinates are deliberately different in kind. The line is physical
 * because it is the one thing a reader can act on without trusting the file —
 * whether line 1 is a digest or a data row is exactly what is unknown at the
 * caller — while the column is the field's place in its record, which is what
 * names the cell. A newline inside a quoted value advances the line without
 * ending the record, so the two can disagree, and when they do the message
 * says so.
 */
function csvPositionOf(
  text: string,
  offset: number
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  let quoted = false;

  for (let index = 0; index < offset; index += 1) {
    const char = text[index];

    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }

      line += 1;

      // Only a newline outside a quoted field starts a new record, and only a
      // new record restarts the column count.
      if (!quoted) {
        column = 1;
      }

      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (!quoted && char === ",") {
      column += 1;
    }
  }

  return { line, column };
}

function dataRowsOf(
  text: string,
  file: string,
  columns: readonly string[],
  blankable: readonly string[]
): string[][] {
  // The very first thing, ahead of the digest and everything after it.
  //
  // This guard has now been moved twice, each time one step earlier, because
  // each time a diagnostic *above* it turned out to quote the file to explain
  // itself: the header refusal prints the row it found, and `declaredDigest`
  // printed line 1. Placing it third and then second was fixing instances of a
  // class. Placing it first is the fix for the class — every check below it
  // now runs on text that has already been refused if it is contaminated, so a
  // diagnostic added later inherits the guarantee instead of quietly reopening
  // the hole.
  //
  // It reads the raw text, before the digest is verified, which is why it
  // reports a physical **line** rather than a row. It cannot speak in rows:
  // whether line 1 is a digest line or a data row is exactly what is still
  // unknown here, and that ambiguity is the leak it exists to close.
  //
  // Matched against the whole text rather than line by line, and the position
  // is walked out of it rather than re-parsed. A quoted field may contain
  // newlines — `csvLine` writes that shape itself, for any cell holding one —
  // so a physical line is not a record, and the line an address sits on can be
  // the middle of a value that began earlier. Handing that line to `parseCsv`
  // on its own asks it to read a fragment: it either reports column 1 for a
  // continuation line that has no commas of its own, or throws "the response
  // ended inside a quoted field" over the unbalanced quote and loses this
  // refusal altogether, message and coordinates with it.
  //
  // That mattered more than a wrong number usually would, because there is no
  // value printed beside it. The coordinate *is* the diagnostic here, so it
  // has to be right for the trade that removed the value to hold.
  //
  // A single regex over the whole text is no less thorough than one per line:
  // `EMAIL_SHAPED` excludes commas, quotes and whitespace, so a match lies
  // inside exactly one field on exactly one line whichever way it is run.
  const contaminated = EMAIL_SHAPED.exec(text);

  if (contaminated) {
    const { line, column } = csvPositionOf(text, contaminated.index);

    throw new CatalogueRefreshError(
      `${file} line ${line}, column ${column} holds something shaped like an ` +
        `email address — the line it sits on, and its column in the record ` +
        `that line belongs to, which a quoted value spanning lines can start ` +
        `above it. Refusing to read further, and reporting neither the cell ` +
        `nor the line it sits in.`
    );
  }

  const optional = new Set(blankable);
  const rows = parseCsv(verifiedBody(text, file));
  const [header, ...dataRows] = rows;

  // What line 2 holds instead is not quoted, and this diagnostic is the reason
  // the rule needs saying rather than assuming: a file whose header row has
  // been dropped presents a *data* row here, so the refusal for "this is not
  // the header" is reached by exactly the malformation that makes line 2
  // member-adjacent content. The expected names are a constant of this
  // repository and safe to print; the coordinate of the first column that
  // disagrees with them locates the rest.
  const found = header ?? [];
  const differs = columns.findIndex((column, at) => found[at] !== column);

  if (found.length !== columns.length || differs !== -1) {
    throw new CatalogueRefreshError(
      `${file} line 2 should be the header row ` +
        `${JSON.stringify(columns)} and is not: it has ${found.length} ` +
        `columns` +
        (differs === -1
          ? `.`
          : `, and its column ${differs + 1} is not \`${columns[differs]}\`.`) +
        ` What it holds instead is not quoted — a file that has lost its ` +
        `header row reaches this refusal with a data row on the line.`
    );
  }

  return dataRows.map((row, index) => {
    const where = `${file} row ${index + 2}`;

    // Neither of these echoes the row, and the scan above is not the reason.
    // That scan catches one shape of member data, which is what a tripwire is
    // for; it is not a filter, and treating a clean pass through it as licence
    // to print a whole row would make it one. A name, an address or a member
    // id would sail through it. What the coordinates already give is the file,
    // the row and — for the blank — the column, which locates the cell exactly,
    // so the echo was never buying the diagnostic anything the reader could not
    // get by opening the file at the line it was just handed.
    if (row.length !== columns.length) {
      throw new CatalogueRefreshError(
        `${where} has ${row.length} fields where the header declares ` +
          `${columns.length}.`
      );
    }

    const blank = row.findIndex(
      (field, at) => !field && !optional.has(columns[at] ?? "")
    );

    if (blank !== -1) {
      throw new CatalogueRefreshError(
        `${where}, column ${blank + 1} is empty — it names no ${columns[blank]}.`
      );
    }

    return row;
  });
}

/**
 * Refuses anything that is not an `https://www.cpap.com/collections/<handle>`
 * URL.
 *
 * This is the only hand-entered URL in the pipeline. A Resolved Product's URL
 * is Shopify's own `onlineStoreUrl` (ADR-0009) and so is a URL by
 * construction; a Collection Link's is typed by a curator into a committed
 * file. It also has the widest blast radius of any string here, because
 * Discourse refuses the whole `profile_link_fields` value rather than the one
 * Mapping it dislikes (ADR-0016) — one typo takes every Profile Link down, not
 * just this one.
 *
 * The verdict is `collectionHandleFromUrl`'s and nothing else's. The
 * derivation asks Shopify about the handle that function reads, so a gate that
 * judged URLs by its own rules could refuse a URL the derivation had just
 * shipped — a refresh writing a file no other command can load — or admit one
 * whose handle Shopify was never asked about. Everything below the early
 * return exists to explain a refusal, not to decide one.
 *
 * Shape only, and deliberately not existence: whether Shopify admits the
 * collection is a different question, asked on refresh against Shopify itself
 * and reported as `unadmitted-collection` rather than shipped (ADR-0020). This
 * check is the cheap, offline half, and it is the half that runs on every
 * read — `build` and `apply` have no network and would otherwise take a
 * curated URL entirely on trust.
 */
function assertCollectionUrl(url: string, where: string): void {
  if (collectionHandleFromUrl(url) !== "") {
    return;
  }

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

  throw new CatalogueRefreshError(
    `${where} has the url ${JSON.stringify(url)}, whose path is ` +
      `${JSON.stringify(`${parsed.pathname}${parsed.search}${parsed.hash}`)} ` +
      `rather than ${JSON.stringify(COLLECTION_URL_PREFIX)} and one ` +
      `collection handle. A Collection Link that points at a product page is ` +
      `a Resolved Product in the wrong file (ADR-0021), and one carrying a ` +
      `nested path names a page Shopify was never asked to admit (ADR-0009).`
  );
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
    COLLECTION_LINK_COLUMNS,
    []
  );
  const seen = new Map<string, number>();

  return dataRows.map((row, index) => {
    const [userFieldName, value, url] = row;
    const where = `${COLLECTION_LINKS_FILE} row ${index + 2}`;

    if (value.trim() === COLLECTION_LINK_SUFFIX.trim()) {
      throw new CatalogueRefreshError(
        `${where} has the value ${JSON.stringify(value)}, which is the ` +
          `suffix and nothing else. ADR-0020 accepts a category link only ` +
          `because the value names the equipment it replaced — it is both the ` +
          `join key and the anchor text a User reads, so a bare suffix tells ` +
          `them nothing and matches nobody.`
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

    // A Mapping is keyed on its value within a field, so a second row for the
    // same one is not two links: the component reports `duplicate-value` as a
    // Config Problem on every page load and resolves the first. Which of the
    // two URLs wins is then decided by row order, which is not a decision
    // anyone made.
    const key = `${userFieldName}\u0000${value}`;
    const earlier = seen.get(key);

    if (earlier !== undefined) {
      throw new CatalogueRefreshError(
        `${where} repeats the value ${JSON.stringify(value)} for ` +
          `${JSON.stringify(userFieldName)}, already given on row ` +
          `${earlier}. One value resolves one URL, so the second row is ` +
          `either a mistake or a decision nobody recorded.`
      );
    }

    seen.set(key, index + 2);

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
  const dataRows = dataRowsOf(text, CATALOGUE_FILE, CATALOGUE_COLUMNS, []);

  return dataRows.map((row, index) => {
    const [userFieldName, value, handle, status, url] = row;
    const where = `${CATALOGUE_FILE} row ${index + 2}`;

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
 * "Every Mapping" includes the Collection Links. They ship in the same setting
 * from a second file, and a document that showed 55 of 58 while saying it
 * showed all of them would be worse than one that never mentioned them: the
 * approver would have no reason to look.
 *
 * There is deliberately no timestamp. A refresh that changes nothing produces
 * the same document, which is what makes a change in it worth reading.
 */
export function renderReviewDocument({
  catalogue,
  exclusions,
  collectionLinks,
  collectionFaults,
  dispositions,
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
      `- Mappings: ${catalogue.length + collectionLinks.length} ` +
        `(${catalogue.length} Resolved Products, ` +
        `${collectionLinks.length} Collection Links)`,
      `- Collection Links file: \`${COLLECTION_LINKS_FILE}\``,
      `- Excluded Suggested Titles: ${exclusions.length}`,
      `- Collection Links that could not be derived: ` +
        `${undeliveredValues(collectionFaults)} ` +
        `(${collectionFaults.length} reported problems)`,
      `- Disposition table: \`${DISPOSITION_FILE}\`, ` +
        `${dispositions.length} legacy values`,
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
    renderCollectionLinks(collectionLinks),
    renderCollectionFaults(collectionFaults),
    renderDispositions(dispositions),
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

/**
 * The Collection Links section. These ship as Mappings but are not Resolved
 * Products, so they get their own section rather than being folded into a
 * field's table: there is no handle and no status to report, the target is a
 * collection page rather than a product page, and the approver's question
 * about them is a different one — is this the right collection for this
 * equipment (ADR-0020)?
 *
 * Every row here is derived: from an Excluded Product whose reason earns a
 * link, and from the Collection Assignment row that says where it points. None
 * of it is hand-authored any more, so a value in this table that looks wrong is
 * a curation fix in the Sheet rather than an edit to a file.
 */
function renderCollectionLinks(
  collectionLinks: readonly CollectionLink[]
): string {
  const heading = `## Collection Links — ${collectionLinks.length}`;
  const description =
    `Equipment cpap.com no longer sells. Each one ships as a Mapping with no ` +
    `Dropdown Option, so a member who already holds the value keeps a working ` +
    `link and nobody new can choose it (ADR-0020, ADR-0021). The ` +
    `\`${COLLECTION_LINK_SUFFIX.trim()}\` in the value is the anchor text a ` +
    `member reads, not bookkeeping.`;

  if (collectionLinks.length === 0) {
    return [heading, description, `None.`].join("\n\n");
  }

  return [
    heading,
    description,
    [
      tableRow([`Custom User Field`, `Value`, `Collection`]),
      tableRow(["---", "---", "---"]),
      ...collectionLinks.map((link) =>
        tableRow([link.userFieldName, link.value, link.url])
      ),
    ].join("\n"),
  ].join("\n\n");
}

/**
 * What each Collection Link problem means, in a shape the compiler checks — the
 * same arrangement as `REASON_DESCRIPTIONS`, and for the same reason: a problem
 * nobody explained here is a problem nobody reading the document can act on,
 * and adding one to the union without explaining it is a type error.
 */
const PROBLEM_DESCRIPTIONS: Record<CollectionLinkProblem, string> = {
  "unassigned-legacy-value":
    "The Suggested Title was excluded for a reason that earns a Collection Link, and no Collection Assignment row claims the legacy value. Nobody decided against a link here — the row was never put in front of anyone. Add it to the assignment tab and re-export.",
  "undecided-disposition":
    "The Collection Assignment row is still `undecided`. That is an absence of evidence rather than a preference, so it blocks the link rather than quietly resolving to none (ADR-0021). Set a `Disposition` in the Sheet and re-export.",
  "stale-product-resolution":
    "The Collection Assignment row records `resolves-to-product` — the title names a product the store still sells, so the legacy value becomes an ordinary product Mapping and was never a Collection Link candidate. But this refresh excluded that title for a reason that earns a link, so the product it was resolving to is gone. The row is not wrong about what it decided; it is out of date about the store. Point the row at a collection (or at plain text) in the Sheet and re-export. Reported rather than honoured because honouring it is the exact silent degradation ADR-0020 reversed ADR-0012 to prevent: the value would fall back to plain text with no Mapping and no complaint.",
  "unadmitted-collection":
    "The assigned collection is one Shopify does not hold, or the cell names no collection at all. Which collection a piece of retired equipment belongs to is an editorial judgement; whether that collection exists is Shopify's answer, and this is Shopify saying no (ADR-0009, ADR-0020). Note this is existence in the admin catalogue, not that the public page serves — that is Catalogue Verify's question (ADR-0017).",
  "no-base-name":
    "Stripping the suffix left no name behind, so the value would have been ` (Discontinued)` and nothing else. A Collection Link is accepted only because its value names the equipment it replaced — it is both the join key and the anchor text a member reads (ADR-0020).",
  "curation-disagreement":
    "The value this refresh derives and the `Profile Link Value` the assignment row carries are different strings. They are two applications of one rule — ADR-0020's — so exactly one of them is wrong, and this document cannot say which. Nothing is shipped for the row until they agree.",
  "duplicate-assignment":
    "Two or more Collection Assignment rows claim the same legacy value and do not decide the same thing. The assignment tab is seeded one-to-one from the option tables, so a second claim is a curation mistake rather than a second opinion — but which row is the mistake is a curator's answer, and honouring the first would answer it by sheet order. Delete or merge the duplicate in the Sheet and re-export. Rows that repeat a claim and decide identically are left alone, because they change nothing that ships.",
  "conflicting-collection":
    "Two or more legacy values derive the same Collection Link value and were assigned to different collections. They collapse to one Mapping, and a Mapping has one URL — shipping either would be picking one by row order, which is not a decision anyone made.",
  "divided-value":
    "Two or more legacy values derive the same Collection Link value, and only some of them earned a link — the rest are unassigned, `undecided`, `plain-text`, or pointed at a collection Shopify would not admit. A Mapping is keyed on its value and cannot tell which legacy identifier a member arrived by, so shipping the link would hand it to the withheld rows too: a curator's `plain-text` overruled, or a link nobody assigned. The value waits until its rows agree.",
};

/** Every Collection Link problem, in the order the review document reports it. */
export const COLLECTION_LINK_PROBLEMS: readonly CollectionLinkProblem[] =
  Object.keys(PROBLEM_DESCRIPTIONS) as CollectionLinkProblem[];

/**
 * The Collection Links that were owed and not derived.
 *
 * This is the section that has to be readable when it is not empty, which is
 * why every problem gets its own subsection with its own explanation even when
 * there is nothing under it. A refresh that ships almost every link and
 * silently drops one is the failure ADR-0020 reversed ADR-0012 to prevent,
 * arriving one value at a time instead of all at once.
 */
function renderCollectionFaults(
  faults: readonly CollectionLinkFault[]
): string {
  const sections = COLLECTION_LINK_PROBLEMS.map((problem) => {
    const matching = faults.filter((fault) => fault.problem === problem);
    const heading = `### \`${problem}\` — ${matching.length}`;
    const description = PROBLEM_DESCRIPTIONS[problem];

    if (matching.length === 0) {
      return [heading, description, `None.`].join("\n\n");
    }

    return [
      heading,
      description,
      [
        tableRow([
          `Custom User Field`,
          `Legacy value`,
          `Value it would have shipped`,
          `What happened`,
        ]),
        tableRow(["---", "---", "---", "---"]),
        ...matching.map((fault) =>
          tableRow([
            fault.userFieldName,
            fault.legacyValues.join(", "),
            fault.value,
            fault.detail,
          ])
        ),
      ].join("\n"),
    ].join("\n\n");
  });

  return [
    `## Collection Links not derived — ${undeliveredValues(faults)} ` +
      `(${faults.length} reported ` +
      `${faults.length === 1 ? "problem" : "problems"})`,
    `Each row here is a legacy value a member can be holding whose Suggested ` +
      `Title was excluded for one of the five reasons that earns a Collection ` +
      `Link, and which did not get one. The link is reported rather than ` +
      `shipped: a Profile Link pointing at a collection that does not exist, ` +
      `or carrying a value nobody agrees on, is worse than the missing link ` +
      `it would replace. Every one of these is fixed in the Sheet and picked ` +
      `up by the next export.`,
    `The two exclusion reasons that earn no link — \`blank-title\` and ` +
      `\`ambiguous-title-match\` — are not faults and are not here. They are ` +
      `reported as exclusions below, which is where they end (ADR-0020).`,
    ...sections,
  ].join("\n\n");
}

/**
 * The disposition table, as counts rather than rows.
 *
 * Counts and not the table itself, and this is the one section where that is
 * the right call. Every other section reports facts a reviewer has to read one
 * at a time; this one reports the same values a second time, already approved
 * above as Mappings, re-keyed onto the legacy identifiers behind them. Two
 * hundred-odd rows of that would bury the sections that carry new information,
 * and the file is committed, so the rows are reviewable as a diff — which is
 * the better review for them anyway.
 *
 * What the counts are for is the shape of the handoff (#28): an unexpected
 * number of values earning no link is visible immediately, and the split
 * between the seven dispositions is the thing that moves when the store does.
 */
function renderDispositions(dispositions: readonly DispositionRow[]): string {
  const linked = resolvingValues(dispositions);

  return [
    `## Disposition table — ${dispositions.length} legacy values`,
    `The one output of a refresh that leaves this repository. It carries no ` +
      `member data: a legacy identifier, the name the bulletin board showed ` +
      `for it, the chosen value, the target URL and the disposition. The ` +
      `non-public side joins it against a fresh member export to produce the ` +
      `three columns Discourse asked for — member identifier, custom field ` +
      `name, value — and that join is the only thing on either side that ` +
      `touches a member (#28).`,
    `${linked} of these ${linked === 1 ? "resolves" : "resolve"} a Profile ` +
      `Link and ${dispositions.length - linked} ` +
      `${dispositions.length - linked === 1 ? "does" : "do"} not. A value ` +
      `that resolves one ` +
      `carries the Mapping's own bytes; a value that does not carries the ` +
      `legacy display text unchanged, so the member keeps what they entered ` +
      `and simply gets no link. No suffix is added to an unlinked value: ` +
      `${JSON.stringify(COLLECTION_LINK_SUFFIX)} is a Collection Link's own ` +
      `anchor text (ADR-0020), and a value that is not a link has none.`,
    [
      tableRow([`Disposition`, `Legacy values`, `Resolves a Profile Link`]),
      tableRow(["---", "---", "---"]),
      ...DISPOSITION_OUTCOMES.map((disposition) =>
        tableRow([
          `\`${disposition}\``,
          `${
            dispositions.filter((row) => row.disposition === disposition).length
          }`,
          resolvesALink(disposition) ? `yes` : `no`,
        ])
      ),
    ].join("\n"),
    `\`undecided\` and \`collection-link-fault\` are the section above seen ` +
      `from the member's side rather than the curator's — not the last two ` +
      `rows of this table, which are ordered to put the curator's four words ` +
      `first. They do not sum to that section either: an \`undecided\` row is ` +
      `reported there as a Collection Link Fault and counted here under ` +
      `\`undecided\`, because a curator did decide to say so and a gate blocks ` +
      `the release on it (#38). \`collection-link-fault\` is every other way a ` +
      `link went undelivered, and a non-zero number there is work outstanding.`,
  ].join("\n\n");
}

function renderExclusions(exclusions: readonly ExcludedProduct[]): string {
  const sections = EXCLUSION_REASONS.map((reason) => {
    const matching = exclusions.filter((entry) => entry.reason === reason);
    const heading = `### \`${reason}\` — ${matching.length}`;
    // Said per reason rather than only in the prose above, because "excluded"
    // has meant two opposite things since ADR-0020 and the section heading
    // cannot tell them apart: five of these reasons send the title on to a
    // Collection Link, and two end here. Asked of the transform rather than
    // restated, so the document cannot disagree with what shipped.
    const description = `${REASON_DESCRIPTIONS[reason]}${
      earnsCollectionLink(reason)
        ? ` **Earns a Collection Link.**`
        : ` **Earns no Collection Link — these titles end here.**`
    }`;

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
