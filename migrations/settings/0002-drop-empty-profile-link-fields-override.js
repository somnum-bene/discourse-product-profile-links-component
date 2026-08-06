// Removes an empty `profile_link_fields` override, which nothing else can.
//
// Saving a setting through the theme settings UI stores an override, and from
// then on Discourse never delivers that setting's shipped default to that site
// again (ADR-0008). While the shipped default was itself empty — which it was
// until the catalogue was generated into `settings.yml` — opening the setting
// and saving it changed nothing anyone could see, so nothing signalled that the
// site had just been frozen at empty. The test instance was found in exactly
// that state: an override of `[]` against a default carrying 55 Mappings.
//
// The site is not visibly broken. `readLinkConfig` normalizes an empty value to
// no Field Mappings and raises no Config Problem, because a component that is
// configured to link nothing is a legitimate configuration. Every Link Surface
// simply renders nothing, on every page, with an empty console — the same
// silent failure ADR-0006 exists to prevent, arrived at by a different route.
//
// A settings migration is the only supported way out. Discourse exposes no
// route that deletes a `theme_settings` row: `update_single_setting` only
// writes, and `ThemeSettingsManager#value=` has no destroy path. But
// `Theme#migrate_settings` calls `theme_settings.destroy_all` and then
// recreates only the keys the migration returned, so a key removed from the map
// is gone. That is the same mechanism `0001` uses to retire the flat settings.
//
// An empty override is treated as an accident rather than a preference. The two
// are indistinguishable in the data, and only one of them can really happen:
// until the catalogue shipped, the default was empty too, so deliberately
// setting empty was a no-op no administrator had a reason to perform. A site
// that genuinely wants no Profile Links turns the component off, which is a
// decision this migration cannot undo and does not touch.

const SETTING = "profile_link_fields";

export default function migrate(settings) {
  const overridden = settings.get(SETTING);

  // Deleted only when the value is certainly an empty list. Discourse hands an
  // `objects` setting over as a real array — `ThemeSettingsManager::Objects`
  // reads it from the row's `json_value` and the base `cast` is the identity —
  // so anything else here is a shape this migration did not expect. Every
  // uncertain case is left alone rather than removed, because a removal cannot
  // be undone by a later migration and a site keeping a configuration it no
  // longer wanted is the recoverable half of that choice.
  if (Array.isArray(overridden) && overridden.length === 0) {
    settings.delete(SETTING);
  }

  // Everything else is returned exactly as it arrived. This is not incidental:
  // `migrate_settings` destroys every override row before recreating the keys
  // this map still holds, so a setting dropped here is a setting deleted from
  // the site.
  return settings;
}
