# The catalogue ships as the setting's default, not as a migration

PSD-68 populates the Machine and Mask Field Mappings with the cpap.com product catalogue, first on a test Discourse instance and later on production, which lives on a different subdomain. The obvious reading of "make it repeatable" is a settings migration, because `migrations/settings/0001` already exists and converting configuration is what it does. That reading is wrong, and the reason is worth recording because the next person will reach for the same tool.

Discourse runs a settings migration once per installation, on update, and hands it only the settings an administrator has overridden. Both instances here are fresh installs with `profile_link_fields` unoverridden, so a migration receives an empty `Map` and correctly does nothing — the mechanism cannot fire on the sites it would need to. A migration also cannot be edited after it has succeeded, which makes it the wrong home for data that changes whenever the product range does. ADR-0006 exists because a migration was the right answer to a different problem: carrying an administrator's own configuration across a schema change. Catalogue data is not the administrator's configuration.

So the catalogue ships as the `default:` of `profile_link_fields` in `settings.yml`, generated and committed. One commit serves both subdomains with no per-site step, the value is diffable and reviewable in the same pull request as the code, and it is validated by the same schema an administrator's input would be. Nothing about a new subdomain requires a deploy ritual: install the component, and the Mappings are already correct.

The cost is that **the repository owns `profile_link_fields`.** Discourse stores an administrator's edit as an override, and once a site has one, shipped defaults never reach that setting again — silently, and for good. Anyone editing Mappings through the theme settings UI on a live site freezes that site's catalogue at the moment they clicked save. That is stated in the setting's `description` and in the README, because it is not discoverable from the behaviour: the site keeps working, it just stops receiving updates.

## Consequences

The Dropdown Options half of the configuration cannot ship this way — it is site data, not theme data (ADR-0011). A per-site step therefore exists regardless, which weakens but does not overturn the argument here: the half that *can* be versioned should be.

Regenerating `settings.yml` by hand is a way to introduce a value that no longer matches its source. A drift gate regenerates it in CI and fails on any diff, so the committed file and `data/resolved-products.csv` cannot disagree.

One premise of this decision was unverified when it was taken: that Discourse accepts a *populated* nested `default:` of roughly eighty-six Mappings. An empty one demonstrably works, and ADR-0006 records that schema validation rejects an entire `objects` value rather than one bad entry, so a size or validation limit would not fail gracefully. That is why the first piece of work is a spike against a real instance — generate the file, install it, confirm the value is accepted, the admin UI copes, and Profile Links resolve. If it does not hold, this decision is superseded rather than patched, because the alternative is a different mechanism and not a smaller default.
