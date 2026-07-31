import Component from "@glimmer/component";
import { service } from "@ember/service";
import ProfileLinkRow from "../../components/profile-link-row";
import { profileLinksFor } from "../../lib/profile-links-config";
import type { SiteLike } from "../../lib/profile-links-config";
import type { UserFieldValues } from "../../lib/profile-links";

interface Signature {
  Args: {
    outletArgs: {
      user?: { get(key: string): unknown };
    };
  };
}

export default class CustomProfileLink extends Component<Signature> {
  @service declare site: SiteLike;

  get links() {
    const userFields = this.args.outletArgs.user?.get(
      "user_fields"
    ) as UserFieldValues;

    return profileLinksFor(this.site, userFields);
  }

  <template>
    {{#if this.links.length}}
      <div class="user-card-metadata-outlet custom-profile-links-links">
        {{#each this.links as |link|}}
          <ProfileLinkRow @link={{link}} class="profile-link" />
        {{/each}}
      </div>
    {{/if}}
  </template>
}
