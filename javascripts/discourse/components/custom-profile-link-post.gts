import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { service } from "@ember/service";
import { postUserFieldSource } from "../lib/post-user-field-source";
import type { UserFieldValues } from "../lib/profile-links";
import { profileLinksFor, type SiteLike } from "../lib/profile-links-config";
import ProfileLinkRow from "./profile-link-row";

interface Signature {
  Args: {
    post?: { username?: string };
  };
}

export default class CustomProfileLinkPost extends Component<Signature> {
  @service declare site: SiteLike;

  // The completed lookup, tagged with the author it was for. Tagging it is what
  // makes a recycled component correct: when the post underneath changes to a
  // different author, this no longer matches and the previous author's Profile
  // Links stop rendering immediately, rather than waiting for the new lookup.
  @tracked
  completedLookup: {
    username: string;
    userFields: UserFieldValues;
  } | null = null;

  // Not tracked: it exists only to stop the getter re-requesting a lookup that
  // is already under way, and nothing renders from it.
  requestedUsername: string | null = null;

  /**
   * The author's Custom User Field values: null when there is no author or the
   * lookup found nothing, undefined while a lookup is in flight. Starting a
   * lookup from the getter is what makes this react to the post changing —
   * a Glimmer component's constructor runs once, but its args do not.
   */
  get userFields(): UserFieldValues {
    const username = this.args.post?.username;
    if (!username) {
      return null;
    }

    if (this.completedLookup?.username === username) {
      return this.completedLookup.userFields;
    }

    this.startLookup(username);
    return undefined;
  }

  async startLookup(username: string) {
    if (this.requestedUsername === username) {
      return;
    }
    this.requestedUsername = username;

    const outcome = await postUserFieldSource.lookup(username);

    if (this.isDestroying || this.isDestroyed) {
      return;
    }

    // The post may have changed under this component while the lookup was in
    // flight. Its result belongs to the author it was requested for, so drop it
    // unless that is still who this post is by.
    //
    // A failed lookup is dropped too. The source does not cache one, so storing
    // its empty result here would be the only thing making a network blip
    // permanent — the author's Profile Links would stay hidden until reload.
    if (this.args.post?.username !== username || !outcome.ok) {
      // Nothing was stored for this author, so the guard above must not keep
      // refusing to look them up. Clearing it is what lets the next render try
      // again — including when the post cycles back to an author whose result
      // was dropped for arriving late.
      this.requestedUsername = null;
      return;
    }

    this.completedLookup = { username, userFields: outcome.userFields };
  }

  get links() {
    const userFields = this.userFields;

    // Nothing resolved, or nothing to resolve against yet. Rendering nothing
    // while a lookup is in flight keeps Profile Links from flashing in and
    // rearranging the post.
    if (!userFields) {
      return [];
    }

    return profileLinksFor(this.site, userFields);
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
