// The transport half of the Catalogue Apply. `plan-apply.ts` decides what should
// happen to one instance; this file knows how to say it to Discourse and how to
// tell whether Discourse did it.
//
// Those are two files rather than one because the second question turned out to
// have a surprising answer. The update route answers `200 OK` to a write it
// discarded: an empty `options` array arrives at Rails as `nil` and the
// controller skips it, and a list containing the same option twice is silently
// deduplicated. A status code here means "your request was well formed", not
// "the site now holds what you sent" (ADR-0014). So the readback is not a
// belt-and-braces flourish — it is the only thing that reports whether the apply
// happened.
//
// Nothing here opens a socket either. It builds URLs, validates responses,
// assembles payloads, compares what came back against what was asked for, and
// renders all of it for a person. The command around it is a fetch loop.
//
// Credentials never reach this file. The command reads them and puts them in a
// header, so no function that could format a message has ever seen the API key.

import { type FieldMapping, type FieldOptions } from "./build-catalogue.ts";
import { SETTING_NAME } from "./build-settings.ts";
import { type ApplyPlan, type FieldWrite } from "./plan-apply.ts";

/** The one variable that differs between the test and production instances. */
export const BASE_URL_VAR = "DISCOURSE_BASE_URL";
export const API_USERNAME_VAR = "DISCOURSE_API_USERNAME";
export const API_KEY_VAR = "DISCOURSE_API_KEY";

/**
 * Where the field definitions live on Discourse 2026.8. The `/admin/customize/`
 * path the admin UI still shows in its own address bar returns 404 for JSON, so
 * anyone who trusts the UI's URL will conclude the API does not exist.
 */
const USER_FIELDS_PATH = "/admin/config/user_fields";

const THEMES_PATH = "/admin/themes.json";

export class CatalogueApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogueApplyError";
  }
}

/**
 * A Custom User Field exactly as the instance reports it, every key kept.
 *
 * `UserFieldDefinition` in `plan-apply.ts` is deliberately the four keys a
 * decision needs. This is the whole record, because the update route takes a
 * field object rather than a patch and the twelve keys the plan has no opinion
 * about still have to arrive back unharmed.
 */
export interface LiveUserField {
  readonly id: number;
  readonly name: string;
  readonly field_type: string;
  readonly options?: readonly string[] | null;
  readonly [key: string]: unknown;
}

/** The body of one update request. */
export interface UserFieldRequest {
  user_field: Record<string, unknown>;
}

export const REPLACE_FLAG = "--replace";
export const CLEAR_FLAG = "--clear";
export const PLAN_FLAG = "--plan";

export interface ApplyArguments {
  /** Authorises removing an option the catalogue does not carry. */
  replace: boolean;
  /** Fields to empty, named one at a time. */
  clear: string[];
  /** Print the Apply Plan and send no write. */
  planOnly: boolean;
}

/**
 * The command line. `--replace` is the authorisation for a destructive write and
 * `--plan` is the only way to see what it would do without doing it — without
 * that pair, the first time anyone sees the consequences of `--replace` is after
 * they are irreversible.
 */
export function parseApplyArgs(argv: readonly string[]): ApplyArguments {
  const args: ApplyArguments = { replace: false, clear: [], planOnly: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === REPLACE_FLAG) {
      args.replace = true;
      continue;
    }

    if (arg === PLAN_FLAG) {
      args.planOnly = true;
      continue;
    }

    if (arg === CLEAR_FLAG || arg.startsWith(`${CLEAR_FLAG}=`)) {
      const inline = arg.startsWith(`${CLEAR_FLAG}=`)
        ? arg.slice(CLEAR_FLAG.length + 1)
        : argv[(index += 1)];

      if (!inline || inline.startsWith("-")) {
        throw new CatalogueApplyError(
          `${CLEAR_FLAG} needs the name of one Custom User Field, exactly as ` +
            `the instance spells it. Emptying a field is spelled out one field ` +
            `at a time on purpose; there is no flag that clears everything.`
        );
      }

      args.clear.push(inline);
      continue;
    }

    throw new CatalogueApplyError(
      `Unrecognised argument: ${arg}. The arguments are ${REPLACE_FLAG}, ` +
        `${CLEAR_FLAG} <field name>, and ${PLAN_FLAG}.`
    );
  }

  return args;
}

