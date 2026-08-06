// The reachability half of verification. Shopify decides whether a product is
// eligible; this decides whether the page a Profile Link points at actually
// answers. Shopify cannot see storefront routing, redirects or a publishing gap,
// so `onlineStoreUrl` being present is not the same fact as the URL resolving —
// `AirCurve 11 ASV` is ACTIVE, in stock, and 404s.
//
// Everything here is pure. The command around it does the requests and the
// waiting; every judgement about what a status code means, how long to wait, when
// to stop asking, and whether the catalogue is shippable is made in this file, so
// there is nowhere in the transport for a decision to hide.
//
// Two things this deliberately does NOT do. It does not look at URL syntax —
// that is the schema gate's question, answered against Discourse's own validator
// in settings-schema.ts (ADR-0016), and a URL can be syntactically perfect and
// dead. And it never rewrites the catalogue: a correction is printed for a human
// to approve, because the fix for a dead product URL is upstream in the
// spreadsheet or in Shopify (ADR-0009), not a hand edit to a generated file.

import type { ResolvedProduct } from "./build-catalogue.ts";

export class CatalogueVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogueVerifyError";
  }
}

/**
 * Milliseconds to wait between two requests. cpap.com rate-limits hard — eight
 * concurrent requests produced 429 on sixty-eight of eighty-six URLs during
 * planning — so the pass is sequential and paced, and concurrency is not used to
 * go faster. Fifty-five URLs at this pace is under a minute, which is cheap
 * enough that there is nothing to gain by risking the throttle.
 */
export const PACE_MS = 750;

/**
 * How many times one URL is asked. The retries exist for the throttle, not for
 * the product: a 429 is not an answer about the URL, so giving up after one is
 * how a rate limit gets recorded as a broken page.
 */
export const MAX_ATTEMPTS = 4;

/**
 * The wait before the second, third and fourth attempt. Backing off further each
 * time is the point — a fixed retry interval against a rate limiter is the same
 * request pattern that earned the 429.
 */
export const BACKOFF_MS: readonly number[] = [2_000, 8_000, 30_000];

/**
 * The ceiling on a `Retry-After` the server asks for. Honouring an arbitrarily
 * large one would let a misconfigured header hang the pass; a request that has
 * not been answered inside this is reported as unresolved instead, which is a
 * result rather than a hang.
 */
export const MAX_RETRY_AFTER_MS = 120_000;

/** Per-request ceiling. A connection that never answers is a `no-answer`. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The statuses that mean "ask again" rather than "here is your answer". Both are
 * the server declining to answer about this URL at all: 429 is the rate limiter
 * and 503 is the same message from in front of it. A 500 or a 502 is deliberately
 * NOT here — that is a definite answer that something is wrong, and reporting it
 * as a failure with its status leaves the judgement with the human rather than
 * retrying past it.
 */
export const RETRYABLE_STATUSES: readonly number[] = [429, 503];

/** What one request came back with, or the reason it came back with nothing. */
export type Attempt =
  | {
      kind: "answered";
      status: number;
      /**
       * The URL the response actually came from. Redirects are followed, so this
       * differs from the requested URL when the storefront moved the product —
       * which is a proposed correction rather than a failure.
       */
      finalUrl: string;
      /** The `Retry-After` header verbatim, when there was one. */
      retryAfter?: string;
    }
  | { kind: "no-answer"; detail: string };

/**
 * What one catalogue entry came to. Four outcomes, kept distinct because they go
 * to four different people: a verified entry ships, an excluded one is a
 * catalogue defect, a failed one is a merchandising or spreadsheet job, and an
 * unresolved one is nobody's job yet because the question was never answered.
 */
export type VerifyOutcome = "verified" | "excluded" | "failed" | "unresolved";

