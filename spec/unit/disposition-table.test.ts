import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildCatalogue,
  COLLECTION_LINK_SUFFIX,
  DISPOSITION_OUTCOMES,
  type DispositionRow,
  type FieldMapping,
  type ProductRecord,
} from "../../scripts/lib/build-catalogue";
import { SETTINGS_FILE } from "../../scripts/lib/build-settings";
import {
  CATALOGUE_FILE,
  collectionHandlesFrom,
  DISPOSITION_FILE,
  dispositionTableCsv,
  readDispositionTable,
  readResolvedProducts,
} from "../../scripts/lib/catalogue-refresh";
import {
  ASSIGNMENT_TABS,
  assignmentRowsFrom,
  exportFileName,
  type ExportTab,
  SHEET_TABS,
  sheetRowsFrom,
} from "../../scripts/lib/sheet-export";

/**
 * The committed disposition table, held against the committed files it is
 * derived from and the `settings.yml` this repository ships.
 *
 * This file exists because the artifact is the entire interface between this
 * repository and the non-public one that writes to members (#28), and it is the
 * only artifact here that nothing in this repository reads. Every other output
 * is checked by the command that consumes it; this one is checked here or
 * nowhere. What it is checked for is the one property the downstream join
 * cannot survive being wrong about: the value has to be reproducible character
 * for character, because Profile Link resolution is an exact string match and a
 * near miss stores fine and silently renders nothing.
 *
 * Byte-identity is deliberately stricter than the runtime, which resolves on a
 * *trimmed* match on both sides (`javascripts/discourse/lib/profile-links.ts`,
 * which is why `linkCovering` in `plan-apply.ts` trims rather than comparing
 * with `===`). The runtime forgiving a leading space is a property of the
 * runtime. This table is consumed by a different repository doing its own join
 * against a member export, and a value that differs by one byte there is a
 * member whose Profile Link renders nothing. The two must not be "aligned":
 * being stricter than what would work is the only guarantee the join has.
 *
 * ADR-0023 records that decision, because relaxing this gate until it agrees
 * with `linkCovering` is the obvious tidy-up and it would remove the guarantee
 * without failing a single test.
 */

const committed = readFileSync(DISPOSITION_FILE, "utf8");
const rows = readDispositionTable(committed);

function committedExport(tab: ExportTab): string {
  return readFileSync(join("data", exportFileName(tab)), "utf8");
}

const sheetRows = SHEET_TABS.flatMap((tab) =>
  sheetRowsFrom(tab, committedExport(tab))
);
const assignments = ASSIGNMENT_TABS.flatMap((tab) =>
  assignmentRowsFrom(tab, committedExport(tab))
);

interface SettingsFile {
  profile_link_fields: { default: FieldMapping[] };
}

/** Every Mapping the shipped default carries, flattened to what a member matches on. */
const shippedMappings = (
  parse(readFileSync(SETTINGS_FILE, "utf8")) as SettingsFile
).profile_link_fields.default.flatMap((field) =>
  field.mappings.map((mapping) => ({
    userFieldName: field.user_field_name,
    value: mapping.value,
    url: mapping.url,
  }))
);

const shippedByValue = new Map(
  shippedMappings.map((mapping) => [
    `${mapping.userFieldName}\u0000${mapping.value}`,
    mapping.url,
  ])
);

/**
 * The same Mappings keyed the way the *runtime* keys them.
 *
 * `profile-links.ts` trims each Mapping value into `urlsByValue` and trims the
 * stored value before the lookup, so this is the map that answers "will a
 * member holding this string get a link". Deliberately not the map the
 * byte-identity check uses: that one asks whether we can reproduce a Mapping
 * exactly and this one asks what the member actually experiences, and ADR-0023
 * is the argument that those are different questions asked by different
 * consumers. A raw `Map.has` answers the first while reading like the second,
 * which is how a padded unlinked value could claim to resolve nothing while
 * resolving perfectly well.
 */
const resolvableByValue = new Map(
  shippedMappings.map((mapping) => [
    `${mapping.userFieldName}\u0000${mapping.value.trim()}`,
    mapping.url,
  ])
);

function keyOf(row: { userFieldName: string; legacyValue: string }): string {
  return `${row.userFieldName}\u0000${row.legacyValue}`;
}