/**
 * The instance to write to, validated before anything is sent to it.
 *
 * The base URL is the entire difference between test and production (ADR-0011),
 * which makes a typo in it the one mistake that writes the right data to the
 * wrong site. `https` is required rather than preferred: the API key travels in a
 * request header, and over `http` it travels in the clear.
 */
export function instanceOrigin(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new CatalogueApplyError(
      `${BASE_URL_VAR} is not a URL: ${JSON.stringify(trimmed)}. It needs the ` +
        `scheme too — "https://example.discourse.group", not ` +
        `"example.discourse.group".`
    );
  }

  if (url.protocol !== "https:") {
    throw new CatalogueApplyError(
      `${BASE_URL_VAR} is ${url.protocol.replace(":", "")}. The API key travels ` +
        `in a request header, so it has to be https.`
    );
  }

  if (url.username || url.password) {
    throw new CatalogueApplyError(
      `${BASE_URL_VAR} carries credentials in the URL. They belong in ` +
        `${API_USERNAME_VAR} and ${API_KEY_VAR}, which go into headers and are ` +
        `never logged.`
    );
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new CatalogueApplyError(
      `${BASE_URL_VAR} should be an origin and nothing more. ` +
        `${JSON.stringify(trimmed)} carries a path, a query or a fragment, and ` +
        `the admin routes are appended to it.`
    );
  }

  return url.origin;
}

export function userFieldsUrl(origin: string): string {
  return `${origin}${USER_FIELDS_PATH}.json`;
}

/**
 * One field's update route. The id is checked because the instance answers a
 * request for a field that does not exist with 500 rather than 404, so a
 * malformed id produces a server error that reads like an outage.
 */
export function userFieldUrl(origin: string, id: number): string {
  if (!Number.isInteger(id) || id <= 0) {
    throw new CatalogueApplyError(
      `A Custom User Field id should be a positive integer. It is ` +
        `${JSON.stringify(id)}.`
    );
  }

  return `${origin}${USER_FIELDS_PATH}/${id}.json`;
}

