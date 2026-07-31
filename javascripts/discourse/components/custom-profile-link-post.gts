import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import type Owner from "@ember/owner";
import { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";
import { profileLinksFor } from "../lib/profile-links-config";
import type { SiteLike } from "../lib/profile-links-config";
import type { UserFieldValues } from "../lib/profile-links";
import ProfileLinkRow from "./profile-link-row";

// Module-level cache: username → Promise<user_fields object | null>
// Avoids duplicate requests across all posts on the page.
const _userFieldsCache = new Map<string, Promise<UserFieldValues>>();

function fetchUserFields(username: string): Promise<UserFieldValues> {
  if (!_userFieldsCache.has(username)) {
    _userFieldsCache.set(
      username,
      ajax(`/u/${username}/card.json`)
        .then((data) => data.user?.user_fields || null)
        .catch(() => null)
    );
  }
  return _userFieldsCache.get(username)!;
}

interface Signature {
  Args: {
    post?: { username?: string };
  };
}

export default class CustomProfileLinkPost extends Component<Signature> {
  @service declare site: SiteLike;

  // undefined = still loading, null = failed/empty, object = loaded
  @tracked userFields: UserFieldValues = undefined;

  constructor(owner: Owner, args: Signature["Args"]) {
    super(owner, args);

    const username = this.args.post?.username;
    if (!username) {
      this.userFields = null;
      return;
    }

    fetchUserFields(username).then((fields) => {
      if (!this.isDestroying && !this.isDestroyed) {
        this.userFields = fields;
      }
    });
  }

  get links() {
    // Still loading, or nothing to resolve against — render nothing yet.
    if (!this.userFields) {
      return [];
    }

    return profileLinksFor(this.site, this.userFields);
  }

  <template>
    {{#if this.links.length}}
      <div class="custom-profile-links-post">
        {{#each this.links as |link|}}
          <ProfileLinkRow
            @link={{link}}
            class="custom-profile-link-post-item"
          />
        {{/each}}
      </div>
    {{/if}}
  </template>
}
