# A freeze stops the wipe, so it covers the migration and not the feature

> **Answers the probe [ADR-0024](0024-a-shadow-text-field-must-be-visible-to-be-readable.md) named as highest-value and closes the decision #61 was opened to make.** It does not build the shadow field. It establishes that the shadow field is still the standing answer, and that a freeze is the thing to reach for in the meantime.

ADR-0024 read `app/controllers/users_controller.rb` and concluded that marking a Custom User Field not-User-editable ought to stop the #58 wipe outright, independently of field type — then said plainly that the editability axis "has not been exercised against the instance," because proving it needs a non-staff account saving a profile against a field that is *already* not-editable. #58's own repro exercised neither half. That probe has now been run against `tyler-test.discourse.group` (Discourse `2026.9.0-latest`), and the reading was right.

## The freeze holds, and it holds on the server

An `Api-Key` carrying an `Api-Username` of a non-staff account is genuinely that account: `/session/current.json` returned the throwaway User's own id, and `/admin/config/user_fields.json` was refused on the same credentials that answered `200` for the Administrator a moment later. So `current_user.staff?` is false for these requests, which is the condition #59 could not create.

A throwaway `dropdown` field was created with two options, one of them was stored on a throwaway non-staff User by an admin write, and that option was then removed from the field's list — leaving the stored value off-list, which is the state [ADR-0021](0021-a-collection-link-is-a-mapping-with-no-option.md) puts every Collection Link holder in permanently and by construction. The value survived the option removal itself, as #29 and #41 already found. Then the same User saved their own profile, four times, against one flag:

| Field | Payload from the non-staff User | Stored value after |
| --- | --- | --- |
| `editable: true` | `{ 10: "" }` | `""` — **wiped** |
| `editable: false` | `{ 10: "" }` | `"Doomed Bravo"` — survived |
| `editable: false` | `{ 10: "Keeper Alpha" }` (a **valid on-list** value) | `"Doomed Bravo"` — survived |
| `editable: false` | `{ 10: "", 4: "probe-humidifier" }` | `"Doomed Bravo"` — survived |
| `editable: true` again | `{ 10: "" }` | `""` — **wiped** |

Every one of those saves answered `200 success: OK`. The flag was flipped back and forth on one field, one User and one value, so the difference is the flag and not the weather.

Two details in that table carry more than the headline. The third row submitted a value that was *legal* — `"Keeper Alpha"` was on the option list — and it still did not land, so the narrowing refuses the field rather than sanitising what arrives in it; this is not the client declining to render a control, it is the server declining to read the key. The fourth row wrote `"probe-humidifier"` to an unrelated `editable: true` field **in the same request**, and that write did land, which is what proves these were real profile saves and not requests failing wholesale somewhere earlier.

So `fields = fields.where(editable: true) unless current_user.staff?` does what it says, before the payload is considered, independently of field type and independently of the value submitted. A freeze cannot be defeated by a client that submits the key anyway — a scripted call, the mobile app, a future preferences page — which is the property that makes it worth anything.

## Why that does not make a freeze the answer

It is tempting to stop here, because the freeze is free: one flag, no new field, no migration, no Link Surface change, and it protects **every** stored value rather than only the ones a shadow field would be built to carry.

It is also not available as a standing answer, for a reason ADR-0024 established before this probe ran. `editable: false` does not grey the control out — `frontend/discourse/app/controllers/preferences/profile.js` filters the site's field list with `siteUserFields.filter((field) => field.editable)`, so the field leaves `/my/preferences/profile` altogether. A standing freeze on `Machine` and `Mask` is therefore not "Users may not change their equipment"; it is "Users may not record their equipment," including the User who just bought a machine and has nothing to correct. That is the primary purpose of the two fields, and trading it away to protect the subset of values that are discontinued spends the feature to save part of it.

The freeze is also all-or-nothing per field. There is no configuration that freezes only the Users holding an off-list value, because the flag is a property of the field, so the tax falls on everybody to protect a minority.

## Why accepting the leak is worse

Option C — do nothing — reads like the patient choice, and it is the one this decision rejects hardest.

