# Core's duplicate rows are hidden by a modifier, not by static CSS

Discourse core renders every Custom User Field marked "show on profile" or "show on user card" as a plain-text `.public-user-field` row. Where a Profile Link shows the same value as a link, the value reads twice. Hiding core's row was expected to be static CSS in `common/common.scss`; it cannot be, for two reasons.

Core does tag each row with the field's identity — `public-user-field {{dasherized_name}}` on the profile, `public-user-field public-user-field__{{dasherized_name}}` on the user card — so a selector *can* name a field. But the field names come from the `profile_link_fields` setting, which static SCSS cannot enumerate; and hiding a row is only correct when that particular user's value resolved to a Profile Link, which is a per-user fact no stylesheet can know. A field with no Field Mapping, or a value matching no Mapping, must keep rendering core's plain text — otherwise installing this component silently deletes information from profiles.

Both conditions are known in JavaScript, at the point where a Link Surface has already resolved its links. So the decision of which rows to hide is made there, by `hideCoreFieldRows`, which adds a class that `common/common.scss` styles. The matching rule itself — which row belongs to which field — lives in the pure `core-field-rows` module and is unit-tested; the modifier is the only place that touches DOM outside the component's own subtree.

Generating a stylesheet from the settings at boot was the alternative. It was rejected because it can only hide by field name, which would have required this component to take over rendering the unmatched values core would no longer show.

Dasherizing is lossy, and core exposes no field id in the markup to fall back on. Two differently-named Custom User Fields — "Sleep Apnea" and "sleep-apnea" — collapse onto one token, and core tags both their rows with it; a field named "Public User Field" collapses onto the class core puts on every row. In either case, hiding on the token would take the plain text of a field that has no Profile Link off the profile along with the one that does. So a name that does not pick out exactly one field is dropped before any row is hidden, and the duplicate is left on screen: showing a value twice is a blemish, silently deleting one is data loss. The drop is warned about once per field name, in the same `[Profile Links]` console channel as the other configuration problems.

The reserved-name case could in principle be salvaged on the user card, where core's prefixed spelling `public-user-field__public-user-field` is unambiguous even though the profile's bare spelling is not. Making the rule surface-specific to recover it was rejected: it would split one rule into two for a field name nobody will use, and the current failure is the safe one — a visible duplicate, not lost data.

## Consequences

Three dependencies on core markup exist, all in `hide-core-field-rows.ts` and commented there: the scope selectors `.primary-textual` and `.card-content`, the `.public-user-field` row class, and Ember's `dasherize` (imported rather than reimplemented, so it cannot drift from core's). If core changes any of them the duplicate returns and nothing else breaks — the Profile Links still render, they just sit under core's plain text again.

Hiding core's row also removes core's `searchable` link to user search for that value. This is accepted: a field configured with Profile Links is one whose values are meant to link somewhere else.

Glint does not type-check modifier positional arguments in this project — verified by fault injection, where passing a number as the scope selector type-checked clean while a bogus component argument in the same template errored. The modifier's parameter types are therefore documentation, not a gate. Both call sites are in the two Link Surface connectors.