export interface VerifyResult {
  userFieldName: string;
  value: string;
  url: string;
  outcome: VerifyOutcome;
  /** Why, in one line, for every outcome including `verified`. */
  detail: string;
  /** How many requests it took. Zero for an entry that was never requested. */
  attempts: number;
  /** The last status seen, or null when nothing answered. */
  status: number | null;
  /** Where the response came from, when that is not where the request went. */
  redirectedTo?: string;
}

/**
 * The command line, which is empty.
 *
 * This is in the lib rather than in the command because it is a decision, not
 * plumbing: every flag this pass could plausibly have — skip a field, accept an
 * unresolved entry, go faster, ignore a failure — is a way of declaring the
 * catalogue verified without having verified it. A refusal living in an untested
 * shell is one a mistake can quietly remove.
 */
export function refuseArguments(argv: readonly string[]): void {
  if (argv.length === 0) {
    return;
  }

  throw new CatalogueVerifyError(
    `pnpm verify:catalogue takes no arguments, and it was given ` +
      `${argv.map((arg) => JSON.stringify(arg)).join(" ")}. There is no flag ` +
      `that narrows the pass, accepts an unanswered URL, or makes it go faster.`
  );
}

/**
 * Whether a catalogue entry is eligible to be requested at all.
 *
 * Shopify's verdict travels in the catalogue's `status` column, so this needs no
 * network and no token — which is what lets the reachability pass run without
 * Shopify credentials. `buildCatalogue` cannot emit a non-`ACTIVE` entry, so one
 * appearing here means the catalogue is wrong rather than the product is: it is
 * reported as excluded, is never requested, and blocks shipping.
 */
export function isEligible(entry: ResolvedProduct): boolean {
  return entry.status === "ACTIVE";
}

/** What one attempt means: an answer, a "come back later", or a failure. */
export function classifyAttempt(attempt: Attempt): "pass" | "retry" | "failed" {
  if (attempt.kind === "no-answer") {
    return "retry";
  }

  if (attempt.status >= 200 && attempt.status <= 299) {
    return "pass";
  }

  return RETRYABLE_STATUSES.includes(attempt.status) ? "retry" : "failed";
}

/** Whether another request should be sent after this one. */
export function shouldRetry(attempt: Attempt, attemptsSoFar: number): boolean {
  return classifyAttempt(attempt) === "retry" && attemptsSoFar < MAX_ATTEMPTS;
}

/**
 * How long to wait for the given `Retry-After`, or null when there is nothing
 * usable in it. Both forms the header takes are read — a number of seconds and
 * an HTTP date — because a server that says how long to wait has said something
 * more useful than any backoff schedule can guess.
 *
 * `now` is a parameter rather than a call to the clock so that the date form can
 * be argued with a fixture.
 */
