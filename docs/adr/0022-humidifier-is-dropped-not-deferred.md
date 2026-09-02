# Humidifier is dropped, not deferred

> **Reverses the "Humidifier returns to scope" section of [ADR-0020](0020-discontinued-equipment-links-to-a-collection.md).** Everything else in ADR-0020 — the Collection Link mechanism itself, its use for discontinued Machine and Mask values — stands untouched. This is Humidifier-specific.

ADR-0020 put Humidifier back into scope because a Collection Link gave its five legacy values somewhere real to point: `CPAP Heated Humidifiers` at `/collections/cpap-heated-humidifiers`, carrying 27 products. That collection is a real page. It is not, on manual verification, where any of the five values actually resolve — every one of them currently links to the cpap.com homepage, not to that collection or to any humidifier-specific page. The Collection Link mechanism's entire justification is link equity (ADR-0020); a link to the homepage carries none, so the premise ADR-0020 reasoned from does not hold for this field.

Product confirmed independently, while this was under investigation for other reasons (issue #32), that Humidifier is a low-revenue field and does not need to be carried through this migration at all. Between the two — a mechanism whose payoff doesn't materialize, and a stakeholder who doesn't need it carried — the field is dropped rather than patched.

## What this changes

Humidifier stops being a **Managed Field**. Nothing in this pipeline reads `user_humidifier`, ships a `Humidifier` Field Mapping, or lists it in `SHEET_TABS`. `data/user_humidifier.csv` is retired the same way `data/resolved-products.csv` rows are retired when a product is excluded — it stops being generated, not hand-deleted mid-refactor. The five legacy values become **Unmatched Values** for any User still holding one: expected, unremarkable, logged only in Debug Mode, exactly like any other value with no Mapping behind it.

## What this does not change

**The `Humidifier` Custom User Field on the live Discourse instance is not this repository's to remove.** ADR-0015 already established that emptying or deleting a dropdown Custom User Field is a decision about the site, not about the catalogue, and refused to let a Catalogue Apply do it even when asked. That reasoning is unaffected by Humidifier leaving the Managed Field list — if anything it sharpens: a field this pipeline no longer touches is even less something an apply step should reach into. Whether the field is deleted, retyped, or left alone on the Discourse admin side is a site-administration call outside this codebase.

Gerhard's phpBB finding — that `user_humidifier` is a genuine option list rather than free text — is now moot for this pipeline's purposes, but stays true and stays recorded in ADR-0020 for anyone reconstructing the history.
