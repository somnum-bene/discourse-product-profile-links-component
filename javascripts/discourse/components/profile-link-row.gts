import type { TOC } from "@ember/component/template-only";
import type { ProfileLink } from "../lib/profile-links";

// The one row shared by all three Link Surfaces. Only the row is shared — each
// surface keeps its own wrapper, whose class names core CSS targets directly.
// See ADR-0004.
const ProfileLinkRow: TOC<{
  Element: HTMLDivElement;
  Args: { link: ProfileLink };
}> = <template>
  <div ...attributes>
    <span class="profile-link-field-name">{{@link.fieldName}}:</span>
    <a
      href={{@link.url}}
      target="_blank"
      rel="noopener noreferrer"
    >{{@link.value}}</a>
  </div>
</template>;

export default ProfileLinkRow;