export function themesUrl(origin: string): string {
  return `${origin}${THEMES_PATH}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * The field definitions, from `{ "user_fields": [...] }`.
 *
 * Every key is kept and only the four the plan reasons about are checked. A
 * response shaped differently from this is refused rather than coerced: the next
 * thing that happens is a destructive write, and a field list read as empty
 * because the envelope changed would look exactly like an instance with nothing
 * configured on it.
 */
export function parseUserFields(body: unknown): LiveUserField[] {
  if (!isRecord(body) || !Array.isArray(body.user_fields)) {
    throw new CatalogueApplyError(
      `The Custom User Fields response should be an object with a ` +
        `"user_fields" array. Reading it as empty would be indistinguishable ` +
        `from an instance that has no fields at all.`
    );
  }

  return body.user_fields.map((entry, index) => {
    const at = `user_fields[${index}]`;

    if (!isRecord(entry)) {
      throw new CatalogueApplyError(`${at} is not an object.`);
    }

    if (typeof entry.id !== "number" || !Number.isInteger(entry.id)) {
      throw new CatalogueApplyError(
        `${at} has no integer id, and the id is how a write addresses it.`
      );
    }

    if (typeof entry.name !== "string" || entry.name === "") {
      throw new CatalogueApplyError(
        `${at} has no name, and the name is how the component finds a field.`
      );
    }

    if (typeof entry.field_type !== "string") {
      throw new CatalogueApplyError(`${at} has no field_type.`);
    }

    if (
      entry.options !== undefined &&
      entry.options !== null &&
      !isStringArray(entry.options)
    ) {
      throw new CatalogueApplyError(
        `${at} ("${entry.name}") reports options that are not a list of ` +
          `strings. Dropdown Options are compared exactly, so a value that is ` +
          `not a string cannot be compared at all.`
      );
    }

    return entry as LiveUserField;
  });
}

/**
 * One field's update body: the record the instance gave us, with the options
 * replaced.
 *
 * Every other key is carried across. Omitted keys were observed to survive an
 * update on 2026.8, so this is not fixing a bug — it is declining to depend on
 * Rails' assignment semantics for the twelve attributes this pipeline has no
 * business having an opinion about. Round-tripping them costs nothing.
 *
 * `id` is dropped because it addresses the field in the URL rather than being an
 * attribute of it.
 */
export function writePayload(
  field: LiveUserField,
  options: readonly string[]
): UserFieldRequest {
  const body: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(field)) {
    if (key === "id" || key === "options") {
      continue;
    }

    body[key] = value;
  }

  body.options = [...options];

  return { user_field: body };
}

/**
 * Why a `clear` write cannot be carried out, whatever the plan says.
 *
 * Five payload shapes were tried against a throwaway field on the test instance.
 * `options: []` is answered `200 OK` and changes nothing, because Rails' own
 * parameter handling turns an empty array into `nil` and the controller skips a
 * nil options list. `options: null` and `options: ""` do the same. `options:
 * [""]` and the form-encoded `user_field[options][]=` both leave the field
 * offering one blank choice, which is a visible option rather than no options.
 * Changing the field type to `text` and back does not destroy them either.
 *
 * So Discourse offers no way to empty a dropdown, and the two things that do
 * reach zero — deleting the field, or changing its type for good — destroy every
 * value Users have already stored and are decisions about the site rather than
 * about the catalogue (ADR-0015). This refuses instead of doing the nearest
 * thing that works.
 */
export const CLEAR_UNSUPPORTED =
  `Discourse offers no way to empty a dropdown's Dropdown Options. The update ` +
  `route answers 200 to an empty options list and changes nothing, and every ` +
  `other payload that was tried leaves the field offering one blank choice. ` +
  `The only ways to reach zero options are deleting the Custom User Field or ` +
  `changing its type, and both destroy every value Users have already stored, ` +
  `so neither is something this command will do on its own. Leave the field ` +
  `alone, or delete it in the admin UI knowing what that costs. ADR-0015 has ` +
  `the whole story.`;

/**
 * The writes this transport cannot carry out. Only `clear` qualifies, and it is
 * checked before the first request so the plan stays all-or-nothing: refusing
 * halfway through would leave a site neither configured nor unconfigured, which
 * is the state `plan-apply.ts` exists to avoid.
 */
export function unsupportedWrites(writes: readonly FieldWrite[]): FieldWrite[] {
  return writes.filter((write) => write.reason === "clear");
}

/** Whether a plan gets carried out, and what to say when it does not. */
export type ApplyDecision =
  | { kind: "proceed" }
  | { kind: "refused"; message: string }
  | { kind: "impossible"; message: string };

/**
 * Whether to send anything at all. It lives here rather than in the command
 * because it is a decision, and a decision inside a shell is a decision nothing
 * checks.
 *
 * It is not what stops a refused plan being half applied — `planApply` already
 * empties the write list when it refuses anything, and that is where the
 * all-or-nothing rule lives. This is what makes a run *say so*: a command that
 * printed refusals and exited zero would be reported as a success by everything
 * watching it.
 */
export function applyDecision(plan: ApplyPlan): ApplyDecision {
  if (plan.refusals.length > 0) {
    return {
      kind: "refused",
      message:
        `${plan.refusals.length} refusal` +
        `${plan.refusals.length === 1 ? "" : "s"}, so nothing was written. A ` +
        `half-configured site is harder to reason about than an unconfigured ` +
        `one, and the operator's next move is the same either way: read what ` +
        `the plan says it would remove. Pass ${REPLACE_FLAG} to authorise it.`,
    };
  }

  const impossible = unsupportedWrites(plan.writes);

  if (impossible.length > 0) {
    return {
      kind: "impossible",
      message: `${impossible
        .map((write) => write.user_field_name)
        .join(", ")}: ${CLEAR_UNSUPPORTED}`,
    };
  }

  return { kind: "proceed" };
}

/** This component as one instance has it installed. */
export interface InstalledComponent {
  id: number;
  name: string;
  /** The Field Mappings the component is actually using. */
  fields: FieldMapping[];
  /** What the checked-out theme shipped, before any admin override. */
  shipped: FieldMapping[];
  /**
   * True when an administrator has saved the setting through the theme settings
   * UI. That freezes this site's Mappings: the setting no longer follows the
   * repository, and a later deployment changes nothing (ADR-0008).
   */
  overridden: boolean;
}

export type ComponentLookup =
  | { kind: "one"; component: InstalledComponent }
  | { kind: "none" }
  | { kind: "many"; components: { id: number; name: string }[] };

/**
 * Finds this component among the instance's themes, by the setting it defines.
 *
 * Identified that way rather than by a theme id in `.env` because the base URL
 * is meant to be the only thing that differs between instances. A theme id is a
 * second per-instance variable that can silently go stale — pointing at a theme
 * that was deleted and recreated, and reporting the wrong site's configuration
 * with complete confidence.
 */
export function findComponent(body: unknown): ComponentLookup {
  if (!isRecord(body) || !Array.isArray(body.themes)) {
    throw new CatalogueApplyError(
      `The themes response should be an object with a "themes" array.`
    );
  }

  const found: InstalledComponent[] = [];

  for (const theme of body.themes) {
    if (!isRecord(theme) || !Array.isArray(theme.settings)) {
      continue;
    }

    const setting = theme.settings.find(
      (entry) => isRecord(entry) && entry.setting === SETTING_NAME
    );

    if (!isRecord(setting)) {
      continue;
    }

    const id = typeof theme.id === "number" ? theme.id : 0;
    const name = typeof theme.name === "string" ? theme.name : "(unnamed)";
    const fields = fieldMappingsFrom(setting.value, `${name} value`);
    const shipped = fieldMappingsFrom(setting.default, `${name} default`);

    found.push({
      id,
      name,
      fields,
      shipped,
      overridden: JSON.stringify(fields) !== JSON.stringify(shipped),
    });
  }

  if (found.length === 0) {
    return { kind: "none" };
  }

  if (found.length > 1) {
    return {
      kind: "many",
      components: found.map((component) => ({
        id: component.id,
        name: component.name,
      })),
    };
  }

  return { kind: "one", component: found[0] };
}

/**
 * A `profile_link_fields` value as the instance reports it. A malformed entry is
 * refused rather than skipped, because a Field Mapping quietly dropped here
 * would be reported as a Mapping the instance is missing, and the remedy for
 * that ("deploy the theme") is not the remedy for this.
 */
function fieldMappingsFrom(value: unknown, where: string): FieldMapping[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new CatalogueApplyError(
      `The ${SETTING_NAME} ${where} is not a list of Field Mappings.`
    );
  }

  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.user_field_name !== "string") {
      throw new CatalogueApplyError(
        `The ${SETTING_NAME} ${where} has no user_field_name at index ${index}.`
      );
    }

    const mappings = Array.isArray(entry.mappings) ? entry.mappings : [];

    return {
      user_field_name: entry.user_field_name,
      mappings: mappings.map((mapping, at) => {
        if (
          !isRecord(mapping) ||
          typeof mapping.value !== "string" ||
          typeof mapping.url !== "string"
        ) {
          throw new CatalogueApplyError(
            `The ${SETTING_NAME} ${where} has a Mapping without a value and a ` +
              `url, at "${entry.user_field_name}" index ${at}.`
          );
        }

        return { value: mapping.value, url: mapping.url };
      }),
    };
  });
}

