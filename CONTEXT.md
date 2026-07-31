# Profile Links

A Discourse theme component that turns a user's custom user field values into labelled hyperlinks, shown wherever that user appears.

## Language

**Profile Link**:
A labelled hyperlink shown for a user, derived from one of their Custom User Field values.
_Avoid_: link, custom link, product link

**Custom User Field**:
A field defined at `/admin/customize/user_fields` that users fill in on their profile. Identified by name in configuration, but keyed by integer ID in a user's stored values.
_Avoid_: user field, profile field, custom field

**Field Mapping**:
The configured association between one Custom User Field and the set of Mappings that turn its values into URLs.
_Avoid_: CSV, lookup table, mapping table

**Mapping**:
A single value-to-URL pair inside a Field Mapping. A user whose field value equals the value gets a Profile Link to the URL.
_Avoid_: row, entry, CSV row

**Link Surface**:
One of the three places a Profile Link renders — the user card, the user profile, or a post.
_Avoid_: outlet, connector, component, view

**User Field Source**:
How a Link Surface obtains a user's Custom User Field values. The card and profile surfaces receive them in outlet args; the post surface fetches them.
_Avoid_: data source, provider, fetcher
