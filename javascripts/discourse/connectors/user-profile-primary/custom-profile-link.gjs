import Component from "@glimmer/component";
import { service } from "@ember/service";

export default class CustomProfileLink extends Component {
  @service site;

  get links() {
    if (settings.custom_profile_link_debug_mode)
      console.debug("[Custom Profile Link] Settings dump follows", settings);
    const fieldNames = settings.custom_profile_link_user_field_ids
      .split(/\|/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
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
    if (settings.custom_profile_link_debug_mode)
      console.debug(
        "[Custom Profile Link] Field names:",
        fieldNames,
        "Site user fields:",
        siteUserFields
      );
    if (settings.custom_profile_link_debug_mode)
      console.debug("[Custom Profile Link] args dump:", this.args.outletArgs);
    const userFields = this.args.outletArgs.model.get("user_fields");
    if (!userFields) {
      console.warn(
        `[Custom Profile Link] User Profile missing "user_fields"! Raw user dump follows.`,
        this.args.outletArgs.model
      );
      return undefined;
    }
    let links = [];
    for (let i = 0; i < fieldNames.length; i++) {
      const siteField = siteUserFields.find((f) => f.name === fieldNames[i]);
      if (!siteField) {
        if (settings.custom_profile_link_debug_mode)
          console.debug(
            `[Custom Profile Link] No site field found with name "${fieldNames[i]}"`
          );
        continue;
      }
      const fieldValue = userFields[siteField.id];
      if (!fieldValue) {
        if (settings.custom_profile_link_debug_mode)
          console.debug(
            `[Custom Profile Link] User field "${fieldNames[i]}" (id: ${siteField.id}) has no value. user_fields dump follows.`,
            userFields
          );
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
          `[Custom Profile Link] No CSV match for field "${fieldNames[i]}" value "${fieldValue}"`
        );
      }
    }
    if (settings.custom_profile_link_debug_mode)
      console.debug("[Custom Profile Link] links built, dump:", links);
    return links.length ? links : undefined;
  }

  <template>
    {{#if this.links}}
      <div class="public-user-fields">
        <div class="public-user-field">
          {{#each this.links as |link|}}
            <div class="user-field-value">
              <span class="profile-link-field-value">{{link.[0]}}:</span>
              <a href="{{link.[2]}}" target="_blank">{{link.[1]}}</a>
            </div>
          {{/each}}
        </div>
      </div>
    {{/if}}
  </template>
}
