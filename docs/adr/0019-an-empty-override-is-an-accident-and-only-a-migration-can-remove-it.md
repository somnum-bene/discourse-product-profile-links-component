# An empty override is an accident, and only a migration can remove it

ADR-0008 accepted a known cost when it chose `settings.yml` as the sink for the catalogue: an administrator who saves `profile_link_fields` through the theme settings UI freezes that site's Field Mappings, silently and permanently. It was written as a hazard to warn people about. Applying the catalogue to the test instance found it had already happened.

The instance carried an override of `[]` against a default of fifty-five Mappings. It is provably an override rather than an absent value, because `ThemeSettingsManager::Objects#value` is `has_record? ? hydrate_uploads(db_record.json_value) : default` — a setting with no row reports its default, so a value that disagrees with the default is a row.

Nothing about the site looked wrong. `readLinkConfig` normalizes an empty value to no Field Mappings and raises no Config Problem, because a component configured to link nothing is a legitimate configuration. Every Link Surface rendered nothing, on every page, with an empty console. That is the silent failure ADR-0006 was written to prevent, reached by a different route: there, a setting disappeared from `settings.yml`; here, a setting stopped listening to it.

**Discourse offers no way to delete a theme setting override.** `Admin::ThemesController#update_single_setting` computes `new_value = params[:value] || nil` and calls `update_setting`, which only writes; `ThemeSettingsManager#value=` creates or updates a row and has no destroy path. There is no reset route. A hosted instance has no console. The override is unreachable through every interface the site exposes.

One mechanism reaches it. `Theme#migrate_settings` runs the pending settings migrations, then:

```ruby
old_settings = theme_settings.pluck(:name)
theme_settings.destroy_all

final_result[:settings_after].each do |key, val|
  update_setting(key.to_sym, val)
end
```

Every override row is destroyed and only the keys the migration returned are recreated, so a key a migration removes from its map is gone. `0001` already relies on this to retire the eleven flat settings. `0002-drop-empty-profile-link-fields-override.js` uses it to remove an empty `profile_link_fields` and nothing else.

## An empty override is treated as an accident

The migration deletes an empty value and keeps a populated one, which asserts that nobody meant to configure a component to link nothing. That is a judgement, and it could be wrong for some site — so it rests on something stronger than taste: **until the catalogue was generated into `settings.yml`, the shipped default was itself empty.** Setting it to empty was therefore a no-op with no visible effect and no reason to perform, while *saving an unchanged editor* produces exactly this state and is something people do constantly. One of the two explanations can barely happen and the other is how our own instance got here.

A site that genuinely wants no Profile Links has a supported way to say so, and it is disabling the component — a decision this migration neither reads nor disturbs.

## Consequences

**This is a repair, not a guard.** Discourse runs a migration once per installation and records that it ran, so `0002` fixes an instance trapped before it runs and can do nothing for one trapped afterwards. Anyone who saves the setting tomorrow freezes their site again, and the answer to that is unchanged: the ownership warning in the setting's own `description`, and the override detection in `pnpm apply:catalogue`.

**That detection under-reports, and this ADR is where to record it.** `findComponent` computes `overridden` as `JSON.stringify(value) !== JSON.stringify(default)`, because nothing readable from outside exposes `has_record?`. An override that happens to match the shipped default is therefore invisible to it. It catches the frozen sites that have drifted, which is the case that matters, and it will never catch one that has not drifted yet.

**A migration must return the map otherwise intact**, and that is now a structural hazard rather than a stylistic preference. Because `destroy_all` precedes the recreate, a migration that drops a key it was not asked about deletes that setting from the site. `0002` is tested against that directly and fault-injected against it: a mutation replacing its single `delete` with `clear()` is caught.

**Uncertain shapes keep their value.** The migration deletes only when the value is certainly an empty array. Discourse hands an `objects` setting over as a real array, so nothing else should arrive — but a deletion cannot be undone by a later migration, while a site keeping a configuration it no longer wanted can be fixed by anyone. The asymmetry decides it, the same way it decides ADR-0016.

**Deleting and reinstalling the component was the alternative, and it was rejected.** It works — the `theme_settings` rows go with the theme, and nothing in the cascade reaches `user_fields` or a User's stored values, which is ADR-0011's two-sink split protecting us from the other direction. But it is a destructive operation on a live site, it discards the theme id, and it repairs one instance by hand instead of shipping something that repairs any instance. A migration is reviewable in a pull request and a delete is not.