describe("the disposition table this repository commits", () => {
  it("is the file a refresh wrote, not an empty one", () => {
    // Every assertion below walks `rows`, and on an empty file all but this one
    // would pass — five of the six checks in `collection-assignment.test.ts`
    // had the same hole, which is why that file grew the same test. It matters
    // more here: this artifact is the only interface to the repository that
    // writes to members, so an empty-but-green disposition table is the worst
    // available outcome. It would read as "no member has any equipment".
    //
    // The floor is well under the real count and deliberately not pinned to
    // it: a curation pass that adds legacy values should not fail this file,
    // and a number that tracked the data exactly would have to be edited on
    // every refresh until nobody read it.
    expect(rows.length).toBeGreaterThan(200);
    expect(shippedMappings.length).toBeGreaterThan(50);
  });

  it("is every legacy option value in the committed exports, once each", () => {
    // Derived from the option tables rather than from the table under test,
    // which is the whole point: a count taken from the same source it is
    // checking passes on any subset of it.
    const expected = sheetRows.map((row) =>
      keyOf({
        userFieldName: row.userFieldName,
        legacyValue: row.legacyValue.trim(),
      })
    );

    expect(new Set(expected).size).toBe(expected.length);
    expect(rows.map(keyOf).sort()).toEqual([...expected].sort());
  });

  it("covers both Managed Fields and no third one", () => {
    // Humidifier is dropped from the pipeline entirely (#42/ADR-0022), and its
    // five values must not reach the non-public side by way of this file.
    expect([...new Set(rows.map((row) => row.userFieldName))].sort()).toEqual([
      "Machine",
      "Mask",
    ]);
  });

  it("carries a value byte-identical to the Mapping that ships", () => {
    // The acceptance criterion, against the real committed files rather than
    // fixtures, and the mirror image of `build-settings.test.ts`'s "ships the
    // seeded Collection Links as Mappings": that one asserts every committed
    // Collection Link reaches the setting, this one asserts every value this
    // table hands downstream is in the setting it will be matched against.
    //
    // `toBe` on the raw strings, with no trimming and no normalising anywhere
    // in the comparison. That is the point of the criterion.
    const linked = rows.filter((row) => row.url !== "");

    expect(linked.length).toBeGreaterThan(200);

    for (const row of linked) {
      const shippedUrl = shippedByValue.get(
        `${row.userFieldName}\u0000${row.value}`
      );

      expect(
        shippedUrl,
        `${DISPOSITION_FILE} offers ${row.userFieldName} ` +
          `${JSON.stringify(row.value)} for legacy value ${row.legacyValue}, ` +
          `and ${SETTINGS_FILE} ships no Mapping with that value`
      ).toBeDefined();
      expect(shippedUrl).toBe(row.url);
    }
  });

  it("carries the suffix on a collection value and nowhere else", () => {
    // The suffix is the one part of a value where byte-identity is already
    // enforced upstream, by `readCollectionLinks` refusing a Collection Link
    // that does not end in exactly those bytes. So the gap this file covers is
    // the base name — and the other half, that no unlinked value wears the
    // suffix, which nothing upstream could catch because no upstream reader
    // ever sees these rows.
    for (const row of rows) {
      expect(row.value.endsWith(COLLECTION_LINK_SUFFIX)).toBe(
        row.disposition === "collection"
      );
    }
  });

  it("keeps the member's own text where no link ships", () => {
    // A value with no Mapping behind it is a string invented for a member to
    // hold that resolves for nobody, so the only string this table may put
    // there is the one the bulletin board showed them (#28: unmatched values
    // are written as the member wrote them, not dropped).
    const unlinked = rows.filter((row) => row.url === "");

    for (const row of unlinked) {
      expect(row.value).toBe(row.legacyText);
      // Asked the way the *runtime* asks it, not with a raw lookup. A member
      // holding `"  AirSense 11 AutoSet  "` resolves the `AirSense 11 AutoSet`
      // Mapping, because `profile-links.ts` trims both sides — so a row can
      // claim to resolve nothing while resolving perfectly well, and an exact
      // `Map.has` would agree with the claim. The exposure is a consequence of
      // carrying the legacy text verbatim, which is right for its own reasons
      // (ADR-0023); this is the check that keeps the two decisions honest.
      expect(
        resolvableByValue.has(`${row.userFieldName}\u0000${row.value.trim()}`),
        `${DISPOSITION_FILE} gives legacy value ${row.legacyValue} no URL, ` +
          `and ${SETTINGS_FILE} ships a Mapping that ` +
          `${JSON.stringify(row.value)} resolves once both sides are ` +
          `trimmed — the member gets a link this row says they do not`
      ).toBe(false);
    }
  });

  it("resolves the resolves-to-product rows to the product, not to `n/a`", () => {
    // PNums 6377 and 6378 are the two rows whose `Profile Link Value` is `n/a`
    // — the row saying it proposes no *new* value, not that the identifier has
    // no value. Passing that through emits a Profile Link literally called
    // `n/a`, which stores fine and renders nothing, and it is a one-cell
    // mistake that produces a plausible-looking artifact.
    //
    // Nothing parses the `5232` out of the row's `Recommended Collection URL`
    // prose either. Both legacy rows carry their own `Suggested Title` in
    // `data/user_mask.csv`, that title is 5232's, and the catalogue is keyed on
    // it — so the join is structural and survives a curator rewording the
    // sentence.
    const curated = assignments.filter(
      (row) => row.disposition === "resolves-to-product"
    );

    expect(curated.length).toBeGreaterThan(0);

    for (const row of curated) {
      expect(row.profileLinkValue).toBe("n/a");
    }

    const legacyValues = curated.flatMap((row) =>
      row.legacyPnums
        .split(",")
        .map((pnum) => pnum.trim())
        .filter(Boolean)
        .map((pnum) => keyOf({ userFieldName: row.field, legacyValue: pnum }))
    );
    const emitted = rows.filter((row) => legacyValues.includes(keyOf(row)));

    expect(emitted).toHaveLength(legacyValues.length);

    for (const row of emitted) {
      expect(row.disposition).toBe("resolves-to-product");
      expect(row.value).not.toBe("n/a");
      expect(row.url).not.toBe("");
      expect(row.url.startsWith("https://www.cpap.com/products/")).toBe(true);
      // The value has to be the *product's*, which is the same check the linked
      // rows get above — restated here because this is the row it was written
      // for and a reader looking at 6377 should not have to find it elsewhere.
      expect(shippedByValue.get(`${row.userFieldName}\u0000${row.value}`)).toBe(
        row.url
      );
    }
  });

  it("holds no cell shaped like an email address", () => {
    // The writer refuses one; this is the same tripwire on the committed file,
    // because the file is what crosses the boundary and it is committed rather
    // than regenerated by whoever consumes it. Neither the pattern nor the
    // failure names the cell.
    const shaped = /[^\s,"]+@[^\s,"]+\.[A-Za-z]{2,}/;
    const offending = rows
      .map((row, index) => ({ row, at: index + 2 }))
      .filter(({ row }) =>
        [
          row.userFieldName,
          row.legacyValue,
          row.legacyText,
          row.value,
          row.url,
        ].some((field) => shaped.test(field))
      )
      .map(({ at }) => `row ${at}`);

    expect(offending).toEqual([]);
  });

  it("is what a refresh derives from the committed inputs, byte for byte", () => {
    // The closest a test can get to running `pnpm refresh:catalogue`, which
    // needs a Shopify token and so is never run here. The same substitution
    // `catalogue-refresh.test.ts` makes for the Collection Links: the products
    // are rebuilt from the committed Resolved Product Catalogue, which is the
    // record of what the last real run found Shopify holding, and every
    // collection the table names is granted as admitted.
    //
    // A derivation that reordered the rows, altered a value or recomputed a
    // different digest would show up as a spurious diff on the next real run,
    // and this is what catches it before someone else's join does.
    const products: ProductRecord[] = readResolvedProducts(
      readFileSync(CATALOGUE_FILE, "utf8")
    ).map((entry) => ({
      handle: entry.handle,
      title: entry.value,
      status: entry.status,
      tags: [],
      onlineStoreUrl: entry.url,
    }));

    const { dispositions } = buildCatalogue({
      sheetRows,
      products,
      assignments,
      admittedCollections: collectionHandlesFrom(assignments),
    });

    expect(dispositionTableCsv(dispositions)).toBe(committed);
  });

  it("says how many values each disposition accounts for", () => {
    // Not an assertion about the counts, which move when the store does, but
    // about the file being reconcilable: every row is accounted for under
    // exactly one disposition, and the reviewer's per-disposition counts (#28)
    // sum to the whole table rather than to a subset of it.
    const counted = new Map<string, DispositionRow[]>();

    for (const row of rows) {
      const under = counted.get(row.disposition) ?? [];

      under.push(row);
      counted.set(row.disposition, under);
    }

    // `counted` is built by partitioning `rows`, so summing the partition
    // sizes and comparing to `rows.length` is an identity that holds for any
    // input — it was asserting arithmetic, not the file. What actually makes
    // the table reconcilable is that every disposition in it is one this
    // repository has a word for: a row under a word `DISPOSITION_OUTCOMES`
    // does not enumerate is a row the far side cannot classify, and it would
    // still sum correctly.
    const vocabulary = DISPOSITION_OUTCOMES as readonly string[];

    for (const disposition of counted.keys()) {
      expect(vocabulary, `${disposition} is not a disposition`).toContain(
        disposition
      );
    }

    expect(counted.size).toBeGreaterThan(1);

    // Both of the two that carry a URL are represented, which is what says the
    // table covers products as well as Collection Links — the third acceptance
    // criterion, and the one a table built from the Collection Assignment
    // alone would fail while looking complete.
    expect(counted.get("resolves-to-product")?.length).toBeGreaterThan(0);
    expect(counted.get("collection")?.length).toBeGreaterThan(0);
  });
});
