# The configuration adapter joins theme settings with site user fields

`readLinkConfig` takes both the theme settings and `site.user_fields`, rather than reading settings alone as its name suggests. Theme settings identify a Custom User Field by *name*, but a user's stored values are keyed by the field's *integer ID*, so the name-to-ID join has to happen somewhere — and doing it in the adapter means both ambient Discourse inputs are consumed at a single point, and the result is derived once per page load instead of once per Link Surface.

## Consequences

A topic page renders one post Link Surface per post. Pushing the join back into the surfaces — which reads as the tidier design, since the adapter would then take only settings — restores a per-post recomputation of every Field Mapping, on a page that may render dozens of posts against a catalogue of hundreds of Mappings. The join stays in the adapter.
