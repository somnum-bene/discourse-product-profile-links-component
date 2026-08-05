# Build-time scripts

Everything in here runs on a developer's machine or in CI. None of it ships to a
browser — that is what `javascripts/` is for, and putting a script there would
send the catalogue pipeline to every forum visitor.

The three commands and what each one is allowed to touch:

| Command   | Reads                                   | Writes                       | Credentials                                                       |
| --------- | --------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| _refresh_ | `data/` Sheet Exports, Shopify Admin API | `data/resolved-products.csv` | `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_API_TOKEN`                        |
| _build_   | `data/resolved-products.csv`            | `settings.yml`               | none, so it runs in CI                                            |
| _apply_   | `data/resolved-products.csv`            | one Discourse instance       | `DISCOURSE_BASE_URL`, `DISCOURSE_API_USERNAME`, `DISCOURSE_API_KEY` |

Credentials come from an ignored `.env` and are never logged, never printed in
an error, and never committed.

## Two things about the toolchain that will surprise you

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

## Where the logic lives

`buildCatalogue` and `planApply` hold every decision worth testing, and they are
pure — no network, no filesystem, no clock. The commands around them are thin
shells: fetch, read, write, execute a plan. If a bug can hide in a shell, logic
has leaked out of a transform and belongs back inside it.

Tests live in `spec/unit/`, never in `test/` — Discourse serves a theme's
`test/` directory at `/theme-qunit`. See `docs/adr/0003`.
