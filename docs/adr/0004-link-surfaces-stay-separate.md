# The three Link Surfaces stay separate

The user card, user profile, and post Link Surfaces render near-identical markup, and merging them into one rendering module was considered and rejected. The card and profile wrappers use Discourse core class names — `user-card-metadata-outlet`, `public-user-fields`, `public-user-field` — which core CSS targets directly, so collapsing the wrappers would silently change how core styles apply to our output. Only the row *inside* each wrapper is shared, as a single `ProfileLinkRow`.

## Consequences

The duplication between the three surfaces is deliberate and should not be "cleaned up". What remains in each surface is a wrapper whose class names are load-bearing plus its own User Field Source; the resolution logic and the row markup are already shared.
