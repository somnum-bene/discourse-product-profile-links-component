// Everything the Catalogue Apply decides. It takes one Discourse instance's
// Custom User Field definitions as data, plus the committed Resolved Product
// Catalogue, and returns a plan: which fields to write, which to refuse, and
// what a person should be told before any of it happens.
//
// Nothing here touches the network. That is the point of the file rather than a
// convenience: this step overwrites Dropdown Options, which is site data no
// commit can restore, and a User holding a removed value silently stops getting
// a Profile Link (ADR-0011). Discovering this behaviour by running it against a
// live instance is how that data gets destroyed. Every question worth arguing
// about is answered here, against a fixture, before a request exists.
//
// The plan is all-or-nothing. A refusal empties the write list, because a
// half-configured site is harder to reason about than an unconfigured one, and
// because the operator's next move is the same either way: look at what the plan
// says it would remove, then decide.
//
// The Dropdown Options come from `dropdownOptionsFor`, the same function the
// review document uses, and are never derived a second way. A Dropdown Option
// with no Mapping behind it is an Unmatched Value — the User picks their machine
// and no Profile Link appears — so the two lists have one source.

import {
  dropdownOptionsFor,
  type FieldOptions,
  type ResolvedProduct,
} from "./build-catalogue.ts";
import { SHEET_TABS } from "./sheet-export.ts";

/**
 * The Custom User Fields this pipeline is responsible for, in the order the
 * Sheet Export allowlist names them.
 *
 * It is derived from that allowlist rather than written out again because the
 * two must agree: a field the spreadsheet curates titles for and this step has
 * never heard of would go unreported, which is the failure `Humidifier` would
 * have been. The catalogue names only the fields that resolved *some* product,
 * so it cannot answer "which fields were in scope and came up empty".
 */
export const MANAGED_FIELDS: readonly string[] = SHEET_TABS.map(
  (tab) => tab.userFieldName
);

/** A Custom User Field as Discourse's admin API reports it. */
export interface UserFieldDefinition {
  id: number;
  name: string;
  field_type: string;
  /** Absent or null for every field type that does not offer a choice. */
  options?: readonly string[] | null;
}

/**
 * Why a write exists. Five distinct answers, because "the options changed" is
 * not enough to approve a destructive one — `extend` adds and keeps everything,
 * `replace` removes something a User may be holding, and they should never read
 * the same in a summary.
 */
export type WriteReason =
  | "populate"
  | "extend"
  | "reorder"
  | "replace"
  | "clear";

/** One field's write, with the before-and-after diff that justifies it. */
export interface FieldWrite {
  id: number;
  user_field_name: string;
  reason: WriteReason;
  before: string[];
  after: string[];
  /** In target order. */
  added: string[];
  /** In the order the instance holds them. */
  removed: string[];
}

export type RefusalReason =
  | "field-missing"
  | "field-ambiguous"
  | "field-not-dropdown"
  | "would-remove-options"
  | "clear-target-missing"
  | "clear-target-mapped";

/**
 * An option the plan would remove, and the target option it is probably a
 * differently-typed spelling of.
 *
 * `sameProductAs` compares the two with every non-alphanumeric character
 * dropped, which is how `AirCurve™ 11 VAuto with HumidAir™` is recognised as the
 * instance's spelling of `AirCurve 11 VAuto with HumidAir`. **It never affects a
 * decision.** It exists because a person approving a destructive replace needs
 * to know whether they are deleting four unrelated products or the same four
 * products spelled with trademark symbols, and no amount of reading the two
 * lists side by side reliably reveals a difference that fine. Matching itself
 * stays exact: Discourse stores what a User picked, and a Mapping either equals
 * it or resolves nothing.
 */
export interface RemovedOption {
  option: string;
  sameProductAs: string | null;
}

/** A field the plan will not touch, and everything needed to decide what next. */
export interface ApplyRefusal {
  user_field_name: string;
  reason: RefusalReason;
  detail: string;
  before: string[];
  /** What the write would have set, so a refusal shows what it is protecting. */
  after: string[];
  removes: RemovedOption[];
}

