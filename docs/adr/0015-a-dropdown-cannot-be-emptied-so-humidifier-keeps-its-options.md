# A dropdown cannot be emptied, so `Humidifier` keeps its hand-entered options

ADR-0011 said the apply step clears `Humidifier`'s Dropdown Options and leaves the field in place, unmapped, rather than leaving four selectable values that resolve to nothing. That is not possible. Discourse offers no way to reduce a dropdown Custom User Field to zero options.

Five payload shapes were tried against a throwaway field on the running test instance, each answered `200 OK`:

- `options: []` changes nothing — Rails turns an empty array parameter into `nil` and the controller skips a nil option list (ADR-0014).
- `options: null` and `options: ""` do the same.
- `options: [""]` and the form-encoded `user_field[options][]=` leave the field offering one blank choice, which is a visible option rather than no options.
- Changing `field_type` to `text` and back does not destroy the option records either; they come back intact.

The two operations that do reach zero are deleting the Custom User Field and changing its type permanently, and both destroy every value Users have already stored in it. That is a decision about the site rather than about the catalogue — the same reason the plan refuses to *create* a field it finds missing rather than inventing one (ADR-0013). So the apply step refuses a requested clear and says why, instead of doing the nearest thing that appears to work. A single blank dropdown entry would have satisfied the letter of the plan and left a selectable option that resolves to nothing, which is the exact failure the clear existed to prevent.

The clear stays in the plan. `planApply` still decides that naming a field authorises emptying it, still refuses to clear a field the catalogue populates, and still refuses to clear a name the instance does not define; those decisions are correct and tested. What changed is that the transport cannot carry the resulting write out, so it is refused before the first request rather than partway through the writes — a plan is all-or-nothing, and a run that wrote `Machine` and then discovered it could not clear `Humidifier` would leave the site in the state the all-or-nothing rule exists to avoid.

## Consequences

`Humidifier` on the test instance keeps its four hand-entered options — `DreamStation Heated Humidifier`, `HC150 Heated Humidifier`, `Dreamstation Heated Humidifier` and `S9™ Series H5i™ Heated Humidifier`, including the case-duplicate. Every User who picks one gets no Profile Link and nothing is logged unless Debug Mode is on. The apply step reports that on every run as a warning naming all four, so it is visible rather than remembered.

That makes Tyler's outstanding question about `Humidifier` (ADR-0012) more consequential than it looked. The options cannot be tidied away while waiting for an answer: either the field gets Mappings, or it gets deleted, or those four values stay selectable and broken. "Leave it cleared for now" was the third option and it does not exist.

Anyone extending this pipeline to another dropdown field inherits the same limitation. A field this pipeline populates can be corrected, extended and reordered; it cannot be handed back empty.
