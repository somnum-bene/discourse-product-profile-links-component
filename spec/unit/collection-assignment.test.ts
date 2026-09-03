import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_TABS,
  assignmentRowsFrom,
  exportFileName,
  type ExportTab,
  readSheetTab,
  SHEET_TABS,
} from "../../scripts/lib/sheet-export";

/**
 * The committed Collection Assignment, held against the committed option
 * tables it draws from.
 *
 * This exists because the same defect got through twice. PNum 5851's
 * `Profile Link Value` was the literal string `Text` — the name of the column
 * in `Base Name Source` rather than the value it names — and 6377/6378
 * declared `Suggested Title` while carrying a different product's legacy text.
 * Both were caught by review, and the hand-written scan that cleared the file
 * after the first fix was too narrow to catch the second: it checked the
 * `Text` rows and never joined the `Suggested Title` rows to the tables that
 * define them.
 *
 * The invariant does not need the Collection Link transform to exist, which is
 * why this is not waiting for #37/#38: a row that names where its value comes
 * from can be checked against that source today. A value that merely looks
 * plausible is the failure mode worth a gate — nothing reads this file yet, so
 * a wrong cell is invisible until it is load-bearing.
 */

const DISCONTINUED = " (Discontinued)";

function committedExport(tab: ExportTab): string {
  return readFileSync(join("data", exportFileName(tab)), "utf8");
}

/**
 * Every option table's `Value` → `Suggested Title`, keyed by the user field
 * the assignment tab names in its `Field` column. Read by header rather than
 * by position, on the same grounds the library does it.
 */
const suggestedTitleByField = new Map(
  SHEET_TABS.map((tab) => {
    const valueAt = tab.headers.indexOf("Value");
    const titleAt = tab.headers.indexOf(tab.titleColumn ?? "");

    return [
      tab.userFieldName,
      new Map(
        readSheetTab(tab, committedExport(tab)).map((row) => [
          row[valueAt] ?? "",
          row[titleAt] ?? "",
        ])
      ),
    ] as const;
  })
);

/**
 * The same tables' `Value` → `Text`, which is the source a Text-sourced row
 * names. Without it the Text branch below could only check a row against
 * itself: `Legacy Text` and `Profile Link Value` agreeing says nothing if both
 * were pasted from the wrong product. This is the outside opinion.
 */
const legacyTextByField = new Map(
  SHEET_TABS.map((tab) => {
    const valueAt = tab.headers.indexOf("Value");
    const textAt = tab.headers.indexOf("Text");

    return [
      tab.userFieldName,
      new Map(
        readSheetTab(tab, committedExport(tab)).map((row) => [
          row[valueAt] ?? "",
          row[textAt] ?? "",
        ])
      ),
    ] as const;
  })
);

const rows = ASSIGNMENT_TABS.flatMap((tab) =>
  assignmentRowsFrom(tab, committedExport(tab)).map((row, index) => ({
    ...row,
    // The spreadsheet row an editor would have to open to fix it: the header
    // is row 1, so the first data row is row 2.
    sheetRow: index + 2,
  }))
);

/** The PNums one row speaks for. A few rows fold several into one. */
function pnumsOf(row: { legacyPnums: string }): string[] {
  return row.legacyPnums
    .split(",")
    .map((pnum) => pnum.trim())
    .filter((pnum) => pnum !== "");
}

