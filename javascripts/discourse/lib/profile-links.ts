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
  mappings?: RawMapping[] | null;
}

/** The slice of the theme settings this component reads. */
export interface ThemeSettings {
  profile_link_fields?: RawFieldMapping[] | null;
}

/**
 * A Field Mapping joined to its Custom User Field's integer id, with its
 * Mappings indexed for lookup. A Map rather than an object so that a value
 * like "constructor" resolves normally.
 */
export interface FieldMapping {
  fieldName: string;
  fieldId: number;
  urlsByValue: Map<string, string>;
}

/** Something wrong with the configuration itself, reported rather than thrown. */
export type ConfigProblem =
  | { kind: "missing-user-field-name" }
  | { kind: "unknown-user-field"; fieldName: string }
  | { kind: "no-mappings"; fieldName: string }
  | { kind: "duplicate-value"; fieldName: string; value: string }
  | { kind: "incomplete-mapping"; fieldName: string };

export interface LinkConfig {
  fieldMappings: FieldMapping[];
  problems: ConfigProblem[];
}

/** A user's stored Custom User Field values, keyed by field id. */
export type UserFieldValues = Record<string, unknown> | null | undefined;

/** A Profile Link ready to render. */
export interface ProfileLink {
  fieldName: string;
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

    fieldMappings.push({ fieldName, fieldId: siteUserField.id, urlsByValue });
  }

  return { fieldMappings, problems };
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
    const rawValue = userFields[fieldMapping.fieldId];
    if (typeof rawValue !== "string") {
      continue;
    }

    const value = rawValue.trim();
    if (!value) {
      continue;
    }

    const url = fieldMapping.urlsByValue.get(value);
    if (url === undefined) {
      unmatched.push({ fieldName: fieldMapping.fieldName, value });
      continue;
    }

    links.push({ fieldName: fieldMapping.fieldName, value, url });
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
  }
}
