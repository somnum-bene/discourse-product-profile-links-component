// The Catalogue Apply. Pushes the Resolved Product Catalogue's Dropdown Options
// to the Discourse instance named by `DISCOURSE_BASE_URL`, then rereads that
// instance and reports whether the writes landed. Run it with
// `pnpm apply:catalogue`.
//
// The base URL is the whole difference between the test and production instances
// (ADR-0011), which is what "repeatable on a different subdomain" comes down to.
// It needs nothing from Shopify, so a rotated Shopify token cannot block a
// Discourse deployment.
//
// Every decision it makes is somewhere else. `lib/plan-apply.ts` decides what
// should happen; `lib/catalogue-apply.ts` builds the requests and judges the
// responses. What is left here is a read, a plan, a write loop and a reread — and
// the write loop is deliberately the only part of the pipeline that no test
// covers, because a test of it would be a test of `fetch`.
//
// Each write is one whole field, applied in order and complete on its own, so an
// interrupted run is repeated rather than repaired: the next run replans against
// whatever the instance now holds and asks for the rest.

import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  dropdownOptionsFor,
  renderFieldMappings,
} from "./lib/build-catalogue.ts";
import {
  driftReport,
  recordedDigest,
  SETTINGS_FILE,
  settingsWithCatalogue,
} from "./lib/build-settings.ts";
import {
  API_KEY_VAR,
  API_USERNAME_VAR,
  applyDecision,
  BASE_URL_VAR,
  CatalogueApplyError,
  componentDrift,
  digestDisagreement,
  findComponent,
  instanceOrigin,
  type LiveUserField,
  parseApplyArgs,
  parseUserFields,
  PLAN_FLAG,
  readbackMismatches,
  renderComponent,
  renderPlan,
  renderReadback,
  themesUrl,
  type UserFieldRequest,
  userFieldsUrl,
  userFieldUrl,
  writePayload,
} from "./lib/catalogue-apply.ts";
import {
  CATALOGUE_FILE,
  CatalogueRefreshError,
  COLLECTION_LINKS_FILE,
  declaredDigest,
  readCollectionLinks,
  readResolvedProducts,
} from "./lib/catalogue-refresh.ts";
import { MANAGED_FIELDS, planApply, PlanApplyError } from "./lib/plan-apply.ts";
import { SheetExportError } from "./lib/sheet-export.ts";

/** The API key goes in here and nowhere else. */
interface Credentials {
  username: string;
  key: string;
}

