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
A field defined at `/admin/customize/user_fields` that Users fill in on their profile. Identified by name in configuration, but keyed by integer ID in a User's stored values.
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

**Flat Settings**:
The eleven pre-refactor settings — a pipe-delimited field-name list plus ten positional CSV textareas — that the structured `profile_link_fields` setting replaced. A Settings Migration converts them on update.
_Avoid_: old settings, CSV settings, legacy config

## Ambiguities to watch

**"CSV" means the Flat Settings format, and nothing else.**
A Field Mapping is not a CSV, and a Mapping is not a CSV row — that is what the _Avoid_ lines above are about. When a genuine CSV **file** enters the picture as a source of Mapping data, call it the **Product CSV**; never bare "CSV", which now has two possible readings.

**"mapping" unqualified is ambiguous.**
It spans **Field Mapping** and **Mapping**, which are different things at different levels. Always qualify which one you mean.

**A regenerated `UBIQUITOUS_LANGUAGE.md` is not this file.**
The `/ubiquitous-language` skill writes a glossary to the repo root. Treat its output as a proposal against this file — fold anything worth keeping in here, then delete it. This is the only glossary. See `docs/agents/domain.md`.
