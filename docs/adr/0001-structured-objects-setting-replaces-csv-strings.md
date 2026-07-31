# Structured `objects` setting replaces per-field CSV strings

Field Mappings were configured through eleven flat settings: a pipe-separated list of Custom User Field names, positionally paired with ten CSV textareas (`custom_profile_link_csv_1` through `_10`). We replaced them with a single `type: objects` setting whose schema nests Mappings under each field name, because Discourse validates the structure and the URLs in the admin UI and exposes the value to JavaScript as plain objects — removing the string parser, the invisible positional pairing, and the ten-field ceiling outright.

## Considered Options

- **Keep the schema, validate the pairing in code.** Rejected: it hardens an accidental contract instead of deleting it, and the ten-field ceiling survives.
- **Replace the schema and ship a theme migration.** The migration turned out to be unnecessary — see Consequences.

## Consequences

At the time of this change the component was installed on a test site only, so no migration was written; the install is removed and re-added instead. Any *later* change to the setting schema will need a real migration under `migrations/`, because that assumption expires the moment this ships anywhere real.