export function retryAfterMs(
  header: string | undefined,
  now: number
): number | null {
  if (header === undefined) {
    return null;
  }

  const trimmed = header.trim();

  if (trimmed === "") {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  }

  // An HTTP-date starts with a day name. The letter is checked before parsing
  // because `Date.parse` is willing to make sense of things that are not dates
  // at all — it reads "-5" as a year and answers 1901 — and a header nobody can
  // read should produce no opinion rather than a confident wait.
  if (!/^[A-Za-z]/.test(trimmed)) {
    return null;
  }

  const at = Date.parse(trimmed);

  if (Number.isNaN(at)) {
    return null;
  }

  // A date already past means "now", not a negative wait.
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

/**
 * How long to wait before the attempt numbered `attempt` (2 for the first
 * retry). The server's own `Retry-After` wins when it asks for longer than the
 * schedule; asking again sooner than it said to is how a rate limit gets
 * extended rather than waited out.
 */
export function delayBeforeAttempt(
  attempt: number,
  retryAfter: number | null
): number {
  const scheduled =
    BACKOFF_MS[attempt - 2] ?? BACKOFF_MS[BACKOFF_MS.length - 1];

  return Math.max(scheduled, retryAfter ?? 0);
}

/**
 * Why the pass is pausing, said out loud while it happens. A command that goes
 * quiet for thirty seconds looks hung, and the difference between "cpap.com is
 * throttling us" and "this product page is gone" is the distinction the whole
 * unresolved outcome exists to preserve — so it is worth printing at the moment
 * it is decided rather than only in the summary.
 */
export function pauseReason(attempt: Attempt): string {
  if (attempt.kind === "no-answer") {
    return `no answer (${attempt.detail})`;
  }

  return attempt.retryAfter === undefined
    ? `HTTP ${attempt.status}`
    : `HTTP ${attempt.status}, Retry-After: ${attempt.retryAfter}`;
}

/**
 * The product handle a URL names, or null when it names no product.
 *
 * This exists because of a storefront behaviour that makes a status code an
 * incomplete answer. cpap.com serves a dead product handle as a **200**: it
 * redirects to the homepage rather than returning 404, so
 * `/products/airsense-11-autoset` — a real handle until Shopify renamed it —
 * comes back 200 from `https://www.cpap.com/#erid51316016`. A pass that took 2XX
 * as verification would report that URL as a working Profile Link, and a member
 * clicking it would land on the front page with no idea why.
 *
 * So the landing URL has to be looked at, not only the status. A redirect from one
 * product handle to another product handle is a moved product and the link works;
 * a redirect off `/products/` altogether is that soft 404.
 */
export function productHandleOf(url: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const match = /^\/products\/([^/]+)\/?$/.exec(parsed.pathname);

  return match ? match[1] : null;
}

function statusPhrase(status: number): string {
  return RETRYABLE_STATUSES.includes(status)
    ? `HTTP ${status}, which is the server declining to answer rather than an ` +
        `answer about the product`
    : `HTTP ${status}`;
}

/**
 * The outcome of one entry, from the attempts made for it.
 *
 * An empty attempt list is an entry that was never requested, which only happens
 * when it was excluded — so this refuses one for an eligible entry rather than
 * inventing a verdict for a request nobody made.
 */
export function resultFrom(
  entry: ResolvedProduct,
  attempts: readonly Attempt[]
): VerifyResult {
  const base = {
    userFieldName: entry.userFieldName,
    value: entry.value,
    url: entry.url,
    attempts: attempts.length,
  };

  if (!isEligible(entry)) {
    return {
      ...base,
      attempts: 0,
      outcome: "excluded",
      status: null,
      detail:
        `Shopify reports this product as ${entry.status}, so it was never ` +
        `requested. A catalogue cannot contain a product Shopify refused — ` +
        `regenerate it with pnpm refresh:catalogue.`,
    };
  }

  if (attempts.length === 0) {
    throw new CatalogueVerifyError(
      `${entry.userFieldName} / ${entry.value} is eligible and no request was ` +
        `made for it. An entry with no attempts has no outcome, and guessing ` +
        `one would report an unchecked URL as checked.`
    );
  }

  const last = attempts[attempts.length - 1];
  const verdict = classifyAttempt(last);

  if (verdict === "pass" && last.kind === "answered") {
    if (last.finalUrl === entry.url) {
      return {
        ...base,
        outcome: "verified",
        status: last.status,
        detail: `HTTP ${last.status}`,
      };
    }

    // A 2XX from somewhere else is only a pass if somewhere else is still a
    // product. cpap.com answers a dead handle by redirecting to the homepage,
    // so this branch is the difference between a moved product and a Profile
    // Link that quietly goes to the front page.
    if (productHandleOf(last.finalUrl) === null) {
      return {
        ...base,
        outcome: "failed",
        status: last.status,
        detail:
          `HTTP ${last.status}, but from ${last.finalUrl} — the storefront ` +
          `redirected off /products/, which is how cpap.com serves a handle it ` +
          `no longer has. The status code says the request succeeded; the ` +
          `landing page is not this product.`,
      };
    }

    return {
      ...base,
      outcome: "verified",
      status: last.status,
      detail: `HTTP ${last.status}, after a redirect to ${last.finalUrl}`,
      redirectedTo: last.finalUrl,
    };
  }

  if (verdict === "failed" && last.kind === "answered") {
    return {
      ...base,
      outcome: "failed",
      status: last.status,
      detail: statusPhrase(last.status),
    };
  }

  // Retryable, and the attempts ran out. Not a pass and not a failure: the
  // question was never answered.
  return {
    ...base,
    outcome: "unresolved",
    status: last.kind === "answered" ? last.status : null,
    detail:
      last.kind === "answered"
        ? `${statusPhrase(last.status)}, on all ${attempts.length} attempts`
        : `no answer on any of ${attempts.length} attempts: ${last.detail}`,
  };
}

/**
 * What a human might do about one result, or null when there is nothing to
 * propose. Never applied — every one of these is a change to the spreadsheet, to
 * Shopify, or to nothing at all, and a pass that edited the catalogue to make
 * itself green would be reporting on its own repairs (ADR-0009).
 */
export function proposedCorrection(result: VerifyResult): string | null {
  if (result.outcome === "verified") {
    return result.redirectedTo === undefined
      ? null
      : `The storefront redirects this to ${result.redirectedTo}. The link ` +
          `works, so this is not a failure, but the catalogue is carrying a ` +
          `handle Shopify has moved on from. Re-run pnpm refresh:catalogue and ` +
          `see whether onlineStoreUrl has caught up.`;
  }

  if (result.outcome === "excluded") {
    return (
      `Re-run pnpm refresh:catalogue. This entry should not have been written ` +
      `— the transform excludes anything Shopify does not report as ACTIVE.`
    );
  }

  if (result.outcome === "unresolved") {
    return (
      `Run pnpm verify:catalogue again when the site is quieter. This is a ` +
      `rate limit or an outage, not evidence about the product, and the ` +
      `catalogue is not shippable while it is unanswered either way.`
    );
  }

  // A failed entry carrying a 2XX is the soft 404: the request succeeded and
  // landed somewhere that is not the product. The fix is the same as for a hard
  // 404, but the diagnosis is not, and someone reading "HTTP 200" next to
  // "failed" deserves to be told why rather than left to assume a bug here.
  if (result.status !== null && result.status >= 200 && result.status <= 299) {
    return (
      `The handle in the catalogue no longer exists at cpap.com, which the ` +
      `storefront reports by redirecting to the homepage with a 200 rather ` +
      `than by returning 404. Re-run pnpm refresh:catalogue: Shopify's ` +
      `onlineStoreUrl is the authority for this URL (ADR-0009), and if it ` +
      `still hands back this handle then Shopify and the storefront disagree ` +
      `and the product needs looking at directly.`
    );
  }

  if (result.status === 404 || result.status === 410) {
    return (
      `Shopify says this product is ACTIVE and published, and cpap.com does ` +
      `not serve it. Two things look identical from here: a handle that has ` +
      `changed, which pnpm refresh:catalogue would pick up, and a product ` +
      `that is live but not published to the Online Store, which is a ` +
      `merchandising fix at cpap.com rather than anything this repository can ` +
      `do. Check the product in Shopify before changing the spreadsheet.`
    );
  }

  if (result.status !== null && result.status >= 500) {
    return (
      `A ${result.status} is the storefront failing rather than the product ` +
      `being absent. Re-run before treating it as a catalogue problem; if it ` +
      `persists, it is a cpap.com incident.`
    );
  }

  return (
    `Open the URL. A ${result.status ?? "non-2XX"} that is neither missing nor ` +
    `a server error usually means the request was refused rather than the ` +
    `page absent — a bot filter answers 403 to a script and 200 to a browser.`
  );
}

export interface VerifySummary {
  verified: number;
  excluded: number;
  failed: number;
  unresolved: number;
  total: number;
}

export function summarize(results: readonly VerifyResult[]): VerifySummary {
  const summary: VerifySummary = {
    verified: 0,
    excluded: 0,
    failed: 0,
    unresolved: 0,
    total: results.length,
  };

  for (const result of results) {
    summary[result.outcome] += 1;
  }

  return summary;
}

export interface Shippability {
  shippable: boolean;
  message: string;
}

/**
 * Whether this catalogue may be applied to an instance.
 *
 * Unresolved is not a pass. A 429 leaves a URL unchecked, and an unchecked URL
 * shipped as a Mapping is a Profile Link that may be pointing at nothing — so a
 * catalogue still holding one is not shippable and the pass is run again. That is
 * the whole reason unresolved is a third outcome rather than being folded into
 * either of the other two.
 */
export function shippability(results: readonly VerifyResult[]): Shippability {
  const summary = summarize(results);
  const blocking: string[] = [];

  if (summary.failed > 0) {
    blocking.push(`${summary.failed} failed`);
  }

  if (summary.unresolved > 0) {
    blocking.push(`${summary.unresolved} unresolved`);
  }

  if (summary.excluded > 0) {
    blocking.push(`${summary.excluded} excluded`);
  }

  if (results.length === 0) {
    return {
      shippable: false,
      message:
        `The catalogue is empty, so nothing was checked. That is not a pass: ` +
        `an empty catalogue ships no Mappings at all.`,
    };
  }

  if (blocking.length === 0) {
    return {
      shippable: true,
      message:
        `Shippable: all ${summary.verified} URLs answered 2XX and Shopify ` +
        `admits every product.`,
    };
  }

  return {
    shippable: false,
    message:
      `NOT shippable: ${blocking.join(", ")} of ${summary.total}.` +
      // Only said when there is one to say it about. A caveat printed next to
      // "0 unresolved" reads as boilerplate, and this one is load-bearing.
      (summary.unresolved > 0
        ? ` An unresolved entry is not a failure — it is a URL nobody has an ` +
          `answer for, and it blocks in exactly the same way.`
        : ""),
  };
}

function section(
  title: string,
  results: readonly VerifyResult[],
  note: string
): string {
  if (results.length === 0) {
    return "";
  }

  const entries = results.map((result) => {
    const correction = proposedCorrection(result);

    return (
      `  ${result.userFieldName} / ${result.value}\n` +
      `    ${result.url}\n` +
      `    ${result.detail}\n` +
      (correction === null ? "" : `    proposed: ${correction}\n`)
    );
  });

  return `\n${title} (${results.length})\n${note}\n${entries.join("")}`;
}

const CORRECTION_NOTE =
  "  Proposed corrections are printed for approval and never applied. Nothing\n" +
  "  below changed any file.";

/**
 * The report. Every outcome that is not `verified` is listed in full with its
 * reason — a count on its own tells nobody which product to go and look at.
 */
export function renderVerification(results: readonly VerifyResult[]): string {
  const summary = summarize(results);
  const verdict = shippability(results);
  const of = (outcome: VerifyOutcome) =>
    results.filter((result) => result.outcome === outcome);

  const redirected = of("verified").filter(
    (result) => result.redirectedTo !== undefined
  );

  return (
    `\nverified   ${summary.verified}\n` +
    `excluded   ${summary.excluded}\n` +
    `failed     ${summary.failed}\n` +
    `unresolved ${summary.unresolved}\n` +
    `           ${summary.total} entries\n` +
    section(
      "failed",
      of("failed"),
      `${CORRECTION_NOTE}\n  Shopify admits these products and cpap.com did not serve them.`
    ) +
    section(
      "unresolved",
      of("unresolved"),
      `${CORRECTION_NOTE}\n  Never answered. Not a pass and not a failure — run the pass again.`
    ) +
    section(
      "excluded",
      of("excluded"),
      `${CORRECTION_NOTE}\n  Shopify refuses these, so they were never requested.`
    ) +
    section(
      "verified, with a proposed correction",
      redirected,
      `${CORRECTION_NOTE}\n  These resolve. The URL the catalogue carries is not the one that served them.`
    ) +
    `\n${verdict.message}\n`
  );
}