async function main(): Promise<void> {
  const args = parseApplyArgs(process.argv.slice(2));

  const baseUrl = process.env[BASE_URL_VAR];
  const username = process.env[API_USERNAME_VAR];
  const key = process.env[API_KEY_VAR];

  if (!baseUrl || !username || !key) {
    throw new CatalogueApplyError(
      `${BASE_URL_VAR}, ${API_USERNAME_VAR} and ${API_KEY_VAR} all have to be ` +
        `set. They live in the ignored .env, and the base URL is the only one ` +
        `that differs between the test and production instances.`
    );
  }

  const origin = instanceOrigin(baseUrl);
  const credentials: Credentials = { username, key };

  // Through the catalogue's own reader, which recomputes the digest on its first
  // line: a catalogue edited by hand after it was approved is refused rather
  // than pushed to a live site.
  const catalogueText = await readFile(CATALOGUE_FILE, "utf8");
  const catalogue = readResolvedProducts(catalogueText);
  const declared = declaredDigest(catalogueText, CATALOGUE_FILE);

  // Read for the drift comparison below and for nothing else. The Dropdown
  // Options this command writes come from `dropdownOptionsFor(catalogue)`,
  // which is never handed a Collection Link — that is the point of the two
  // arrays (ADR-0021).
  const collectionLinks = readCollectionLinks(
    await readFile(COLLECTION_LINKS_FILE, "utf8")
  );
  const targets = dropdownOptionsFor(catalogue);

  const settingsText = await readFile(SETTINGS_FILE, "utf8");
  const disagreement = digestDisagreement(
    recordedDigest(settingsText),
    declared
  );

  if (disagreement) {
    throw new CatalogueApplyError(disagreement);
  }

  // The digest above correlates the Dropdown Options this command writes with
  // the products they came from, and that is all it can do: it records the
  // catalogue's digest alone, on purpose, because a combined digest would blur
  // what it means (see `DIGEST_LABEL`). Collection Links are therefore outside
  // it, and `settings.yml` ships them as of #34.
  //
  // So a links file that was edited and re-digested without a rebuild left
  // this command comparing a live instance against Mappings that were never
  // shipped, with the digest guard passing throughout. This asks the question
  // the digest cannot: is the committed file what a fresh build from both
  // inputs would write? Same comparison `pnpm build:settings --check` runs,
  // which apply cannot assume anyone ran.
  const stale = driftReport(
    settingsText,
    settingsWithCatalogue(
      settingsText,
      renderFieldMappings(catalogue, collectionLinks, MANAGED_FIELDS),
      declared
    )
  );

  if (stale) {
    throw new CatalogueApplyError(
      `${stale}\nRun \`pnpm build:settings\` and commit the result before ` +
        `applying: this command pushes Dropdown Options to a live site and ` +
        `reports drift against the Mappings in this file.`
    );
  }

  process.stdout.write(
    `instance: ${origin}\ncatalogue: ${declared}\n` +
      `${targets
        .map(
          (target) =>
            `  ${target.user_field_name}: ${target.options.length} options`
        )
        .join("\n")}\n\n`
  );

  const current = parseUserFields(
    await request("GET", userFieldsUrl(origin), credentials)
  );

  // What the component on this instance actually has, printed before the plan
  // rather than after the writes. Dropdown Options with no Mappings behind them
  // are written perfectly and resolve to nothing, and that is worth knowing
  // before authorising a destructive replace rather than afterwards.
  const lookup = findComponent(
    await request("GET", themesUrl(origin), credentials)
  );
  // Against both arrays, because `settings.yml` ships both: comparing an
  // instance's live Mappings against the products alone would report every
  // Collection Link as drift on every run.
  const drift =
    lookup.kind === "one"
      ? componentDrift(
          lookup.component.fields,
          renderFieldMappings(catalogue, collectionLinks, MANAGED_FIELDS)
        )
      : [];

  process.stdout.write(`${renderComponent(lookup, drift)}\n`);

  const plan = planApply(current, catalogue, {
    replace: args.replace,
    clear: args.clear,
  });

  process.stdout.write(renderPlan(plan));

  const decision = applyDecision(plan);

  if (decision.kind !== "proceed") {
    throw new CatalogueApplyError(decision.message);
  }

  if (args.planOnly) {
    process.stdout.write(
      `\n${PLAN_FLAG}: nothing was written. ${plan.writes.length} write` +
        `${plan.writes.length === 1 ? "" : "s"} would have been.\n`
    );
    return;
  }

  for (const write of plan.writes) {
    const field = current.find((entry) => entry.id === write.id);

    if (!field) {
      throw new CatalogueApplyError(
        `The plan writes to Custom User Field id ${write.id} ` +
          `("${write.user_field_name}") and the field list read from the ` +
          `instance does not contain it.`
      );
    }

    await request(
      "PUT",
      userFieldUrl(origin, write.id),
      credentials,
      writePayload(field, write.after)
    );

    process.stdout.write(
      `wrote ${write.user_field_name}: ${write.after.length} options\n`
    );
  }

  // The reread, not the update responses. The route answers 200 to a write it
  // discarded — an empty options list is ignored and a repeated option is
  // dropped — so nothing but a fresh read says whether the site changed
  // (ADR-0014).
  const after: LiveUserField[] =
    plan.writes.length === 0
      ? current
      : parseUserFields(
          await request("GET", userFieldsUrl(origin), credentials)
        );

  const mismatches = readbackMismatches(after, targets);

  process.stdout.write(
    `\n${plan.writes.length} field${plan.writes.length === 1 ? "" : "s"} ` +
      `written.\n${renderReadback(mismatches)}`
  );

  if (mismatches.length > 0) {
    process.exitCode = 1;
  }
}

/**
 * One request. The API key goes into a header and nowhere else — not into the
 * URL, not into an error message, not into the log.
 *
 * A field id the instance does not know answers 500 rather than 404, so the
 * status code is reported as-is rather than interpreted. Only Discourse's own
 * `errors` array is echoed; the rest of a response body is not repeated back.
 */
async function request(
  method: "GET" | "PUT",
  url: string,
  credentials: Credentials,
  body?: UserFieldRequest
): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: {
      "Api-Key": credentials.key,
      "Api-Username": credentials.username,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new CatalogueApplyError(
      `${method} ${url} answered ${response.status} ${response.statusText}` +
        `${reported(text)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new CatalogueApplyError(
      `${method} ${url} answered ${response.status} with a body that is not ` +
        `JSON. That is what a login page looks like: check ` +
        `${API_USERNAME_VAR} and ${API_KEY_VAR}.`
    );
  }
}

function reported(text: string): string {
  try {
    const body: unknown = JSON.parse(text);

    if (
      typeof body === "object" &&
      body !== null &&
      "errors" in body &&
      Array.isArray((body as { errors: unknown[] }).errors)
    ) {
      return `: ${(body as { errors: unknown[] }).errors.join("; ")}`;
    }
  } catch {
    // A non-JSON body is not repeated back. It is usually an HTML error page.
  }

  return "";
}

// Not top-level `await`: TypeScript reads this file as CommonJS, because
// package.json declares no `"type"`, and CommonJS has no top-level await. Node
// runs it as ESM regardless. `scripts/README.md` has the whole story.
main().catch((error: unknown) => {
  if (
    error instanceof CatalogueApplyError ||
    error instanceof PlanApplyError ||
    error instanceof CatalogueRefreshError ||
    error instanceof SheetExportError
  ) {
    process.stderr.write(`\n${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
});
