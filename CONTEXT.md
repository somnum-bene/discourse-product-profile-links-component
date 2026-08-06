# Profile Links

A Discourse theme component that turns a User's Custom User Field values into labelled hyperlinks, shown wherever that User appears.

## Language

**Profile Link**:
A labelled hyperlink shown for a User, derived from one of their Custom User Field values.
_Avoid_: link, custom link, product link

**User**:
A person with a Discourse account, whose Custom User Field values produce Profile Links.
_Avoid_: member, customer, profile owner

**Administrator**:
The person who configures Field Mappings on the theme component and Custom User Fields on the site.
_Avoid_: admin user, site owner, operator

**Custom User Field**:
A field defined at `/admin/config/user_fields` that Users fill in on their profile. Identified by name in configuration, but keyed by integer ID in a User's stored values.
_Avoid_: user field, profile field, custom field

**Dropdown Option**:
One of the predefined values a Custom User Field offers. A Mapping's value must equal one exactly, or it resolves no Profile Link.
_Avoid_: choice, option value, field option

**Field Mapping**:
The configured association between one Custom User Field and the set of Mappings that turn its values into URLs.
_Avoid_: CSV, lookup table, mapping table

**Mapping**:
A single value-to-URL pair inside a Field Mapping. A User whose field value equals the value gets a Profile Link to the URL.
_Avoid_: row, entry, CSV row

**Link Surface**:
One of the three places a Profile Link renders — the user card, the user profile, or a post.
_Avoid_: outlet, connector, component, view

**User Field Source**:
How a Link Surface obtains a User's Custom User Field values. The card and profile surfaces receive them in outlet args; the post surface fetches them.
_Avoid_: data source, provider, fetcher

**Config Problem**:
A fault in the configuration itself, reported to the console rather than thrown — a Field Mapping naming a Custom User Field that does not exist, one with no Mappings, an incomplete Mapping, or a value mapped twice.
_Avoid_: error, warning, validation failure

**Unmatched Value**:
A Custom User Field value a User holds that no Mapping covers. Expected, and deliberately not a Config Problem — only logged when Debug Mode is on.
_Avoid_: missing mapping, unmapped value, orphan value

**Debug Mode**:
The setting that logs Unmatched Values to the console. Config Problems are reported whether or not it is on.
_Avoid_: verbose mode, logging, dev mode

**Sheet Export**:
A verbatim export of one tab of the migration spreadsheet, committed for provenance. Its `Suggested Title` and `Suggested URL` columns are the only ones that matter; the rest describe the legacy bulletin board it was written for. Never read by the component.
_Avoid_: the sheet, product CSV, source CSV

**Suggested Title**:
The curated display name for a product, taken from a Sheet Export. Becomes both a Mapping's value and a Dropdown Option, so the two cannot disagree.
_Avoid_: product name, label, title

**Resolved Product**:
A Suggested Title joined to a live product in the cpap.com Shopify catalogue, carrying its handle, its status, and its canonical URL.
_Avoid_: product, matched product, SKU

**Resolved Product Catalogue**:
The committed file of Resolved Products. The single input to both sinks — the Mappings shipped in `settings.yml` and the Dropdown Options pushed to a site.
_Avoid_: product CSV, catalogue file, product list

**Excluded Product**:
A Suggested Title left out of the Resolved Product Catalogue because Shopify reports its product archived, unpublished, or tagged `Discontinued`. Reported with its reason, never dropped silently.
_Avoid_: missing product, failed product, dead link

**Catalogue Refresh**:
Rebuilding the Resolved Product Catalogue from the Sheet Exports and Shopify. Deliberate, reviewed as a diff, and the only step that needs Shopify credentials.
_Avoid_: sync, update, regenerate

**Catalogue Verify**:
Asking cpap.com whether every URL in the Resolved Product Catalogue serves a page. Sequential and paced because the storefront rate-limits, and a deliberate command rather than a gate — it is absent from every build script and pre-commit hook on purpose (ADR-0018). Needs no credentials.
_Avoid_: link check, smoke test, health check

**Verified**:
Said of one catalogue entry, and it means two things at once: Shopify admits the product, **and** a request to its URL returns 2XX from a page that is still that product. Nothing is verified by half of that (ADR-0017).
_Avoid_: valid, working, live

**Unresolved URL**:
A URL the Catalogue Verify never got an answer about — the storefront answered 429 or 503 on every attempt, or nothing answered at all. Not a pass and not a failure: there is no evidence either way, so it blocks shipping and the pass is run again.
_Avoid_: flaky, timeout, error

