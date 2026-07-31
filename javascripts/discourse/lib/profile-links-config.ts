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
 * Derives the configuration once per page load and reports any Config Problems
 * with it once. A topic page renders one post Link Surface per post, so this
 * must not be recomputed per surface — see ADR-0002.
 */
function linkConfig(site: SiteLike): LinkConfig {
  if (!cachedConfig) {
    cachedConfig = readLinkConfig(settings, site?.user_fields ?? []);

    for (const problem of cachedConfig.problems) {
      console.warn(`[Profile Links] ${describeConfigProblem(problem)}`);
    }
  }

  return cachedConfig;
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
