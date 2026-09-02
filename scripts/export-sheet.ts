// Fetch the exported tabs of the migration spreadsheet and commit them
// verbatim as the Sheet Exports. Run it with `pnpm export:sheet`.
//
// The shell is deliberately thin: it fetches, validates, and writes. Every
// decision about what is allowed lives in `lib/sheet-export.ts`, which is pure
// and therefore actually tested. This file contains no tab names and builds no
// URLs of its own — it can only ask the allowlist what to fetch.

import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  EXPORT_TABS,
  exportFileName,
  readSheetTab,
  sheetCsvUrl,
  SheetExportError,
  sheetRowsFrom,
  sheetTabFor,
  WORKBOOK_ID_VAR,
} from "./lib/sheet-export.ts";

const OUTPUT_DIR = "data";

async function main(): Promise<void> {
  const workbookId = process.env[WORKBOOK_ID_VAR];
  if (!workbookId) {
    throw new SheetExportError(
      `${WORKBOOK_ID_VAR} is not set. It lives in the ignored .env — the ` +
        `workbook is a public link to real customer data and this repository ` +
        `is public, so the id is not committed.`
    );
  }

  // Fetch and validate everything before writing anything. A run that aborts
  // half way through would leave `data/` holding one refreshed export and a
  // stale one, which is worse than leaving both alone.
  const fetched = [];
  for (const tab of EXPORT_TABS) {
    const response = await fetch(sheetCsvUrl(workbookId, tab));
    if (!response.ok) {
      throw new SheetExportError(
        `${tab.tab}: the sheet answered ${response.status} ${response.statusText}`
      );
    }

    // Both calls validate, so the CSV is parsed twice. That costs nothing at a
    // few hundred rows and leaves each function safe to call on its own, which
    // is worth more than the saving.
    const csvText = await response.text();
    const dataRows = readSheetTab(tab, csvText);
    // Only the option tables feed the catalogue. The Collection Assignment is
    // fetched, validated and committed on the same terms and contributes no
    // rows, which is a fact about the tab rather than a special case for it.
    const optionTable = sheetTabFor(tab);
    const sheetRows = optionTable ? sheetRowsFrom(optionTable, csvText) : [];
    fetched.push({ tab, csvText, dataRows, sheetRows });
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const { tab, csvText, dataRows, sheetRows } of fetched) {
    // Written byte for byte as the endpoint returned it, LF endings and absent
    // final newline included. `data/` is exempt from the whitespace-fixing
    // pre-commit hooks for exactly this reason.
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
