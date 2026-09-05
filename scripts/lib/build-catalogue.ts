// The catalogue transform. Every decision about which curated product titles
// ship, what they link to, why the rest were left out, and the order a user
// scrolls them in happens here — and nowhere else. It is pure: no network, no
// filesystem, no clock, no environment. The commands around it fetch, read,
// write and print, so there is nowhere in them for a decision to hide.
//
// The rules it applies are recorded in docs/adr/0009 (Shopify is the authority
// for product URLs), 0010 (the sheet defines membership, Shopify defines
// validity), 0020 (discontinued equipment links to a collection) and 0021 (a
// Collection Link is a Mapping with no Dropdown Option).

// The one import, and it is `import type`, so it is erased before anything
// runs: `sheet-export.ts` already type-imports `SheetRow` from here, and two
// runtime imports pointing at each other would be a cycle. What crosses the
// line is a shape, not a behaviour — `AssignmentRow` is the schema of the
// curated table, and the transform below is the thing that decides what a row
// of it means. Importing the reader itself would cost the purity the three
// commands rely on; importing what the reader produces costs nothing.
import type { AssignmentRow } from "./sheet-export.ts";

/**
 * One row of a Sheet Export, reduced to the four columns that carry meaning:
 * the legacy identity the row speaks for, and the Suggested pair it maps to.
 * The rest of the spreadsheet describes the legacy bulletin board it was
 * written for.
 */
export interface SheetRow {
  /** The Custom User Field this tab maps to — `Machine`, `Mask`. */
  userFieldName: string;
  /**
   * The `Value` column: the legacy phpBB option identifier, which is what a
   * migrated member is actually holding. It is the key the Collection
   * Assignment is curated against, so a row that reached the transform without
   * it could be judged but not assigned.
   */
  legacyValue: string;
  /**
   * The `Text` column: the name the bulletin board displayed for that value.
   * Provenance for most rows, and the base name a Collection Link is built
   * from on the four retired catch-all Suggested Titles (ADR-0020).
   */
  legacyText: string;
  /** The `Suggested Title` column, as the sheet holds it. */
  suggestedTitle: string;
  /** The `Suggested URL` column. Read for its slug only, never carried through. */
  suggestedUrl: string;
}

/**
 * Shopify's product statuses. Only `ACTIVE` is admissible.
 *
 * `UNLISTED` is the one to know about: it means the product is buyable by direct
 * link but hidden from storefront collections and search, and the cpap.com
 * catalogue currently has two of them under the Machines division. A profile
 * link to an unlisted product would resolve, so treating it as inadmissible is a
 * choice — an unlisted product has been deliberately taken out of the catalogue,
 * and every exclusion is reported with its status, so a reviewer who disagrees
 * can see exactly which titles it cost.
 */
export type ProductStatus = "ACTIVE" | "ARCHIVED" | "DRAFT" | "UNLISTED";

/** The slice of a Shopify product this transform judges. */
export interface ProductRecord {
  handle: string;
  title: string;
  status: ProductStatus;
  tags: string[];
  /**
   * Shopify's canonical storefront URL, already `https://www.cpap.com/…`. Null
   * when the product was never published to the Online Store sales channel,
   * which is a different fact from being archived and has to stay distinct.
   */
  onlineStoreUrl: string | null;
}

/** A Suggested Title joined to a live, linkable product. */
export interface ResolvedProduct {
  userFieldName: string;
  /** The Suggested Title verbatim — never Shopify's product title (ADR-0010). */
  value: string;
  handle: string;
  status: ProductStatus;
  /** Shopify's `onlineStoreUrl`, never a rewritten spreadsheet URL (ADR-0009). */
  url: string;
}

/**
 * A Profile Link whose target is a cpap.com collection page rather than a
 * product page, for equipment cpap.com no longer sells (ADR-0020).
 *
 * It is deliberately not a `ResolvedProduct` and deliberately not a flag on
 * one. There is no `handle` and no `status` because a collection has neither,
 * and inventing sentinels for them would mean relaxing
 * `readResolvedProducts` for every row and making the Resolved Product
 * Catalogue mean two things at once. Being a separate type in a separate array
 * is what makes the asymmetry structural: `dropdownOptionsFor` cannot emit one
 * because it is never handed one (ADR-0021).
 */
export interface CollectionLink {
  userFieldName: string;
  /**
   * The equipment's name with `COLLECTION_LINK_SUFFIX` appended. This is both
   * the value a User holds and the anchor text they read, which is why there is
   * no separate display label: a second string can drift from the first, and
   * the value is the only place a Collection Link can describe itself honestly.
   */
  value: string;
  /** The curated cpap.com collection URL. */
  url: string;
}

