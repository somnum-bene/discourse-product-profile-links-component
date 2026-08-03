// The User Field Source for the post Link Surface.
//
// The card and profile Link Surfaces receive a user's Custom User Field values
// in their outlet args; a post carries only a username, so those values have to
// be fetched. This module owns that lookup — request dedupe, cache lifetime and
// failure policy — around an injected fetch, so the unit tests in spec/unit
// drive it with no network. Nothing here imports Discourse or Ember.

import type { UserFieldValues } from "./profile-links";

/** Fetches one user's Custom User Field values, rejecting if it cannot. */
export type UserFieldsFetch = (username: string) => Promise<UserFieldValues>;

/**
 * What one lookup came back with. A user who holds no Custom User Field values
 * and a lookup that never reached the server both have no values to show, but
 * only the second is worth trying again — so the two are distinguishable here
 * rather than collapsed into a bare null. A caller that stores the null of a
 * failed lookup turns a network blip into a permanent absence.
 */
export type UserFieldLookup =
  | { ok: true; userFields: UserFieldValues }
  | { ok: false };

export interface UserFieldSource {
  /**
   * One user's Custom User Field values, or the fact that the lookup failed.
   * Never rejects — a theme component must not break the page.
   */
  lookup(username: string): Promise<UserFieldLookup>;
}

/** How many times one lookup tries before it reports failure. */
const DEFAULT_ATTEMPTS = 3;

/** How long to wait before the nth retry, in milliseconds. */
function defaultBackoff(attempt: number): number {
  return 250 * 2 ** (attempt - 1);
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface UserFieldSourceOptions {
  /** Total tries per lookup, the first included. One disables retrying. */
  attempts?: number;
  /** Sleeps. Injected so a test exercises the retries without waiting. */
  wait?: (ms: number) => Promise<void>;
  /** How long to wait before the nth retry. */
  backoff?: (attempt: number) => number;
}

/**
 * A User Field Source over the given fetch. Each source owns its own cache, so
 * a test starts from a known state rather than inheriting module state from
 * whatever ran before it.
 */
export function createUserFieldSource(
  fetchUserFields: UserFieldsFetch,
  options: UserFieldSourceOptions = {}
): UserFieldSource {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const wait = options.wait ?? defaultWait;
  const backoff = options.backoff ?? defaultBackoff;

  const inFlight = new Map<string, Promise<UserFieldLookup>>();
  const fetched = new Map<string, UserFieldValues>();

  /**
   * Tries the fetch until it succeeds or the attempts run out.
   *
   * Retrying belongs here rather than in the Link Surface that renders the
   * result. A post sitting on screen has no reason to re-render, so a component
   * that merely allowed a retry would be waiting for something that may never
   * come, and the blip would outlast itself after all. Here the recovery is the
   * lookup's own business and needs nothing from the page.
   *
   * The first fetch is issued before this function awaits anything, so a second
   * lookup in the same tick still finds this one in flight rather than starting
   * a competing one. A fetch that throws synchronously takes the same path as
   * one that rejects.
   */
  async function fetchWithRetries(username: string): Promise<UserFieldLookup> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const userFields = await fetchUserFields(username);
        return { ok: true, userFields: userFields ?? null };
      } catch {
        if (attempt < attempts) {
          await wait(backoff(attempt));
        }
      }
    }

    return { ok: false };
  }

  return {
    lookup(username: string): Promise<UserFieldLookup> {
      if (fetched.has(username)) {
        return Promise.resolve({
          ok: true,
          userFields: fetched.get(username) ?? null,
        });
      }

      // Every caller arriving while the retries play out joins this one, so a
      // topic full of posts by one author still makes a single lookup's worth
      // of requests however many times it has to be retried.
      const existing = inFlight.get(username);
      if (existing) {
        return existing;
      }

      const request = fetchWithRetries(username).then((outcome) => {
        inFlight.delete(username);

        // Only a success is cached. Caching a failure is the bug this module
        // exists to fix: one blip while a topic loaded used to hide a member's
        // Profile Links for the rest of the session.
        if (outcome.ok) {
          fetched.set(username, outcome.userFields ?? null);
        }

        return outcome;
      });

      inFlight.set(username, request);
      return request;
    },
  };
}
