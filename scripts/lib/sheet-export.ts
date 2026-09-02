// The Sheet Exports are provenance: the exported tabs of the migration
// spreadsheet, committed exactly as the sheet returned them, so that a change
// product made to the spreadsheet shows up in `git diff` separately from a
// change the transform made. Nothing in the component reads them.
//
// Two shapes of tab, on purpose. The `user_*` option tables reduce to a
// Suggested Title and a Suggested URL; the collection-assignment tab is eleven
// columns of human curation that reduce to nothing. They share the guards and
// not the shape — see `ExportTab` below.
//
// The reason this file is careful out of proportion to what it does: the
// workbook this command was first written against held roughly 124,000 real
// usernames and email addresses on tabs two clicks away. Every guard below is
// fail-closed, because
// the failure worth protecting against is not "we fetched the wrong tab" — that
// is loud — but "a tab we recognise by name now holds different data", which is
// silent. Skipping a surprise is not safe. Stopping is.

import type { SheetRow } from "./build-catalogue";

export type { SheetRow };

/**
 * The workbook is identified by an environment variable rather than a constant.
 * It is a public link to a workbook containing real customer email addresses,
 * and this repository is public, so committing the id would publish the link.
 * The variable lives in the ignored `.env` alongside the API credentials.
 */
export const WORKBOOK_ID_VAR = "SHEET_WORKBOOK_ID";

/**
 * Everything the fetch-and-validate path needs to know about a tab, and the
 * whole of what it is allowed to know: a name to address it by and the header
 * row it must still have. `sheetCsvUrl`, `exportFileName` and `readSheetTab`
 * take this and nothing more, so a tab of any shape gets the same three
 * fail-closed guards without either allowlist having to restate them.
 */
export interface ExportTab {
  /** Exact tab name in the workbook. Every allowlist is a list of these. */
  tab: string;
  /** The header row, exactly and in order. Anything else aborts the run. */
  headers: readonly string[];
}

/** An option table: one `user_*` tab, reducible to Suggested Title and URL. */
export interface SheetTab extends ExportTab {
  /** The Custom User Field the tab's rows belong to. */
  userFieldName: string;
  /**
   * Header of the column holding the Suggested Title, or null when the tab has
   * no Suggested columns at all.
   */
  titleColumn: string | null;
  /** Header of the column holding the Suggested URL, or null. Pairs with titleColumn. */
  urlColumn: string | null;
}

/**
 * A curation table: the collection-assignment tab, which a person edits and
 * this command only reads. It is deliberately not a `SheetTab`. Its eleven
 * columns do not reduce to a title and a URL — `Recommended Collection URL` is
 * a proposal, `Override` can replace it, and `Disposition` decides whether
 * either is used at all — so squeezing it into `titleColumn`/`urlColumn` would
 * have to either drop columns or lie about what the two it kept mean. Adding a
 * second shape alongside the first costs one interface; generalising `SheetTab`
 * would cost the meaning of the one that already works.
 */
export interface AssignmentTab extends ExportTab {
  /** Header of each column, by the name the rest of the pipeline calls it. */
  columns: {
    field: string;
    legacyPnums: string;
    legacyText: string;
    baseNameSource: string;
    profileLinkValue: string;
    recommendedCollectionTitle: string;
    recommendedCollectionUrl: string;
    confidence: string;
    rationale: string;
    override: string;
    disposition: string;
  };
}

/**
 * One curated row of the collection-assignment tab, named rather than
 * positional. Values are passed through verbatim and no column is preferred
 * over another here: whether `override` wins over `recommendedCollectionUrl`,
 * and whether an `undecided` `disposition` blocks a release, are the
 * transform's decisions, not this file's. Reading the tab and judging it are
 * separate jobs for the same reason `sheetRowsFrom` does no trimming.
 */
export interface AssignmentRow {
  field: string;
  legacyPnums: string;
  legacyText: string;
  baseNameSource: string;
  profileLinkValue: string;
  recommendedCollectionTitle: string;
  recommendedCollectionUrl: string;
  confidence: string;
  rationale: string;
  override: string;
  disposition: string;
}

/**
 * The option-table allowlist. Two entries, and no code path that fetches a tab
 * absent from it: the only way to turn a name into a `SheetTab` is `tabNamed`,
 * which refuses anything not listed here.
 */
export const SHEET_TABS: readonly SheetTab[] = [
  {
    tab: "user_machine",
    userFieldName: "Machine",
    headers: ["Value", "Text", "URL", "Suggested Title", "Suggested URL"],
    titleColumn: "Suggested Title",
    urlColumn: "Suggested URL",
  },
  {
    tab: "user_mask",
    userFieldName: "Mask",
    headers: ["Value", "Text", "URL", "Suggested Title", "Suggested URL"],
    titleColumn: "Suggested Title",
    urlColumn: "Suggested URL",
  },
];

