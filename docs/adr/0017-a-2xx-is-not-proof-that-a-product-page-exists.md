# A 2XX is not proof that a product page exists

The reachability check was specified as "a request to the URL returns 2XX", and on cpap.com that is not the same fact as the product page existing. The storefront serves a handle it no longer has by **redirecting to the homepage**, and the response that comes back is a 200:

```
GET https://www.cpap.com/products/airsense-11-autoset
→ 200, from https://www.cpap.com/#erid51316016
```

That handle was real until Shopify renamed the product. A member with `AirSense 11 AutoSet` selected would click their Profile Link and land on the cpap.com front page with nothing explaining why. A pass that read the status code alone would have called that URL verified, and it is exactly the class of thing Shopify cannot tell us about: `onlineStoreUrl` was populated, the product was `ACTIVE`, and the storefront still had no page for it.

So the landing URL is part of the verdict. A 2XX from the URL that was requested is verified. A 2XX from a different URL is only verified if the different URL is **still a product page** — a renamed handle that resolves to another `/products/<handle>` is a moved product, the link works, and the catalogue is carrying a stale handle that a Catalogue Refresh will correct. A 2XX from anywhere else is a **Soft 404**: the request succeeded and the page is not this product, so it is reported as failed with its 200 intact and the reason spelled out, because "failed — HTTP 200" is otherwise the most confusing line a report can contain.

This is the same shape of problem as ADR-0016 and the opposite failure direction. There, a generated value had to be checked against a rule only Discourse enforces, and the mirror was allowed to be pessimistic. Here the authority answers directly and the risk is that its answer means less than it appears to: a status code is a fact about a request, and what was wanted was a fact about a page.

## Consequences

Verification asks two questions of one response, so the pass cannot use `HEAD` and cannot discard the final URL. `fetch` follows redirects and reports where it ended up; a client configured with `redirect: "manual"` would return the 301 itself and the pass would have to chase it, reimplementing what the platform already does correctly.

A Soft 404 is a failure whose status is a success, and its proposed correction has to say so. The fix is the same as for a hard 404 — re-run `pnpm refresh:catalogue`, because Shopify's `onlineStoreUrl` is the authority for the URL (ADR-0009) — but the diagnosis is not, and someone reading the report should not have to work out whether the tool is broken.

`/products/<handle>` is now load-bearing structure rather than an incidental URL shape. It is asserted in three places for three reasons: the shipped `settings.yml` is checked for it, the transform reads a handle out of a Suggested URL with it, and the verify pass decides whether a redirect landed somewhere acceptable with it. If cpap.com ever moves products off that path, all three have to change together.

Nothing here is a judgement about *which* product page a redirect landed on. A handle that redirects to a different, unrelated product would be reported as verified with a proposed correction, and a human reading the correction is the check. Comparing the landing handle against the catalogue's would sound stricter and would fail every legitimately renamed product, which is the majority case.
