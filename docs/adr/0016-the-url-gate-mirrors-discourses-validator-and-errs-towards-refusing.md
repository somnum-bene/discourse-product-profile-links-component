# The URL gate mirrors Discourse's validator, and errs only towards refusing

The Mappings ship as a generated `default:` (ADR-0008), and a default is the one form of setting value Discourse's schema validation never sees during development. `validations: url: true` runs server-side, in Ruby, on an administrator's input. Nothing in `pnpm lint`, `pnpm test` or the drift gate had any opinion about whether the fifty-five generated URLs were URLs at all — and one refused URL invalidates the entire `profile_link_fields` value rather than the single offending Mapping (ADR-0006), so the failure mode is every Profile Link on the site, not one.

`readLinkConfig` does not close that gap and should not be asked to. It reports Config Problems — a Field Mapping naming a Custom User Field that does not exist, one with no Mappings, an incomplete Mapping, a value mapped twice — and it deliberately treats a URL as a string that is either present or absent. Teaching the component's runtime resolver to parse URLs would put a build-time concern in the code path that runs on every page load.

So the gate mirrors `UrlHelper.is_valid_url?`, which is the method `SchemaSettingsObjectValidator` reaches for, in `scripts/lib/settings-schema.ts`. Three things make that defensible rather than a guess:

**The Ruby is quoted in the module.** Anyone comparing the two is comparing them side by side rather than reconstructing the original from behaviour. Two of its details are counter-intuitive enough that a mirror written from a description would get them wrong: `uri.scheme` is downcased before being interpolated into a match against the raw string, so an uppercase scheme is refused; and a URL Ruby's parser rejects outright never reaches the scheme branches at all, because the raise is rescued into `false`.

**The expectations came from running it, not reading it.** `is_valid_url?` was executed over a corpus of a hundred and thirty-three strings — Discourse's own `url_helper_spec.rb` cases, the fifty-five shipped URLs, and the malformations this pipeline could plausibly produce — under both of Ruby's URI parsers. The corpus and its verdicts are the test table. They cannot be re-derived from the TypeScript, which is why they are written down as data rather than as reasoning.

**It errs in one direction only.** The mirror refuses an IP-literal host, an IPvFuture host and a `mailto:` address it does not recognise, all of which Discourse accepts. The RFC 3986 productions behind the first two are recursive and are not transcribed. That asymmetry is the point: refusing something Discourse would accept raises a false alarm about a URL shape this pipeline cannot generate, and the alarm is loud and local. Accepting something Discourse refuses is the failure the gate exists to prevent, and it would surface as a live site whose every Profile Link had stopped resolving. A gate is allowed to be pessimistic; it is not allowed to be optimistic.

The two Ruby parsers disagree on exactly one thing the corpus could not settle either way — an underscore in the host, which RFC3986 accepts and RFC2396 refuses — and the mirror decides nothing about it, because a separate assertion pins the shipped host to `www.cpap.com`, where an underscore cannot occur.

## Consequences

`settings-schema.ts` may be narrowed and may not be widened. Anything that makes it accept more is a change to the one property that makes it worth having, and there is no test that can catch that on its own: widening it towards Discourse's real behaviour and widening it past Discourse's real behaviour look identical from inside this repository. Re-run the Ruby against a fresh corpus instead.

A URL this gate refuses is not necessarily a broken URL. `HTTPS://www.cpap.com/products/x` resolves perfectly well in a browser and is still refused by Discourse, so a Suggested URL arriving in that form is a catalogue problem to fix upstream rather than a gate to relax. Whether the page behind a URL exists is a different question again, asked by the link check rather than here — the schema never asks it.

The gate is also the first thing in this repository that had to be verified against Discourse's own source rather than against its documentation or its behaviour through the API. The pattern generalises: where a server-side rule decides whether a generated artifact is acceptable, the artifact gets checked against a mirror of that rule, and the mirror gets checked against the rule.
