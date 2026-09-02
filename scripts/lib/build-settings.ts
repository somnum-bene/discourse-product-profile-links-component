// Everything the build step decides. It has one input — the committed Resolved
// Product Catalogue — and one output: the `default:` of `profile_link_fields` in
// `settings.yml`, which is how the catalogue reaches an instance (ADR-0008).
//
// Two properties make the rest of the design fall out. The build must be
// deterministic, because a drift gate regenerates the file in CI and fails on
// any difference — so nothing here reads a clock, an environment or a locale.
// And it must leave the rest of `settings.yml` exactly as it found it, because
// everything else in that file is written by hand: the schema the Mappings are
// validated against, the description an administrator reads, and a second
// setting that has nothing to do with the catalogue.
//
// Hence a marked region rather than a YAML round trip. Reserialising the whole
// document would reformat and comment-strip parts of it that nobody edited, and
// a diff full of incidental reformatting is a diff nobody reads.
//
// This file re-decides nothing. Which titles ship, what they link to and the
// order they appear in are all settled by `buildCatalogue` and recorded in the
// catalogue file; the order below is the order the file holds. That is why the
// catalogue carries a digest: a hand-shuffled or hand-edited catalogue would
// otherwise change what ships without anything noticing.

import { stringify } from "yaml";
import type { FieldMapping } from "./build-catalogue.ts";

/** The shipped setting definitions. Committed, and the thing an instance gets. */
export const SETTINGS_FILE = "settings.yml";

/** The setting whose default the catalogue becomes. */
export const SETTING_NAME = "profile_link_fields";

/**
 * The generated region's fences. They sit at the indentation of a key inside
 * `profile_link_fields`, because that is where the region lives, and they name
 * the setting so a second generated region could never be confused for this one.
 *
 * The region is found by exact line match. A fence that has been edited, moved
 * or deleted stops the run rather than being guessed at: the fences are the only
 * statement of which part of a hand-written file is not hand-written.
 */
export const BEGIN_MARKER = `  # BEGIN GENERATED ${SETTING_NAME} default`;
export const END_MARKER = `  # END GENERATED ${SETTING_NAME} default`;

/** How the region records the catalogue it was generated from. */
const DIGEST_LABEL = "  # Catalogue digest (sha256): ";
const DIGEST_LINE = /^ {2}# Catalogue digest \(sha256\): ([0-9a-f]{64})$/;
const DIGEST_SHAPE = /^[0-9a-f]{64}$/;

/** Keys inside a setting are indented one level; the region is a key. */
const INDENT = "  ";

/**
 * Anything wrong enough to stop the build before it writes, and every drift the
 * check reports. The command catches only this and `CatalogueRefreshError`, so a
 * programming mistake still surfaces as a crash.
 */
export class BuildSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildSettingsError";
  }
}

/**
 * The generated region, fences included, as it appears in `settings.yml`.
 *
 * The digest is recorded here rather than left implicit because two sinks are
 * generated from one catalogue (ADR-0011). The Mappings ship in this file; the
 * Dropdown Options are pushed to a site separately. Recording which catalogue
 * this file was built from is what lets the second step notice it is working
 * from a different one — a site whose dropdown offers titles the shipped
 * Mappings do not cover produces an Unmatched Value for every user who picks
 * one, and nothing is logged unless Debug Mode is on.
 *
 * There is deliberately no timestamp and no generator version. A build from an
 * unchanged catalogue produces an unchanged file, which is what makes the drift
 * gate meaningful and a diff here worth reading.
 */
export function generatedRegion(
  fields: readonly FieldMapping[],
  digest: string
): string {
  if (!DIGEST_SHAPE.test(digest)) {
    throw new BuildSettingsError(
      `The catalogue digest should be 64 hex digits. It is ` +
        `${JSON.stringify(digest)}.`
    );
  }

  for (const field of fields) {
    // A Field Mapping with no Mappings is a Config Problem: the component
    // reports it on every page load and ignores the field. A Custom User Field
    // the catalogue has nothing for is meant to have no entry at all rather
    // than an empty one, so an empty list arriving here is a fault upstream,
    // not something to serialise faithfully.
    if (field.mappings.length === 0) {
      throw new BuildSettingsError(
        `The Field Mapping for "${field.user_field_name}" has no Mappings. A ` +
          `Custom User Field with nothing to map should produce no entry at ` +
          `all, because an entry with an empty mappings list is a Config ` +
          `Problem on every page load.`
      );
    }

    for (const mapping of field.mappings) {
      // A newline in a value would make YAML choose a quoted or block scalar
      // spanning several lines, which the fixed indentation below would then
      // mangle. It is also not a thing a Dropdown Option can hold, so this is a
      // corrupt catalogue rather than an unusual product name.
      if (/[\n\r]/.test(mapping.value) || /[\n\r]/.test(mapping.url)) {
        throw new BuildSettingsError(
          `A Mapping under "${field.user_field_name}" contains a line break: ` +
            `${JSON.stringify(mapping)}. A Dropdown Option cannot hold one, so ` +
            `the catalogue is corrupt.`
        );
      }
    }
  }

  // `lineWidth: 0` switches off line folding. Product URLs run well past the
  // default eighty columns, and a folded plain scalar is valid YAML that no
  // longer looks like the URL it is.
  const yaml = stringify({ default: fields }, { indent: 2, lineWidth: 0 });

  return [
    BEGIN_MARKER,
    `${INDENT}# Written by \`pnpm build:settings\` from the Resolved Product Catalogue.`,
    `${DIGEST_LABEL}${digest}`,
    `${INDENT}# Do not edit between these fences: \`pnpm build:settings --check\``,
    `${INDENT}# runs in CI and fails when this region disagrees with the catalogue.`,
    ...yaml.trimEnd().split("\n").map(indented),
    END_MARKER,
  ].join("\n");
}

