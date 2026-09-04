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

/**
 * One row of a Sheet Export, reduced to the two columns that carry meaning.
 * The rest of the spreadsheet describes the legacy bulletin board it was
 * written for.
 */
export interface SheetRow {
  /** The Custom User Field this tab maps to — `Machine`, `Mask`. */
  userFieldName: string;
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

export interface CatalogueInput {
  sheetRows: SheetRow[];
  products: ProductRecord[];
  /**
   * The Collection Links, as the committed collection-links file holds them.
   * Hand-seeded for now: deriving them from the Excluded Products and the
   * Collection Assignment is a later step, and this ticket proves the sink
   * path works before anything depends on it.
   *
   * Required, and not optional, for the reason `renderFieldMappings` takes no
   * default: a caller who leaves them out gets no Collection Links and no
   * complaint, and none of them means to.
   */
  collectionLinks: readonly CollectionLink[];
}

export interface CatalogueResult {
  catalogue: ResolvedProduct[];
  exclusions: ExcludedProduct[];
  /**
   * The third output, alongside the catalogue and the Excluded Products. It
   * goes to the Mappings sink and nowhere else (ADR-0021).
   */
  collectionLinks: CollectionLink[];
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
  collectionLinks,
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
          "the Suggested Title is a legacy catch-all for equipment with no " +
          "current equivalent, and links to a category page rather than a " +
          "product (ADR-0012)",
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

  // Sorted on the way through rather than trusted as given, so the order the
  // Mappings ship in is decided here for both arrays by the same rule.
  //
  // Only this output can reach the `?? 0` fallback above: `catalogue` and
  // `exclusions` take their field names from the same `sheetRows` that built
  // `fieldOrder`, so their names are always ranked. A Collection Link is read
  // from a hand-seeded file and can name a field the sheet never presented,
  // which ranks 0 and ties with the first field. It is `renderFieldMappings`
  // that decides where such a field's Mappings land, from the order it is
  // handed.
  const sortedCollectionLinks = [...collectionLinks].sort(byFieldThenValue);

  return { catalogue, exclusions, collectionLinks: sortedCollectionLinks };
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