/**
 * The curation-table allowlist, and the second half of the tab allowlist. Its
 * header row is the schema locked on #26, in column order; a curator who adds,
 * renames or reorders a column stops the run rather than shifting the meaning
 * of `Disposition` one place to the left.
 */
export const ASSIGNMENT_TABS: readonly AssignmentTab[] = [
  {
    tab: "collection-assignment",
    headers: [
      "Field",
      "Legacy PNum(s)",
      "Legacy Text",
      "Base Name Source",
      "Profile Link Value",
      "Recommended Collection Title",
      "Recommended Collection URL",
      "Confidence",
      "Rationale",
      "Override",
      "Disposition",
    ],
    columns: {
      field: "Field",
      legacyPnums: "Legacy PNum(s)",
      legacyText: "Legacy Text",
      baseNameSource: "Base Name Source",
      profileLinkValue: "Profile Link Value",
      recommendedCollectionTitle: "Recommended Collection Title",
      recommendedCollectionUrl: "Recommended Collection URL",
      confidence: "Confidence",
      rationale: "Rationale",
      override: "Override",
      disposition: "Disposition",
    },
  },
];

/**
 * Every tab the export command fetches, in the order it writes them. The
 * command iterates this and never either allowlist directly, so adding a third
 * shape later is one entry here rather than a second loop over there.
 */
export const EXPORT_TABS: readonly ExportTab[] = [
  ...SHEET_TABS,
  ...ASSIGNMENT_TABS,
];

/**
 * A ceiling on how many data rows an exported tab may have. The three of them
 * run to 75, 151 and 83 rows; the tabs holding personal data run to about
 * 124,000. A tab that has grown by an order of magnitude under a header row
 * that still matches has been restructured, not edited, and the run stops.
 */
export const MAX_DATA_ROWS = 2000;

/**
 * Anything wrong enough to stop the run. The command catches only this type, so
 * a programming mistake still surfaces as a crash rather than as a tidy refusal.
 */
export class SheetExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetExportError";
  }
}

// Deliberately strict about what sits either side of the `@`: the point is to
// recognise an email address, and a loose pattern that also matched product
// titles would turn a safety net into a nuisance that gets switched off.
const EMAIL_SHAPED = /[^\s,"]+@[^\s,"]+\.[A-Za-z]{2,}/;

/**
 * Resolve a tab name against the option-table allowlist. This is the only way
 * to obtain a `SheetTab`, and a tab object is the only thing `sheetCsvUrl`
 * accepts, so an unlisted tab cannot be fetched even by mistake.
 */
export function tabNamed(name: string): SheetTab {
  return namedIn(SHEET_TABS, name);
}

/**
 * The same, for the curation tab. Two lookups rather than one that returns the
 * wider `ExportTab`: a caller that wants the Suggested columns and a caller
 * that wants `Disposition` are asking different questions, and a single lookup
 * would answer both with a type that has neither.
 */
export function assignmentTabNamed(name: string): AssignmentTab {
  return namedIn(ASSIGNMENT_TABS, name);
}

/**
 * Whether an exported tab is an option table, and so has rows to contribute to
 * the catalogue. The command needs to ask because it iterates `EXPORT_TABS`,
 * which holds both shapes; it identifies by name against the allowlist rather
 * than by sniffing for a property, so a malformed object cannot answer yes.
 */
export function isSheetTab(tab: ExportTab): tab is SheetTab {
  return SHEET_TABS.some((candidate) => candidate.tab === tab.tab);
}

function namedIn<T extends ExportTab>(
  allowlist: readonly T[],
  name: string
): T {
  const tab = allowlist.find((candidate) => candidate.tab === name);
  if (!tab) {
    const allowed = allowlist.map((candidate) => candidate.tab).join(", ");
    throw new SheetExportError(
      `refusing to fetch tab "${name}": not in the allowlist (${allowed})`
    );
  }
  return tab;
}

/**
 * The CSV endpoint for one allowlisted tab. `gviz/tq` addresses a tab by name,
 * which matters: the allowlist is written in names, and `export?format=csv`
 * takes only a numeric gid, which the workbook is free to reassign.
 */
export function sheetCsvUrl(workbookId: string, tab: ExportTab): string {
  const params = new URLSearchParams({
    tqx: "out:csv",
    sheet: tab.tab,
  });
  return `https://docs.google.com/spreadsheets/d/${workbookId}/gviz/tq?${params}`;
}

/** Where a tab's export is committed. Named after the tab so provenance is obvious. */
export function exportFileName(tab: ExportTab): string {
  return `${tab.tab}.csv`;
}