/**
 * The literal appended to a Collection Link's value — one leading space, one
 * capital `D`, no variants. Exported because resolution is an exact trimmed
 * string match against what the User holds, so this string is load-bearing and
 * every place that asserts it has to be asserting the same bytes.
 *
 * Not to be confused with the ` (discontinued)` the exclusion check below
 * matches on: that one is a lowercased comparison form for spotting the four
 * retired legacy catch-all titles in the spreadsheet, and it is never a value
 * this pipeline writes.
 */
export const COLLECTION_LINK_SUFFIX = " (Discontinued)";

/**
 * Why a Suggested Title did not make the catalogue. Each value is a separate
 * fact someone can act on, which is the reason they are not collapsed into one
 * "failed" outcome — an unpublished product is a merchandising job, a missing
 * handle is a data job, and a legacy catch-all is neither.
 */
export type ExclusionReason =
  /** The row carries no Suggested Title at all. */
  | "blank-title"
  /** The title ends in ` (Discontinued)` — legacy bookkeeping, not a product. */
  | "discontinued-suffix"
  /** Neither the Suggested URL's slug nor the title found a product. */
  | "no-matching-product"
  /** The title matched more than one product, so no single answer is safe. */
  | "ambiguous-title-match"
  /** Shopify reports the product as anything other than `ACTIVE`. */
  | "not-active"
  /** The product is live but was never published to the Online Store. */
  | "unpublished"
  /** Shopify carries the authoritative `Discontinued` tag on the product. */
  | "discontinued-tag";

/**
 * Which exclusion reasons earn a Collection Link, as a table the compiler
 * checks rather than a list a reader has to trust. Adding a reason to
 * `ExclusionReason` without deciding this is a type error, which is the point:
 * a reason nobody classified would silently take the `false` branch and lose
 * every value behind it, and losing a value is the exact failure ADR-0020
 * reversed ADR-0012 to stop.
 *
 * The two `false`s are the interesting ones. `blank-title` has no name to build
 * a value out of. `ambiguous-title-match` means the title matched more than one
 * product, which is evidence the equipment is *still sold* and the Sheet Export
 * is wrong — a Collection Link there would bury a fixable data fault behind a
 * plausible link, so the row stays in the review document until a human
 * disambiguates it (ADR-0020).
 */
const EARNS_COLLECTION_LINK: Record<ExclusionReason, boolean> = {
  "blank-title": false,
  "discontinued-suffix": true,
  "no-matching-product": true,
  "ambiguous-title-match": false,
  "not-active": true,
  unpublished: true,
  "discontinued-tag": true,
};

/**
 * Whether an excluded Suggested Title goes on to become a Collection Link.
 *
 * Exported because the review document says so per reason, and a report that
 * disagreed with the transform about which exclusions still get a link would be
 * worse than a report that never mentioned it.
 */
export function earnsCollectionLink(reason: ExclusionReason): boolean {
  return EARNS_COLLECTION_LINK[reason];
}

/** A Suggested Title left out of the catalogue, with the reason it was. */
export interface ExcludedProduct {
  userFieldName: string;
  value: string;
  /**
   * The product handle involved — the one Shopify matched, or the one the join
   * looked for, or empty when the Suggested URL named none.
   */
  handle: string;
  reason: ExclusionReason;
  /** Every fact behind the reason, so precedence between them loses nothing. */
  detail: string;
}

/**
 * Why a value that earned a Collection Link did not get one. Every one of them
 * is a fact about the curated table or the store rather than about the member's
 * value, which is why they are reported separately from `ExcludedProduct`: an
 * Excluded Product is the pipeline working, and one of these is the pipeline
 * unable to finish a job it was asked to do.
 */
export type CollectionLinkProblem =
  /** No Collection Assignment row claims this legacy value. */
  | "unassigned-legacy-value"
  /** The row's `Disposition` is `undecided` — nobody has looked yet. */
  | "undecided-disposition"
  /** The assigned collection is one Shopify does not admit, or is no URL. */
  | "unadmitted-collection"
  /** Stripping the suffix leaves no name, so the value would be the suffix alone. */
  | "no-base-name"
  /** The derived value and the row's curated `Profile Link Value` differ. */
  | "curation-disagreement"
  /** Two legacy values derive one value and disagree about its collection. */
  | "conflicting-collection";

