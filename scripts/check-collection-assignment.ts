// The Collection Assignment gate. Exits non-zero while any committed row is
// `undecided`, or while any legacy value earned a Collection Link and did not
// get one, and locates every one so the fix is obvious without hunting. Run it
// with `pnpm check:collection-assignment`.
//
// Two halves, because `undecided` alone leaves a hole. `undecided` only exists
// where a curator typed the word; a value that newly starts earning a link has
// no assignment row at all, and an absent row types nothing. The second half
// reads the disposition table, where that case lands as a
// `collection-link-fault`.
//
// A Catalogue Refresh now goes red on `undecided` too — #38 names that command
// as well — so this is not the only thing standing between an undecided row and
// a release. It is the thing standing between an undecided *committed* row and
// one, which is a different question: a refresh reports on the Sheet as it was
// the moment it ran, and nobody has to run one before merging.
//
// A `collection-link-fault` is not gated there at all. A refresh stays green on
// it deliberately, because it is drift — a product retiring at Shopify creates
// one through nobody's action, and a command that failed every time the
// catalogue moved is a command people stop reading. It blocks here instead,
// where the fault is a committed file rather than a passing observation.
//
// Either way this is a statement about the repository: it reads only committed
// files, so it needs no credentials and no network, which is what lets it run
// in CI and as a pre-commit hook beside `build:settings --check`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  CatalogueRefreshError,
  COLLECTION_LINK_FAULT,
  DISPOSITION_FILE,
  readDispositionTable,
  undecidedAssignments,
  unfinishedCollectionLinks,
} from "./lib/catalogue-refresh.ts";
import {
  ASSIGNMENT_TABS,
  type AssignmentRow,
  assignmentRowsFrom,
  exportFileName,
  SheetExportError,
} from "./lib/sheet-export.ts";

const EXPORT_DIR = "data";

async function main(): Promise<void> {
  refuseArguments(process.argv.slice(2));

  const assignments = await readCollectionAssignment();
  const undecided = undecidedAssignments(assignments);

  if (undecided.length > 0) {
    // Located, never quoted. This runs in CI on a public repository, so its
    // output is a public artifact, and every column that would identify the
    // row by its content — `Legacy PNum(s)`, `Legacy Text`, `Profile Link
    // Value` — is workbook content read across the boundary. `Legacy Text` in
    // particular is free text a curator typed into a bulletin board. `Field`
    // is safe because it is a Managed Field name, a closed set this
    // repository owns, and the row number is a coordinate rather than a cell.
    //
    // `undecidedAssignments` filters, so it returns the same object
    // references, and a row's position in `assignments` is its position in
    // the Sheet. `+ 2` for the header row and for counting from one, the same
    // convention `assignmentRowsFrom` reports its own refusals in.
    const undecidedRows = new Set<AssignmentRow>(undecided);

    throw new CatalogueRefreshError(
      `${undecided.length} of ${assignments.length} Collection Assignment ` +
        `${undecided.length === 1 ? "row is" : "rows are"} still \`undecided\`, ` +
        `locating ${undecided.length === 1 ? "it" : "them"} below. Each is an ` +
        `absence of evidence rather than a preference, so it blocks the ` +
        `release the way an Unresolved URL does, until a curator sets its ` +
        `\`Disposition\`. The cells are not reported:\n` +
        assignments
          .map((row, index) => ({ row, index }))
          .filter(({ row }) => undecidedRows.has(row))
          .map(
            ({ row, index }) =>
              `  - ${row.field} row ${index + 2}, column ` +
              `\`Disposition\` (\`${exportFileName(ASSIGNMENT_TABS[0])}\`)`
          )
          .join("\n")
    );
  }

  const faults = unfinishedCollectionLinks(
    readDispositionTable(await readFile(DISPOSITION_FILE, "utf8"))
  );

  if (faults.length > 0) {
    throw new CatalogueRefreshError(
      `${faults.length} legacy ${faults.length === 1 ? "value" : "values"} ` +
        `earned a Collection Link and did not get one, ` +
        `${faults.length === 1 ? "it is" : "they are"} named below. ` +
        `A \`${COLLECTION_LINK_FAULT}\` row is the pipeline unable to finish a job it was ` +
        `asked to do, so it blocks the release for the same reason an ` +
        `\`undecided\` row does — a member holding one of these values gets ` +
        `no Profile Link at all, which is the outcome ADR-0021 rejected:\n` +
        faults
          .map((row) => `  - ${row.userFieldName} \`Value\` ${row.legacyValue}`)
          .join("\n")
    );
  }

  process.stdout.write(
    `${assignments.length} Collection Assignment ` +
      `${assignments.length === 1 ? "row" : "rows"}, none \`undecided\`. ` +
      `No \`${COLLECTION_LINK_FAULT}\` row in \`${DISPOSITION_FILE}\`.\n`
  );
}

/**
 * The command line, which is empty. Every flag this check could plausibly have
 * — skip a field, accept an undecided row, narrow the count — is a way of
 * declaring the table curated without it being curated, the same reasoning
 * `verify-catalogue.ts` applies to its own empty command line.
 */
function refuseArguments(argv: readonly string[]): void {
  if (argv.length === 0) {
    return;
  }

  throw new CatalogueRefreshError(
    `pnpm check:collection-assignment takes no arguments, and it was given ` +
      `${argv.map((arg) => JSON.stringify(arg)).join(" ")}. There is no flag ` +
      `that narrows the check or accepts an undecided row.`
  );
}

/**
 * The Collection Assignment, re-validated on the way in like every other
 * committed export. Duplicated from `refresh-catalogue.ts` rather than shared,
 * because sharing it would mean the two commands importing from each other for
 * three lines of a read loop — each stays a standalone shell over the same
 * committed files.
 */
async function readCollectionAssignment(): Promise<AssignmentRow[]> {
  const rows: AssignmentRow[] = [];

  for (const tab of ASSIGNMENT_TABS) {
    const path = join(EXPORT_DIR, exportFileName(tab));
    const csvText = await readFile(path, "utf8");
    rows.push(...assignmentRowsFrom(tab, csvText));
  }

  return rows;
}

// Not top-level `await`: TypeScript reads this file as CommonJS, because
// package.json declares no `"type"`. `scripts/README.md` has the whole story.
main().catch((error: unknown) => {
  if (
    error instanceof CatalogueRefreshError ||
    error instanceof SheetExportError
  ) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
});
