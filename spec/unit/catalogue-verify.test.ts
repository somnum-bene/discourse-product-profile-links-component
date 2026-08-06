import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  ProductStatus,
  ResolvedProduct,
} from "../../scripts/lib/build-catalogue";
import {
  type Attempt,
  BACKOFF_MS,
  CatalogueVerifyError,
  classifyAttempt,
  delayBeforeAttempt,
  isEligible,
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  PACE_MS,
  pauseReason,
  productHandleOf,
  proposedCorrection,
  refuseArguments,
  renderVerification,
  resultFrom,
  retryAfterMs,
  shippability,
  shouldRetry,
  summarize,
  type VerifyResult,
} from "../../scripts/lib/catalogue-verify";

function entry(overrides: Partial<ResolvedProduct> = {}): ResolvedProduct {
  return {
    userFieldName: "Machine",
    value: "AirSense 11 AutoSet",
    handle: "airsense-11-autoset",
    status: "ACTIVE",
    url: "https://www.cpap.com/products/airsense-11-autoset",
    ...overrides,
  };
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
    expect(verdict.message).toContain("all 2 URLs");
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
});