The population at risk is not a trickle. ADR-0021 defines a Collection Link as a Mapping with **no** Dropdown Option, on purpose, so a User holding one holds an off-list value permanently and by construction rather than by accident. `data/disposition-table.csv` carries 103 rows at `disposition: collection` against 122 at `resolves-to-product`. Every one of those 103 values is one profile save away from `""`, for every User holding it, and the trigger is any profile save at all — ADR-0024 measured the real lifetime as *until the next profile save that includes the field in its payload*, and the preferences page submits every editable field, so changing an avatar is enough.

The loss is silent and it does not come back. Nothing in this repository records which machine a given User had: `data/user_machine.csv` and `data/user_mask.csv` are option tables — `Value,Text,URL,Suggested Title,Suggested URL` — not per-User rows. Once the wipe lands there is nothing to restore from. C is therefore not "accept a slow leak"; it is "ship [ADR-0020](0020-discontinued-equipment-links-to-a-collection.md) and watch it drain," and it leaves ADR-0021's retention guarantee false in exactly the way the pipeline keeps printing that it is true.

## The decision

**A freeze is adopted as a migration-window tool, and the shadow field remains the standing answer.** #61 offers these as A and B and notes they are not mutually exclusive; they are taken together, with A bounded.

During a Catalogue Apply that writes `Machine` and `Mask` wholesale, those fields are marked `editable: false` for the duration and returned to `editable: true` afterwards. It costs one flag, it is reversible in one call, staff and the migration script write straight through it (ADR-0024 confirmed the staff bypass, and this probe re-confirmed it on every setup write), and it removes the one window in which a User's save can race the migration's own writes over the same value. Visibility is a separate axis and the freeze does not touch it, so `show_on_profile` and `show_on_user_card` stay as they are and **the Link Surfaces keep rendering throughout** — a freeze costs editing, not display. That is the whole reason it is safe to reach for.

What a freeze cannot do is expire. The Collection Link population needs protecting after the migration window closes, and the only shape that protects it without taking self-service editing away permanently is the shadow `text` field in ADR-0024's forced configuration — `editable: false` **and** visible on profile and/or card. ADR-0024 already spent the risk out of that design, so what is left is build cost, and it is costed in its own issue rather than here.

Converting `Machine` and `Mask` from `dropdown` to `text` was rejected on the way past. It would buy the same immunity for free — the `else` branch of `clean_custom_field_values` returns a `text` value verbatim — but a Mapping is looked up by exact string, so a free-text control turns every future value into an Unmatched Value the moment a User types `ResMed Airsense 11` for `AirSense 11 AutoSet`. ADR-0011 and [ADR-0012](0012-discontinued-equipment-is-out-of-scope-for-profile-links.md) exist to keep the option list curated, and this would trade the wipe for a slower, messier version of the same loss.

## What this corrects

The decision changes the real lifetime of a stored value — under a freeze no User save can reach it at all — so the two places that overstate that lifetime are corrected with it, as #61 requires.

ADR-0021's "The load-bearing assumption, verified (#41)" section now carries a subsection saying what "retained" is actually worth, because #29 and #41 both measured survival across an *option removal* and neither measured a subsequent *profile save*. Their finding stands; it was simply narrower than the section read.

`planApply`'s `RetainedLink` detail — the `RETAINED` line an operator reads before authorising a destructive write — promised that "a User already holding it keeps getting a Profile Link" with no condition attached. ADR-0013 makes a destructive write authorised by what it removes, which only works if the plan says what the removal actually costs, and an operator who believes the unconditional version under-reacts to #58. It now names the profile save as the terminus and the editability flag as the thing that stops it.

## What is not settled here

**The build itself.** Field configuration, the migration path, Link Surface fallback logic, tests, and what `pnpm apply:catalogue --plan/--replace` must start asserting all belong to the shadow field's own issue, and #61 closes without them.

**Whether the freeze should be automated.** It is adopted here as an operator step around a migration, not as something `apply:catalogue` does on its own. Making the tool flip a flag on a live instance and flip it back is a destructive-write question under ADR-0013 — the failure mode is an apply that dies between the two and leaves the instance frozen — and nothing has been designed for it.

**What a shadow field is called.** ADR-0024 already flagged that it is not a **Managed Field** as `CONTEXT.md` defines the term, since the Sheet Export allowlist names `Machine` and `Mask`. The glossary needs a word for it before the pipeline grows code that assumes one.
