// Fetch the exported tabs of the migration spreadsheet and commit them as the
// Sheet Exports. Run it with `pnpm export:sheet`.
//
// The shell is deliberately thin: it authenticates, fetches, validates, and
// writes. Every decision about what is allowed lives in `lib/sheet-export.ts`,
// which is pure and therefore actually tested, and everything about the
// credential lives in `lib/sheets-auth.ts`. This file contains no tab names and
// builds no URLs of its own — it can only ask the allowlist what to fetch.

import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  assignmentRowsFrom,
  assignmentTabFor,
  EXPORT_TABS,
  exportFileName,
  readSheetTab,
  SheetExportError,
  sheetRowsFrom,
  sheetTabFor,
  sheetValuesUrl,
  valuesToCsv,
  WORKBOOK_ID_VAR,
} from "./lib/sheet-export.ts";
import { accessTokenFor, credentialsFrom } from "./lib/sheets-auth.ts";

const OUTPUT_DIR = "data";

async function main(): Promise<void> {
  const workbookId = process.env[WORKBOOK_ID_VAR];
  if (!workbookId) {
    throw new SheetExportError(
      `${WORKBOOK_ID_VAR} is not set. It lives in the ignored .env — the ` +
        `workbook is not public and this repository is, so the id is not ` +
        `committed.`
    );
  }

  // One token for the whole run. It is read-only, it lasts an hour, and this
  // command fetches a handful of tabs and exits, so there is nothing to cache
  // and no refresh to get wrong.
  const accessToken = await accessTokenFor(credentialsFrom(process.env));

  // Fetch and validate everything before writing anything. A run that aborts
  // half way through would leave `data/` holding one refreshed export and a
  // stale one, which is worse than leaving both alone.
  const fetched = [];
  for (const tab of EXPORT_TABS) {
    const response = await fetch(sheetValuesUrl(workbookId, tab), {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      // 400 here is how a missing tab presents: the range names it, and a
      // range naming a tab the workbook does not have cannot be parsed.
      // `statusText` is not reported — HTTP/2 has no reason phrase, so it is
      // empty in practice and reads as a truncated sentence.
      throw new SheetExportError(
        `${tab.tab}: the sheet answered ${response.status}. A 400 means the ` +
          `range could not be parsed, which is what a renamed or absent tab ` +
          `looks like; a 403 means the impersonated user cannot open this ` +
          `workbook.`
      );
    }

    const body = (await response.json()) as { values?: string[][] };

    // The API omits `values` entirely for a tab with nothing in it. Turning
    // that into empty text hands it to `readSheetTab`'s emptiness guard,
    // rather than inventing a second way to say the same thing here. That
    // guard's wording is specific about which emptiness this is: a tab the
    // workbook does not have is a 400 above, so anything reaching it is a
    // tab that exists and holds nothing.
    const csvText = valuesToCsv(tab, body.values ?? []);

    // Both calls validate, so the CSV is parsed twice. That costs nothing at a
    // few hundred rows and leaves each function safe to call on its own, which
    // is worth more than the saving.
    const dataRows = readSheetTab(tab, csvText);
    // Only the option tables feed the catalogue. The Collection Assignment is
    // fetched, validated and committed on the same terms and contributes no
    // rows, which is a fact about the tab rather than a special case for it.
    const optionTable = sheetTabFor(tab);
    const sheetRows = optionTable ? sheetRowsFrom(optionTable, csvText) : [];

    // The Collection Assignment's rows are read for the same reason, and the
    // result is discarded on purpose: `assignmentRowsFrom` is where the
    // `Disposition` vocabulary is enforced, and a curated word outside it has
    // to stop the run here rather than reach `data/`. Nothing downstream
    // consumes these rows yet — the checking is the point.
    const assignment = assignmentTabFor(tab);
    if (assignment) {
      assignmentRowsFrom(assignment, csvText);
    }

    fetched.push({ tab, csvText, dataRows, sheetRows });
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const { tab, csvText, dataRows, sheetRows } of fetched) {
    // Every field quoted, LF endings, no final newline — `valuesToCsv` writes
    // the shape the old CSV endpoint returned, and `data/` is exempt from the
    // whitespace-fixing pre-commit hooks so it survives being committed.
    const path = join(OUTPUT_DIR, exportFileName(tab));
    await writeFile(path, csvText);
    process.stdout.write(
      `${path}: ${Buffer.byteLength(csvText)} bytes, ${dataRows.length} rows, ` +
        `${sheetRows.length} for the catalogue\n`
    );
  }
}

// Not top-level `await`: TypeScript reads this file as CommonJS, because
// package.json declares no `"type"`, and CommonJS has no top-level await. Node
// runs it as ESM regardless. `scripts/README.md` has the whole story.
main().catch((error: unknown) => {
  if (error instanceof SheetExportError) {
    // A refusal is an expected outcome, not a crash, so it reports the reason
    // and nothing else. A stack trace here would bury the message.
    process.stderr.write(`${error.message}\nNothing was written.\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
});
