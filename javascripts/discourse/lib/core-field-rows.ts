// Which of Discourse core's Custom User Field rows a Link Surface replaces.
//
// Core renders every field marked "show on profile" / "show on user card" as
// plain text. Where a Profile Link resolved for that same value, the plain text
// and the link read as a duplicate, so core's row is hidden. This module owns
// the matching rule — which row belongs to which field — and nothing else: it
// takes plain class-name lists, so the unit tests in spec/unit drive it with no
// DOM. The modifier in ../modifiers/hide-core-field-rows.ts supplies the rows.

/** Core's base class, on every public user field row on both Link Surfaces. */
const ROW_CLASS = "public-user-field";

/** Anything with class names — in practice an element's `classList`. */
export interface CoreFieldRow {
  classNames: readonly string[];
}

/**
 * The names among `dasherizedFieldNames` that pick out exactly one Custom User
 * Field in core's markup, given the dasherized name of every field core knows
 * about in `allDasherizedSiteNames`. A name that does not is dropped, and its
 * caller leaves core's row alone.
 *
 * Dasherizing is lossy in two ways, and both end here. "Sleep Apnea" and
 * "sleep-apnea" are two different Custom User Fields that core tags with the
 * same class, so a row carrying it could belong to either. And a field named
 * "Public User Field" dasherizes onto the class core puts on *every* row.
 *
 * In both cases, hiding on the class would take the plain text of a field with
 * no Profile Link off the profile along with the one that has it. Core exposes
 * no field id in the markup, so neither can be resolved — the name is dropped
 * and the duplicate stays visible. Showing a value twice is a blemish; silently
 * deleting one is data loss.
 */
export function usableDasherizedNames(
  dasherizedFieldNames: readonly string[],
  allDasherizedSiteNames: readonly string[]
): string[] {
  const seen = new Set<string>();
  const unusable = new Set<string>([ROW_CLASS]);

  for (const name of allDasherizedSiteNames) {
    if (seen.has(name)) {
      unusable.add(name);
    }
    seen.add(name);
  }

  return dasherizedFieldNames.filter((name) => name && !unusable.has(name));
}

/**
 * The rows among `rows` that belong to one of `dasherizedFieldNames`.
 *
 * Core tags a row with the field's dasherized name, but the two Link Surfaces
 * spell it differently — the profile uses the bare name, the user card prefixes
 * it. Both spellings are matched here so callers do not have to care which
 * surface they are on.
 *
 *   profile   <div class="public-user-field machine">
 *   user card <div class="public-user-field public-user-field__machine">
 *
 * Names must already be dasherized, by the same `dasherize` core itself uses —
 * see the modifier. Passing raw field names silently matches nothing.
 */
export function coreRowsToHide<T extends CoreFieldRow>(
  rows: readonly T[],
  dasherizedFieldNames: readonly string[]
): T[] {
  const wanted = new Set<string>();

  for (const name of dasherizedFieldNames) {
    // A blank name would match core's base class or nothing useful, and a field
    // actually named "Public User Field" dasherizes onto the base class itself.
    // Either would hide every row on the page, so neither is allowed through.
    if (!name || name === ROW_CLASS) {
      continue;
    }

    wanted.add(name);
    wanted.add(`${ROW_CLASS}__${name}`);
  }

  if (wanted.size === 0) {
    return [];
  }

  return rows.filter((row) => row.classNames.some((name) => wanted.has(name)));
}