/**
 * RFC 4180, enough of it for what the endpoint emits: every field quoted, `""`
 * for a literal quote, commas and newlines legal inside quotes, LF line endings
 * and no final newline. Written out rather than pulled in as a dependency
 * because a CSV parser that surprises us is worse than one we can read.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }

    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (quoted) {
    throw new SheetExportError(
      "the response ended inside a quoted field, so it is not complete CSV"
    );
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Check a fetched tab against everything the allowlist promises about it and
 * return its data rows. Throws on the first thing that does not match, and the
 * caller writes nothing until every tab has passed.
 *
 * Three independent guards, because each catches a restructure the others miss:
 * the header row (a tab now holding different columns), the row count (a tab
 * now holding a different volume of data), and the cell contents (a tab now
 * holding email addresses under a header row that still looks right).
 *
 * It takes an `ExportTab`, so the curation tab is held to exactly the same
 * three as the two option tables it sits beside in the same workbook.
 */
export function readSheetTab(tab: ExportTab, csvText: string): string[][] {
  if (csvText.trim() === "") {
    throw new SheetExportError(
      `${tab.tab}: the sheet returned an empty response. The endpoint answers ` +
        `200 with no body for a tab it cannot find, so the tab has most likely ` +
        `been renamed or removed.`
    );
  }

  const rows = parseCsv(csvText);
  const [header, ...dataRows] = rows;

  if (!header || !sameHeaders(header, tab.headers)) {
    throw new SheetExportError(
      `${tab.tab}: unexpected header row.\n` +
        `  expected: ${JSON.stringify(tab.headers)}\n` +
        `  found:    ${JSON.stringify(header ?? [])}\n` +
        `A renamed, missing, added or reordered column means the tab is not ` +
        `the one this command was written against.`
    );
  }

  if (dataRows.length > MAX_DATA_ROWS) {
    throw new SheetExportError(
      `${tab.tab}: ${dataRows.length} data rows exceeds the ${MAX_DATA_ROWS}-row ` +
        `ceiling. The tabs holding personal data are far larger than any ` +
        `exported one, so a jump this size is a restructured workbook.`
    );
  }

  for (const [rowIndex, dataRow] of dataRows.entries()) {
    const offending = dataRow.findIndex((cell) => EMAIL_SHAPED.test(cell));
    if (offending !== -1) {
      // The value itself is not reported. It is the thing we are refusing to
      // let into the repository, so it does not go into a log either.
      throw new SheetExportError(
        `${tab.tab}: row ${rowIndex + 2}, column ${offending + 1} holds ` +
          `something shaped like an email address. This command exports ` +
          `product mappings and nothing else; refusing to write.`
      );
    }
  }

  return dataRows;
}

/**
 * The tab's rows in the shape `buildCatalogue` consumes. Values are passed
 * through verbatim — trimming, deduplication and every other judgement belong
 * to the transform, so that this file has no opinions to disagree with it.
 *
 * A tab with no Suggested columns yields no rows. It is still validated and
 * still exported; it simply has nothing to contribute to the catalogue.
 */
export function sheetRowsFrom(tab: SheetTab, csvText: string): SheetRow[] {
  const dataRows = readSheetTab(tab, csvText);

  if (tab.titleColumn === null || tab.urlColumn === null) {
    return [];
  }

  const titleIndex = tab.headers.indexOf(tab.titleColumn);
  const urlIndex = tab.headers.indexOf(tab.urlColumn);

  return dataRows.map((dataRow) => ({
    userFieldName: tab.userFieldName,
    suggestedTitle: dataRow[titleIndex] ?? "",
    suggestedUrl: dataRow[urlIndex] ?? "",
  }));
}

/**
 * The curation tab's rows, named by column. Like `sheetRowsFrom`, it reads by
 * header rather than by position and passes every value through verbatim: an
 * empty `Override` stays empty, an `undecided` `Disposition` stays `undecided`,
 * and neither is resolved here. The header allowlist has already established
 * that the columns are the ones these names mean.
 */
export function assignmentRowsFrom(
  tab: AssignmentTab,
  csvText: string
): AssignmentRow[] {
  const dataRows = readSheetTab(tab, csvText);
  const at = (dataRow: string[], header: string): string =>
    dataRow[tab.headers.indexOf(header)] ?? "";

  return dataRows.map((dataRow) => ({
    field: at(dataRow, tab.columns.field),
    legacyPnums: at(dataRow, tab.columns.legacyPnums),
    legacyText: at(dataRow, tab.columns.legacyText),
    baseNameSource: at(dataRow, tab.columns.baseNameSource),
    profileLinkValue: at(dataRow, tab.columns.profileLinkValue),
    recommendedCollectionTitle: at(
      dataRow,
      tab.columns.recommendedCollectionTitle
    ),
    recommendedCollectionUrl: at(dataRow, tab.columns.recommendedCollectionUrl),
    confidence: at(dataRow, tab.columns.confidence),
    rationale: at(dataRow, tab.columns.rationale),
    override: at(dataRow, tab.columns.override),
    disposition: at(dataRow, tab.columns.disposition),
  }));
}

function sameHeaders(found: string[], expected: readonly string[]): boolean {
  return (
    found.length === expected.length &&
    found.every((value, index) => value === expected[index])
  );
}
