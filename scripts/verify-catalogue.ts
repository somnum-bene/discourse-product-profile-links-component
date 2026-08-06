// The Catalogue Verify. Asks cpap.com whether every URL in the Resolved Product
// Catalogue actually serves a page, one request at a time. Run it with
// `pnpm verify:catalogue`.
//
// It is a deliberate command and it is absent from every build script and every
// pre-commit hook on purpose: it takes about a minute, it depends on a third
// party's rate limiter, and a commit that cannot be made while cpap.com is busy
// would be a gate that fails for reasons nobody in this repository controls.
//
// It needs no credentials at all — not Shopify's, not Discourse's. Shopify's
// verdict on each product already travels in the catalogue's `status` column, so
// the only thing this asks for is a public product page.
//
// Every judgement is in lib/catalogue-verify.ts: what a status code means, how
// long to wait, when to stop asking, what to propose, and whether the catalogue
// is shippable. What is left here is a loop, a `fetch`, a wait and some printing.

import { readFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import type { ResolvedProduct } from "./lib/build-catalogue.ts";
import {
  CATALOGUE_FILE,
  CatalogueRefreshError,
  declaredDigest,
  readResolvedProducts,
} from "./lib/catalogue-refresh.ts";
import {
  type Attempt,
  CatalogueVerifyError,
  delayBeforeAttempt,
  isEligible,
  MAX_ATTEMPTS,
  PACE_MS,
  pauseReason,
  refuseArguments,
  renderVerification,
  REQUEST_TIMEOUT_MS,
  resultFrom,
  retryAfterMs,
  shippability,
  shouldRetry,
  type VerifyResult,
} from "./lib/catalogue-verify.ts";

async function main(): Promise<void> {
  refuseArguments(process.argv.slice(2));

  // Through the catalogue's own reader, so a file edited after it was approved
  // is refused rather than verified.
  const catalogueText = await readFile(CATALOGUE_FILE, "utf8");
  const catalogue = readResolvedProducts(catalogueText);

  process.stdout.write(
    `catalogue: ${declaredDigest(catalogueText)}\n` +
      `${catalogue.length} URLs, one request at a time, ${PACE_MS}ms apart, ` +
      `up to ${MAX_ATTEMPTS} attempts each\n\n`
  );

  const results: VerifyResult[] = [];

  for (const [index, entry] of catalogue.entries()) {
    if (index > 0 && isEligible(entry)) {
      await sleep(PACE_MS);
    }

    const result = await verify(entry);

    results.push(result);
    process.stdout.write(
      `${`${index + 1}`.padStart(3)}/${catalogue.length} ` +
        `${result.outcome.padEnd(10)} ${result.status ?? "—"} ${result.url}\n`
    );
  }

  process.stdout.write(renderVerification(results));

  if (!shippability(results).shippable) {
    process.exitCode = 1;
  }
}

/** One entry, asked for as many times as the retry policy allows. */
async function verify(entry: ResolvedProduct): Promise<VerifyResult> {
  if (!isEligible(entry)) {
    return resultFrom(entry, []);
  }

  const attempts: Attempt[] = [];

  for (;;) {
    const attempt = await request(entry.url);

    attempts.push(attempt);

    if (!shouldRetry(attempt, attempts.length)) {
      return resultFrom(entry, attempts);
    }

    const asked =
      attempt.kind === "answered"
        ? retryAfterMs(attempt.retryAfter, Date.now())
        : null;
    const wait = delayBeforeAttempt(attempts.length + 1, asked);

    process.stdout.write(
      `    ${pauseReason(attempt)} — waiting ${wait}ms before attempt ` +
        `${attempts.length + 1} of ${MAX_ATTEMPTS}\n`
    );

    await sleep(wait);
  }
}

/**
 * One request. `HEAD` is not used: a storefront can answer it differently from
 * the `GET` a member's browser will send, and the question is whether the page a
 * Profile Link opens exists. Redirects are followed, so a moved product resolves
 * and reports where from rather than reading as a failure.
 */
async function request(url: string): Promise<Attempt> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        // Named rather than disguised. A storefront is entitled to know what is
        // asking, and a bot filter answering 403 to this is a finding rather
        // than something to work around with a browser's user agent.
        "User-Agent":
          "discourse-product-profile-links-component catalogue verify",
        Accept: "text/html",
      },
    });

    // The body is not read. Whether the page exists is a status code question,
    // and downloading fifty-five product pages to discard them is fifty-five
    // requests' worth of load on a site that already rate-limits.
    await response.body?.cancel();

    return {
      kind: "answered",
      status: response.status,
      finalUrl: response.url,
      ...(response.headers.get("retry-after") === null
        ? {}
        : { retryAfter: response.headers.get("retry-after") as string }),
    };
  } catch (error: unknown) {
    return {
      kind: "no-answer",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

// Not top-level `await`: TypeScript reads this file as CommonJS, because
// package.json declares no `"type"`, and CommonJS has no top-level await. Node
// runs it as ESM regardless. `scripts/README.md` has the whole story.
main().catch((error: unknown) => {
  if (
    error instanceof CatalogueVerifyError ||
    error instanceof CatalogueRefreshError
  ) {
    process.stderr.write(`\n${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
});