/** A Collection Link that could not be derived, and everything known about it. */
export interface CollectionLinkFault {
  userFieldName: string;
  /**
   * The legacy `Value`s the fault is about — the phpBB identifiers, because
   * that is the column the Collection Assignment is keyed on and so the thing a
   * curator opens the Sheet to find.
   *
   * A list rather than a string, and always a list even when it holds one.
   * Most faults are about a single legacy value, but a `conflicting-collection`
   * is about the several that collided on one derived value, and a field that
   * held either one identifier or a comma-joined run of them would leave every
   * consumer to guess which it had — including the one that has to render them.
   */
  legacyValues: string[];
  /** The value that would have shipped, as far as it could be derived. */
  value: string;
  problem: CollectionLinkProblem;
  /** Every fact behind the problem, in the terms a curator would fix it in. */
  detail: string;
}

export interface CatalogueInput {
  sheetRows: SheetRow[];
  products: ProductRecord[];
  /**
   * The Collection Assignment, as the committed export holds it. This is what
   * replaced the hand-seeded collection-links file: the file is still written
   * and still committed, but every row in it is now derived from these two
   * inputs rather than typed by a person.
   *
   * Required, and not optional, for the reason `renderFieldMappings` takes no
   * default: a caller who leaves them out gets no Collection Links and no
   * complaint, and none of them means to.
   */
  assignments: readonly AssignmentRow[];
  /**
   * The collection handles Shopify admits, as `collectionHandleFromUrl` spells
   * them. Whether a collection exists is a fact Shopify owns (ADR-0009), so it
   * is asked of Shopify and handed in here rather than assumed from a
   * well-formed URL.
   *
   * Admission is not reachability: this says the collection exists in the
   * store's admin data, not that its public page serves. That second question
   * is Catalogue Verify's, deliberately and separately (ADR-0017).
   */
  admittedCollections: readonly string[];
}

export interface CatalogueResult {
  catalogue: ResolvedProduct[];
  exclusions: ExcludedProduct[];
  /**
   * The third output, alongside the catalogue and the Excluded Products. It
   * goes to the Mappings sink and nowhere else (ADR-0021).
   */
  collectionLinks: CollectionLink[];
  /**
   * The fourth: the links that should have been derived and were not. They are
   * reported rather than shipped, and reported rather than dropped — a value a
   * member is holding that resolves to nothing is the failure this whole
   * mechanism exists to prevent, so it does not get to be a silent zero.
   */
  collectionFaults: CollectionLinkFault[];
}

/** One entry of the `profile_link_fields` setting value. */
export interface FieldMapping {
  user_field_name: string;
  mappings: { value: string; url: string }[];
}

/** The Dropdown Options one Custom User Field should offer. */
export interface FieldOptions {
  user_field_name: string;
  options: string[];
}

const DISCONTINUED_SUFFIX = " (discontinued)";
const DISCONTINUED_TAG = "discontinued";
const ADMISSIBLE_STATUS: ProductStatus = "ACTIVE";

/**
 * Titles are compared case-insensitively and with runs of whitespace collapsed,
 * because two Dropdown Options differing only in case or spacing are a defect
 * rather than two products — the test instance's hand-entered `DreamStation` /
 * `Dreamstation` pair is what that looks like in practice.
 *
 * Exported because the Catalogue Refresh's review document counts distinct
 * Suggested Titles per field, and a report that disagreed with the transform
 * about which two titles are the same title would be worse than no report.
 */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The product handle a Suggested URL identifies, or an empty string when it
 * identifies none. Only a `/products/<handle>` path counts: some Suggested URLs
 * point at a collection page and one points at a search results page, and
 * inventing a handle out of either is how a confident wrong answer gets shipped
 * (ADR-0009). Those rows fall through to the title match instead.
 *
 * Exported because the Catalogue Refresh has to ask Shopify about exactly the
 * handles this join will look for. If the command worked out the handles some
 * other way it could fetch a product the transform never consults, or miss one
 * it does.
 */
