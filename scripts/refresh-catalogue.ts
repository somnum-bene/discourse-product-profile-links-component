// The Catalogue Refresh. Reads the committed Sheet Exports, asks the cpap.com
// Shopify Admin API about every product they name plus everything those
// divisions currently sell, and writes the Resolved Product Catalogue and the
// review document. Run it with `pnpm refresh:catalogue`.
//
// This is the only command that needs a Shopify token, and the only one that
// needs the network at all after the exports are committed. Everything it
// decides lives in `lib/catalogue-refresh.ts` and `lib/build-catalogue.ts`; what
// is left here is a fetch loop and two writes.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { buildCatalogue } from "./lib/build-catalogue.ts";
import {
  CATALOGUE_FILE,
  CatalogueRefreshError,
  curatesTitles,
  declaredDigest,
  type Division,
  DIVISIONS,
  divisionSurveyQuery,
  handleBatches,
  handlesFromSheetRows,
  MAX_SURVEY_PAGES,
  mergeProducts,
  productsByHandleQuery,
  productsFromByHandleResponse,
  renderReviewDocument,
  resolvedProductsCsv,
  REVIEW_FILE,
  SHOP_DOMAIN_VAR,
  shopifyEndpoint,
  type SurveyedProduct,
  surveyPageFromResponse,
  TOKEN_VAR,
} from "./lib/catalogue-refresh.ts";
import {
  exportFileName,
  SHEET_TABS,
  SheetExportError,
  type SheetRow,
  sheetRowsFrom,
} from "./lib/sheet-export.ts";

const EXPORT_DIR = "data";

async function main(): Promise<void> {
  const shopDomain = process.env[SHOP_DOMAIN_VAR];
  const token = process.env[TOKEN_VAR];

  if (!shopDomain || !token) {
    throw new CatalogueRefreshError(
      `${SHOP_DOMAIN_VAR} and ${TOKEN_VAR} both have to be set. They live in ` +
        `the ignored .env; this is the only command that needs them.`
    );
  }

  const endpoint = shopifyEndpoint(shopDomain);
  const sheetRows = await readSheetExports();
  const handles = handlesFromSheetRows(sheetRows);

  process.stdout.write(
    `${sheetRows.length} sheet rows naming ${handles.length} product handles\n`
  );

  const fetched: SurveyedProduct[][] = [];

  for (const batch of handleBatches(handles)) {
    const body = await post(endpoint, token, productsByHandleQuery(batch));
    const found = productsFromByHandleResponse(body, batch);
    fetched.push(found);
    process.stdout.write(
      `  by handle: Shopify knows ${found.length} of ${batch.length}\n`
    );
  }

  for (const division of DIVISIONS) {
    fetched.push(await surveyDivision(endpoint, token, division));
  }

  const products = mergeProducts(...fetched);
  const { catalogue, exclusions } = buildCatalogue({ sheetRows, products });
  const csv = resolvedProductsCsv(catalogue);
  const digest = declaredDigest(csv);
  const review = renderReviewDocument({
    catalogue,
    exclusions,
    sheetRows,
    products,
    digest,
  });

  await mkdir(dirname(CATALOGUE_FILE), { recursive: true });
  await writeFile(CATALOGUE_FILE, csv);
  await writeFile(REVIEW_FILE, review);

  process.stdout.write(
    `\n${CATALOGUE_FILE}: ${catalogue.length} Mappings, ${exclusions.length} excluded\n` +
      `${REVIEW_FILE}: the review document — read this before applying anything\n` +
      `digest: ${digest}\n`
  );

  for (const division of DIVISIONS) {
    const mappings = catalogue.filter(
      (entry) => entry.userFieldName === division.userFieldName
    ).length;

    // Stated rather than left as a zero to be interpreted: a field whose tab
    // curates no Suggested columns is meant to produce nothing (ADR-0012), and
    // a run that printed the same silence for "nothing to map" and "everything
    // failed to resolve" would make the expected case look like the broken one.
    process.stdout.write(
      mappings === 0 && !curatesTitles(division.userFieldName)
        ? `${division.userFieldName}: no Mappings — expected, the tab curates none\n`
        : `${division.userFieldName}: ${mappings} Mappings\n`
    );
  }
}

/**
 * The Sheet Exports, re-validated on the way in. They are committed, so
 * this rereads them rather than the spreadsheet — the point of committing them
 * is that a refresh and a review are looking at the same rows.
 */
async function readSheetExports(): Promise<SheetRow[]> {
  const rows: SheetRow[] = [];

  for (const tab of SHEET_TABS) {
    const path = join(EXPORT_DIR, exportFileName(tab));
    const csvText = await readFile(path, "utf8");
    rows.push(...sheetRowsFrom(tab, csvText));
  }

  return rows;
}

async function surveyDivision(
  endpoint: string,
  token: string,
  division: Division
): Promise<SurveyedProduct[]> {
  const products: SurveyedProduct[] = [];
  let cursor: string | null = null;

  for (let page = 1; page <= MAX_SURVEY_PAGES; page += 1) {
    const body = await post(
      endpoint,
      token,
      divisionSurveyQuery(division, cursor)
    );
    const surveyed = surveyPageFromResponse(body, division);
    products.push(...surveyed.products);

    if (!surveyed.hasNextPage) {
      process.stdout.write(
        `  ${division.tag}: ${products.length} live products\n`
      );
      return products;
    }

    cursor = surveyed.endCursor;
  }

  throw new CatalogueRefreshError(
    `${division.tag} has more than ${MAX_SURVEY_PAGES} pages of live products. ` +
      `That is far more than the division is expected to hold, so the tag no ` +
      `longer means what this command assumes.`
  );
}

/**
 * One GraphQL request. The token goes into a header and nowhere else — not into
 * the URL, not into an error message, not into the log. Shopify reports a
 * refused query as HTTP 200 with an `errors` array, so the response body is
 * checked by the caller rather than the status code being trusted.
 */
async function post(
  endpoint: string,
  token: string,
  query: string
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new CatalogueRefreshError(
      `Shopify answered ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}

// Not top-level `await`: TypeScript reads this file as CommonJS, because
// package.json declares no `"type"`, and CommonJS has no top-level await. Node
// runs it as ESM regardless. `scripts/README.md` has the whole story.
main().catch((error: unknown) => {
  // A Sheet Export that no longer validates is caught here too. It is a refusal
  // rather than a crash — the same guards that fetched the exports check them on
  // the way back in, and the reason belongs on stderr, not in a stack trace.
  if (
    error instanceof CatalogueRefreshError ||
    error instanceof SheetExportError
  ) {
    process.stderr.write(`${error.message}\nNothing was written.\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
});
