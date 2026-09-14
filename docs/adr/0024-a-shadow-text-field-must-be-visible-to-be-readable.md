# A shadow text field must be visible to be readable

> **Answers the two staging questions in #59 and closes the assumption [ADR-0021](0021-a-collection-link-is-a-mapping-with-no-option.md) left open by name.** It does not decide whether to build the shadow field. It establishes what any build is permitted to look like, and forecloses the configuration #59 proposed as its most likely shape — which is the part a build would otherwise have discovered late.

Gerhard's mitigation for #58 is to store a discontinued value in a second, `text`-typed Custom User Field and have the Link Surfaces fall back to it when the dropdown is empty. #59 proposed configuring that field as admin-write-only and not User-editable, and asked two questions about what those flags do. Both were run against `tyler-test.discourse.group` (Discourse 2026.9.0, core read at `d4971434ce13627ac79bcf95474dcbeea6999a71`) on two throwaway `text` fields that differed only in their visibility flags, and both throwaway fields were deleted afterwards.

## Not User-editable hides the field, and that is the safe half

`editable: false` does not grey the control out. It removes the field from `/my/preferences/profile` altogether for anyone who is not staff — `frontend/discourse/app/controllers/preferences/profile.js` filters the site's field list with `siteUserFields.filter((field) => field.editable)` before the template ever iterates it, under a comment that says why: *"Staff can edit fields that are not `editable`."* An Administrator still sees the field on their own preferences page and can still change it there.

The instance confirms the input to that filter. `/site.json` delivered the throwaway field to the client as `editable=false` alongside the three real ones at `editable=true`, so the filter is acting on a fact the server states rather than on anything a Link Surface controls.

The same flag is enforced a second time on the write path, and this is the stronger of the two. `app/controllers/users_controller.rb` builds the writable set as `fields = UserField.all` and then narrows it — `fields = fields.where(editable: true) unless current_user.staff?` — before it considers the payload at all. A User's profile save cannot reach a non-editable field even if the field's key is present in the request. Writing such a field from the migration script or our own admin tooling works, because that path is staff: a `PUT /u/:username.json` carrying an `editable: false` field's value was answered `success: OK` and read back unchanged, which is ADR-0014's rule applied to this question.

## Hidden from the User means hidden from the API, and that is the half that bites

A field hidden from both profile and user card is not returned to the people the feature exists for.

`lib/guardian/user_guardian.rb#allowed_user_field_ids` splits on the viewer, not on the field:

```ruby
is_staff_or_is_me = is_staff? || is_me?(user)
@allowed_user_field_ids[cache_key] ||= if is_staff_or_is_me
  UserField.pluck(:id)
else
  UserField.where("show_on_profile OR show_on_user_card").pluck(:id)
end
```

Staff, and the User themselves, get every field. Everybody else gets only the fields flagged onto a profile or a card. The serializer filters `user_fields` through that list, so the flag pair is a visibility rule about the *reader*, and a Link Surface renders in the reader's browser.

Both throwaway fields were populated on one User and then read anonymously. The field flagged `show_on_profile: true, show_on_user_card: true` came back with its value. The field flagged false on both was absent from the payload entirely — not null, absent — while remaining readable to the admin key against the same URL a moment earlier.

So #59's second question has a blunt answer: **hidden-from-User does mean hidden-from-API**, for every reader except staff and the profile's owner. An admin-only hidden field would have rendered Collection Links that only Administrators and the User themselves could see, which is the opposite of the SEO and public-profile value [ADR-0020](0020-discontinued-equipment-links-to-a-collection.md) exists to preserve, and it would have tested clean for whoever built it, because a developer checking their own work is both.

## What follows from it

A shadow field, if built, is `editable: false` **and** `show_on_profile: true` and/or `show_on_user_card: true`, matched to the Link Surfaces it must feed. The two axes are independent and only one of them is safe to close: withholding *edit* is the protection, and withholding *visibility* destroys the feature. The "admin-only, hidden" shape #59 floated is not available.

That configuration is world-readable, and deliberately so. It is the same exposure the `Machine` and `Mask` Dropdown Options already carry — an equipment name against a public profile — so it widens nothing, and the shadow field holds no identifier the curated pipeline does not already ship in `settings.yml`.

## The retention guarantee, finally measured

ADR-0021 named one assumption as load-bearing and unverified: that Discourse preserves a stored value after the Dropdown Option behind it is removed. It has now been measured on both sides, and the honest statement is narrower than either ADR-0021 or #58 put it.

The wipe is a property of the field's *type*, applied at `clean_custom_field_values`:

```ruby
if field.field_type == "dropdown"
  field.user_field_options.find_by_value(field_values)&.value
elsif field.field_type == "multiselect"
  ...
else
  field_values
end
```

A `dropdown` value absent from the option list resolves through `find_by_value` to `nil`. The `else` branch — which is where `text` lands — returns the value verbatim, with no option list consulted because there is none to consult. The same off-list string was written in a single request to a `dropdown` field and a `text` field on one User: the dropdown came back `null`, the text field came back intact. #58 reproduces on demand, and the premise under Gerhard's mitigation is sound rather than merely plausible.

The value's real lifetime, then, is *until the next profile save that includes that field in its payload* — the controller skips any field whose key is absent (`next unless params[:user_fields].has_key?(field_id)`), so the loss is a resave of a rendered-blank control, not a background sweep. ADR-0021's warning that "a User already holding a removed value silently stops getting a Profile Link" was right about the outcome and wrong about the trigger, and `pnpm apply:catalogue`'s `RETAINED` wording inherits that error.

## What is not settled here

**Whether to build it at all is still open, and this ADR deliberately does not close it.** The spike found no technical blocker, which is not the same as a reason.

**The editability axis has not been exercised against the instance.** The `unless current_user.staff?` narrowing is unambiguous in core source at the pinned commit, and read plainly it means that marking the existing `Machine` and `Mask` fields not-User-editable would stop the #58 wipe outright — no new field, no migration, no Link Surface change — at the cost of Users no longer curating their own equipment. That trade is probably unacceptable standing, and might be exactly right as a freeze for the duration of a migration. It was not tested because proving it needs a non-staff account saving a profile against a field that is already not-editable, and #58's repro exercised neither half: `Machine` is `editable: true`, so the narrowing has nothing to bite on no matter which account performed it. **This is the highest-value next probe, and it should happen before the shadow field is costed**, because it is the one finding that could make the shadow field unnecessary.

> **Settled in [ADR-0025](0025-a-freeze-stops-the-wipe-so-it-covers-the-migration-not-the-feature.md) (#61).** The probe was run and the reading above was right: a non-staff User's save cannot reach a field at `editable: false`, even when the payload carries a *valid on-list* value for it, while an unrelated editable field written in the same request lands normally. It did not make the shadow field unnecessary. A freeze is all-or-nothing per field and, per this ADR's own first section, removes the control from `/my/preferences/profile` rather than greying it out — so standing, it stops Users recording equipment at all. It is adopted as a migration-window tool; the shadow field remains the standing answer and is costed in its own issue.

**The two questions #59 lists after the flag pair are not spike questions.** Whether the shadow field replaces the CSV-into-dropdown plan or follows it, whether it earns a row in `data/disposition-table.csv`, and what `pnpm apply:catalogue --plan/--replace` must start asserting are design decisions that only become answerable once the build decision above is made. A shadow field is also not a **Managed Field** as `CONTEXT.md` defines the term — the Sheet Export allowlist names `Machine` and `Mask` — so if it is built, the glossary needs a word for it before the pipeline grows code that assumes one.
