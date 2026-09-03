// The Sheet Exports are provenance: the exported tabs of the migration
// spreadsheet, committed as the sheet holds them, so that a change product made
// to the spreadsheet shows up in `git diff` separately from a change the
// transform made. Nothing in the component reads them.
//
// "As the sheet holds them" and not "byte for byte as the endpoint returned
// them", which is what this said while the source was a CSV endpoint. The
// source is now the Sheets API, which answers with JSON row arrays, so the
// committed bytes are reconstructed by `valuesToCsv` rather than passed
// through. Every cell is still verbatim; the quoting and the line endings are
// this file's, and the distinction is worth keeping because provenance that
// overstates itself is worse than provenance that says what it is.
//
// Two shapes of tab, on purpose. The `user_*` option tables reduce to a
// Suggested Title and a Suggested URL; the Collection Assignment is eleven
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
 * row it must still have. `sheetValuesUrl`, `exportFileName` and `readSheetTab`
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
 * The Collection Assignment's columns: the name this pipeline calls each one,
 * against the header the Sheet holds it under. #26 locked this schema, and
 * this object is the only place it is written down — the header allowlist, the
 * row shape and the reader all derive from it, so there is no second copy for
 * a curator's rename to fall out of step with.
 */
const ASSIGNMENT_COLUMNS = {
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
} as const;

/**
 * Every value a curator may put in `Disposition`. This is schema, not policy:
 * it says which words the column is allowed to hold, and nothing about what
 * any of them should cause. What `undecided` blocks and which of the others
 * yields a link stay the transform's decisions.
 *
 * `resolves-to-product` is the one that is easy to leave out and expensive to
 * omit. Some rows in this table are not Collection Link candidates at all —
 * the title turns out to name a product the store still sells, so the value
 * belongs as an ordinary product Mapping. Those rows carry `n/a` in both
 * `Base Name Source` and `Profile Link Value`, which means "proposes no *new*
 * value", not "this identifier has no value": the legacy PNum is still one a
 * member can be holding, so it still has to reach the disposition table with
 * the live product's value. Without a word for that state the row can only be
 * `undecided`, and a release gate that blocks on `undecided` would block for
 * ever on a row that is already correctly curated.
 *
 * Guarded rather than merely documented because the failure is silent: a
 * curator typing `colection` produces a row that no transform recognises and
 * no header check notices.
 */
export const DISPOSITIONS = [
  "collection",
  "plain-text",
  "resolves-to-product",
  "undecided",
] as const;

/** One of the four words `Disposition` is allowed to hold. */
export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * The Collection Assignment tab, which a person edits and this command only
 * reads. It is deliberately not a `SheetTab`. Its eleven columns do not reduce
 * to a title and a URL — `Recommended Collection URL` is a proposal,
 * `Override` can replace it, and `Disposition` decides whether either is used
 * at all — so squeezing it into `titleColumn`/`urlColumn` would have to either
 * drop columns or lie about what the two it kept mean. Adding a second shape
 * alongside the first costs one interface; generalising `SheetTab` would cost
 * the meaning of the one that already works.
 */
export interface AssignmentTab extends ExportTab {
  columns: typeof ASSIGNMENT_COLUMNS;
}

/**
 * One curated row of the Collection Assignment, named rather than positional.
 * Values are passed through verbatim and no column is preferred over another
 * here: whether `override` wins over `recommendedCollectionUrl`, and whether
 * an `undecided` `disposition` blocks a release, are the transform's
 * decisions, not this file's. Reading the tab and judging it are separate jobs
 * for the same reason `sheetRowsFrom` does no trimming.
 */
export type AssignmentRow = Record<
  Exclude<keyof typeof ASSIGNMENT_COLUMNS, "disposition">,
  string
> & { disposition: Disposition };

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
 * The Collection Assignment allowlist, and the second half of the tab
 * allowlist. Its header row is `ASSIGNMENT_COLUMNS` read in order, so a
 * curator who adds, renames or reorders a column stops the run rather than
 * shifting the meaning of `Disposition` one place to the left.
 */