describe("the committed Collection Assignment", () => {
  it("is the file the export actually wrote, not an empty one", () => {
    // Every assertion below walks `rows`, so all of them would pass on an
    // empty file. This is the one that notices.
    expect(rows.length).toBeGreaterThan(50);
    expect(suggestedTitleByField.get("Machine")?.size).toBeGreaterThan(50);
    expect(suggestedTitleByField.get("Mask")?.size).toBeGreaterThan(50);
  });

  it("declares a Base Name Source this check knows how to verify", () => {
    // An unrecognised source is not a pass. A fourth kind of derivation is a
    // reason to widen this file, not to let the row through unchecked.
    const unknown = rows
      .filter(
        (row) =>
          !["Text", "Suggested Title", "n/a"].includes(row.baseNameSource)
      )
      .map(
        (row) =>
          `row ${row.sheetRow} (PNum ${row.legacyPnums}): ` +
          `${JSON.stringify(row.baseNameSource)}`
      );

    expect(unknown).toEqual([]);
  });

  it("names a PNum the matching option table holds", () => {
    const orphaned = rows
      .filter((row) => row.baseNameSource === "Suggested Title")
      .flatMap((row) => {
        const table = suggestedTitleByField.get(row.field);

        return pnumsOf(row)
          .filter((pnum) => !table?.has(pnum))
          .map((pnum) => `row ${row.sheetRow}: ${row.field} PNum ${pnum}`);
      });

    expect(orphaned).toEqual([]);
  });

  it("derives a Text-sourced value from that row's own Legacy Text", () => {
    const wrong = rows
      .filter((row) => row.baseNameSource === "Text")
      .filter((row) => row.profileLinkValue !== row.legacyText + DISCONTINUED)
      .map(
        (row) =>
          `row ${row.sheetRow} (PNum ${row.legacyPnums}): expected ` +
          `${JSON.stringify(row.legacyText + DISCONTINUED)}, got ` +
          `${JSON.stringify(row.profileLinkValue)}`
      );

    // PNum 5851 read `"Text"` here, which is what this catches.
    expect(wrong).toEqual([]);
  });

  it("joins on a Value each option table holds exactly once", () => {
    // Both maps above are built by `new Map(entries)`, which keeps the last
    // entry for a repeated key and says nothing. A PNum appearing twice under
    // two different titles would make the join silently prefer whichever the
    // sheet happens to list second, so a row derived from the first would read
    // as wrong — or a wrong row as right. The assertions are only as
    // trustworthy as the key they join on being unique.
    const duplicated = SHEET_TABS.flatMap((tab) => {
      const valueAt = tab.headers.indexOf("Value");
      const seen = new Set<string>();

      return readSheetTab(tab, committedExport(tab))
        .map((row) => row[valueAt] ?? "")
        .filter((value) => !seen.add(value))
        .map((value) => `${tab.userFieldName}: PNum ${value}`);
    });

    expect(duplicated).toEqual([]);
  });

  it("holds the Legacy Text the option table holds, for a Text-sourced row", () => {
    // The check above compares a row against itself: it proves the suffix was
    // applied, not that the name is the right one. A curator pasting the wrong
    // product into both `Legacy Text` and `Profile Link Value` leaves a row
    // that is internally consistent and wrong — the 6377/6378 defect one
    // column over. `Text` is the source the row names, so it is the source
    // that should settle it.
    const wrong = rows
      .filter((row) => row.baseNameSource === "Text")
      .flatMap((row) => {
        const table = legacyTextByField.get(row.field);

        return pnumsOf(row)
          .filter((pnum) => table?.get(pnum) !== row.legacyText)
          .map(
            (pnum) =>
              `row ${row.sheetRow} (PNum ${pnum}): option table holds ` +
              `${JSON.stringify(table?.get(pnum))}, assignment holds ` +
              `${JSON.stringify(row.legacyText)}`
          );
      });

    expect(wrong).toEqual([]);
  });

  it("derives a Suggested Title-sourced value from the option table", () => {
    const wrong = rows
      .filter((row) => row.baseNameSource === "Suggested Title")
      .flatMap((row) => {
        const table = suggestedTitleByField.get(row.field);
        const titles = new Set(
          pnumsOf(row)
            .map((pnum) => table?.get(pnum))
            .filter((title): title is string => title !== undefined)
        );

        // Folded PNums that disagree have no single answer, so the row cannot
        // be checked — or written — without saying which one it means.
        if (titles.size > 1) {
          return [
            `row ${row.sheetRow} (PNum ${row.legacyPnums}): folded PNums ` +
              `disagree on Suggested Title: ${[...titles].join(" | ")}`,
          ];
        }

        const expected = [...titles][0] + DISCONTINUED;

        return row.profileLinkValue === expected
          ? []
          : [
              `row ${row.sheetRow} (PNum ${row.legacyPnums}): expected ` +
                `${JSON.stringify(expected)}, got ` +
                `${JSON.stringify(row.profileLinkValue)}`,
            ];
      });

    // 6377 and 6378 carried PNum 5232's legacy text, which is what this
    // catches — a real product name, for the wrong product.
    expect(wrong).toEqual([]);
  });

  it("claims no Profile Link Value where it claims no source", () => {
    // `n/a` in `Base Name Source` is how a row says it is not a Collection
    // Link candidate at all — 6377/6378 resolve to an already-mapped product.
    // A derived-looking value beside it would be the earlier bug wearing a
    // better disguise.
    const contradictory = rows
      .filter((row) => row.baseNameSource === "n/a")
      .filter((row) => row.profileLinkValue !== "n/a")
      .map(
        (row) =>
          `row ${row.sheetRow} (PNum ${row.legacyPnums}): ` +
          `${JSON.stringify(row.profileLinkValue)}`
      );

    expect(contradictory).toEqual([]);
  });
});
