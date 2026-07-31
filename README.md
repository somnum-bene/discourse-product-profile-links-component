# Discourse Custom Profile Link (CSV Lookup)

Displays custom "user fields" as links on a user's profile and user card, as directed by [this tutorial](https://meta.discourse.org/t/link-custom-user-field-to-external-website/41218).

Instead of defining a label and URL prefix per field, this component uses a CSV lookup table per field: the user's field value is matched against the `value` column, and the corresponding URL is used as the link. This is designed for dropdown-type user fields where the set of options is predefined.

## Settings

**`custom_profile_link_user_field_ids`**
A pipe-separated list of custom user field **names**, exactly as they appear in `/admin/customize/user_fields`. Supports up to 10 fields.

**`custom_profile_link_csv_1` through `custom_profile_link_csv_10`**
One CSV textarea per field slot, in the same order as `custom_profile_link_user_field_ids`. Each textarea accepts one entry per line in `value,https://url` format:

```
Option A,https://example.com/a
Option B,https://example.com/b
Option C,https://example.com/c
```

The `value` must exactly match the user's field value. If no match is found, the field is silently hidden. Leave unused CSV slots blank.

**`custom_profile_link_debug_mode`**
Enables debug logging in the browser console. Useful for troubleshooting field IDs and CSV matches.

## Notes

- Field names must match exactly (case-sensitive) what is shown in `/admin/customize/user_fields`.
- Only CSV slots up to the number of fields configured are used; the rest are ignored.

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