/** One difference between what an instance's component has and what shipped. */
export interface DriftNote {
  user_field_name: string;
  detail: string;
}

/**
 * How the Mappings on the instance differ from the Mappings in the checked-out
 * catalogue — the drift generating both sinks from one file cannot prevent
 * (ADR-0011). They land at different times by different mechanisms, so a
 * deployment that has not happened yet, or an admin override, pulls them apart
 * with every test still passing.
 *
 * This is the comparison the ticket asked for as a digest check. A digest is not
 * available: the catalogue digest is a comment in `settings.yml`, and comments do
 * not reach an instance. So the instance is asked what Mappings it actually has,
 * which is what the digest was standing in for and strictly more informative
 * (ADR-0014).
 */
export function componentDrift(
  live: readonly FieldMapping[],
  shipped: readonly FieldMapping[]
): DriftNote[] {
  const notes: DriftNote[] = [];

  for (const expected of shipped) {
    const actual = live.find(
      (field) => field.user_field_name === expected.user_field_name
    );

    if (!actual) {
      notes.push({
        user_field_name: expected.user_field_name,
        detail:
          `The component on this instance carries no Mappings for ` +
          `"${expected.user_field_name}", and the checked-out catalogue has ` +
          `${expected.mappings.length}. Every Dropdown Option written for it ` +
          `would be an Unmatched Value: the User picks their equipment, no ` +
          `Profile Link appears, and nothing is logged unless Debug Mode is on.`,
      });
      continue;
    }

    const liveValues = new Map(
      actual.mappings.map((mapping) => [mapping.value, mapping.url])
    );
    const missing = expected.mappings.filter(
      (mapping) => !liveValues.has(mapping.value)
    );
    const different = expected.mappings.filter((mapping) => {
      const url = liveValues.get(mapping.value);

      return url !== undefined && url !== mapping.url;
    });
    const expectedValues = new Set(
      expected.mappings.map((mapping) => mapping.value)
    );
    const extra = actual.mappings.filter(
      (mapping) => !expectedValues.has(mapping.value)
    );

    if (missing.length === 0 && different.length === 0 && extra.length === 0) {
      continue;
    }

    const parts: string[] = [];

    if (missing.length > 0) {
      parts.push(
        `${missing.length} Mapping${missing.length === 1 ? "" : "s"} the ` +
          `instance does not have (${listed(missing.map((m) => m.value))})`
      );
    }

    if (extra.length > 0) {
      parts.push(
        `${extra.length} the instance has and the catalogue does not ` +
          `(${listed(extra.map((m) => m.value))})`
      );
    }

    if (different.length > 0) {
      parts.push(
        `${different.length} pointing somewhere else ` +
          `(${listed(different.map((m) => m.value))})`
      );
    }

    notes.push({
      user_field_name: expected.user_field_name,
      detail:
        `"${expected.user_field_name}": the instance has ` +
        `${actual.mappings.length} Mappings and the checked-out catalogue has ` +
        `${expected.mappings.length} — ${parts.join(", ")}.`,
    });
  }

  for (const actual of live) {
    if (
      shipped.some((field) => field.user_field_name === actual.user_field_name)
    ) {
      continue;
    }

    notes.push({
      user_field_name: actual.user_field_name,
      detail:
        `The component on this instance carries ${actual.mappings.length} ` +
        `Mappings for "${actual.user_field_name}" and the checked-out ` +
        `catalogue has none. This command does not touch that field.`,
    });
  }

  return notes;
}

