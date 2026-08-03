// Converts the flat pre-structured settings into `profile_link_fields`.
//
// A Field Mapping used to be spread across two settings joined only by
// position: `custom_profile_link_user_field_ids` held a "|"-delimited list of
// Custom User Field names, and `custom_profile_link_csv_{n}` held the Mappings
// for the nth name, one "value,url" line each. There were ten CSV slots, so a
// site with an eleventh Custom User Field had nowhere to put it.
//
// Without this migration an installation that updates the component loses every
// Profile Link it had configured. Discourse discards the stored value of a
// setting that no longer appears in settings.yml, so the old keys would go and
// `profile_link_fields` would come up empty — rendering nothing, on every Link
// Surface, with no Config Problem to explain it.
//
// Discourse passes in only the settings an administrator has overridden and
// runs this once per installation, so a fresh install arrives here with an
// empty Map and leaves with one.

const FIELD_NAMES_SETTING = "custom_profile_link_user_field_ids";
const DEBUG_MODE_SETTING = "custom_profile_link_debug_mode";

/** How many CSV slots the flat settings offered. */
const CSV_SLOTS = 10;

/** The name of the CSV setting that held the Mappings for the nth name. */
function csvSetting(index) {
  return `custom_profile_link_csv_${index + 1}`;
}

/**
 * The configured Custom User Field names, in the order that indexed the CSV
 * slots. The list setting stores them "|"-delimited.
 */
function fieldNames(settings) {
  const raw = settings.get(FIELD_NAMES_SETTING);
  if (typeof raw !== "string") {
    return [];
  }

  return raw
    .split("|")
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * The Mappings held in one CSV slot. Each line is `value,url`, split on the
 * first comma so that a value containing one survives — which is how the old
 * code read them, so a migrated site resolves the same Profile Links it did
 * before. A line with no comma configured nothing and is dropped.
 *
 * The flat settings were plain strings and validated nothing, so they could
 * hold a `url` that the new setting's schema refuses — it declares
 * `validations: url: true`, which Discourse checks with `UrlHelper.is_valid_url?`.
 * A refused Mapping is dropped rather than written, because the alternative is
 * an entire `profile_link_fields` value that fails validation: that would sink
 * the whole conversion, and every other Field Mapping with it, over one bad
 * line. `isValidUrl` is the same check the schema will apply, handed to
 * migrations by Discourse for exactly this, so the judgement here and the
 * judgement there cannot disagree. `migrate` refuses to run at all without it,
 * so it is a function by the time this is reached.
 *
 * A Mapping with a blank URL goes the same way. The old parser rendered it as
 * an empty link; the new schema marks `url` required, so it cannot be carried
 * over in any form.
 */
function mappings(csv, isValidUrl) {
  if (typeof csv !== "string") {
    return [];
  }

  const parsed = [];

  for (const line of csv.split(/\r?\n/)) {
    const comma = line.indexOf(",");
    if (comma === -1) {
      continue;
    }

    const value = line.slice(0, comma).trim();
    const url = line.slice(comma + 1).trim();
    if (!value || !url) {
      continue;
    }

    if (!isValidUrl(url)) {
      continue;
    }

    parsed.push({ value, url });
  }

  return parsed;
}

export default function migrate(settings, helpers) {
  const names = fieldNames(settings);

  // Refusing to run is the safe failure here, and the only recoverable one.
  // Discourse aborts the update when a migration throws and does not record it
  // as having run, so the flat settings survive untouched and a corrected
  // version of this file will migrate them later. Converting without the check
  // has no way back: it could write a URL the schema refuses, invalidating the
  // whole setting, after the settings it was converting from are already gone.
  if (names.length && typeof helpers?.isValidUrl !== "function") {
    throw new Error(
      "Cannot convert Profile Links settings: Discourse did not provide the isValidUrl migration helper, so the URLs in the old CSV settings cannot be checked against the new setting's schema. The old settings have been left as they are."
    );
  }

  const isValidUrl = (url) => helpers.isValidUrl(url);

  if (names.length) {
    // Every configured name is carried over, including one past the tenth slot
    // and one whose slot was empty. Both resolved no Profile Links before and
    // still resolve none, but dropping them here would silently discard part of
    // an administrator's configuration — the failure this migration exists to
    // prevent. Carried over, they instead surface as a Config Problem.
    settings.set(
      "profile_link_fields",
      names.map((name, index) => ({
        user_field_name: name,
        mappings:
          index < CSV_SLOTS
            ? mappings(settings.get(csvSetting(index)), isValidUrl)
            : [],
      }))
    );
  }

  if (settings.has(DEBUG_MODE_SETTING)) {
    settings.set("profile_link_debug_mode", settings.get(DEBUG_MODE_SETTING));
  }

  settings.delete(FIELD_NAMES_SETTING);
  settings.delete(DEBUG_MODE_SETTING);
  for (let index = 0; index < CSV_SLOTS; index++) {
    settings.delete(csvSetting(index));
  }

  return settings;
}
