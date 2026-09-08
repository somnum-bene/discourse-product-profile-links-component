// The Collection Assignment gate. Exits non-zero while any committed row is
// `undecided`, and names every one so the fix is obvious without hunting. Run
// it with `pnpm check:collection-assignment`.
//
// A Catalogue Refresh reports `undecided` rows but stays green while they
// exist — deliberately, because its exit code is a statement about Shopify and
// the Sheet, which move without anyone committing anything. This check is a
// statement about the repository instead: it reads only the committed Sheet
// Export, so it needs no credentials and no network, which is what lets it run
// in CI and as a pre-commit hook beside `build:settings --check`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  CatalogueRefreshError,
  undecidedAssignments,
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
    throw new CatalogueRefreshError(
      `${undecided.length} of ${assignments.length} Collection Assignment ` +
        `${assignments.length === 1 ? "row is" : "rows are"} still \`undecided\`, ` +
        `naming ${undecided.length === 1 ? "it" : "them"} below. Each is an ` +
        `absence of evidence rather than a preference, so it blocks the ` +
        `release the way an Unresolved URL does, until a curator sets its ` +
        `\`Disposition\`:\n` +
        undecided
          .map(
            (row) =>
              // `legacyPnums` is empty on the rows that only ever carry
              // `legacyText` — the four retired catch-all titles — so this
              // falls back rather than naming the row with an empty string.
              `  - ${row.field} ${JSON.stringify(row.legacyPnums || row.legacyText)}` +
              ` — proposed \`Profile Link Value\` ` +
              `${JSON.stringify(row.profileLinkValue.trim())}`
          )
          .join("\n")
    );
  }

  process.stdout.write(
    `${assignments.length} Collection Assignment ` +
      `${assignments.length === 1 ? "row" : "rows"}, none \`undecided\`.\n`
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
