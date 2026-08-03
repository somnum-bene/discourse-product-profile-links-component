import {
  describeConfigProblem,
  readLinkConfig,
  resolveProfileLinks,
} from "./profile-links";
import type {
  LinkConfig,
  ProfileLink,
  SiteUserField,
  UserFieldValues,
} from "./profile-links";

// The seam between the pure resolution module and Discourse's ambient inputs:
// the `settings` global and the site's Custom User Fields. Everything impure —
// reading the global, reporting problems to the console — lives here.

/** The slice of the `site` service this module needs. */
export interface SiteLike {
  user_fields?: SiteUserField[] | null;
}

let cachedConfig: LinkConfig | null = null;

/**
 * Derives the configuration once per page load. A topic page renders one post
 * Link Surface per post, so this must not be recomputed per surface — see
 * ADR-0002.
 */
function linkConfig(site: SiteLike): LinkConfig {
  if (!cachedConfig) {
    cachedConfig = readLinkConfig(settings, site?.user_fields ?? []);
  }

  return cachedConfig;
}

/**
 * Reports every Config Problem once, at boot. This is deliberately driven by an
 * initializer rather than by a Link Surface: an administrator editing the
 * setting is never looking at a user card, a user profile or a post, so a
 * report that waits for one to render is a report they never see.
 */
export function reportConfigProblems(site: SiteLike): void {
  for (const problem of linkConfig(site).problems) {
    console.warn(`[Profile Links] ${describeConfigProblem(problem)}`);
  }
}

/**
 * The Profile Links for one user, for any Link Surface to render. Always an
 * array, empty when the user has no matching Custom User Field values.
 */
export function profileLinksFor(
  site: SiteLike,
  userFields: UserFieldValues
): ProfileLink[] {
  const { links, unmatched } = resolveProfileLinks(
    linkConfig(site),
    userFields
  );

  if (settings.profile_link_debug_mode && unmatched.length) {
    console.debug(
      "[Profile Links] Field values matching no Mapping:",
      unmatched
    );
  }

  return links;
}
