// The Sheet Exports are provenance: the three `user_*` tabs of the migration
// spreadsheet, committed exactly as the sheet returned them, so that a change
// product made to the spreadsheet shows up in `git diff` separately from a
// change the transform made. Nothing in the component reads them.
//
// The reason this file is careful out of proportion to what it does: the same
// workbook holds roughly 124,000 real usernames and email addresses on tabs
// two clicks away from these three. Every guard below is fail-closed, because
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

/** A tab this command is allowed to fetch, and everything it is allowed to read. */
export interface SheetTab {
  /** Exact tab name in the workbook. The allowlist is a list of these. */
  tab: string;
  /** The Custom User Field the tab's rows belong to. */
  userFieldName: string;
  /** The header row, exactly and in order. Anything else aborts the run. */
  headers: readonly string[];
  /**
   * Header of the column holding the Suggested Title, or null when the tab has
   * no Suggested columns at all. `user_humidifier` is the null case and that is
   * by design, not an oversight — see ADR-0012.
   */
  titleColumn: string | null;
  /** Header of the column holding the Suggested URL, or null. Pairs with titleColumn. */
  urlColumn: string | null;
}

/**
 * The tab allowlist. Three entries, and no code path that fetches a tab absent
 * from it: the only way to turn a name into a URL is `tabNamed`, which refuses
 * anything not listed here.
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
  {
    // Three columns, and the third one's header is genuinely blank in the
    // spreadsheet. It holds URLs, but nobody curated a Suggested Title to go
    // with them, so the tab exports for provenance and yields no rows.
    tab: "user_humidifier",
    userFieldName: "Humidifier",
    headers: ["Value", "Text", ""],
    titleColumn: null,
    urlColumn: null,
  },
];

/**
 * A ceiling on how many data rows a `user_*` tab may have. The three of them
 * run to 68, 149 and 5 rows; the tabs holding personal data run to about
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
 * Resolve a tab name against the allowlist. This is the only way to obtain a
 * `SheetTab`, which is the only thing `sheetCsvUrl` accepts, so an unlisted tab
 * cannot be fetched even by mistake.
 */
export function tabNamed(name: string): SheetTab {
  const tab = SHEET_TABS.find((candidate) => candidate.tab === name);
  if (!tab) {
    const allowed = SHEET_TABS.map((candidate) => candidate.tab).join(", ");
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
export function sheetCsvUrl(workbookId: string, tab: SheetTab): string {
  const params = new URLSearchParams({
    tqx: "out:csv",
    sheet: tab.tab,
  });
  return `https://docs.google.com/spreadsheets/d/${workbookId}/gviz/tq?${params}`;
}

/** Where a tab's export is committed. Named after the tab so provenance is obvious. */
export function exportFileName(tab: SheetTab): string {
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
 * caller writes nothing until all three tabs have passed.
 *
 * Three independent guards, because each catches a restructure the others miss:
 * the header row (a tab now holding different columns), the row count (a tab
 * now holding a different volume of data), and the cell contents (a tab now
 * holding email addresses under a header row that still looks right).
 */
export function readSheetTab(tab: SheetTab, csvText: string): string[][] {
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
        `ceiling. The tabs holding personal data are far larger than these ` +
        `three, so a jump this size is a restructured workbook.`
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

function sameHeaders(found: string[], expected: readonly string[]): boolean {
  return (
    found.length === expected.length &&
    found.every((value, index) => value === expected[index])
  );
}