/** One field whose live Dropdown Options are not what the plan asked for. */
export interface ReadbackMismatch {
  user_field_name: string;
  expected: string[];
  /** Null when the field is gone, or when two fields answer to the name. */
  actual: string[] | null;
  detail: string;
}

/**
 * What the instance holds after the writes, against what the catalogue says it
 * should hold.
 *
 * Every field the catalogue covers is checked, not only the ones written, so the
 * report describes the site rather than the run. And it is checked by rereading
 * the instance rather than by trusting the update responses, because the update
 * route answers 200 to writes it discards (ADR-0014) — a run can be entirely
 * green and have changed nothing at all.
 */
export function readbackMismatches(
  after: readonly LiveUserField[],
  targets: readonly FieldOptions[]
): ReadbackMismatch[] {
  const mismatches: ReadbackMismatch[] = [];

  for (const target of targets) {
    const matches = after.filter(
      (field) => field.name === target.user_field_name
    );

    if (matches.length !== 1) {
      mismatches.push({
        user_field_name: target.user_field_name,
        expected: [...target.options],
        actual: null,
        detail:
          matches.length === 0
            ? `"${target.user_field_name}" is not on the instance any more.`
            : `${matches.length} Custom User Fields answer to ` +
              `"${target.user_field_name}", so there is no single option list ` +
              `to check.`,
      });
      continue;
    }

    const actual = [...(matches[0].options ?? [])];

    if (
      actual.length === target.options.length &&
      actual.every((option, index) => option === target.options[index])
    ) {
      continue;
    }

    const missing = target.options.filter((option) => !actual.includes(option));
    const extra = actual.filter((option) => !target.options.includes(option));

    mismatches.push({
      user_field_name: target.user_field_name,
      expected: [...target.options],
      actual,
      detail:
        `"${target.user_field_name}" holds ${actual.length} option` +
        `${actual.length === 1 ? "" : "s"} and the catalogue calls for ` +
        `${target.options.length}` +
        (missing.length > 0
          ? `, missing ${listed(missing)}`
          : extra.length > 0
            ? `, still offering ${listed(extra)}`
            : `, in a different order`) +
        `. The instance accepted the write and did something else with it: an ` +
        `empty list is ignored outright and a repeated option is silently ` +
        `dropped, so a 200 is not confirmation.`,
    });
  }

  return mismatches;
}

