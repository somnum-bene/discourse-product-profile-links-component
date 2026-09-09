import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  collectionHandleFromUrl,
  type ProductStatus,
} from "../../scripts/lib/build-catalogue";
import {
  readCollectionLinks,
  readResolvedProducts,
} from "../../scripts/lib/catalogue-refresh.ts";
import {
  type Attempt,
  BACKOFF_MS,
  CatalogueVerifyError,
  classifyAttempt,
  collectionHandleOf,
  collectionUrlFor,
  delayBeforeAttempt,
  distinctUrls,
  entriesByUrl,
  handleOf,
  isEligible,
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  PACE_MS,
  pauseReason,
  productHandleOf,
  proposedCorrection,
  refuseArguments,
  refuseEmptyCatalogue,
  renderVerification,
  resultFrom,
  retryAfterMs,
  shippability,
  shouldRetry,
  summarize,
  type VerifyEntry,
  type VerifyResult,
} from "../../scripts/lib/catalogue-verify";

function entry(overrides: Partial<VerifyEntry> = {}): VerifyEntry {
  return {
    userFieldName: "Machine",
    value: "AirSense 11 AutoSet",
    handle: "airsense-11-autoset",
    status: "ACTIVE",
    url: "https://www.cpap.com/products/airsense-11-autoset",
    kind: "product",
    ...overrides,
  };
}

/** The other sink, which borrows the product shape and is not a product. */
function link(overrides: Partial<VerifyEntry> = {}): VerifyEntry {
  return entry({
    value: "DreamStation CPAP Machine (Discontinued)",
    handle: "apap-machines",
    url: "https://www.cpap.com/collections/apap-machines",
    kind: "collection",
    ...overrides,
  });
}

function answered(status: number, overrides: Partial<Attempt> = {}): Attempt {
  return {
    kind: "answered",
    status,
    finalUrl: "https://www.cpap.com/products/airsense-11-autoset",
    ...overrides,
  } as Attempt;
}

function result(overrides: Partial<VerifyResult> = {}): VerifyResult {
  return {
    userFieldName: "Machine",
    value: "AirSense 11 AutoSet",
    url: "https://www.cpap.com/products/airsense-11-autoset",
    kind: "product",
    outcome: "verified",
    detail: "HTTP 200",
    attempts: 1,
    status: 200,
    ...overrides,
  };
}

describe("the command line, which is empty", () => {
  it("accepts no arguments", () => {
    expect(() => refuseArguments([])).not.toThrow();
  });

  it("refuses anything at all, and says what it was given", () => {
    // There is no flag that narrows the pass or accepts an unanswered URL:
    // each one would be a way of declaring the catalogue verified without
    // having verified it.
    expect(() => refuseArguments(["--force"])).toThrow(CatalogueVerifyError);
    expect(() => refuseArguments(["--force"])).toThrow(/"--force"/);
    expect(() => refuseArguments(["Machine"])).toThrow(/"Machine"/);
    expect(() => refuseArguments(["--plan", "-x"])).toThrow(/"--plan" "-x"/);
  });
});

describe("which entries get requested at all", () => {
  it("requests the products Shopify admits", () => {
    expect(isEligible(entry())).toBe(true);
  });

  it("does not request one Shopify refuses, whatever the refusal was", () => {
    // Shopify's verdict travels in the catalogue's status column, which is what
    // lets this pass run with no Shopify credentials. `buildCatalogue` cannot
    // emit one of these, so an entry here means the catalogue is wrong.
    for (const status of ["ARCHIVED", "DRAFT", "UNLISTED"] as ProductStatus[]) {
      expect(isEligible(entry({ status })), status).toBe(false);
    }
  });
});

describe("what one request means", () => {
  it("passes on any 2XX, not only 200", () => {
    for (const status of [200, 201, 202, 204, 226, 299]) {
      expect(classifyAttempt(answered(status)), `${status}`).toBe("pass");
    }
  });

  it("retries the two statuses that mean ask again", () => {
    // Both are the server declining to answer about this URL rather than
    // answering. Telling that apart from a dead page is most of what this pass
    // is for: an ad-hoc run at eight concurrent produced 429 on 68 of 86 URLs.
    expect(classifyAttempt(answered(429))).toBe("retry");
    expect(classifyAttempt(answered(503))).toBe("retry");
  });

  it("fails a definite non-2XX answer, including a server error", () => {
    // 500 and 502 are deliberately not retried. They are answers, and reporting
    // one with its status leaves the judgement with a human rather than looping
    // past it and calling the result unresolved.
    for (const status of [301, 400, 403, 404, 410, 418, 500, 502]) {
      expect(classifyAttempt(answered(status)), `${status}`).toBe("failed");
    }
  });

  it("retries when nothing answered", () => {
    // A DNS blip or a timeout is not evidence about a product page. Recording
    // one as a failure would report a broken network as a broken catalogue.
    expect(classifyAttempt({ kind: "no-answer", detail: "fetch failed" })).toBe(
      "retry"
    );
  });
});

