// Pure resolution of Field Mappings into Profile Links.
//
// Nothing in this module reaches for the ambient `settings` global, Ember, or
// Discourse — it takes plain data and returns plain data, so the unit tests in
// spec/unit drive it directly. Problems are returned as data and never logged
// or thrown from here; reporting them is the caller's job.

/** A Custom User Field as the site exposes it: named, but keyed by integer id. */
export interface SiteUserField {
  id: number;
  name: string;
}

/** One value-to-URL Mapping, exactly as the theme setting delivers it. */
export interface RawMapping {
  value?: string | null;
  url?: string | null;
}

/** One Field Mapping, exactly as the theme setting delivers it. */
export interface RawFieldMapping {
  user_field_name?: string | null;
  /**
   * The Shadow Field this Managed Field falls back to, named rather than keyed
   * for the same reason `user_field_name` is: a site's integer ids are its own.
   * Optional — a Field Mapping without one simply has no fallback.
   */
  shadow_user_field_name?: string | null;
  mappings?: RawMapping[] | null;
}

/** The slice of the theme settings this component reads. */
export interface ThemeSettings {
  profile_link_fields?: RawFieldMapping[] | null;
}

/**
 * A Shadow Field joined to its integer id: the `text`-typed Custom User Field a
 * Field Mapping reads when the Managed Field it shadows holds nothing.
 *
 * Name and id travel together rather than as two optional properties on
 * `FieldMapping`, so "either both or neither" is a fact about the type instead
 * of an invariant every reader has to keep. The name is needed as well as the
 * id because a Link Surface hides core's plain-text row by field name, and
 * under a fallback that row belongs to the Shadow Field.
 */
export interface ShadowField {
  name: string;
  id: number;
}

/**
 * A Field Mapping joined to its Custom User Field's integer id, with its
 * Mappings indexed for lookup. A Map rather than an object so that a value
 * like "constructor" resolves normally.
 */
export interface FieldMapping {
  fieldName: string;
  fieldId: number;
  /** Absent unless the setting names a Shadow Field the site actually has. */
  shadow?: ShadowField;
  urlsByValue: Map<string, string>;
}

/** Something wrong with the configuration itself, reported rather than thrown. */
export type ConfigProblem =
  | { kind: "missing-user-field-name" }
  | { kind: "unknown-user-field"; fieldName: string }
  | { kind: "no-mappings"; fieldName: string }
  | { kind: "duplicate-value"; fieldName: string; value: string }
  | { kind: "incomplete-mapping"; fieldName: string }
  | {
      kind: "unknown-shadow-user-field";
      fieldName: string;
      shadowFieldName: string;
    }
  | { kind: "shadow-field-is-its-own-field"; fieldName: string };

export interface LinkConfig {
  fieldMappings: FieldMapping[];
  problems: ConfigProblem[];
}

/** A user's stored Custom User Field values, keyed by field id. */
export type UserFieldValues = Record<string, unknown> | null | undefined;

/** A Profile Link ready to render. */
export interface ProfileLink {
  /**
   * The Managed Field this link belongs to, and the label the row carries. It
   * stays the Managed Field's name under a fallback: a fallback changes where
   * a value came from, never which link it is (ADR-0026).
   */
  fieldName: string;
  /**
   * The Custom User Field the value was actually read from — `fieldName`
   * itself, or the Shadow Field's name when the fallback fired. A Link Surface
   * hides core's plain-text row for this field, because this is the field whose
   * row core rendered.
   */
  valueFieldName: string;
  value: string;
  url: string;
}

/** A field value the user holds that no Mapping covers. Not a Config Problem. */
export interface UnmatchedValue {
  fieldName: string;
  value: string;
}

export interface ResolvedProfileLinks {
  links: ProfileLink[];
  unmatched: UnmatchedValue[];
}

