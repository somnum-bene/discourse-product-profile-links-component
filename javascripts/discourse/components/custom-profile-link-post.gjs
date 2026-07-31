import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { service } from "@ember/service";
import { ajax } from "discourse/lib/ajax";

// Module-level cache: username → Promise<user_fields object | null>
// Avoids duplicate requests across all posts on the page.
const _userFieldsCache = new Map();

function fetchUserFields(username) {
  if (!_userFieldsCache.has(username)) {
    _userFieldsCache.set(
      username,
      ajax(`/u/${username}/card.json`)
        .then((data) => data.user?.user_fields || null)
        .catch(() => null)
    );
  }
  return _userFieldsCache.get(username);
}

export default class CustomProfileLinkPost extends Component {
  @service site;
  // undefined = still loading, null = failed/empty, object = loaded
  @tracked _userFields = undefined;

  constructor(owner, args) {
    super(owner, args);
    const username = this.args.post?.username;
    if (!username) {
      this._userFields = null;
      return;
    }
    fetchUserFields(username).then((fields) => {
      if (!this.isDestroying && !this.isDestroyed) {
        this._userFields = fields;
        if (settings.custom_profile_link_debug_mode) {
          console.debug(
            `[Custom Profile Link] Loaded user_fields for ${username}:`,
            fields
          );
        }
      }
    });
  }

  get links() {
    // Still loading — render nothing yet
    if (this._userFields === undefined) return undefined;
    if (!this._userFields) return undefined;

    const fieldNames = settings.custom_profile_link_user_field_ids
      .split(/\|/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0);

    if (!fieldNames.length) return undefined;

    const csvMappings = [
      settings.custom_profile_link_csv_1,
      settings.custom_profile_link_csv_2,
      settings.custom_profile_link_csv_3,
      settings.custom_profile_link_csv_4,
      settings.custom_profile_link_csv_5,
      settings.custom_profile_link_csv_6,
      settings.custom_profile_link_csv_7,
      settings.custom_profile_link_csv_8,
      settings.custom_profile_link_csv_9,
      settings.custom_profile_link_csv_10,
    ];

    const siteUserFields = this.site.user_fields || [];
    // user_fields from /card.json uses integer field IDs as keys (same as user-card connector)
    const userFields = this._userFields;

    let links = [];
    for (let i = 0; i < fieldNames.length; i++) {
      const siteField = siteUserFields.find((f) => f.name === fieldNames[i]);
      if (!siteField) {
        if (settings.custom_profile_link_debug_mode) {
          console.debug(
            `[Custom Profile Link] No site field found for "${fieldNames[i]}"`
          );
        }
        continue;
      }

      const fieldValue = userFields[siteField.id];
      if (!fieldValue) {
        if (settings.custom_profile_link_debug_mode) {
          console.debug(
            `[Custom Profile Link] No value for field "${fieldNames[i]}" (id: ${siteField.id})`
          );
        }
        continue;
      }

      const csv = csvMappings[i] || "";
      const rows = csv
        .split(/\r?\n/)
        .map((r) => r.trim())
        .filter((r) => r.length > 0);

      let matched = null;
      for (const row of rows) {
        const commaIdx = row.indexOf(",");
        if (commaIdx === -1) continue;
        const text = row.slice(0, commaIdx).trim();
        const link = row.slice(commaIdx + 1).trim();
        if (text === fieldValue) {
          matched = [text, link];
          break;
        }
      }

      if (matched) {
        links.push([fieldNames[i], matched[0], matched[1]]);
      } else if (settings.custom_profile_link_debug_mode) {
        console.debug(
          `[Custom Profile Link] No CSV match for "${fieldNames[i]}" value "${fieldValue}"`
        );
      }
    }

    if (settings.custom_profile_link_debug_mode) {
      console.debug("[Custom Profile Link] Post links:", links);
    }
    return links.length ? links : undefined;
  }

  <template>
    {{#if this.links}}
      <div class="custom-profile-links-post">
        {{#each this.links as |link|}}
          <div class="custom-profile-link-post-item">
            <span class="profile-link-field-name">{{link.[0]}}:</span>
            <a
              href="{{link.[2]}}"
              target="_blank"
              rel="noopener noreferrer"
            >{{link.[1]}}</a>
          </div>
        {{/each}}
      </div>
    {{/if}}
  </template>
}