describe("when to stop asking", () => {
  it("keeps asking a throttled URL until the attempts run out", () => {
    expect(shouldRetry(answered(429), 1)).toBe(true);
    expect(shouldRetry(answered(429), MAX_ATTEMPTS - 1)).toBe(true);
    expect(shouldRetry(answered(429), MAX_ATTEMPTS)).toBe(false);
  });

  it("never asks twice about an answer it already has", () => {
    expect(shouldRetry(answered(200), 1)).toBe(false);
    expect(shouldRetry(answered(404), 1)).toBe(false);
  });

  it("paces requests rather than running them concurrently", () => {
    // The constants are the finding, not a preference: eight concurrent
    // requests is known to be too many, and one at a time with a pause is what
    // the pass does instead of discovering the ceiling on every run.
    expect(PACE_MS).toBeGreaterThan(0);
    expect(MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(BACKOFF_MS.length).toBe(MAX_ATTEMPTS - 1);
  });

  it("backs off further on each retry rather than at a fixed interval", () => {
    // A fixed retry interval against a rate limiter is the same request pattern
    // that earned the 429 in the first place.
    for (let index = 1; index < BACKOFF_MS.length; index += 1) {
      expect(BACKOFF_MS[index]).toBeGreaterThan(BACKOFF_MS[index - 1]);
    }
  });
});

describe("how long to wait", () => {
  const now = Date.parse("2026-08-05T12:00:00Z");

  it("reads the seconds form of Retry-After", () => {
    expect(retryAfterMs("30", now)).toBe(30_000);
    expect(retryAfterMs("  5  ", now)).toBe(5_000);
    expect(retryAfterMs("0", now)).toBe(0);
  });

  it("reads the HTTP-date form", () => {
    expect(retryAfterMs("Wed, 05 Aug 2026 12:00:20 GMT", now)).toBe(20_000);
  });

  it("treats a date already past as no wait rather than a negative one", () => {
    expect(retryAfterMs("Wed, 05 Aug 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("caps what it will honour", () => {
    // A misconfigured header should not be able to hang the pass. Past the cap
    // the URL is reported unresolved, which is a result rather than a wait.
    expect(retryAfterMs("999999", now)).toBe(MAX_RETRY_AFTER_MS);
    expect(retryAfterMs("Fri, 07 Aug 2026 12:00:00 GMT", now)).toBe(
      MAX_RETRY_AFTER_MS
    );
  });

  it("has no opinion when the header is absent or unreadable", () => {
    expect(retryAfterMs(undefined, now)).toBeNull();
    expect(retryAfterMs("", now)).toBeNull();
    expect(retryAfterMs("   ", now)).toBeNull();
    expect(retryAfterMs("soon", now)).toBeNull();
    expect(retryAfterMs("-5", now)).toBeNull();
  });

  it("follows the schedule when the server asked for nothing", () => {
    expect(delayBeforeAttempt(2, null)).toBe(BACKOFF_MS[0]);
    expect(delayBeforeAttempt(3, null)).toBe(BACKOFF_MS[1]);
    expect(delayBeforeAttempt(4, null)).toBe(BACKOFF_MS[2]);
  });

  it("waits as long as the server asked when that is longer", () => {
    // Asking again sooner than a rate limiter said to is how the rate limit
    // gets extended rather than waited out.
    expect(delayBeforeAttempt(2, 60_000)).toBe(60_000);
  });

  it("keeps the schedule when the server asked for less", () => {
    expect(delayBeforeAttempt(3, 1)).toBe(BACKOFF_MS[1]);
  });

  it("does not run off the end of the schedule", () => {
    expect(delayBeforeAttempt(99, null)).toBe(
      BACKOFF_MS[BACKOFF_MS.length - 1]
    );
  });
});

describe("the outcome of one entry", () => {
  it("verifies a 2XX", () => {
    expect(resultFrom(entry(), [answered(200)])).toEqual({
      userFieldName: "Machine",
      value: "AirSense 11 AutoSet",
      kind: "product",
      url: "https://www.cpap.com/products/airsense-11-autoset",
      outcome: "verified",
      detail: "HTTP 200",
      attempts: 1,
      status: 200,
    });
  });

  it("verifies a 2XX reached after retries, counting them", () => {
    const verdict = resultFrom(entry(), [
      answered(429),
      answered(429),
      answered(200),
    ]);

    expect(verdict.outcome).toBe("verified");
    expect(verdict.attempts).toBe(3);
  });

  it("records where a redirect landed, and still calls it verified", () => {
    // The link works, so this is not a failure. It is a proposed correction:
    // the catalogue is carrying a handle Shopify has moved on from.
    const verdict = resultFrom(entry(), [
      answered(200, { finalUrl: "https://www.cpap.com/products/airsense-11" }),
    ]);

    expect(verdict.outcome).toBe("verified");
    expect(verdict.redirectedTo).toBe(
      "https://www.cpap.com/products/airsense-11"
    );
    expect(verdict.detail).toContain("after a redirect to");
  });

  it("says nothing about a redirect when there was none", () => {
    expect(resultFrom(entry(), [answered(200)])).not.toHaveProperty(
      "redirectedTo"
    );
  });

  it("fails a 200 that redirected off /products/ altogether", () => {
    // Measured against the real storefront on 2026-08-05:
    // /products/airsense-11-autoset — a handle Shopify has since renamed —
    // answers 200 from https://www.cpap.com/#erid51316016. Reading the status
    // code alone would report a Profile Link to the homepage as verified.
    const verdict = resultFrom(entry(), [
      answered(200, { finalUrl: "https://www.cpap.com/#erid51316016" }),
    ]);

    expect(verdict.outcome).toBe("failed");
    expect(verdict.status).toBe(200);
    expect(verdict.detail).toContain("redirected off /products/");
    expect(verdict.detail).toContain("https://www.cpap.com/#erid51316016");
  });

  it("fails a 200 that landed on a collection or a search page", () => {
    for (const finalUrl of [
      "https://www.cpap.com/collections/cpap-machines",
      "https://www.cpap.com/pages/about",
      "https://www.cpap.com/search?q=airsense",
      "https://www.cpap.com/products/",
      "https://www.cpap.com/products/a/b",
    ]) {
      expect(
        resultFrom(entry(), [answered(200, { finalUrl })]).outcome,
        finalUrl
      ).toBe("failed");
    }
  });

  it("still verifies a 200 that redirected to another product", () => {
    // A renamed handle that resolves to a product page is a moved product: the
    // link works, so it is not a failure — it is a proposed correction.
    expect(
      resultFrom(entry(), [
        answered(200, {
          finalUrl: "https://www.cpap.com/products/resmed-airsense-11-autoset",
        }),
      ]).outcome
    ).toBe("verified");
  });

  it("fails a Collection Link that redirected onto a product page", () => {
    // Not a moved collection. A whole range of discontinued equipment answered
    // by one product page is the outcome a Collection Link exists to avoid
    // (ADR-0021), so a 200 from `/products/` is a failure for this sink even
    // though it is a pass for the other.
    const verdict = resultFrom(link(), [
      answered(200, {
        finalUrl: "https://www.cpap.com/products/airsense-11-autoset",
      }),
    ]);

    expect(verdict.outcome).toBe("failed");
    expect(verdict.detail).toContain("redirected off /collections/");
    expect(verdict.detail).toContain("not this collection");
  });

  it("still verifies a Collection Link that redirected to another collection", () => {
    // The mirror image, and the half that was actively broken: checked against
    // `/products/`, a collection that cpap.com had merely renamed read as a
    // soft 404 and blocked the ship for no reason.
    const verdict = resultFrom(link(), [
      answered(200, {
        finalUrl: "https://www.cpap.com/collections/auto-cpap-machines",
      }),
    ]);

    expect(verdict.outcome).toBe("verified");
    expect(verdict.redirectedTo).toBe(
      "https://www.cpap.com/collections/auto-cpap-machines"
    );
  });

  it("carries the sink each result came from", () => {
    expect(resultFrom(entry(), [answered(200)]).kind).toBe("product");
    expect(
      resultFrom(link(), [
        answered(200, {
          finalUrl: "https://www.cpap.com/collections/apap-machines",
        }),
      ]).kind
    ).toBe("collection");
  });

  it("reads the collection handle out of a URL, and only a collection URL", () => {
    expect(
      collectionHandleOf("https://www.cpap.com/collections/apap-machines")
    ).toBe("apap-machines");
    expect(
      collectionHandleOf("https://www.cpap.com/collections/apap-machines/")
    ).toBe("apap-machines");
    expect(
      collectionHandleOf("https://www.cpap.com/products/airsense-11")
    ).toBeNull();
    expect(collectionHandleOf("https://www.cpap.com/")).toBeNull();
    expect(collectionHandleOf("not a url")).toBeNull();
  });

  it("refuses a collection path on any other origin", () => {
    // The path alone is not the question. A redirect that leaves cpap.com has
    // not moved the collection, and a landing page on someone else's host that
    // happens to be spelled /collections/ is not a Collection Link resolving.
    expect(
      collectionHandleOf("https://example.com/collections/apap-machines")
    ).toBeNull();
    expect(
      collectionHandleOf("http://www.cpap.com/collections/apap-machines")
    ).toBeNull();
    expect(
      collectionHandleOf("https://cpap.com/collections/apap-machines")
    ).toBeNull();
    expect(
      handleOf("collection", "https://example.com/collections/x")
    ).toBeNull();
  });

  it("asks the question that matches the sink", () => {
    const product = "https://www.cpap.com/products/airsense-11";
    const collection = "https://www.cpap.com/collections/apap-machines";

    expect(handleOf("product", product)).toBe("airsense-11");
    expect(handleOf("product", collection)).toBeNull();
    expect(handleOf("collection", collection)).toBe("apap-machines");
    expect(handleOf("collection", product)).toBeNull();
  });

  it("reads the product handle out of a URL, and only a product URL", () => {
    expect(productHandleOf("https://www.cpap.com/products/airsense-11")).toBe(
      "airsense-11"
    );
    expect(
      productHandleOf("https://www.cpap.com/products/airsense-11?variant=1")
    ).toBe("airsense-11");
    expect(productHandleOf("https://www.cpap.com/products/airsense-11/")).toBe(
      "airsense-11"
    );
    expect(productHandleOf("https://www.cpap.com/#erid51316016")).toBeNull();
    expect(productHandleOf("https://www.cpap.com/")).toBeNull();
    expect(productHandleOf("not a url")).toBeNull();
  });

  it("fails a 404 with its status", () => {
    const verdict = resultFrom(entry(), [answered(404)]);

    expect(verdict.outcome).toBe("failed");
    expect(verdict.status).toBe(404);
    expect(verdict.detail).toBe("HTTP 404");
  });

  it("calls a URL that only ever got 429 unresolved, not failed", () => {
    // The distinction the whole outcome exists for. Four 429s is a URL nobody
    // has an answer for, and calling it a failure would send someone to look at
    // a product page that is probably fine.
    const verdict = resultFrom(entry(), [
      answered(429),
      answered(429),
      answered(429),
      answered(429),
    ]);

    expect(verdict.outcome).toBe("unresolved");
    expect(verdict.status).toBe(429);
    expect(verdict.attempts).toBe(4);
    expect(verdict.detail).toContain("declining to answer");
    expect(verdict.detail).toContain("all 4 attempts");
  });

  it("calls a persistent 503 unresolved for the same reason", () => {
    expect(resultFrom(entry(), [answered(503), answered(503)]).outcome).toBe(
      "unresolved"
    );
  });

  it("calls a URL nothing answered unresolved, and says what happened", () => {
    const verdict = resultFrom(entry(), [
      { kind: "no-answer", detail: "The operation was aborted due to timeout" },
    ]);

    expect(verdict.outcome).toBe("unresolved");
    expect(verdict.status).toBeNull();
    expect(verdict.detail).toContain("timeout");
  });

  it("excludes an entry Shopify refuses without requesting it", () => {
    const verdict = resultFrom(entry({ status: "ARCHIVED" }), []);

    expect(verdict.outcome).toBe("excluded");
    expect(verdict.attempts).toBe(0);
    expect(verdict.status).toBeNull();
    expect(verdict.detail).toContain("ARCHIVED");
    expect(verdict.detail).toContain("never requested");
  });

  it("refuses to invent an outcome for a request nobody made", () => {
    // The one thing worse than an unresolved entry is an unchecked one reported
    // as checked.
    expect(() => resultFrom(entry(), [])).toThrow(CatalogueVerifyError);
    expect(() => resultFrom(entry(), [])).toThrow(/no request was made/);
  });
});

describe("the corrections proposed for a human to approve", () => {
  it("proposes nothing for a URL that simply worked", () => {
    expect(proposedCorrection(result())).toBeNull();
  });

  it("proposes catching the catalogue up when the storefront redirects", () => {
    const correction = proposedCorrection(
      result({ redirectedTo: "https://www.cpap.com/products/moved" })
    );

    expect(correction).toContain("https://www.cpap.com/products/moved");
    expect(correction).toContain("refresh:catalogue");
    expect(correction).toContain("not a failure");
  });

  it("names both things a 404 can mean rather than guessing", () => {
    // A changed handle and a product that is live but unpublished look identical
    // from here. `AirCurve 11 ASV` is the second kind: ACTIVE, in stock, and
    // 404. Picking one would send someone to edit the wrong system.
    const correction = proposedCorrection(
      result({ outcome: "failed", status: 404, detail: "HTTP 404" })
    );

    expect(correction).toContain("refresh:catalogue");
    expect(correction).toContain("Online Store");
    expect(correction).toContain("Check the product in Shopify");
  });

  it("treats 410 the same way", () => {
    expect(
      proposedCorrection(result({ outcome: "failed", status: 410 }))
    ).toContain("refresh:catalogue");
  });

  it("explains a failure that carries a 200, rather than leaving it puzzling", () => {
    const correction = proposedCorrection(
      result({ outcome: "failed", status: 200 })
    );

    expect(correction).toContain("redirecting to the homepage with a 200");
    expect(correction).toContain("refresh:catalogue");
    expect(correction).toContain("ADR-0009");
  });

  it("says a 5XX is the storefront failing, not the product missing", () => {
    const correction = proposedCorrection(
      result({ outcome: "failed", status: 502 })
    );

    expect(correction).toContain("storefront failing");
    expect(correction).not.toContain("refresh:catalogue");
  });

  it("suggests looking at a 403 by hand, because a bot filter looks like this", () => {
    expect(
      proposedCorrection(result({ outcome: "failed", status: 403 }))
    ).toContain("bot filter");
  });

  it("proposes running the pass again for an unresolved entry", () => {
    const correction = proposedCorrection(
      result({ outcome: "unresolved", status: 429 })
    );

    expect(correction).toContain("verify:catalogue");
    expect(correction).toContain("not evidence about the product");
  });

  it("proposes regenerating for an entry that should not be in the catalogue", () => {
    expect(
      proposedCorrection(
        result({ kind: "collection", outcome: "failed", status: 200 })
      )
    ).toContain("ADR-0021");
    expect(
      proposedCorrection(
        result({ kind: "collection", outcome: "failed", status: 200 })
      )
    ).not.toContain("onlineStoreUrl");

    // ADR-0009 makes Shopify the authority for a *product* URL, so a refresh
    // is the repair there. A Collection Link's URL is curated (ADR-0021) and a
    // refresh will never touch it — sending an operator to `refresh:catalogue`
    // would send them to a command that cannot help.
    expect(
      proposedCorrection(
        result({ kind: "collection", outcome: "failed", status: 404 })
      )
    ).toContain("ADR-0017");
    expect(
      proposedCorrection(
        result({
          kind: "collection",
          redirectedTo: "https://www.cpap.com/collections/auto-cpap-machines",
        })
      )
    ).toContain("curated rather than derived");

    expect(
      proposedCorrection(result({ outcome: "excluded", status: null }))
    ).toContain("refresh:catalogue");
  });
});

describe("whether the catalogue may be applied to an instance", () => {
  it("counts the four outcomes separately", () => {
    expect(
      summarize([
        result(),
        result({ outcome: "failed" }),
        result({ outcome: "failed" }),
        result({ outcome: "unresolved" }),
        result({ outcome: "excluded" }),
      ])
    ).toEqual({
      verified: 1,
      excluded: 1,
      failed: 2,
      unresolved: 1,
      total: 5,
    });
  });

  it("ships a catalogue whose every URL answered", () => {
    const verdict = shippability([result(), result()]);

    expect(verdict.shippable).toBe(true);
    expect(verdict.message).toContain("all 2 Mappings");
  });

  it("counts Mappings and the URLs actually asked apart", () => {
    // `summary.verified` counts results, and there is one per Mapping. Two
    // Mappings sharing a collection page are one request, so a message
    // calling that count "2 URLs" told an operator the pass hit the
    // storefront twice as often as it did. Both numbers are said because both
    // are real: how much shipped, and how much was asked.
    const shared = "https://www.cpap.com/collections/nasal-cpap-masks";
    const verdict = shippability([
      result({ kind: "collection", url: shared, value: "Viva Nasal" }),
      result({ kind: "collection", url: shared, value: "Wisp Nasal" }),
    ]);

    expect(verdict.shippable).toBe(true);
    expect(verdict.message).toContain("all 2 Mappings");
    expect(verdict.message).toContain("1 distinct URL,");
    expect(verdict.message).not.toContain("2 distinct");
  });

  it("says URLs in the plural only when there is more than one", () => {
    const verdict = shippability([
      result(),
      result({
        url: "https://www.cpap.com/products/airmini",
        value: "AirMini",
      }),
    ]);

    expect(verdict.message).toContain("2 distinct URLs,");
  });

  it("blocks on a failure", () => {
    const verdict = shippability([result(), result({ outcome: "failed" })]);

    expect(verdict.shippable).toBe(false);
    expect(verdict.message).toContain("1 failed");
    // The unresolved caveat is not printed when nothing is unresolved. It is
    // load-bearing where it applies, and boilerplate where it does not.
    expect(verdict.message).not.toContain("nobody has an answer for");
  });

  it("blocks on an unresolved entry exactly as hard as on a failure", () => {
    // Unresolved is not a pass. A 429 leaves a URL unchecked, and an unchecked
    // URL shipped as a Mapping may be a Profile Link pointing at nothing.
    const verdict = shippability([result(), result({ outcome: "unresolved" })]);

    expect(verdict.shippable).toBe(false);
    expect(verdict.message).toContain("1 unresolved");
    expect(verdict.message).toContain("not a failure");
  });

  it("blocks on an excluded entry, which should not be in the catalogue", () => {
    expect(shippability([result({ outcome: "excluded" })]).shippable).toBe(
      false
    );
  });

  it("reports every blocking reason rather than the first", () => {
    const verdict = shippability([
      result({ outcome: "failed" }),
      result({ outcome: "unresolved" }),
      result({ outcome: "excluded" }),
    ]);

    expect(verdict.message).toContain("1 failed");
    expect(verdict.message).toContain("1 unresolved");
    expect(verdict.message).toContain("1 excluded");
  });

  it("does not call an empty catalogue verified", () => {
    // Nothing checked is not everything passing. An empty catalogue ships no
    // Mappings at all, which is a different failure and still one.
    const verdict = shippability([]);

    expect(verdict.shippable).toBe(false);
    expect(verdict.message).toContain("nothing was checked");
  });
});

describe("the report", () => {
  const report = renderVerification([
    result({ value: "Fine" }),
    result({
      value: "Gone",
      outcome: "failed",
      status: 404,
      detail: "HTTP 404",
      url: "https://www.cpap.com/products/gone",
    }),
    result({
      value: "Throttled",
      outcome: "unresolved",
      status: 429,
      attempts: 4,
      detail:
        "HTTP 429, which is the server declining to answer, on all 4 attempts",
      url: "https://www.cpap.com/products/throttled",
    }),
    result({
      value: "Moved",
      redirectedTo: "https://www.cpap.com/products/moved-to",
    }),
  ]);

  it("counts all four outcomes", () => {
    expect(report).toContain("verified   2");
    expect(report).toContain("failed     1");
    expect(report).toContain("unresolved 1");
    expect(report).toContain("excluded   0");
  });

  it("names the field, the value and the URL of everything that did not pass", () => {
    // A count on its own tells nobody which product to go and look at.
    expect(report).toContain("Machine / Gone");
    expect(report).toContain("https://www.cpap.com/products/gone");
    expect(report).toContain("Machine / Throttled");
    expect(report).toContain("https://www.cpap.com/products/throttled");
  });

  it("keeps failed and unresolved in separate sections", () => {
    expect(report).toContain("failed (1)");
    expect(report).toContain("unresolved (1)");
    expect(report).toContain("run the pass again");
  });

  it("lists a verified entry that still has a correction to propose", () => {
    expect(report).toContain("verified, with a proposed correction (1)");
    expect(report).toContain("https://www.cpap.com/products/moved-to");
  });

  it("omits a section with nothing in it", () => {
    expect(report).not.toContain("excluded (");
  });

  it("says the corrections were not applied", () => {
    expect(report).toContain("never applied");
    expect(report).toContain("Nothing");
  });

  it("ends with the shippability verdict", () => {
    expect(report.trimEnd().endsWith("in exactly the same way.")).toBe(true);
    expect(report).toContain("NOT shippable");
  });

  it("says why the pass is pausing while it pauses", () => {
    // Thirty seconds of silence looks like a hang, and the reason for the pause
    // is the distinction the unresolved outcome exists to preserve.
    expect(pauseReason(answered(429))).toBe("HTTP 429");
    expect(pauseReason(answered(429, { retryAfter: "30" }))).toBe(
      "HTTP 429, Retry-After: 30"
    );
    expect(pauseReason({ kind: "no-answer", detail: "fetch failed" })).toBe(
      "no answer (fetch failed)"
    );
  });
});

describe("what the verify pass is allowed to be part of", () => {
  const packageJson = readFileSync("package.json", "utf8");
  const preCommit = readFileSync(".pre-commit-config.yaml", "utf8");
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const command = readFileSync("scripts/verify-catalogue.ts", "utf8");
  const lib = readFileSync("scripts/lib/catalogue-verify.ts", "utf8");
  const scripts = JSON.parse(packageJson).scripts as Record<string, string>;

  it("is a command anyone can run", () => {
    expect(scripts["verify:catalogue"]).toContain(
      "scripts/verify-catalogue.ts"
    );
  });

  it("is in no pre-commit hook", () => {
    // A rate-limited third party must not be able to block a commit. This is
    // the assertion, not the comment in the config file.
    expect(preCommit).not.toContain("verify:catalogue");
    expect(preCommit).not.toContain("verify-catalogue");
  });

  it("is in no CI step", () => {
    expect(ci).not.toContain("verify:catalogue");
    expect(ci).not.toContain("verify-catalogue");
  });

  it("is in no other npm script", () => {
    // Including a build script: `pnpm build:settings` gates CI, so anything it
    // called would gate CI too.
    for (const [name, body] of Object.entries(scripts)) {
      if (name === "verify:catalogue") {
        continue;
      }

      expect(body, name).not.toContain("verify:catalogue");
      expect(body, name).not.toContain("verify-catalogue");
    }
  });

  it("needs no credentials, so its script does not read .env", () => {
    // Shopify's verdict is already in the catalogue's status column and the
    // instance is not involved at all. A command that could read .env is one
    // that might come to depend on it.
    expect(scripts["verify:catalogue"]).not.toContain("--env-file");
    expect(command).not.toContain("process.env");

    for (const name of [
      "SHOPIFY_API_TOKEN",
      "SHOPIFY_SHOP_DOMAIN",
      "DISCOURSE_API_KEY",
      "DISCOURSE_API_USERNAME",
      "DISCOURSE_BASE_URL",
      "SHEET_WORKBOOK_ID",
    ]) {
      expect(command, name).not.toContain(name);
      expect(lib, name).not.toContain(name);
    }
  });

  it("takes no arguments at all", () => {
    // The refusal is a decision, so it lives in the lib and is asserted there.
    // What is left to pin here is that the command still asks.
    expect(command).toContain("refuseArguments(");
    expect([...command.matchAll(/"--[a-z-]+"/g)]).toEqual([]);
  });

  it("refuses arguments before it reads anything", () => {
    // A pass that had already started requesting before noticing it had been
    // asked for something it cannot do would be reporting on the wrong run.
    expect(command.indexOf("refuseArguments(")).toBeLessThan(
      command.indexOf("readResolvedProducts(")
    );
  });

  it("writes no file", () => {
    // A pass that could edit the catalogue would be reporting on its own
    // repairs. Corrections are printed (ADR-0009).
    expect(command).not.toContain("writeFile");
    expect(lib).not.toContain("writeFile");
  });

  it("decides everything about the pass without doing any of it", () => {
    // The judgements live in the lib and the transport lives in the command, so
    // there is nowhere in the loop for a decision to hide.
    expect([...lib.matchAll(/from "(node:[^"]+)"/g)]).toEqual([]);
    expect(lib).not.toContain("fetch(");
    expect(lib).not.toContain("setTimeout");
  });

  it("asks Shopify nothing and the Discourse instance nothing", () => {
    expect(command).not.toContain("myshopify");
    expect(command).not.toContain("graphql");
    expect(command).not.toContain("user_fields");
  });

  it("consults the retry policy rather than restating it", () => {
    // The one mistake a shell can make alone: looping on its own terms. If the
    // command stopped calling `shouldRetry`, the policy would be in two places
    // and only one of them tested.
    expect(command).toContain("shouldRetry(");
    expect(command).toContain("delayBeforeAttempt(");
    expect(command).toContain("resultFrom(");
    expect(command).toContain("shippability(");
  });

  it("reads the catalogue through its own reader, digest and all", () => {
    expect(command).toContain("readResolvedProducts(");
    expect(command).not.toContain("parseCsv");
    expect(command).not.toContain('.split("\\n")');
  });

  it("reads the Collection Links through their own reader too", () => {
    // Both committed sinks, both re-validated on the way in. Reading one by
    // hand would skip the suffix and collection-URL rules the reader holds.
    expect(command).toContain("readCollectionLinks(");
    expect(command).toContain("COLLECTION_LINKS_FILE");
  });

  it("asks the storefront about the Collection Links, not just the products", () => {
    // A Catalogue Refresh asks the Admin API only whether a collection exists,
    // and assigns public-page reachability here (ADR-0017) — a collection can
    // exist in the admin, be unpublished to the Online Store, and still 404 for
    // a member. The loop has to run over both or that question is assigned and
    // never asked, and a newly shipped Collection Link 404s while this reports
    // success.
    const loop = command.slice(
      command.indexOf("const results: VerifyResult[]")
    );

    expect(loop).toContain("[...grouped].entries()");
    expect(command).toMatch(/const entries: VerifyEntry\[\] = \[/);
    expect(command).toContain("...collectionLinks.map(");

    // And each side has to say which it is. Without the tag the lib checks
    // every redirect against `/products/`, which is the defect one line of
    // this file would otherwise reintroduce silently.
    expect(command).toContain('kind: "product" as const');
    expect(command).toContain('kind: "collection" as const');
  });

  it("requests each distinct URL once and judges each Mapping", () => {
    // The saving has to be in the requests and nowhere else: one `attemptsFor`
    // per group, and a `resultFrom` per entry in it.
    expect(command).toContain("const grouped = entriesByUrl(entries)");
    expect(command).toContain("await attemptsFor(url)");
    expect(command).toContain("sharing.map((entry) =>");
    expect(command).toContain(
      "resultFrom(entry, isEligible(entry) ? attempts : [])"
    );

    // One request per group, paced against the previous request rather than
    // the previous entry — pacing off `index` would sleep 750ms for a URL it
    // never asked about.
    expect(command).toContain("eligible && requested > 0");
    expect(command).not.toContain("index > 0 && isEligible(entry)");
  });

  it("counts the catalogue before the two sinks become one list", () => {
    // `shippability` refuses an empty run, and that stopped meaning "an empty
    // catalogue" the moment the Collection Links joined it. The guard has to
    // read the per-sink count, so it has to run before the merge.
    const guardAt = command.indexOf("refuseEmptyCatalogue(catalogue.length)");
    const mergeAt = command.indexOf("const entries: VerifyEntry[] = [");

    expect(guardAt).toBeGreaterThan(-1);
    expect(mergeAt).toBeGreaterThan(guardAt);
  });
});

describe("the URLs a pass actually requests", () => {
  it("asks a shared page once and answers for every Mapping on it", () => {
    // 82 committed Collection Links over 10 collections. The pass used to
    // request each row, which is 72 answers already in hand, about a minute of
    // pacing, and 72 avoidable hits on somebody else's rate limiter.
    const shared = [
      link({ value: "DreamStation CPAP Machine (Discontinued)" }),
      link({ value: "DreamStation Go (Discontinued)" }),
      link({
        value: "AirMini (Discontinued)",
        url: "https://www.cpap.com/collections/travel-cpap-machines",
      }),
    ];
    const grouped = entriesByUrl(shared);

    expect(grouped.size).toBe(2);
    expect(grouped.get(link({}).url)).toHaveLength(2);
    expect(
      grouped.get("https://www.cpap.com/collections/travel-cpap-machines")
    ).toHaveLength(1);
  });

  it("keeps the order the entries arrived in", () => {
    // Products first, then collections, is the order the command builds and the
    // order the progress lines read in. Grouping is not licence to reshuffle.
    const grouped = entriesByUrl([
      entry(),
      link({}),
      { ...entry(), url: "https://www.cpap.com/products/airsense-10" },
    ]);

    expect([...grouped.keys()]).toEqual([
      entry().url,
      link({}).url,
      "https://www.cpap.com/products/airsense-10",
    ]);
  });

  it("still produces one result per Mapping, not per URL", () => {
    // What ships is a Mapping. A report that collapsed them would name a URL
    // where an operator needs a `Field` and a `Value`.
    const sharing = [
      link({ value: "DreamStation CPAP Machine (Discontinued)" }),
      link({ value: "DreamStation Go (Discontinued)" }),
    ];
    const attempts = [
      { kind: "answered" as const, status: 200, finalUrl: link({}).url },
    ];
    const results = sharing.map((entryOnPage) =>
      resultFrom(entryOnPage, attempts)
    );

    expect(results.map((shipped) => shipped.value)).toEqual([
      "DreamStation CPAP Machine (Discontinued)",
      "DreamStation Go (Discontinued)",
    ]);
    expect(summarize(results).verified).toBe(2);
  });

  it("groups nothing that is not actually the same URL", () => {
    const grouped = entriesByUrl([link({}), link({ url: `${link({}).url}/` })]);

    expect(grouped.size).toBe(2);
  });
});

describe("the correction offered for a redirected Collection Link", () => {
  const redirectedTo = (finalUrl: string) =>
    resultFrom(link({}), [
      { kind: "answered" as const, status: 200, finalUrl },
    ]);

  it("recommends a URL the transform will accept back", () => {
    // The two handle readers do not accept the same strings.
    // `collectionHandleOf` allows the trailing slash a storefront redirect
    // adds; `collectionHandleFromUrl` refuses it, because a Collection Link is
    // one path segment. Pasting the raw landing URL into the Sheet is how the
    // next refresh answers `unadmitted-collection`.
    const correction = proposedCorrection(
      redirectedTo("https://www.cpap.com/collections/travel-cpap-machines/")
    );

    expect(correction).toContain(
      "set the Collection URL in the Sheet to " +
        "https://www.cpap.com/collections/travel-cpap-machines,"
    );
    expect(
      collectionHandleFromUrl(collectionUrlFor("travel-cpap-machines"))
    ).toBe("travel-cpap-machines");
  });

  it("drops the query string a landing URL carried", () => {
    const correction = proposedCorrection(
      redirectedTo(
        "https://www.cpap.com/collections/travel-cpap-machines?utm_source=x"
      )
    );

    // The landing URL is still quoted as what the storefront answered from —
    // that is the diagnosis. What must be clean is the URL it tells a curator
    // to type.
    expect(correction).toContain(
      "set the Collection URL in the Sheet to " +
        "https://www.cpap.com/collections/travel-cpap-machines,"
    );
  });

  it("proposes nothing when only the slash changed", () => {
    // Same handle, so the Sheet already holds the right value. A correction
    // here is busywork with a wrong-looking diff.
    expect(proposedCorrection(redirectedTo(`${link({}).url}/`))).toBeNull();
  });

  it("keeps that entry out of the section that promises one", () => {
    const report = renderVerification([redirectedTo(`${link({}).url}/`)]);

    expect(report).toContain("verified   1");
    expect(report).not.toContain("verified, with a proposed correction");
  });

  it("still proposes one when the handle actually moved", () => {
    const moved = redirectedTo(
      "https://www.cpap.com/collections/travel-cpap-machines"
    );

    expect(proposedCorrection(moved)).toContain("travel-cpap-machines");
    expect(renderVerification([moved])).toContain(
      "verified, with a proposed correction"
    );
  });
});

describe("every diagnostic a Collection Link can reach", () => {
  // The redirect check and the two corrections learned which sink they were
  // looking at; the messages they share with the product path did not. A
  // Collection Link timing out was "not evidence about the product", a 503 was
  // "the storefront failing rather than the product", and a clean run reported
  // "Shopify admits every product" about 82 collections the Admin API says
  // nothing reachable about (ADR-0017).
  const collectionAnswers = (status: number) => [
    { kind: "answered" as const, status, finalUrl: link({}).url },
  ];

  it("names the collection when the server declines to answer", () => {
    const unresolved = resultFrom(link({}), [
      ...collectionAnswers(429),
      ...collectionAnswers(429),
      ...collectionAnswers(429),
    ]);

    expect(unresolved.outcome).toBe("unresolved");
    expect(unresolved.detail).toContain("answer about the collection");
    expect(unresolved.detail).not.toContain("about the product");
  });

  it("names the collection in the unresolved correction", () => {
    const correction = proposedCorrection(
      resultFrom(link({}), [
        ...collectionAnswers(429),
        ...collectionAnswers(429),
        ...collectionAnswers(429),
      ])
    );

    expect(correction).toContain("evidence about the collection");
    expect(correction).not.toContain("about the product");
  });

  it("names the collection when the storefront itself fails", () => {
    const correction = proposedCorrection(
      resultFrom(link({}), [
        ...collectionAnswers(500),
        ...collectionAnswers(500),
        ...collectionAnswers(500),
      ])
    );

    expect(correction).toContain("rather than the collection being absent");
    expect(correction).not.toContain("than the product");
  });

  it("still names the product when the entry is one", () => {
    // The whole point is that it says which, not that it stopped saying
    // "product" everywhere.
    const failing = resultFrom(entry(), [
      { kind: "answered", status: 503, finalUrl: entry().url },
      { kind: "answered", status: 503, finalUrl: entry().url },
      { kind: "answered", status: 503, finalUrl: entry().url },
    ]);

    expect(failing.detail).toContain("answer about the product");
    expect(proposedCorrection(failing)).toContain("evidence about the product");
  });

  it("counts each sink separately when it says the run is shippable", () => {
    const results = [
      resultFrom(entry(), [
        { kind: "answered", status: 200, finalUrl: entry().url },
      ]),
      resultFrom(link({}), [
        { kind: "answered", status: 200, finalUrl: link({}).url },
      ]),
    ];
    const verdict = shippability(results);

    expect(verdict.shippable).toBe(true);
    expect(verdict.message).toContain("1 product and 1 collection");
    expect(verdict.message).not.toContain("admits every product");
  });

  it("claims nothing about a sink that had no entries", () => {
    const products = shippability([
      resultFrom(entry(), [
        { kind: "answered", status: 200, finalUrl: entry().url },
      ]),
    ]);

    expect(products.message).toContain("1 product");
    expect(products.message).not.toContain("collection");
  });

  it("does not call a failed collection a product in the report", () => {
    const report = renderVerification([
      resultFrom(link({}), [
        { kind: "answered", status: 404, finalUrl: link({}).url },
      ]),
    ]);

    expect(report).toContain("failed (1)");
    expect(report).not.toContain("admits these products");
  });
});

describe("an empty Resolved Product Catalogue", () => {
  it("is refused before anything is requested", () => {
    expect(() => refuseEmptyCatalogue(0)).toThrow(CatalogueVerifyError);
    expect(() => refuseEmptyCatalogue(0)).toThrow(/empty/);
  });

  it("is refused whatever the Collection Links say", () => {
    // The failure this exists for: a header-only catalogue beside one valid
    // Collection Link. The combined result list is not empty, so
    // `shippability` passes it, and the command would exit zero shipping no
    // product Mappings at all.
    const links = [
      resultFrom(link({}), [
        { kind: "answered", status: 200, finalUrl: link({}).url },
      ]),
    ];

    expect(shippability(links).shippable).toBe(true);
    expect(() => refuseEmptyCatalogue(0)).toThrow(CatalogueVerifyError);
  });

  it("lets a catalogue with entries through, and an empty links file too", () => {
    // No discontinued equipment mapped yet is a legitimate state: no Mapping is
    // missing because of it, so it is not this guard's business.
    expect(() => refuseEmptyCatalogue(1)).not.toThrow();
    expect(() => refuseEmptyCatalogue(55)).not.toThrow();
  });
});

describe("what distinctUrls promises about the number it returns", () => {
  const library = readFileSync("scripts/lib/catalogue-verify.ts", "utf8");

  it("does not call a target count a request count", () => {
    // The docblock said this was "how many requests the pass actually made",
    // which holds only when every URL answers first time. `attemptsFor`
    // retries a URL up to `MAX_ATTEMPTS` on a 429 or a timeout, so a throttled
    // run covers the same targets with more requests — and the results this
    // counts cannot see the difference. A contract that overstates what a
    // number means is the same defect as a message that does.
    const docblock = library.slice(
      library.lastIndexOf(
        "/**",
        library.indexOf("export function distinctUrls")
      ),
      library.indexOf("export function distinctUrls")
    );

    expect(docblock).not.toContain("how many requests");
    expect(docblock).toContain("MAX_ATTEMPTS");
    expect(library).toContain("export const MAX_ATTEMPTS");
  });

  it("still counts one per URL and not one per result", () => {
    const shared = "https://www.cpap.com/collections/nasal-cpap-masks";

    expect(
      distinctUrls([
        result({ kind: "collection", url: shared, value: "Viva Nasal" }),
        result({ kind: "collection", url: shared, value: "Wisp Nasal" }),
        result(),
      ])
    ).toBe(2);
  });
});

describe("what scripts/README.md claims about the reachability pass", () => {
  // The prose used to say the pass "asks cpap.com whether each of the 137
  // URLs this pipeline ships serves a page", which stopped being true the
  // moment the pass started grouping Mappings that share a collection page:
  // 137 is the Mapping count and 65 is the request count. Counted from the
  // committed sinks rather than restated, so the next refresh that moves
  // either number fails here instead of leaving the document quietly wrong.
  const readme = readFileSync("scripts/README.md", "utf8");
  const products = readResolvedProducts(
    readFileSync("data/resolved-products.csv", "utf8")
  );
  const links = readCollectionLinks(
    readFileSync("data/collection-links.csv", "utf8")
  );
  const urls = new Set([...products, ...links].map((shipped) => shipped.url));

  it("counts the Mappings the pass files a result for", () => {
    expect(readme).toContain(`each of the ${products.length + links.length}`);
    expect(readme).toContain(`the ${products.length} from the catalogue`);
    expect(readme).toContain(`the\n${links.length} Collection Links alike`);
  });

  it("counts the request targets apart from the Mappings", () => {
    expect(readme).toContain(
      `${products.length + links.length} Mappings over ${urls.size} distinct URLs`
    );
    // Targets, not requests. A URL answering 429 is retried up to
    // `MAX_ATTEMPTS`, so 65 is a floor on the request count rather than the
    // count — the same overstatement the verdict line carried, in prose.
    expect(readme).toContain(`${urls.size} is the number of request _targets_`);
    expect(readme).not.toContain(`${urls.size}\nis the number of requests`);
    expect(readme).toContain("`MAX_ATTEMPTS`");
  });

  it("counts the collection pages the 82 links share", () => {
    const collectionUrls = new Set(links.map((shipped) => shipped.url));

    // Spelled as a word in the prose, so this is the one that has to be kept
    // in step by hand if it ever moves — which is why it is asserted at all.
    expect(collectionUrls.size).toBe(10);
    expect(readme).toContain("ten collection pages");
  });
});