/** Something true of the plan that does not stop it. */
export interface ApplyWarning {
  user_field_name: string;
  detail: string;
}

export interface ApplyPlan {
  writes: FieldWrite[];
  refusals: ApplyRefusal[];
  warnings: ApplyWarning[];
  /** Fields already holding exactly the right options. Named, not silent. */
  unchanged: string[];
}

export interface ApplyOptions {
  /** Authorises removing an option the catalogue does not carry. */
  replace?: boolean;
  /** Fields to empty, named one at a time. Never a blanket flag. */
  clear?: readonly string[];
  /** Defaults to `MANAGED_FIELDS`; tests and future scopes may narrow it. */
  managedFields?: readonly string[];
}

/**
 * A plan that could not be formed because an input is not a thing this step can
 * reason about at all. Distinct from a refusal, which is an ordinary outcome the
 * operator is expected to see and respond to.
 */
export class PlanApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanApplyError";
  }
}

const DROPDOWN = "dropdown";

/** Lowercased with every non-alphanumeric character dropped. Reporting only. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function sameOptions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function describeRemovals(
  removed: readonly string[],
  target: readonly string[]
): RemovedOption[] {
  return removed.map((option) => {
    const squashed = squash(option);
    const match = target.find((value) => squash(value) === squashed);

    return { option, sameProductAs: match ?? null };
  });
}

function optionsOf(field: UserFieldDefinition): string[] {
  return [...(field.options ?? [])];
}

/**
 * Finding a field by name has three outcomes, not two. Two fields sharing a name
 * is a broken instance rather than a missing field, and the component itself
 * reads a field by name, so the two cases have different remedies and must not
 * collapse into one.
 */
type Lookup =
  | { kind: "one"; field: UserFieldDefinition }
  | { kind: "none" }
  | { kind: "many"; fields: UserFieldDefinition[] };

function lookup(
  currentFields: readonly UserFieldDefinition[],
  name: string
): Lookup {
  const matches = currentFields.filter((field) => field.name === name);

  if (matches.length === 0) {
    return { kind: "none" };
  }

  if (matches.length > 1) {
    return { kind: "many", fields: matches };
  }

  return { kind: "one", field: matches[0] };
}

function ambiguous(
  name: string,
  fields: readonly UserFieldDefinition[]
): ApplyRefusal {
  return {
    user_field_name: name,
    reason: "field-ambiguous",
    detail:
      `The instance defines ${fields.length} Custom User Fields named ` +
      `"${name}" (ids ${fields.map((field) => field.id).join(", ")}). The ` +
      `component reads a field by name, so which one it would read is already ` +
      `undefined and writing to either would be a guess. Remove or rename the ` +
      `duplicate.`,
    before: [],
    after: [],
    removes: [],
  };
}

/**
 * The write reason, chosen by what the write does to what is already there
 * rather than by which branch produced it.
 */
function reasonFor(
  before: readonly string[],
  added: readonly string[],
  removed: readonly string[]
): WriteReason {
  if (removed.length > 0) {
    return "replace";
  }

  if (before.length === 0) {
    return "populate";
  }

  return added.length > 0 ? "extend" : "reorder";
}

/**
 * Decides what the Catalogue Apply would do to one instance, and returns it as
 * data.
 *
 * Refusal is the default, and the rule it follows is about removal rather than
 * authorship: **a write that would take an option away needs `replace`.** There
 * is nowhere in Discourse to record that this pipeline wrote an option, so an
 * option we wrote from last month's catalogue and an option a person typed into
 * the admin UI are the same four bytes. Guessing between them would decide, on a
 * hunch, whether to destroy site data. So an option still present in the
 * catalogue is kept because keeping it costs nothing, and everything else is
 * treated as a person's until a human says otherwise — the conservative
 * direction, and the reason a routine catalogue change asks for `replace` again.
 *
 * A field the catalogue has no Mappings for is not touched at all unless it is
 * named in `clear`. Emptying `Humidifier` destroys site data for a field this
 * work does not otherwise cover, and it must not ride along on populating
 * `Machine` and `Mask` (ADR-0012). Naming the field is the authorisation; asking
 * for `replace` as well would make the second flag noise.
 */