**Soft 404**:
A URL that answers 2XX from somewhere that is not the product — cpap.com serves a handle it no longer has by redirecting to its homepage. Reported as failed despite its success status, because the Profile Link would open the front page (ADR-0017).
_Avoid_: redirect, bad link, 404

**Catalogue Apply**:
Pushing Dropdown Options from the Resolved Product Catalogue to one Discourse instance. Runs once per instance; the base URL is the only difference between test and production.
_Avoid_: deploy, push, migration

**Apply Plan**:
What a Catalogue Apply would do to one instance, decided as data before any request exists — the writes, the refusals that stop all of them, the warnings that do not, and the fields already correct. Produced by one pure function so the destructive decisions are argued with a fixture rather than a live site.
_Avoid_: diff, changeset, dry run

**Managed Field**:
One of the three Custom User Fields this pipeline is responsible for, as named by the Sheet Export allowlist. A Managed Field with no Mappings behind it is still in scope — that is how `Humidifier` gets reported rather than forgotten — while a field outside the list is never mentioned at all. `Humidifier` is permanently in that state: product decided against a humidifier list, and the field was changed to a text one so a member's legacy entry can be shown as they wrote it (ADR-0012).
_Avoid_: known field, our field, target field

**Refused URL**:
A Mapping URL Discourse's schema will not accept, judged by the `validations: url: true` it declares. Not a Config Problem and not a broken link: it is a syntax verdict, it invalidates the whole `profile_link_fields` value rather than the one Mapping, and a URL that works in a browser can still be one (ADR-0016).
_Avoid_: invalid URL, bad link, validation error

**Setting Override**:
A setting value stored against one site because an Administrator edited it there — including saving the editor unchanged. Discourse then stops delivering that setting's shipped default to that site — silently, permanently, and invisibly from the outside, since the site keeps working. An override on `profile_link_fields` freezes that site's Field Mappings at the moment of the edit (ADR-0008), which is why the ownership warning is in the setting's own `description`. Discourse offers no route that removes one; only a Settings Migration or reinstalling the component reaches it (ADR-0019). A Catalogue Apply detects one by comparing the live value against the default, which cannot see an override that agrees with the default.
_Avoid_: local change, customisation, site setting

**Empty Override**:
A Setting Override on `profile_link_fields` holding no Field Mappings. Renders nothing on every Link Surface and reports no Config Problem, because linking nothing is a legitimate configuration — so it is indistinguishable from a working site until someone asks why there are no Profile Links. Treated as an accident rather than a preference and removed by `migrations/settings/0002`, on the grounds that the shipped default was itself empty until the catalogue landed, so setting it deliberately was a no-op nobody had reason to perform (ADR-0019).
_Avoid_: blank setting, empty config, unset

**Readback**:
Rereading a Discourse instance's Dropdown Options after a Catalogue Apply has written them, and comparing them against the checked-out catalogue. Not a precaution: the update route answers `200 OK` to a write it discards, so the Readback is the only thing that reports whether an apply happened (ADR-0014).
_Avoid_: verification, confirmation, sanity check

**Flat Settings**:
The eleven pre-refactor settings — a pipe-delimited field-name list plus ten positional CSV textareas — that the structured `profile_link_fields` setting replaced. A Settings Migration converts them on update.
_Avoid_: old settings, CSV settings, legacy config

## Ambiguities to watch

**"CSV" means the Flat Settings format, and nothing else.**
A Field Mapping is not a CSV, and a Mapping is not a CSV row — that is what the _Avoid_ lines above are about.

**"Product CSV" is retired.**
It was reserved for "a genuine CSV file as a source of Mapping data" before there were two of them at different stages. Say **Sheet Export** for the raw spreadsheet tab and **Resolved Product Catalogue** for the file both sinks are generated from; the distinction between them is the whole point of the pipeline, and one name for both erases it.

**Two things are called "discontinued", and only one is authoritative.**
Shopify's `Discontinued` tag is a live fact about a product. The ` (Discontinued)` suffix on some Suggested Titles is legacy spreadsheet bookkeeping marking a catch-all category link. Both are excluded, for different reasons — see ADR-0012 — but do not treat the suffix as evidence about the catalogue.

**"mapping" unqualified is ambiguous.**
It spans **Field Mapping** and **Mapping**, which are different things at different levels. Always qualify which one you mean.

**A regenerated `UBIQUITOUS_LANGUAGE.md` is not this file.**
The `/ubiquitous-language` skill writes a glossary to the repo root. Treat its output as a proposal against this file — fold anything worth keeping in here, then delete it. This is the only glossary. See `docs/agents/domain.md`.
