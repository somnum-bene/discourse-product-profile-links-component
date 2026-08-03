import { ajax } from "discourse/lib/ajax";
import type { UserFieldValues } from "./profile-links";
import { createUserFieldSource } from "./user-field-source";

// The seam between the User Field Source and Discourse's network layer. This is
// the only place that knows a user's Custom User Field values come from their
// card endpoint; the source itself is driven by an injected fetch so the unit
// tests never touch a network.
//
// One source is shared by every post on the page, which is what turns a long
// topic by one author into a single lookup. Deliberately no error handling
// here: a rejection is meaningful to the source, which retries on the next
// lookup rather than caching the failure.

interface UserCardResponse {
  user?: { user_fields?: UserFieldValues };
}

export const postUserFieldSource = createUserFieldSource(
  async (username: string) => {
    const data = (await ajax(`/u/${username}/card.json`)) as UserCardResponse;
    return data?.user?.user_fields ?? null;
  }
);