export const ASSIGNMENT_TABS: readonly AssignmentTab[] = [
  {
    tab: "collection-assignment",
    headers: Object.values(ASSIGNMENT_COLUMNS),
    columns: ASSIGNMENT_COLUMNS,
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
 * A ceiling on how many data rows an exported tab may have. Each of them runs
 * to a few hundred at the outside; the personal-data tabs of the workbook this
 * was written against ran to about 124,000. A tab that has grown by an order
 * of magnitude under a header row that still matches has been restructured,
 * not edited, and the run stops. The ceiling is deliberately far above any
 * real count rather than pinned to one, so a refresh that adds rows is not a
 * refusal and a restructure still is.
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
 * to obtain a `SheetTab`, and a tab object is the only thing `sheetValuesUrl`
 * accepts, so an unlisted tab cannot be fetched even by mistake.
 */
export function tabNamed(name: string): SheetTab {
  return namedIn(SHEET_TABS, name);
}

/**
 * The same, for the Collection Assignment. Two lookups rather than one that returns the
 * wider `ExportTab`: a caller that wants the Suggested columns and a caller
 * that wants `Disposition` are asking different questions, and a single lookup
 * would answer both with a type that has neither.
 */
export function assignmentTabNamed(name: string): AssignmentTab {
  return namedIn(ASSIGNMENT_TABS, name);
}

/**
 * The option table an exported tab is, or null when it is not one. The command
 * needs to ask because it iterates `EXPORT_TABS`, which holds both shapes.
 *
 * It returns the allowlist entry rather than answering yes about the argument,
 * and that is the whole point: a `tab is SheetTab` predicate would have to
 * decide on the strength of the name, so an object calling itself
 * `user_machine` with no `titleColumn` would be narrowed to a type it does not
 * have and read as an empty row. Handing back the entry the allowlist holds
 * means the caller works with the trusted object, never the one it asked about.
 */
export function sheetTabFor(tab: ExportTab): SheetTab | null {
  return SHEET_TABS.find((candidate) => candidate.tab === tab.tab) ?? null;
}

/**
 * The Collection Assignment counterpart to `sheetTabFor`, and it exists for
 * the same reason: the export loop holds an `ExportTab` and needs the trusted
 * allowlist entry back, not an answer about the object it already has.
 *
 * Without it there was no way to reach `assignmentRowsFrom` from a loop over
 * `EXPORT_TABS` — `assignmentTabNamed` takes a name, and the loop has objects
 * — so the Disposition check ran only in the test suite. A tab validates
 * against the header row and the row ceiling either way; what was missing was
 * the check that every `Disposition` cell holds one of the four words.
 */
export function assignmentTabFor(tab: ExportTab): AssignmentTab | null {
  return ASSIGNMENT_TABS.find((candidate) => candidate.tab === tab.tab) ?? null;
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
 * The Sheets API endpoint for one allowlisted tab. Addressed by tab *name*,
 * which matters: the allowlist is written in names, and the numeric gid the
 * older CSV endpoint wanted is something the workbook is free to reassign.
 *
 * The range is pinned rather than left open, but to one column *past* the
 * width the allowlist declares — `A1:F` for a five column tab. That extra
 * column is a probe, and it exists because bounding the range at the declared
 * width defeated the guard it was meant to serve. Asked for `A1:E`, a sixth
 * column never arrives, the header row matches exactly, and the export is
 * accepted while quietly no longer being the verbatim tab it claims to be.
 * Inserting a column was always caught — every header after it shifts — but
 * appending one past the end was invisible. Asking one column wider makes an
 * appended header something `valuesToCsv` can refuse.
 */
export function sheetValuesUrl(workbookId: string, tab: ExportTab): string {
  const range = `'${tab.tab}'!A1:${columnLetter(tab.headers.length + 1)}`;
  const params = new URLSearchParams({ majorDimension: "ROWS" });
  return (
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}` +
    `/values/${encodeURIComponent(range)}?${params}`
  );
}

/**
 * The spreadsheet column letter at a 1-based position — 5 is `E`, 11 is `K`.
 * Handles the two-letter range no tab here reaches, because a helper that is
 * correct only under twenty-six columns is a trap for whoever adds the
 * twenty-seventh.
 */
export function columnLetter(position: number): string {
  if (!Number.isInteger(position) || position < 1) {
    throw new SheetExportError(
      `a tab must declare at least one column; got ${position}`
    );
  }

  let letters = "";
  let remaining = position;
  while (remaining > 0) {
    const index = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + index) + letters;
    remaining = Math.floor((remaining - index) / 26);
  }
  return letters;
}

/**
 * The API's row arrays as the CSV text the rest of this file reads, quoting
 * every field the way the old `gviz` endpoint did so the committed exports keep
 * the shape they have always had.
 *
 * The padding is the part that matters. The API omits trailing empty cells, so
 * a row whose `Suggested URL` is blank comes back three cells wide rather than
 * five, and one whose last two columns are blank comes back shorter still.
 * Left ragged, the header row would disagree with its own data rows and a blank
 * final column would read as a missing one. Padding to the width the allowlist
 * declares restores the rectangle the sheet actually holds — it never invents a
 * column, because the width came from the header the guard is about to check.
 *
 * Truncating is the other half, and the reason the appended-column guard lives
 * here rather than in `readSheetTab` beside the other three. `sheetValuesUrl`
 * asks one column wider than declared; anything in that probe column is a
 * column the tab has grown and this command was not written against, so it is
 * refused rather than dropped. It has to be caught on the API's rows, because
 * by the time this function has produced CSV text the extra column is already
 * gone — which is exactly how an appended column used to slip past a guard
 * whose own message promises to catch one.
 */
export function valuesToCsv(tab: ExportTab, values: string[][]): string {
  for (const [rowIndex, row] of values.entries()) {
    const appended = row
      .slice(tab.headers.length)
      .findIndex((cell) => cell.trim() !== "");
    if (appended !== -1) {
      throw new SheetExportError(
        `${tab.tab}: row ${rowIndex + 1} holds a value in column ` +
          `${columnLetter(tab.headers.length + 1 + appended)}, past the ` +
          `${tab.headers.length} columns the allowlist declares. A column ` +
          `appended to the end of the tab is the one restructure the header ` +
          `row cannot show, because every declared header still matches. ` +
          `Widening the export is a deliberate edit to the allowlist, not ` +
          `something a curator does to the tab.`
      );
    }
  }

  return values
    .map((row) =>
      Array.from(
        { length: tab.headers.length },
        (_unused, column) => row[column] ?? ""
      )
        .map((cell) => `"${cell.replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");
}

/** Where a tab's export is committed. Named after the tab so provenance is obvious. */
export function exportFileName(tab: ExportTab): string {
  return `${tab.tab}.csv`;
}

/**
 * RFC 4180, enough of it for the two ways a tab reaches us. The `gviz`
 * endpoint quotes every field, uses LF endings and emits no final newline;
 * Google Sheets' own File → Download → CSV quotes only what needs it, uses
 * CRLF, ends with a newline and opens with a byte order mark. All of that is
 * the same table, so all of it parses the same way. Written out rather than
 * pulled in as a dependency because a CSV parser that surprises us is worse
 * than one we can read.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // A leading byte order mark is an encoding marker, not a cell. Left in, it
  // becomes part of the first header and the run aborts over a renamed column
  // that was never renamed — a fail-closed guard firing on a correct file,
  // which teaches whoever hits it to distrust the guard. Only the leading one
  // is dropped; anywhere else it is a character the sheet holds.
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;

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
 * It takes an `ExportTab`, so the Collection Assignment is held to exactly the
 * same three as the two option tables it sits beside in the same workbook.
 */
export function readSheetTab(tab: ExportTab, csvText: string): string[][] {
  if (csvText.trim() === "") {
    throw new SheetExportError(
      `${tab.tab}: the tab is empty — not one row, where a header row is ` +
        `the minimum. A tab the workbook does not have cannot reach this ` +
        `refusal: the range naming it fails to parse and the fetch is ` +
        `rejected before here. So this tab exists, under this name, holding ` +
        `nothing.`
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
 * The Collection Assignment's rows, named by column. Like `sheetRowsFrom`, it
 * reads by header rather than by position and passes every value through
 * verbatim: an empty `Override` stays empty, an `undecided` `Disposition` stays
 * `undecided`, and neither is resolved here. The header allowlist has already
 * established that the columns are the ones these names mean.
 *
 * The one exception is `Disposition`, which is checked against `DISPOSITIONS`.
 * That is still not a judgment about the row — an unrecognised word is not a
 * disposition this table can express, the way a renamed column is not a column
 * this command was written against, so it is refused on the same fail-closed
 * terms. Doing it here is what lets `AssignmentRow.disposition` be the union
 * rather than `string`, so a transform switching on it gets exhaustiveness
 * from the compiler instead of a default branch nobody revisits.
 */
export function assignmentRowsFrom(
  tab: AssignmentTab,
  csvText: string
): AssignmentRow[] {
  const dataRows = readSheetTab(tab, csvText);
  const columns = Object.entries(tab.columns) as [
    keyof AssignmentRow,
    string,
  ][];
  const dispositionIndex = tab.headers.indexOf(tab.columns.disposition);

  for (const [rowIndex, dataRow] of dataRows.entries()) {
    const found = dataRow[dispositionIndex] ?? "";
    if (!isDisposition(found)) {
      throw new SheetExportError(
        `${tab.tab}: row ${rowIndex + 2} holds ` +
          `${found === "" ? "an empty" : `an unrecognised`} ` +
          `${tab.columns.disposition}${found === "" ? "" : ` "${found}"`}. ` +
          `One of ${DISPOSITIONS.map((value) => `"${value}"`).join(", ")} is ` +
          `expected. An empty cell is not the same as "undecided": ` +
          `"undecided" is a curator saying nobody has looked yet, and a blank ` +
          `is a row that cannot say even that.`
      );
    }
  }

  return dataRows.map((dataRow) =>
    Object.fromEntries(
      columns.map(([name, header]) => [
        name,
        dataRow[tab.headers.indexOf(header)] ?? "",
      ])
    )
  ) as AssignmentRow[];
}

function isDisposition(value: string): value is Disposition {
  return (DISPOSITIONS as readonly string[]).includes(value);
}

function sameHeaders(found: string[], expected: readonly string[]): boolean {
  return (
    found.length === expected.length &&
    found.every((value, index) => value === expected[index])
  );
}