function trimmed(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Joins the theme settings with the site's Custom User Fields, once, into the
 * configuration the resolver consumes. The name-to-id join lives here rather
 * than in the Link Surfaces so it happens once per page load — see ADR-0002.
 */
export function readLinkConfig(
  settings: ThemeSettings,
  siteUserFields: SiteUserField[]
): LinkConfig {
  const fieldMappings: FieldMapping[] = [];
  const problems: ConfigProblem[] = [];

  // Indexed once rather than searched per Field Mapping: a site may define many
  // Custom User Fields, and this runs on every page load.
  const siteUserFieldsByName = new Map<string, SiteUserField>();
  for (const field of siteUserFields ?? []) {
    if (field?.name && !siteUserFieldsByName.has(field.name)) {
      siteUserFieldsByName.set(field.name, field);
    }
  }

  for (const rawField of settings?.profile_link_fields ?? []) {
    const fieldName = trimmed(rawField?.user_field_name);
    if (!fieldName) {
      problems.push({ kind: "missing-user-field-name" });
      continue;
    }

    const siteUserField = siteUserFieldsByName.get(fieldName);
    if (!siteUserField) {
      problems.push({ kind: "unknown-user-field", fieldName });
      continue;
    }

    const urlsByValue = new Map<string, string>();
    for (const rawMapping of rawField?.mappings ?? []) {
      const value = trimmed(rawMapping?.value);
      const url = trimmed(rawMapping?.url);
      if (!value || !url) {
        problems.push({ kind: "incomplete-mapping", fieldName });
        continue;
      }
      if (urlsByValue.has(value)) {
        problems.push({ kind: "duplicate-value", fieldName, value });
        continue;
      }
      urlsByValue.set(value, url);
    }

    if (urlsByValue.size === 0) {
      problems.push({ kind: "no-mappings", fieldName });
      continue;
    }

    const fieldMapping: FieldMapping = {
      fieldName,
      fieldId: siteUserField.id,
      urlsByValue,
    };

    // Resolved after the Mappings rather than before, so a Field Mapping that
    // is being dropped anyway does not also report a fault about its fallback.
    const shadow = readShadowField(rawField, fieldName, siteUserFieldsByName);
    if (shadow.kind === "one") {
      fieldMapping.shadow = shadow.field;
    } else if (shadow.kind === "problem") {
      problems.push(shadow.problem);
    }

    fieldMappings.push(fieldMapping);
  }

  return { fieldMappings, problems };
}

/**
 * Joins one Field Mapping's Shadow Field, if it names one the site has.
 *
 * Three outcomes rather than two, and the third is the point: a named Shadow
 * Field the site does not define is reported and the Field Mapping ships
 * without a fallback. Dropping the Field Mapping instead would take every
 * Profile Link off the site to protect the one case where the Managed Field is
 * empty — the cure doing more damage than the disease it is for.
 */
function readShadowField(
  rawField: RawFieldMapping | null | undefined,
  fieldName: string,
  siteUserFieldsByName: Map<string, SiteUserField>
):
  | { kind: "one"; field: ShadowField }
  | { kind: "none" }
  | { kind: "problem"; problem: ConfigProblem } {
  const shadowFieldName = trimmed(rawField?.shadow_user_field_name);

  // Absent and blank are one intention — no fallback — and the objects editor
  // writes an empty string for a property nobody filled in.
  if (!shadowFieldName) {
    return { kind: "none" };
  }

  // A Field Mapping shadowing itself would read the same value twice and mean
  // nothing, so it is a typo rather than a configuration, and saying so is
  // cheaper than leaving it to look like a fallback that never fires.
  if (shadowFieldName === fieldName) {
    return {
      kind: "problem",
      problem: { kind: "shadow-field-is-its-own-field", fieldName },
    };
  }

  const siteUserField = siteUserFieldsByName.get(shadowFieldName);
  if (!siteUserField) {
    return {
      kind: "problem",
      problem: {
        kind: "unknown-shadow-user-field",
        fieldName,
        shadowFieldName,
      },
    };
  }

  return {
    kind: "one",
    field: { name: shadowFieldName, id: siteUserField.id },
  };
}

/**
 * The value one Field Mapping resolves against, and the Custom User Field it
 * came from. The Managed Field is read first and wins whenever it holds
 * anything at all — including a value no Mapping covers.
 *
 * That last part is deliberate. An Unmatched Value is a value the User holds
 * now; the Shadow Field holds what the migration wrote, which a User cannot
 * edit and so cannot correct. Falling back over an Unmatched Value would
 * replace what somebody owns with what they used to own, and link it. The
 * fallback fires on an empty Managed Field and nothing else, which is exactly
 * the state the #58 wipe leaves behind.
 */
function valueFor(
  userFields: Record<string, unknown>,
  fieldMapping: FieldMapping
): { value: string; valueFieldName: string } | null {
  const own = trimmed(stringOrNull(userFields[fieldMapping.fieldId]));
  if (own) {
    return { value: own, valueFieldName: fieldMapping.fieldName };
  }

  const shadow = fieldMapping.shadow;
  if (!shadow) {
    return null;
  }

  const held = trimmed(stringOrNull(userFields[shadow.id]));
  return held ? { value: held, valueFieldName: shadow.name } : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Turns one user's Custom User Field values into their Profile Links, in the
 * order the administrator configured the Field Mappings. Always returns an
 * array — an empty one when nothing resolves.
 */
export function resolveProfileLinks(
  config: LinkConfig,
  userFields: UserFieldValues
): ResolvedProfileLinks {
  const links: ProfileLink[] = [];
  const unmatched: UnmatchedValue[] = [];

  if (!userFields) {
    return { links, unmatched };
  }

  for (const fieldMapping of config.fieldMappings) {
    const held = valueFor(userFields, fieldMapping);
    if (!held) {
      continue;
    }

    const { value, valueFieldName } = held;
    const url = fieldMapping.urlsByValue.get(value);
    if (url === undefined) {
      // Reported against the Managed Field, whichever field the value sat in:
      // the slot is what an administrator reading the console is looking for.
      unmatched.push({ fieldName: fieldMapping.fieldName, value });
      continue;
    }

    links.push({
      fieldName: fieldMapping.fieldName,
      valueFieldName,
      value,
      url,
    });
  }

  return { links, unmatched };
}

/** Renders a Config Problem as the sentence an administrator sees. */
export function describeConfigProblem(problem: ConfigProblem): string {
  switch (problem.kind) {
    case "missing-user-field-name":
      return "A Field Mapping names no Custom User Field and was ignored.";
    case "unknown-user-field":
      return `No Custom User Field named "${problem.fieldName}" exists on this site, so its Field Mapping was ignored.`;
    case "no-mappings":
      return `The Field Mapping for "${problem.fieldName}" has no usable Mappings and was ignored.`;
    case "duplicate-value":
      return `The Field Mapping for "${problem.fieldName}" maps the value "${problem.value}" more than once; the first Mapping wins.`;
    case "incomplete-mapping":
      return `The Field Mapping for "${problem.fieldName}" has a Mapping with a blank value or URL, which was ignored.`;
    case "unknown-shadow-user-field":
      return `No Custom User Field named "${problem.shadowFieldName}" exists on this site, so "${problem.fieldName}" has no Shadow Field to fall back to and a discontinued value cleared from it will show nothing.`;
    case "shadow-field-is-its-own-field":
      return `The Field Mapping for "${problem.fieldName}" names itself as its own Shadow Field, which can never fall back to anything, so it was ignored.`;
  }
}