export function handleFromSuggestedUrl(suggestedUrl: string): string {
  const match = /\/products\/([^/?#]+)/.exec(suggestedUrl);

  return match ? match[1] : "";
}

/**
 * The collection handle a curated collection URL identifies, or an empty string
 * when it identifies none. The sibling of `handleFromSuggestedUrl`, and
 * exported for the same reason: the Catalogue Refresh has to ask Shopify about
 * exactly the handles this join will look for, and a command that worked them
 * out some other way could admit a collection the transform never consults.
 *
 * Shape only. Whether the handle names a collection that exists is Shopify's
 * answer, not this function's (ADR-0009).
 */
export function collectionHandleFromUrl(url: string): string {
  const match = /\/collections\/([^/?#]+)/.exec(url);

  return match ? match[1] : "";
}

function isDiscontinued(product: ProductRecord): boolean {
  return product.tags.some(
    (tag) => tag.trim().toLowerCase() === DISCONTINUED_TAG
  );
}

/**
 * Sorts by title the way a person reads a dropdown: case-insensitively, so
 * `AirFit` and `airFit` sit together instead of in two blocks, and falling back
 * to code point order so the result never depends on which two strings were
 * compared first. `localeCompare` is deliberately not used — its answer varies
 * with the host's locale and ICU build, and the committed catalogue has to be
 * byte-identical on every machine that regenerates it.
 */
function compareValues(a: string, b: string): number {
  const loweredA = a.toLowerCase();
  const loweredB = b.toLowerCase();

  if (loweredA !== loweredB) {
    return loweredA < loweredB ? -1 : 1;
  }

  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

/**
 * Turns Sheet Exports and Shopify products into the Resolved Product Catalogue,
 * plus the Excluded Products that did not make it and why.
 *
 * The sheet decides membership and Shopify decides validity (ADR-0010), so a
 * title Shopify never heard of is reported rather than dropped, and a product
 * Shopify carries that the sheet does not name is simply not in scope.
 */
export function buildCatalogue({
  sheetRows,
  products,
  assignments,
  admittedCollections,
}: CatalogueInput): CatalogueResult {
  const byHandle = new Map<string, ProductRecord>();
  const byTitle = new Map<string, ProductRecord[]>();

  for (const product of products) {
    if (!byHandle.has(product.handle)) {
      byHandle.set(product.handle, product);
    }

    const key = normalizeTitle(product.title);
    const sameTitle = byTitle.get(key);

    if (sameTitle) {
      sameTitle.push(product);
    } else {
      byTitle.set(key, [product]);
    }
  }

  const catalogue: ResolvedProduct[] = [];
  const exclusions: ExcludedProduct[] = [];
  const fieldOrder: string[] = [];
  const seen = new Set<string>();

  for (const row of sheetRows) {
    const userFieldName = row.userFieldName;

    if (!fieldOrder.includes(userFieldName)) {
      fieldOrder.push(userFieldName);
    }

    // Verbatim apart from surrounding whitespace, because resolution is an
    // exact trimmed-string match against what the user selected.
    const value = row.suggestedTitle.trim();

    // The spreadsheet is a legacy migration map, so it names each product once
    // per legacy value it replaced — forty-eight rows for four titles in one
    // case. First occurrence wins; title and URL are 1:1 across the source.
    // The separator is a NUL rather than a space or a slash: it cannot occur
    // in a field name or a title, so no two different pairs can collide on one
    // key. It is written as an escape because a literal NUL byte in the source
    // makes git treat the whole file as binary and stop showing its diffs.
    const key = `${userFieldName}\u0000${normalizeTitle(value)}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    if (!value) {
      exclusions.push({
        userFieldName,
        value,
        handle: "",
        reason: "blank-title",
        detail: "the row has no Suggested Title",
      });
      continue;
    }

    if (normalizeTitle(value).endsWith(DISCONTINUED_SUFFIX)) {
      exclusions.push({
        userFieldName,
        value,
        handle: handleFromSuggestedUrl(row.suggestedUrl),
        reason: "discontinued-suffix",
        detail:
          "the Suggested Title is a legacy catch-all naming no equipment, so " +
          "it is retired as a value. The row's own legacy name earns a " +
          "Collection Link instead (ADR-0020, superseding ADR-0012)",
      });
      continue;
    }

    const wantedHandle = handleFromSuggestedUrl(row.suggestedUrl);
    let product = wantedHandle ? byHandle.get(wantedHandle) : undefined;

    if (!product) {
      const candidates = byTitle.get(normalizeTitle(value)) ?? [];

      if (candidates.length === 1) {
        product = candidates[0];
      } else if (candidates.length > 1) {
        exclusions.push({
          userFieldName,
          value,
          handle: wantedHandle,
          reason: "ambiguous-title-match",
          detail: `the Suggested Title matches ${candidates.length} products: ${candidates
            .map((candidate) => candidate.handle)
            .join(", ")}`,
        });
        continue;
      }
    }

    if (!product) {
      exclusions.push({
        userFieldName,
        value,
        handle: wantedHandle,
        reason: "no-matching-product",
        detail: wantedHandle
          ? `no product has the handle "${wantedHandle}", and none is titled "${value}"`
          : `the Suggested URL names no product, and no product is titled "${value}"`,
      });
      continue;
    }

    // Every fact Shopify gave, whichever one the reason names. A product can be
    // archived and tagged and unpublished at once — `Morf Nasal Mask` is two of
    // the three — and reporting only the first would make the exclusion list
    // less useful than the API response it came from.
    const facts = [`status ${product.status}`];

    if (isDiscontinued(product)) {
      facts.push("tagged Discontinued");
    }

    if (!product.onlineStoreUrl) {
      facts.push("not published to the Online Store");
    }

    const detail = facts.join("; ");

    // Precedence runs from the most fundamental fact outward: a product that is
    // not live cannot be published, and one that is not published cannot be
    // linked. `detail` carries the rest either way.
    if (product.status !== ADMISSIBLE_STATUS) {
      exclusions.push({
        userFieldName,
        value,
        handle: product.handle,
        reason: "not-active",
        detail,
      });
      continue;
    }

    if (!product.onlineStoreUrl) {
      exclusions.push({
        userFieldName,
        value,
        handle: product.handle,
        reason: "unpublished",
        detail,
      });
      continue;
    }

    if (isDiscontinued(product)) {
      exclusions.push({
        userFieldName,
        value,
        handle: product.handle,
        reason: "discontinued-tag",
        detail,
      });
      continue;
    }

    catalogue.push({
      userFieldName,
      value,
      handle: product.handle,
      status: product.status,
      url: product.onlineStoreUrl,
    });
  }

  // Order is decided here rather than left to fall out of a serialiser: it is
  // what a user scrolls, and a structure whose order is incidental reshuffles
  // itself whenever the spreadsheet is edited. Fields keep the order the sheet
  // presented them in; titles within a field are alphabetical.
  const fieldRank = new Map(fieldOrder.map((name, index) => [name, index]));
  const byFieldThenValue = (
    a: { userFieldName: string; value: string },
    b: { userFieldName: string; value: string }
  ): number =>
    (fieldRank.get(a.userFieldName) ?? 0) -
      (fieldRank.get(b.userFieldName) ?? 0) || compareValues(a.value, b.value);

  catalogue.sort(byFieldThenValue);
  exclusions.sort(byFieldThenValue);

  // Derived here rather than passed in. The Collection Links are a function of
  // the Excluded Products this same call produced and the curated assignment
  // table, so anywhere else would have to either recompute the exclusions or
  // trust a caller's copy of them.
  //
  // Sorted on the way out by the same rule as the other two, so the order the
  // Mappings ship in is decided once. Only this output can reach the `?? 0`
  // fallback above, and now only barely: a Collection Link takes its field name
  // from the sheet row it was derived from, so it is always ranked. The
  // fallback stays because `byFieldThenValue` is the comparator for three
  // arrays and a comparator that assumes its input is a defect waiting on a
  // fourth.
  const { collectionLinks, faults } = deriveCollectionLinks({
    sheetRows,
    exclusions,
    assignments,
    admittedCollections,
  });

  collectionLinks.sort(byFieldThenValue);

  return {
    catalogue,
    exclusions,
    collectionLinks,
    collectionFaults: faults,
  };
}

/**
 * Everything `deriveCollectionLinks` judges, and nothing it does not.
 *
 * Not exported, and neither is the function: `buildCatalogue` is the only
 * caller and the only way anyone should reach this. Every other export in this
 * file is exported because a command or a report needs it and says so; a seam
 * exported on the strength of being a seam is one more entry point to keep
 * honest for no caller's benefit.
 */
interface DerivationInput {
  sheetRows: readonly SheetRow[];
  /** The Excluded Products, as `buildCatalogue` produced them. */
  exclusions: readonly ExcludedProduct[];
  assignments: readonly AssignmentRow[];
  admittedCollections: readonly string[];
}

/** The links that could be derived, and the ones that could not. */
interface DerivationResult {
  collectionLinks: CollectionLink[];
  faults: CollectionLinkFault[];
}

/**
 * A carried ` (Discontinued)` in whatever form the source happens to hold it —
 * any casing, any run of leading whitespace, and only at the very end.
 *
 * It is stripped and the canonical `COLLECTION_LINK_SUFFIX` re-appended rather
 * than left alone, which does two jobs in one step. The suffix is never
 * doubled, and the bytes are always the ones `readCollectionLinks` insists on:
 * a value ending ` (discontinued)` is not a near miss but a different string,
 * one that resolves for nobody while looking right in a diff. The only text
 * this rewrites is the pipeline's own literal; the equipment's name is
 * untouched.
 */
const CARRIED_SUFFIX = /\s*\(discontinued\)$/i;

/**
 * The Collection Links a Catalogue Refresh derives, and the ones it refuses to.
 *
 * It walks the Sheet Exports rather than the Excluded Products, and that is the
 * whole reason the two catch-all cases behave differently. `buildCatalogue`
 * reduces the sheet to one Excluded Product per distinct Suggested Title, so
 * the forty-six rows carrying `CPAP Machines (Discontinued)` and its three
 * siblings arrive there as four. Forty-six members' machines are named in those
 * rows' `Text` columns, and walking the titles would ship four links where
 * forty-six are owed. Walking the rows and collapsing on the *derived value*
 * gets both halves of ADR-0020 from one rule: rows sharing a real Suggested
 * Title collapse, because they derive the same name, and catch-all rows do not,
 * because each derives its own.
 *
 * Every judgement it makes is checked against the curated table's own answer.
 * `Profile Link Value` is what a curator believes the value should be, derived
 * by hand from the same ADR-0020 rule this function applies, and
 * `spec/unit/collection-assignment.test.ts` already holds the committed table
 * to it. So a disagreement means the transform and the table have diverged, and
 * exactly one of them is right — reported and not shipped, rather than
 * reconciled silently in favour of whichever this function happened to compute.
 */
function deriveCollectionLinks({
  sheetRows,
  exclusions,
  assignments,
  admittedCollections,
}: DerivationInput): DerivationResult {
  const reasonByTitle = new Map<string, ExclusionReason>();

  for (const exclusion of exclusions) {
    reasonByTitle.set(
      `${exclusion.userFieldName}\u0000${normalizeTitle(exclusion.value)}`,
      exclusion.reason
    );
  }

  // Keyed on the legacy identifier, because that is the column a curator
  // assigns against and the string a migrated member is holding. A few rows
  // fold several identifiers into one assignment, and they all resolve to it.
  // First wins if two rows claim one identifier, on the same terms as the
  // `byHandle` map in `buildCatalogue`: the table is exported from a Sheet whose
  // rows are seeded one-to-one from the option tables, so a second claim is a
  // curation mistake rather than a second opinion, and it surfaces as a
  // `curation-disagreement` the moment the two rows propose different values.
  const assignmentByLegacyValue = new Map<string, AssignmentRow>();

  for (const assignment of assignments) {
    for (const legacyValue of legacyValuesOf(assignment)) {
      const key = `${assignment.field}\u0000${legacyValue}`;

      if (!assignmentByLegacyValue.has(key)) {
        assignmentByLegacyValue.set(key, assignment);
      }
    }
  }

  const admitted = new Set(admittedCollections);
  const faults: CollectionLinkFault[] = [];
  const groups = new Map<string, DerivedGroup>();

  for (const row of sheetRows) {
    const userFieldName = row.userFieldName;
    const suggestedTitle = row.suggestedTitle.trim();
    const legacyValue = row.legacyValue.trim();
    const reason = reasonByTitle.get(
      `${userFieldName}\u0000${normalizeTitle(suggestedTitle)}`
    );

    // No exclusion means the title resolved to a live product, so the row has a
    // Mapping already and is none of this function's business.
    if (reason === undefined || !earnsCollectionLink(reason)) {
      continue;
    }

    const fault = (
      problem: CollectionLinkProblem,
      value: string,
      detail: string
    ): void => {
      faults.push({
        userFieldName,
        legacyValues: [legacyValue],
        value,
        problem,
        detail,
      });
    };

    const assignment = assignmentByLegacyValue.get(
      `${userFieldName}\u0000${legacyValue}`
    );

    if (!assignment) {
      fault(
        "unassigned-legacy-value",
        "",
        `the Suggested Title ${JSON.stringify(suggestedTitle)} was excluded as ` +
          `\`${reason}\`, which earns a Collection Link, but no Collection ` +
          `Assignment row claims this legacy value`
      );
      continue;
    }

    switch (assignment.disposition) {
      case "plain-text":
      case "resolves-to-product":
        // Both are decisions a curator recorded, and neither is a Collection
        // Link. `resolves-to-product` in particular is not a dropped row — the
        // legacy identifier still carries the live product's value downstream —
        // it just does not carry one from here.
        continue;
      case "undecided":
        fault(
          "undecided-disposition",
          assignment.profileLinkValue.trim(),
          `the Collection Assignment row for this legacy value is still ` +
            `\`undecided\`. That is an absence of evidence rather than a ` +
            `preference, so it blocks the link rather than quietly resolving ` +
            `to none (ADR-0021)`
        );
        continue;
      case "collection":
        break;
    }

    // ADR-0020's derivation, and the only exception to ADR-0010 there is. The
    // Suggested Title is the curated name and normally wins outright; on the
    // four retired catch-all titles it names no equipment at all, so the row
    // takes the name the bulletin board actually showed its members instead.
    // `discontinued-suffix` *is* the catch-all case — it is the reason those
    // four titles were excluded — so the branch is read off the exclusion the
    // transform already made rather than re-derived from the title here.
    const baseName = (
      reason === "discontinued-suffix" ? row.legacyText : suggestedTitle
    )
      .trim()
      .replace(CARRIED_SUFFIX, "")
      .trim();

    if (!baseName) {
      fault(
        "no-base-name",
        "",
        `the ${
          reason === "discontinued-suffix"
            ? "legacy display text"
            : "Suggested Title"
        } leaves nothing once the suffix is stripped, so the value would be ` +
          `${JSON.stringify(COLLECTION_LINK_SUFFIX)} and nothing else — a ` +
          `string that names no equipment and matches no member (ADR-0020)`
      );
      continue;
    }

    const value = `${baseName}${COLLECTION_LINK_SUFFIX}`;
    const curated = assignment.profileLinkValue.trim();

    if (value !== curated) {
      fault(
        "curation-disagreement",
        value,
        `the Collection Assignment row declares a Base Name Source of ` +
          `${JSON.stringify(assignment.baseNameSource)} and a Profile Link ` +
          `Value of ${JSON.stringify(curated)}, but this row was excluded as ` +
          `\`${reason}\` and so derives ${JSON.stringify(value)}. One of the ` +
          `two is wrong and this cannot say which`
      );
      continue;
    }

    const url = assignedCollectionUrl(assignment);
    const handle = collectionHandleFromUrl(url);

    if (!handle || !admitted.has(handle)) {
      fault(
        "unadmitted-collection",
        value,
        handle
          ? `Shopify admits no collection with the handle ` +
              `${JSON.stringify(handle)}, which is what ${JSON.stringify(url)} ` +
              `names. A collection that does not exist is a link to nothing, ` +
              `and whether it exists is Shopify's answer (ADR-0009)`
          : `the assigned collection ${JSON.stringify(url)} names no ` +
              `collection handle at all, so there is nothing to ask Shopify about`
      );
      continue;
    }

    const key = `${userFieldName}\u0000${value}`;
    const group = groups.get(key);

    if (group) {
      const sharing = group.urls.get(url);

      if (sharing) {
        sharing.push(legacyValue);
      } else {
        group.urls.set(url, [legacyValue]);
      }
    } else {
      groups.set(key, {
        userFieldName,
        value,
        urls: new Map([[url, [legacyValue]]]),
      });
    }
  }

  const collectionLinks: CollectionLink[] = [];

  for (const group of groups.values()) {
    const [first, ...rest] = [...group.urls];

    // One value resolves one URL: a Mapping is keyed on its value within a
    // field, so shipping both would be a `duplicate-value` Config Problem on
    // every page load, resolved by row order — which is not a decision anyone
    // made. Shipping the first would be the same decision, made quietly.
    if (rest.length > 0) {
      faults.push({
        userFieldName: group.userFieldName,
        legacyValues: [...group.urls.values()].flat(),
        value: group.value,
        problem: "conflicting-collection",
        detail:
          `the legacy values behind this one value are assigned to different ` +
          `collections: ` +
          [first, ...rest]
            .map(([url, legacyValues]) => `${url} (${legacyValues.join(", ")})`)
            .join("; ") +
          `. They share a Suggested Title, so they collapse to one Mapping, ` +
          `and one Mapping has one URL`,
      });
      continue;
    }

    collectionLinks.push({
      userFieldName: group.userFieldName,
      value: group.value,
      url: first[0],
    });
  }

  faults.sort(
    (a, b) =>
      compareValues(a.userFieldName, b.userFieldName) ||
      compareValues(a.value, b.value) ||
      compareValues(a.legacyValues.join(), b.legacyValues.join())
  );

  return { collectionLinks, faults };
}

/** One derived value, and every collection the rows behind it were assigned. */
interface DerivedGroup {
  userFieldName: string;
  value: string;
  urls: Map<string, string[]>;
}

/**
 * The collection one Collection Assignment row points at.
 *
 * The `Override` is the curator's last word and wins outright: the
 * recommendation is a proposal, and a proposal that could quietly beat the
 * correction someone made against it would make the column pointless. An empty
 * `Override` is an empty cell rather than a decision, so it falls through
 * (compare ADR-0019, where an empty override on the *setting* is an accident
 * with the opposite consequence and has to be migrated out).
 *
 * Exported because the Catalogue Refresh has to ask Shopify about exactly the
 * collections this join will look for, and a command that applied the
 * precedence the other way round would verify the recommendation and ship the
 * override.
 */
export function assignedCollectionUrl(assignment: AssignmentRow): string {
  return (
    assignment.override.trim() || assignment.recommendedCollectionUrl.trim()
  );
}

/** The legacy identifiers one assignment row speaks for. A few fold several. */
function legacyValuesOf(assignment: AssignmentRow): string[] {
  return assignment.legacyPnums
    .split(",")
    .map((legacyValue) => legacyValue.trim())
    .filter((legacyValue) => legacyValue !== "");
}

/**
 * The shape both sinks group on: a Custom User Field, a value, and the URL that
 * value resolves to. A `ResolvedProduct` is one of these plus a handle and a
 * status; a `CollectionLink` is exactly one.
 */
interface MappingEntry {
  userFieldName: string;
  value: string;
  url: string;
}

function groupByField<Entry extends MappingEntry>(
  entries: readonly Entry[]
): { userFieldName: string; entries: Entry[] }[] {
  const groups: { userFieldName: string; entries: Entry[] }[] = [];

  for (const entry of entries) {
    const group = groups.find((g) => g.userFieldName === entry.userFieldName);

    if (group) {
      group.entries.push(entry);
    } else {
      groups.push({ userFieldName: entry.userFieldName, entries: [entry] });
    }
  }

  return groups;
}

/**
 * The value of the `profile_link_fields` setting, as a data structure rather
 * than YAML text — the serialiser stays outside the tested surface.
 *
 * A Custom User Field with nothing behind it produces no entry at all. An entry
 * with an empty `mappings` list is a Config Problem, so shipping one would be
 * worse than shipping nothing (ADR-0012).
 *
 * This is the sink that takes both arrays. The products come first within each
 * field and the Collection Links after them, because one concatenation of two
 * already-ordered lists is an order anyone can predict from the inputs
 * (ADR-0021).
 *
 * `fieldOrder` decides the order of the fields themselves, and it has to be
 * passed in because this module reaches for nothing — the option-table
 * allowlist lives in `sheet-export.ts` and importing it here would cost the
 * purity the three commands rely on. Without it, grouping a concatenation puts
 * every product-backed field ahead of a field carrying only Collection Links,
 * which is the one case this sink newly supports.
 *
 * All three parameters are required, and the second deliberately has no default. A
 * default of `[]` would let a caller who forgot the argument drop every
 * Collection Link with no type error — which is the same "guarantee turned into
 * a habit" that ADR-0021 rejected a `kind` discriminator for. A caller that
 * genuinely has none passes `[]` and says so.
 */
export function renderFieldMappings(
  catalogue: readonly ResolvedProduct[],
  collectionLinks: readonly CollectionLink[],
  fieldOrder: readonly string[]
): FieldMapping[] {
  const groups = groupByField<MappingEntry>([...catalogue, ...collectionLinks]);
  const rankOf = (userFieldName: string): number => {
    const rank = fieldOrder.indexOf(userFieldName);

    // A field nobody declared sorts after every field somebody did, rather
    // than tying at 0 and interleaving with them. It should not happen — both
    // sinks are fed from the option-table allowlist — and if it does, the
    // Mapping still ships and lands somewhere predictable.
    return rank === -1 ? fieldOrder.length : rank;
  };

  return groups
    .map((group, index) => ({ group, index }))
    .sort(
      (a, b) =>
        rankOf(a.group.userFieldName) - rankOf(b.group.userFieldName) ||
        a.index - b.index
    )
    .map(({ group }) => ({
      user_field_name: group.userFieldName,
      mappings: group.entries.map((entry) => ({
        value: entry.value,
        url: entry.url,
      })),
    }));
}

/**
 * The Dropdown Options each Custom User Field should offer — the second sink,
 * pushed to a Discourse instance rather than committed (ADR-0011).
 *
 * These come from the same catalogue as the Mappings on purpose. A Dropdown
 * Option with no Mapping behind it is an Unmatched Value: the user selects
 * their machine, no Profile Link appears, and nothing is logged unless Debug
 * Mode is on. Deriving the two lists separately would make that a matter of
 * discipline.
 *
 * It takes only the Resolved Products, and that is the whole guarantee behind
 * Collection Links: this function cannot offer one because it is never handed
 * one, and a `CollectionLink` has no `handle` and no `status` so it cannot be
 * passed as a `ResolvedProduct` either. A `kind` discriminator here would have
 * turned that guarantee into something every future caller has to remember
 * (ADR-0021).
 */
export function dropdownOptionsFor(
  catalogue: readonly ResolvedProduct[]
): FieldOptions[] {
  return groupByField(catalogue).map((group) => ({
    user_field_name: group.userFieldName,
    options: group.entries.map((entry) => entry.value),
  }));
}
