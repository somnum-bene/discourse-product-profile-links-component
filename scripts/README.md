# Build-time scripts

Everything in here runs on a developer's machine or in CI. None of it ships to a
browser — that is what `javascripts/` is for, and putting a script there would
send the catalogue pipeline to every forum visitor.

The commands and what each one is allowed to touch:

| Command                  | Reads                                    | Writes                                                 | Configuration                                                       |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `pnpm export:sheet`      | three allowlisted spreadsheet tabs       | `data/user_*.csv`                                      | `SHEET_WORKBOOK_ID`                                                 |
| `pnpm refresh:catalogue` | `data/` Sheet Exports, Shopify Admin API | `data/resolved-products.csv`, `.ig.catalogue-review.md` | `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_API_TOKEN`                          |
| _build_                  | `data/resolved-products.csv`             | `settings.yml`                                         | none, so it runs in CI                                              |
| _apply_                  | `data/resolved-products.csv`             | one Discourse instance                                 | `DISCOURSE_BASE_URL`, `DISCOURSE_API_USERNAME`, `DISCOURSE_API_KEY` |

Configuration comes from an ignored `.env`, read by Node's own
`--env-file-if-exists`, and is never logged, never printed in an error, and
never committed.

## The Sheet Export refuses more than it accepts

`export:sheet` fetches three tabs of a workbook that also holds roughly 124,000
real usernames and email addresses. This repository is public. Those two facts
set the design:

- **The workbook id is configuration, not a constant.** It is a public link to
  real customer data, so committing it would publish the link. It lives in
  `.env` as `SHEET_WORKBOOK_ID` and the run aborts without it.
- **The allowlist is the only way through.** `SHEET_TABS` names the three tabs
  and, for each, the exact header row and the two columns read from it. A name
  becomes a URL only via `tabNamed`, which refuses anything unlisted, and the
  command itself contains no tab name and builds no URL — a test enforces both,
  because an allowlist you can go around is a convention.
- **Three independent guards, all fail-closed.** The header row must match
  exactly; the row count must stay under a ceiling these tabs are nowhere near
  and the personal-data tabs are far above; no cell may look like an email
  address. Each catches a restructured workbook the other two would miss. A
  surprise stops the run — skipping it is not safe.
- **Nothing is written until all three tabs pass.** A partial run would leave one
  refreshed export beside two stale ones, which is worse than leaving all three.
- **`user_humidifier` has no Suggested columns.** That is deliberate (ADR-0012),
  not a fault: the tab validates, exports for provenance, and yields no rows.

Exports are written byte for byte as the endpoint returned them — LF endings,
no final newline — which is why `data/` is exempt from the whitespace-fixing
pre-commit hooks. The endpoint is addressed by tab _name_ (`gviz/tq`) rather
than by the numeric gid `export?format=csv` requires, because the allowlist is
written in names and a workbook is free to reassign a gid.

## The Catalogue Refresh writes one file to ship and one file to read

`refresh:catalogue` is the only command that touches Shopify, and the only one
that turns a curated title into a link. It writes two things, and they are not
the same kind of thing:

- **`data/resolved-products.csv` is the record.** It is committed, it is the only
  input to `build` and `apply`, and it holds nothing but the Mappings that
  resolved. Its first line is a `# sha256 …` digest of the rest, so a later
  command can say which catalogue it is working from, and a file edited by hand
  after it was generated is refused rather than used.
- **`.ig.catalogue-review.md` is the deliverable a human approves.** It is
  ignored, because it is regenerated on every refresh: every Mapping per field,
  every excluded Suggested Title under the reason it was excluded, and both
  directions of the disagreement between the spreadsheet and the live catalogue.
  There is no timestamp in it, so a refresh that changes nothing changes nothing,
  and a diff in it is worth reading.

Two queries go to Shopify. Products the spreadsheet names are fetched **by
handle** — the same handle the transform's join will look for, so the command
cannot fetch a product the transform never consults. Each of the three divisions
is then surveyed for what it currently sells, which is the only way to answer
"what does cpap.com sell that the spreadsheet never mentions". A refused query
arrives as HTTP 200 with an `errors` array, so the body is checked rather than
the status code.

Everything it decides is in `lib/catalogue-refresh.ts` and reached by tests. The
access token is never passed into that file at all: the command reads it and puts
it in a header, so no function that could log something has it.

`Humidifier` produces no Mappings and the run says so. An empty field is reported
two different ways on purpose — "expected, the tab curates none" for
`Humidifier`, and "that is a problem" for a field that curates titles and
resolved none of them. Printing one message for both would make the broken case
look like the intended one.

## Three things about the toolchain that will surprise you

**Import Node builtins explicitly, with the `node:` prefix.** The shared
`discourse/tsconfig-plugin` sets `typeRoots` to a path inside its own package,
which switches off the automatic pickup of `node_modules/@types/*`. So
`@types/node` being installed does _not_ make `process`, `Buffer` or
`__dirname` ambient — referring to them bare is a type error. `import { readFile }
from "node:fs/promises"` and `import process from "node:process"` resolve fine,
because module resolution does not go through `typeRoots`. Write the imports and
the problem disappears.

**Scripts are type-checked by the same `pnpm lint:types` as the component.**
`scripts/` is in `tsconfig.json`'s `include`, so a type error here fails the
same gate an Ember type error would. There is no separate script tsconfig, and
adding one would mean two places to keep in step for no gain.

**A command imports its modules with an explicit `.ts` suffix, and runs with two
Node flags.** `package.json` has no `"type"`, so a `.ts` file is CommonJS as far
as TypeScript is concerned — which is why `import.meta` is a type error here and
why the specs can import modules without an extension. Node disagrees: it sees
the ESM syntax, reparses the file as a module, and then needs the real extension
in every relative specifier, because Node's TypeScript support does not remap
`.js` onto `.ts` the way `tsc` does. Hence `./lib/sheet-export.ts` in the import
and `allowImportingTsExtensions` in `tsconfig.json` to let TypeScript accept it,
plus `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` to silence the reparse
notice on every run.

Two ways out of this were tried and rejected. `"type": "module"` in
`package.json` is what the warning itself suggests, and it would flip every `.ts`
file in the repository to ESM, where TypeScript stops resolving extensionless
relative imports — `javascripts/` would break for the sake of a warning. Naming
the entry point `.mts`, which is unambiguously ESM and needs no flag, fails
lint: `@discourse/lint-configs` routes `.mts` to `ember-eslint-parser`, which
hands it to Babel without the TypeScript plugin, so the first type annotation is
a parse error.

## Where the logic lives

`buildCatalogue` and `planApply` hold every decision worth testing, and they are
pure — no network, no filesystem, no clock. The commands around them are thin
shells: fetch, read, write, execute a plan. If a bug can hide in a shell, logic
has leaked out of a transform and belongs back inside it.

Tests live in `spec/unit/`, never in `test/` — Discourse serves a theme's
`test/` directory at `/theme-qunit`. See `docs/adr/0003`.