export function planApply(
  currentFields: readonly UserFieldDefinition[],
  catalogue: readonly ResolvedProduct[],
  options: ApplyOptions = {}
): ApplyPlan {
  const managed = options.managedFields ?? MANAGED_FIELDS;
  const clearing = options.clear ?? [];
  const targets = dropdownOptionsFor([...catalogue]);

  assertUsableTargets(targets);
  assertNamedOnce(clearing);

  const writes: FieldWrite[] = [];
  const refusals: ApplyRefusal[] = [];
  const warnings: ApplyWarning[] = [];
  const unchanged: string[] = [];

  for (const name of clearing) {
    const target = targets.find((entry) => entry.user_field_name === name);

    if (target) {
      refusals.push({
        user_field_name: name,
        reason: "clear-target-mapped",
        detail:
          `Clearing "${name}" was requested, but the catalogue carries ` +
          `${target.options.length} Mappings for it. Clearing is for a field ` +
          `this work does not cover; a field it does cover would be emptied ` +
          `and immediately repopulated, or emptied and left broken.`,
        before: [],
        after: [],
        removes: [],
      });
      continue;
    }

    const found = lookup(currentFields, name);

    if (found.kind === "many") {
      refusals.push(ambiguous(name, found.fields));
      continue;
    }

    if (found.kind === "none") {
      refusals.push({
        user_field_name: name,
        reason: "clear-target-missing",
        detail:
          `Clearing "${name}" was requested, but the instance defines no ` +
          `Custom User Field by that name. A request to destroy site data ` +
          `that quietly does nothing is worse than one that fails: the name ` +
          `is probably wrong, or this is the wrong instance.`,
        before: [],
        after: [],
        removes: [],
      });
      continue;
    }

    const field = found.field;

    if (field.field_type !== DROPDOWN) {
      refusals.push(notDropdown(field, []));
      continue;
    }

    const before = optionsOf(field);

    if (before.length === 0) {
      unchanged.push(name);
      continue;
    }

    writes.push({
      id: field.id,
      user_field_name: name,
      reason: "clear",
      before,
      after: [],
      added: [],
      removed: before,
    });
  }

  for (const target of targets) {
    const name = target.user_field_name;

    if (clearing.includes(name)) {
      // Already refused above as `clear-target-mapped`.
      continue;
    }

    const found = lookup(currentFields, name);

    if (found.kind === "many") {
      refusals.push(ambiguous(name, found.fields));
      continue;
    }

    if (found.kind === "none") {
      refusals.push({
        user_field_name: name,
        reason: "field-missing",
        detail:
          `The catalogue carries ${target.options.length} Mappings for ` +
          `"${name}", and the instance defines no Custom User Field by that ` +
          `name. Creating one is a decision about the site, not about the ` +
          `catalogue: its type, whether Users must fill it in and where it ` +
          `shows are all outside this step. Create it, then apply.`,
        before: [],
        after: [...target.options],
        removes: [],
      });
      continue;
    }

    const field = found.field;

    if (field.field_type !== DROPDOWN) {
      refusals.push(notDropdown(field, target.options));
      continue;
    }

    const before = optionsOf(field);
    const after = [...target.options];
    const added = after.filter((option) => !before.includes(option));
    const removed = before.filter((option) => !after.includes(option));

    if (removed.length > 0 && !options.replace) {
      refusals.push({
        user_field_name: name,
        reason: "would-remove-options",
        detail:
          `"${name}" already offers ${removed.length} option` +
          `${removed.length === 1 ? "" : "s"} the catalogue does not carry: ` +
          `${quoted(removed)}. Removing one silently stops every User holding ` +
          `it from getting a Profile Link, and there is no record of whether ` +
          `it was written by this pipeline or entered by a person, so it is ` +
          `treated as a person's. Pass replace to authorise it.`,
        before,
        after,
        removes: describeRemovals(removed, after),
      });
      continue;
    }

    if (sameOptions(before, after)) {
      unchanged.push(name);
      continue;
    }

    writes.push({
      id: field.id,
      user_field_name: name,
      reason: reasonFor(before, added, removed),
      before,
      after,
      added,
      removed,
    });
  }

  for (const name of managed) {
    if (targets.some((target) => target.user_field_name === name)) {
      continue;
    }

    const found = lookup(currentFields, name);

    if (found.kind === "none") {
      warnings.push({
        user_field_name: name,
        detail:
          `"${name}" is a field this pipeline covers, the catalogue has no ` +
          `Mappings for it, and the instance does not define it. Nothing to ` +
          `do here, and nothing wrong with the instance.`,
      });
      continue;
    }

    if (found.kind === "many") {
      warnings.push({
        user_field_name: name,
        detail:
          `The instance defines ${found.fields.length} Custom User Fields ` +
          `named "${name}" (ids ${found.fields
            .map((field) => field.id)
            .join(", ")}). This run does not touch the field, so it is a ` +
          `warning rather than a refusal, but the component reads a field by ` +
          `name and would already be reading an undefined one of them.`,
      });
      continue;
    }

    if (clearing.includes(name)) {
      continue;
    }

    const before = optionsOf(found.field);

    if (before.length === 0) {
      continue;
    }

    warnings.push({
      user_field_name: name,
      detail:
        `"${name}" offers ${before.length} option` +
        `${before.length === 1 ? "" : "s"} and the catalogue has no Mappings ` +
        `for it, so every User who picks one gets no Profile Link and nothing ` +
        `is logged unless Debug Mode is on: ${quoted(before)}. This run leaves ` +
        `the field alone. Name it in clear to empty it.`,
    });
  }

  return {
    writes: refusals.length > 0 ? [] : writes,
    refusals,
    warnings,
    unchanged,
  };
}

