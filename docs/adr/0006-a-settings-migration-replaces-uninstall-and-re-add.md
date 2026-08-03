# A settings migration replaces "uninstall and re-add"

ADR-0001 replaced eleven flat settings with the structured `profile_link_fields` and deliberately shipped no migration, on the grounds that the component was installed on a test site only. Upgrading meant uninstalling the component and re-entering every Field Mapping by hand. That ADR named the condition under which the decision expires: "the moment this ships anywhere real." It is now shipping.

We ship `migrations/settings/0001-convert-flat-settings-to-field-mappings.js` instead. Without it, an installation that merely *updates* the component loses its entire configuration silently. Discourse discards the stored value of a setting that no longer appears in `settings.yml`, so the eleven old keys go; `profile_link_fields` then comes up as its empty default, `readLinkConfig` normalizes it to no Field Mappings, and no Config Problem is raised, because an empty configuration is a legitimate one. Every Link Surface renders nothing, on every page, with nothing in the console to explain it. An administrator has no reason to connect that to a component update, and the README's uninstall instructions do not help someone who never chose to uninstall.

The migration reads the old pipe-delimited name list and the ten positional CSV slots and writes the structured equivalent, splitting each `value,url` line on its first comma exactly as the old parser did — so a migrated site resolves the same Profile Links it resolved before, rather than subtly different ones. It also carries `custom_profile_link_debug_mode` onto `profile_link_debug_mode`, which was renamed in the same change and would otherwise have been lost the same way.

A configured Custom User Field name whose CSV slot was empty, or which sat past the tenth slot and so had nowhere to put its Mappings, is carried over as a Field Mapping with no Mappings. Both resolved no Profile Links before and resolve none now. Dropping them would be tidier, but it would silently discard part of an administrator's configuration — the failure this migration exists to prevent. Carried over, they surface as a reported Config Problem instead, which is the outcome that can actually be acted on.

## Consequences

The migration is unit-tested in `spec/unit`, which is possible only because Discourse's contract for one is a plain function over a `Map` — no Discourse imports, so it fits the existing runner with no new machinery. `migrations/` was added to the `lint:js` and `lint:prettier` globs, which previously covered only `javascripts`, `test` and `spec`, so the file is held to the same standard as the rest.

Discourse runs a migration once per installation and records that it ran. A bug in one is therefore not fixable by editing it — it needs a further migration that corrects the state. This is the reason the conversion is kept mechanical and total, with no attempt to clean up or validate the configuration on the way through: validation belongs to `readLinkConfig`, which runs on every page load and can be fixed by shipping a new version.

A fresh installation is unaffected. Discourse passes a migration only the settings an administrator has overridden, so a new install arrives with an empty `Map` and leaves with one.
