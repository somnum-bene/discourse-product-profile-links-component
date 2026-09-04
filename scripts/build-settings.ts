// The build step. Reads the committed Resolved Product Catalogue and Collection
// Links and writes the `profile_link_fields` default into `settings.yml`, which
// is how both reach an instance (ADR-0008). Run it with `pnpm build:settings`.
//
// It needs no credentials and no network — both inputs are committed files —
// which is what lets `--check` run as a CI gate. Everything it decides lives in
// `lib/build-settings.ts`; what is left here is three reads and one write.

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { renderFieldMappings } from "./lib/build-catalogue.ts";
import {
  BuildSettingsError,
  driftReport,
  SETTINGS_FILE,
  settingsWithCatalogue,
} from "./lib/build-settings.ts";
import {
  CATALOGUE_FILE,
  CatalogueRefreshError,
  COLLECTION_LINKS_FILE,
  declaredDigest,
  readCollectionLinks,
  readResolvedProducts,
} from "./lib/catalogue-refresh.ts";

/** Report drift and change nothing. The gate CI and the pre-commit hook run. */
const CHECK_FLAG = "--check";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== CHECK_FLAG);

  if (unknown.length > 0) {
    throw new BuildSettingsError(
      `Unrecognised argument${unknown.length > 1 ? "s" : ""}: ` +
        `${unknown.join(", ")}. The only one is ${CHECK_FLAG}, which reports ` +
        `drift and writes nothing.`
    );
  }

  // Through the catalogue's own reader rather than by parsing the CSV again: it
  // verifies the digest on the first line, so a catalogue edited by hand after
  // it was approved is refused rather than shipped.
  const catalogueText = await readFile(CATALOGUE_FILE, "utf8");
  const catalogue = readResolvedProducts(catalogueText);
  const digest = declaredDigest(catalogueText);

  // The second input. Both sinks used to come from one file; the Mappings now
  // come from two and the Dropdown Options still come from one, which is the
  // asymmetry Collection Links rest on (ADR-0021).
  const collectionLinks = readCollectionLinks(
    await readFile(COLLECTION_LINKS_FILE, "utf8")
  );
  const fields = renderFieldMappings(catalogue, collectionLinks);

  const committed = await readFile(SETTINGS_FILE, "utf8");
  const built = settingsWithCatalogue(committed, fields, digest);

  if (args.includes(CHECK_FLAG)) {
    const drift = driftReport(committed, built);

    if (drift) {
      throw new BuildSettingsError(drift);
    }

    process.stdout.write(
      `${SETTINGS_FILE} matches ${CATALOGUE_FILE} and ` +
        `${COLLECTION_LINKS_FILE}.\n${summary(fields, digest)}`
    );
    return;
  }

  if (built === committed) {
    process.stdout.write(
      `${SETTINGS_FILE} was already up to date.\n${summary(fields, digest)}`
    );
    return;
  }

  await writeFile(SETTINGS_FILE, built);

  process.stdout.write(
    `${SETTINGS_FILE} rebuilt from ${CATALOGUE_FILE} and ` +
      `${COLLECTION_LINKS_FILE}.\n${summary(fields, digest)}`
  );
}

/**
 * What shipped. A Custom User Field the catalogue has nothing for is absent from
 * this list because it is absent from the setting: an entry with an empty
 * mappings list is a Config Problem, so a field having no entry is the
 * intended outcome rather than a missing one (ADR-0012).
 */
function summary(
  fields: readonly { user_field_name: string; mappings: unknown[] }[],
  digest: string
): string {
  const lines = fields.map(
    (field) => `  ${field.user_field_name}: ${field.mappings.length} Mappings`
  );

  return `catalogue: ${digest}\n${lines.join("\n")}\n`;
}

// Not top-level `await`: TypeScript reads this file as CommonJS, because
// package.json declares no `"type"`. `scripts/README.md` has the whole story.
main().catch((error: unknown) => {
  // A catalogue that no longer matches its own digest is caught here too, as a
  // refusal rather than a crash. Drift arrives the same way, which is why the
  // exit code and the message are all the gate needs.
  if (
    error instanceof BuildSettingsError ||
    error instanceof CatalogueRefreshError
  ) {
    process.stderr.write(
      `${error.message}\n${SETTINGS_FILE} was not written.\n`
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
});
