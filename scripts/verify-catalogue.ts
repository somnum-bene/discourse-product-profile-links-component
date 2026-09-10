// The Catalogue Verify. Asks cpap.com whether every URL this pipeline ships
// actually serves a page — the Resolved Product Catalogue and the Collection
// Links alike — one request at a time. Run it with `pnpm verify:catalogue`.
//
// It is a deliberate command and it is absent from every build script and every
// pre-commit hook on purpose: it takes about a minute, it depends on a third
// party's rate limiter, and a commit that cannot be made while cpap.com is busy
// would be a gate that fails for reasons nobody in this repository controls.
//
// It needs no credentials at all — not Shopify's, not Discourse's. Shopify's
// verdict on each product already travels in the catalogue's `status` column, so
// the only thing this asks for is a public page. That is the whole reason the
// Collection Links belong here too: the Admin API admitting a collection is not
// the storefront serving it.
//
// Every judgement is in lib/catalogue-verify.ts: what a status code means, how
// long to wait, when to stop asking, what to propose, and whether the catalogue
// is shippable. What is left here is a loop, a `fetch`, a wait and some printing.

import { readFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { collectionHandleFromUrl } from "./lib/build-catalogue.ts";
import {
  CATALOGUE_FILE,
  CatalogueRefreshError,
  COLLECTION_LINKS_FILE,
  declaredDigest,
  readCollectionLinks,
  readResolvedProducts,
} from "./lib/catalogue-refresh.ts";
import {
  type Attempt,
  CatalogueVerifyError,
  delayBeforeAttempt,
  entriesByUrl,
  isEligible,
  MAX_ATTEMPTS,
  PACE_MS,
  pauseReason,
  refuseArguments,
  refuseEmptyCatalogue,
  renderVerification,
  REQUEST_TIMEOUT_MS,
  resultFrom,
  retryAfterMs,
  shippability,
  shouldRetry,
  type VerifyEntry,
  type VerifyResult,
} from "./lib/catalogue-verify.ts";

async function main(): Promise<void> {
  refuseArguments(process.argv.slice(2));

  // Through each file's own reader, so one edited after it was approved is
  // refused rather than verified.
  const catalogueText = await readFile(CATALOGUE_FILE, "utf8");
  const catalogue = readResolvedProducts(catalogueText);
  const linksText = await readFile(COLLECTION_LINKS_FILE, "utf8");
  const collectionLinks = readCollectionLinks(linksText);

  // Before the two sinks are merged, while the counts are still separable. Once
  // they are one list, `shippability` can no longer tell an empty catalogue from
  // a catalogue whose entries all happen to be collections.
  refuseEmptyCatalogue(catalogue.length);

  // Both sinks, in one bounded pass. A Catalogue Refresh asks Shopify's Admin
  // API only whether a collection exists, and says so at its `COLLECTION_LOOKUP`
  // — "a collection can exist in the admin, be unpublished to the Online Store,
  // and still 404 for a member — and that question is Catalogue Verify's,
  // deliberately (ADR-0017)". That question was assigned here and then not
  // asked: this loop read the catalogue alone, so a newly shipped Collection
  // Link could 404 for every member holding the value while the command
  // reported success.
  //
  // A Collection Link is deliberately not a `ResolvedProduct` (ADR-0021) and
  // this does not make it one. The shape below exists for the length of one
  // request loop and never leaves this command: `status` is `ACTIVE` because
  // eligibility here means "there is a public page to ask about", which is true
  // of every committed Collection Link by construction, and `handle` is the one
  // Shopify was asked to admit.
  //
  // `kind` travels with each entry so the judgement in the lib can tell them
  // apart. Borrowing the product shape is not the same as being a product, and
  // the redirect check and the proposed corrections both turn on which one this
  // is.
  const entries: VerifyEntry[] = [
    ...catalogue.map((product) => ({ ...product, kind: "product" as const })),
    ...collectionLinks.map((link) => ({
      userFieldName: link.userFieldName,
      value: link.value,
      handle: collectionHandleFromUrl(link.url),
      status: "ACTIVE" as const,
      url: link.url,
      kind: "collection" as const,
    })),
  ];

  // Asked once per URL, answered for every Mapping that carries it. Collection
  // Links share a page by design — 82 committed rows over 10 collections — and
  // the pass used to request each one, which is a minute of pacing spent
  // re-asking a question already answered and 72 avoidable hits on a rate
  // limiter this repository does not own.
  const grouped = entriesByUrl(entries);

  process.stdout.write(
    `catalogue: ${declaredDigest(catalogueText, CATALOGUE_FILE)}\n` +
      `links:     ${declaredDigest(linksText, COLLECTION_LINKS_FILE)}\n` +
      `${entries.length} Mappings (${catalogue.length} products, ` +
      `${collectionLinks.length} collections) over ${grouped.size} distinct ` +
      `URLs, one request at a time, ${PACE_MS}ms apart, up to ` +
      `${MAX_ATTEMPTS} attempts each\n\n`
  );

  const results: VerifyResult[] = [];
  let requested = 0;

  for (const [index, [url, sharing]] of [...grouped].entries()) {
    // Eligibility is a property of the entry, not of the URL, so it is asked of
    // each one again below. A group nothing in it is eligible for is never
    // requested at all, which is what keeps an excluded product silent here.
    const eligible = sharing.some((entry) => isEligible(entry));

    if (eligible && requested > 0) {
      await sleep(PACE_MS);
    }

    const attempts = eligible ? await attemptsFor(url) : [];

    if (eligible) {
      requested += 1;
    }

    const groupResults = sharing.map((entry) =>
      resultFrom(entry, isEligible(entry) ? attempts : [])
    );

    results.push(...groupResults);

    const shown = groupResults[0] as VerifyResult;

    process.stdout.write(
      `${`${index + 1}`.padStart(3)}/${grouped.size} ` +
        `${shown.outcome.padEnd(10)} ${shown.status ?? "—"} ${url}` +
        (sharing.length > 1 ? ` (${sharing.length} Mappings)` : "") +
        `\n`
    );
  }

  process.stdout.write(renderVerification(results));

  if (!shippability(results).shippable) {
    process.exitCode = 1;
  }
}

/**
 * One URL, asked for as many times as the retry policy allows.
 *
 * Attempts rather than a result: the answer belongs to the URL and the verdict
 * belongs to the entry, and since several Mappings can share one URL, the
 * judgement has to be made once per Mapping from the attempts made once.
 */
async function attemptsFor(url: string): Promise<Attempt[]> {
  const attempts: Attempt[] = [];

  for (;;) {
    const attempt = await request(url);

    attempts.push(attempt);

    if (!shouldRetry(attempt, attempts.length)) {
      return attempts;
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
