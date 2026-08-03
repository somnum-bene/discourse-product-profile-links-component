# Discourse Profile Links

Turns a user's Custom User Field values into labelled hyperlinks — Profile Links — shown on their user card, their user profile, and their posts. Based on [this tutorial](https://meta.discourse.org/t/link-custom-user-field-to-external-website/41218).

Rather than defining a label and URL prefix per field, this component maps each field value to its own URL. It is designed for dropdown-type Custom User Fields, where the set of options is predefined.

## Settings

**`profile_link_fields`**
The Field Mappings, edited in Discourse's structured settings editor. Each Field Mapping names one Custom User Field and nests the Mappings that turn its values into Profile Links:

- **`user_field_name`** — the Custom User Field's name, exactly as it appears in `/admin/customize/user_fields`. Matching is case-sensitive.
- **`mappings`** — one or more value/URL pairs.
  - **`value`** — must exactly match the user's field value.
  - **`url`** — where the Profile Link points. Discourse validates this is a URL as you type.

A user whose field value matches a Mapping gets a Profile Link to that URL. A value matching no Mapping renders nothing. There is no limit on the number of Field Mappings, and an empty configuration is valid — it simply renders nothing.

Where a Profile Link replaces a value, Discourse's own plain-text row for that Custom User Field is hidden on the user card and the user profile, so the value is shown once rather than twice. Only rows that a Profile Link actually replaces are hidden: a field with no Field Mapping, and a value matching no Mapping, keep rendering exactly as Discourse renders them. See `docs/adr/0005-core-duplicate-rows-are-hidden-by-a-modifier-not-static-css.md`.

Configuration problems — a Field Mapping naming a Custom User Field that does not exist, one with no Mappings, or a value mapped twice — are reported once to the browser console on page load, whether or not debug mode is on.

**`profile_link_debug_mode`**
Logs field values that matched no Mapping to the browser console. Useful when a Profile Link you expect is not appearing.

## Upgrading from the CSV version

Nothing to do. The previous version configured Field Mappings through a pipe-separated field list and ten positional CSV textareas; those eleven settings have been replaced by `profile_link_fields`, and a settings migration converts an existing configuration to the new shape when the component updates. `custom_profile_link_debug_mode` is carried over to `profile_link_debug_mode` at the same time.

A Mapping whose URL Discourse's own validator refuses is dropped — the flat settings validated nothing, so they could hold one, and carrying it over would invalidate the whole setting rather than just that Mapping.

Check the console for Config Problems after the update. A Custom User Field name that was configured but never had any CSV mappings — including one past the tenth slot, which had nowhere to put them — is carried over as a Field Mapping with no Mappings, and reported. It resolved no Profile Links before the update either; it is preserved rather than dropped so the configuration is not silently thinned out.

See `docs/adr/0006-a-settings-migration-replaces-uninstall-and-re-add.md`.

## Development

Requires Node 22 or later and pnpm 10. The `engines` block rejects npm and yarn.

```
pnpm install
pnpm lint        # stylelint, eslint, prettier and type-checking
pnpm lint:fix    # auto-fix what can be auto-fixed
pnpm lint:types  # Glint type-checking on its own
pnpm test        # standalone unit tests
```

Unit tests live in `spec/unit/` and run under Node with vitest — they never touch a Discourse instance. The top-level `test/` directory is reserved for theme QUnit tests served at `/theme-qunit`, which need a running Discourse; Discourse ingests anything placed there, so unit tests must not go in it. See `docs/adr/0003-unit-tests-live-in-spec-not-test.md`.

## Credits

Based on [discourse-custom-profile-link](https://github.com/Firepup6500/discourse-custom-profile-link) by Firepup6500.