function listed(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

/**
 * The Apply Plan, for a person about to authorise it. Refusals first, because
 * one of them is the reason none of the writes will happen.
 *
 * `added` and `removed` are printed in full and never summarised to a count.
 * They are the two lists someone is being asked to approve, and a count is not
 * something anyone can approve.
 */
export function renderPlan(plan: ApplyPlan): string {
  const lines: string[] = [];

  for (const refusal of plan.refusals) {
    lines.push(`REFUSED ${refusal.user_field_name} (${refusal.reason})`);
    lines.push(`  ${refusal.detail}`);

    for (const removal of refusal.removes) {
      lines.push(
        removal.sameProductAs === null
          ? `  - "${removal.option}"`
          : `  - "${removal.option}" — probably the instance's spelling of ` +
              `"${removal.sameProductAs}"`
      );
    }
  }

  for (const write of plan.writes) {
    lines.push(
      `${write.reason.toUpperCase()} ${write.user_field_name} ` +
        `(id ${write.id}): ${write.before.length} option` +
        `${write.before.length === 1 ? "" : "s"} -> ${write.after.length}`
    );

    for (const option of write.removed) {
      lines.push(`  - "${option}"`);
    }

    for (const option of write.added) {
      lines.push(`  + "${option}"`);
    }

    if (write.added.length === 0 && write.removed.length === 0) {
      lines.push(`  the same options in a different order`);
    }
  }

  for (const warning of plan.warnings) {
    lines.push(`WARNING ${warning.user_field_name}`);
    lines.push(`  ${warning.detail}`);
  }

  for (const name of plan.unchanged) {
    lines.push(`UNCHANGED ${name} — already holds exactly the right options`);
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * The instance's own copy of the component, and how far it is from the catalogue
 * about to be pushed. A component that is not installed is worth saying out
 * loud: the Dropdown Options would be written correctly and resolve to nothing.
 */
export function renderComponent(
  lookup: ComponentLookup,
  drift: readonly DriftNote[]
): string {
  const lines: string[] = [];

  if (lookup.kind === "none") {
    lines.push(
      `WARNING no theme on this instance defines ${SETTING_NAME}, so the ` +
        `component is not installed here. Dropdown Options written now resolve ` +
        `to nothing until it is.`
    );

    return `${lines.join("\n")}\n`;
  }

  if (lookup.kind === "many") {
    lines.push(
      `WARNING ${lookup.components.length} themes on this instance define ` +
        `${SETTING_NAME} (${lookup.components
          .map((component) => `${component.name} (id ${component.id})`)
          .join(", ")}). Which one resolves a Profile Link is undefined.`
    );

    return `${lines.join("\n")}\n`;
  }

  const { component } = lookup;
  const total = component.fields.reduce(
    (count, field) => count + field.mappings.length,
    0
  );

  lines.push(
    `component: "${component.name}" (theme id ${component.id}), ${total} ` +
      `Mapping${total === 1 ? "" : "s"} live`
  );

  if (component.overridden) {
    lines.push(
      `WARNING ${SETTING_NAME} has been saved through the theme settings UI on ` +
        `this instance, so its Mappings no longer follow the repository and a ` +
        `later deployment will not change them (ADR-0008).`
    );
  }

  for (const note of drift) {
    lines.push(`WARNING ${note.detail}`);
  }

  return `${lines.join("\n")}\n`;
}

export function renderReadback(
  mismatches: readonly ReadbackMismatch[]
): string {
  if (mismatches.length === 0) {
    return (
      `readback: every field the catalogue covers holds exactly the ` +
      `options it calls for.\n`
    );
  }

  const lines = mismatches.map((mismatch) => `MISMATCH ${mismatch.detail}`);

  return `${lines.join("\n")}\n`;
}

/**
 * The two digests that have to agree before anything is written: the one
 * `settings.yml` records for the Mappings it ships, and the one the catalogue
 * declares for itself.
 *
 * A difference means the shipped Mappings and the Dropdown Options about to be
 * pushed came from two different catalogues, which produces an Unmatched Value
 * for every option only one of them knows about. Both are printed, because
 * "they disagree" does not tell you which one is stale.
 */
export function digestDisagreement(
  recorded: string,
  declared: string
): string | null {
  if (recorded === declared) {
    return null;
  }

  return (
    `The Mappings in settings.yml were built from catalogue ${recorded} and ` +
    `the catalogue on disk is ${declared}. The two sinks would come from ` +
    `different catalogues, so a User could pick an option no Mapping covers. ` +
    `Run pnpm build:settings, then commit the result.`
  );
}