function notDropdown(
  field: UserFieldDefinition,
  after: readonly string[]
): ApplyRefusal {
  return {
    user_field_name: field.name,
    reason: "field-not-dropdown",
    detail:
      `"${field.name}" is a ${field.field_type} field, and only a ${DROPDOWN} ` +
      `field offers Dropdown Options. Changing its type is a decision about ` +
      `the site and would discard whatever Users have already typed into it.`,
    before: [],
    after: [...after],
    removes: [],
  };
}

/**
 * The catalogue side has to be usable before anything is compared against it.
 * A duplicated option means the transform upstream is broken rather than the
 * instance, and writing it would leave the dropdown worse than it started: the
 * same choice offered twice, with no way to tell which one a User picked.
 *
 * There is deliberately no check for an *empty* option list. `dropdownOptionsFor`
 * emits no entry at all for a field with no Resolved Products — that is what
 * keeps `Humidifier` absent rather than present and empty — so the case cannot
 * arise here, and a guard nothing can reach is a guard nothing tests. The
 * invariant is asserted where it is actually true, against `dropdownOptionsFor`.
 */
function assertUsableTargets(targets: readonly FieldOptions[]): void {
  for (const target of targets) {
    const seen = new Set<string>();

    for (const option of target.options) {
      if (seen.has(option)) {
        throw new PlanApplyError(
          `The catalogue produced "${option}" twice for ` +
            `"${target.user_field_name}".`
        );
      }

      seen.add(option);
    }
  }
}

function assertNamedOnce(clearing: readonly string[]): void {
  const seen = new Set<string>();

  for (const name of clearing) {
    if (seen.has(name)) {
      throw new PlanApplyError(
        `"${name}" was named twice for clearing. Destroying site data is ` +
          `spelled out one field at a time, so a repeated name is a mistake ` +
          `rather than a stronger request.`
      );
    }

    seen.add(name);
  }
}
