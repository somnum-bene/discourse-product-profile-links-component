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

/**
 * A User Field Source over the given fetch. Each source owns its own cache, so
 * a test starts from a known state rather than inheriting module state from
 * whatever ran before it.
 */
export function createUserFieldSource(
  fetchUserFields: UserFieldsFetch
): UserFieldSource {
  const inFlight = new Map<string, Promise<UserFieldLookup>>();
  const fetched = new Map<string, UserFieldValues>();

  return {
    lookup(username: string): Promise<UserFieldLookup> {
      if (fetched.has(username)) {
        return Promise.resolve({
          ok: true,
          userFields: fetched.get(username) ?? null,
        });
      }

      const existing = inFlight.get(username);
      if (existing) {
        return existing;
      }

      // The fetch starts now rather than on a later microtask, so a second
      // lookup in the same tick already finds this one in flight. A fetch that
      // throws synchronously is turned into a rejection here, so it takes the
      // same failure path as one that rejects on its own.
      let started: Promise<UserFieldValues>;
      try {
        started = fetchUserFields(username);
      } catch (error) {
        started = Promise.reject(error);
      }

      const request: Promise<UserFieldLookup> = started.then(
        (userFields) => {
          const value = userFields ?? null;
          inFlight.delete(username);
          fetched.set(username, value);
          return { ok: true, userFields: value };
        },
        () => {
          // A failure is deliberately not cached. Caching it is the bug this
          // module exists to fix: one blip while a topic loaded used to hide a
          // member's Profile Links for the rest of the session.
          inFlight.delete(username);
          return { ok: false };
        }
      );

      inFlight.set(username, request);
      return request;
    },
  };
}