function indented(line: string): string {
  return line ? `${INDENT}${line}` : line;
}

/**
 * `settings.yml` with the generated region replaced, and every other byte of it
 * left alone — the schema, the descriptions, the comments and
 * `profile_link_debug_mode` are all hand-written and none of them are the
 * catalogue's business.
 */
export function settingsWithCatalogue(
  settingsText: string,
  fields: readonly FieldMapping[],
  digest: string
): string {
  const lines = settingsText.split("\n");
  const begin = onlyIndexOf(lines, BEGIN_MARKER, "BEGIN");
  const end = onlyIndexOf(lines, END_MARKER, "END");

  if (end < begin) {
    throw new BuildSettingsError(
      `${SETTINGS_FILE} has its generated region fences the wrong way round: ` +
        `the END fence is on line ${end + 1} and the BEGIN fence on line ` +
        `${begin + 1}.`
    );
  }

  return [
    ...lines.slice(0, begin),
    ...generatedRegion(fields, digest).split("\n"),
    ...lines.slice(end + 1),
  ].join("\n");
}

function onlyIndexOf(
  lines: readonly string[],
  marker: string,
  which: string
): number {
  const found = lines.reduce<number[]>(
    (indexes, line, index) => (line === marker ? [...indexes, index] : indexes),
    []
  );

  if (found.length === 1) {
    return found[0];
  }

  const problem =
    found.length === 0
      ? `has no ${which} fence`
      : `has ${found.length} ${which} fences, on lines ${found
          .map((index) => index + 1)
          .join(", ")}`;

  throw new BuildSettingsError(
    `${SETTINGS_FILE} ${problem}. The generated region is delimited by these ` +
      `two lines, exactly as written:\n${BEGIN_MARKER}\n${END_MARKER}\n` +
      `Restore them around the ${SETTING_NAME} default rather than letting ` +
      `this command guess where the generated part of a hand-written file is.`
  );
}

/**
 * The catalogue digest `settings.yml` records, so a later step can say whether
 * the Mappings a site is running and the Dropdown Options it is about to be
 * given came from the same catalogue.
 */
export function recordedDigest(settingsText: string): string {
  for (const line of settingsText.split("\n")) {
    const match = DIGEST_LINE.exec(line);

    if (match) {
      return match[1];
    }
  }

  throw new BuildSettingsError(
    `${SETTINGS_FILE} records no catalogue digest. It should carry a\n` +
      `${DIGEST_LABEL}<64 hex digits>\n` +
      `line inside its generated region. Run \`pnpm build:settings\`.`
  );
}

/**
 * What is different between the committed file and a fresh build, or null when
 * nothing is — the drift gate's whole output.
 *
 * It names the first differing line rather than printing a diff, because there
 * is only ever one useful next step regardless of how much differs: regenerate.
 * Two causes look identical in the file and are worth telling apart in the
 * message, since only one of them is somebody's mistake.
 */
export function driftReport(
  committed: string,
  regenerated: string
): string | null {
  if (committed === regenerated) {
    return null;
  }

  const committedLines = committed.split("\n");
  const regeneratedLines = regenerated.split("\n");
  const length = Math.max(committedLines.length, regeneratedLines.length);
  let first = length;

  for (let index = 0; index < length; index += 1) {
    if (committedLines[index] !== regeneratedLines[index]) {
      first = index;
      break;
    }
  }

  return (
    `${SETTINGS_FILE} is not what \`pnpm build:settings\` would write.\n` +
    `  first difference at line ${first + 1}\n` +
    `    committed: ${describe(committedLines[first])}\n` +
    `    generated: ${describe(regeneratedLines[first])}\n` +
    `Either the generated region was edited by hand, or the Resolved Product ` +
    `Catalogue changed and this file was not rebuilt from it. Run ` +
    `\`pnpm build:settings\` and commit the result — the catalogue is the ` +
    `source, and this file is generated from it.`
  );
}

function describe(line: string | undefined): string {
  return line === undefined ? "(end of file)" : JSON.stringify(line);
}
