# 🔗 Profile Links

A Discourse theme component that turns a member's **Custom User Field** values into labelled hyperlinks — **Profile Links** — wherever that member shows up.

> A member whose _Machine_ field says `AirSense 11` gets a link to your product page for the AirSense 11, on their user card, their profile, and every post they write.

Unlike [the tutorial this started from](https://meta.discourse.org/t/link-custom-user-field-to-external-website/41218), which gives each field a single label and URL prefix, this component maps **each value to its own URL**. It is built for dropdown-type Custom User Fields, where the set of options is known in advance.

---

## ✨ What you get

| | |
|---|---|
| 🪪 **Three Link Surfaces** | User card, user profile, and posts — one shared resolver, so all three agree. |
| 🚫 **No duplicate rows** | Where a Profile Link replaces a value, Discourse's own plain-text row for it is hidden. Rows without a link are left exactly as core renders them. |
| 🩺 **Problems get reported** | A field name that doesn't exist, a Field Mapping with nothing in it, a value mapped twice — all logged to the console on page load, on every page. |
| ♾️ **No ceiling** | Map as many Custom User Fields as you like. The old ten-slot limit is gone. |
| 🧪 **Actually tested** | 457 unit tests over the pure modules and the catalogue pipeline, runnable in a second with no Discourse instance. |

---

## ⚙️ Configuration

### `profile_link_fields`

The Field Mappings, edited in Discourse's structured settings editor. Each **Field Mapping** names one Custom User Field and nests the **Mappings** that turn its values into Profile Links:

- **`user_field_name`** — the field's name, exactly as it appears in `/admin/config/user_fields`. **Case-sensitive.**
- **`mappings`** — one or more value/URL pairs:
  - **`value`** — must match the member's field value exactly.
  - **`url`** — where the Profile Link points. Discourse validates it as you type.

A value that matches no Mapping renders nothing. An empty configuration is valid — it just renders nothing at all.

> ### ⚠️ Don't edit this setting on a live site
>
> The cpap.com Field Mappings ship as this setting's **default**, generated from the product catalogue and committed ([ADR-0008](docs/adr/0008-the-catalogue-ships-as-the-settings-default.md)). Discourse stores an administrator's edit as a **Setting Override**, and once a site has one, **a shipped default never reaches that setting again — silently, and for good.**
>
> So editing Mappings through the theme settings UI freezes that site's catalogue at the moment you click save. Nothing breaks and nothing is logged; the site simply stops receiving product changes while every other site carries on getting them. **Opening the editor and saving it unchanged does this too** — that is how the test instance acquired one ([ADR-0019](docs/adr/0019-an-empty-override-is-an-accident-and-only-a-migration-can-remove-it.md)).
>
> **And there is no undo.** Discourse exposes no route that deletes a Setting Override — the admin API only writes one. Removing it takes a settings migration, or deleting and reinstalling the component. `migrations/settings/0002` removes an *empty* one, because that can only be an accident; a populated one is somebody's configuration and is kept.
>
> Change `data/resolved-products.csv` or `data/collection-links.csv` in this repository and regenerate instead. `pnpm apply:catalogue` reports an override it finds on the target site, so a mistake is at least visible on the next run — though only once the override differs from what the repository shipped, since nothing readable from outside distinguishes "no override" from "an override that agrees".

### `profile_link_debug_mode`

Logs field values that matched no Mapping. Reach for this when a Profile Link you expect isn't showing up. Configuration problems are reported whether or not this is on.

---

## 🔁 Upgrading from the CSV version

**Nothing to do.** ✅

The previous version spread each Field Mapping across a pipe-separated field list and ten positional CSV textareas. Those eleven settings are gone, and a settings migration converts an existing configuration to `profile_link_fields` when the component updates. `custom_profile_link_debug_mode` comes across as `profile_link_debug_mode` at the same time.

Two things worth knowing afterwards:

- A Mapping whose URL Discourse's validator refuses is **dropped**. The flat settings validated nothing, so they could hold one — and carrying it over would invalidate the entire setting rather than just that Mapping.
- A field name that never had any CSV mappings (including one past the tenth slot, which had nowhere to put them) is **carried over empty and reported**. It resolved no Profile Links before either; keeping it means your configuration isn't silently thinned out.

So: check the console once after updating. See [ADR-0006](docs/adr/0006-a-settings-migration-replaces-uninstall-and-re-add.md).

---

## 🗂 The cpap.com product catalogue

The Custom User Fields' **Dropdown Options** are generated from one committed file, `data/resolved-products.csv`, because a Dropdown Option with no matching Mapping value resolves nothing and logs nothing ([ADR-0011](docs/adr/0011-dropdown-options-are-a-second-sink-applied-per-site.md)). The Mappings are generated from that file **and** from `data/collection-links.csv`, which holds equipment cpap.com no longer sells, pointing at a collection page with ` (Discontinued)` on the value ([ADR-0021](docs/adr/0021-a-collection-link-is-a-mapping-with-no-option.md)).

So there are deliberately fewer Dropdown Options than Mappings. A **Collection Link** resolves for a User who already holds the value and is never offered to a User choosing one, and that is structural rather than a rule anyone has to remember: the function that renders the options is handed the products alone and never sees a Collection Link. What has no failure mode is a Mapping without an Option — nobody can select a value that is not offered. The reverse is the one that hurts, and it is still checked.

The two sinks land in **two different places**: Mappings ship in `settings.yml`, and Dropdown Options are Discourse site data that no commit can reach — so the last step runs once per instance.

| Command | What it does | Credentials it needs |
|---|---|---|
| `pnpm export:sheet` | re-exports the three allowlisted Sheet tabs to `data/user_machine.csv`, `data/user_mask.csv` and `data/collection-assignment.csv` | `SHEET_WORKBOOK_ID`, plus the three `GOOGLE_SERVICE_ACCOUNT_*` variables |
| `pnpm refresh:catalogue` | rebuilds `data/resolved-products.csv` from the `user_*` exports + the live Shopify catalogue, derives `data/collection-links.csv` from the Excluded Products + `data/collection-assignment.csv`, and writes a review document | `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_API_TOKEN` |
| `pnpm build:settings` | regenerates the `profile_link_fields` default in `settings.yml` | **none** — which is what lets it gate CI |
| `pnpm build:settings --check` | fails if `settings.yml` and the two committed files disagree | **none** |
| `pnpm verify:catalogue` | asks cpap.com whether every catalogue URL serves a page, one request at a time | **none** — it only asks for public product pages |
| `pnpm apply:catalogue --plan` | prints what a Catalogue Apply would do to one instance, writing nothing | `DISCOURSE_BASE_URL`, `DISCOURSE_API_USERNAME`, `DISCOURSE_API_KEY` |
| `pnpm apply:catalogue` | writes the Dropdown Options to that instance and reads them back | the same three |

`data/collection-assignment.csv` is the curated half of the Collection Links. A Catalogue Refresh joins it to the Excluded Products by legacy value: an excluded Suggested Title earns a link for five of the seven exclusion reasons, the assignment row says which collection it points at (an `Override` beating the recommendation), and the run asks Shopify whether that collection exists before shipping it. No row of `data/collection-links.csv` is hand-authored — the file is still committed, because `pnpm build:settings` has no network by design and needs it as an input, but a refresh writes every row of it.

A link that is owed and cannot be derived is **reported rather than shipped**: an unadmitted collection, a legacy value nobody has assigned, an `undecided` row, or a value the curated table and the transform disagree about. They are listed one at a time under "Collection Links not derived" in the review document, and the command says how many there were on stderr. As of the 2026-09-04 refresh there are five, all of them legacy values whose products retired at Shopify after the curation pass — which is the standing mechanism doing its job, not a defect.

The commands that need credentials read them from an ignored `.env`; the ones that need none cannot read it at all, which is what lets them run in CI and on a shared machine. Only the base URL differs between the test and production instances, and no step needs both Shopify and Discourse credentials — so a rotated Shopify token cannot block a Discourse deployment. `scripts/README.md` is the long version.

`pnpm verify:catalogue` is the one check here that is **not** a hook and not a CI step, and that is deliberate — it sends one request per catalogue URL to a storefront that rate-limits, and a commit that cannot be made while cpap.com is busy would be a gate failing for reasons nobody here controls ([ADR-0018](docs/adr/0018-reachability-is-a-deliberate-command-and-never-a-gate.md)). Run it before an apply. It exits non-zero on anything unshippable, and it reports four outcomes rather than pass/fail:

- **verified** — Shopify admits the product *and* the URL answers 2XX from a page that is still that product.
- **failed** — Shopify admits it and cpap.com did not serve it.
- **unresolved** — nothing ever answered (429, 503, or no response). Not a pass and not a failure; it blocks, and you run the pass again.
- **excluded** — Shopify does not admit it, so it was never requested. The catalogue should not contain one at all.

> ⚠️ **A 2XX is not proof the page exists.** cpap.com serves a product handle it no longer has by redirecting to its **homepage**, with a 200 — so `/products/airsense-11-autoset` "succeeds" while a member clicking it lands on the front page. The pass looks at where the response came from, not only at the status code, and reports that as failed. See [ADR-0017](docs/adr/0017-a-2xx-is-not-proof-that-a-product-page-exists.md).

Two facts about the Discourse admin API that cost time to rediscover:

- On Discourse 2026.8 the field definitions live at **`/admin/config/user_fields.json`**, and they are written with `PUT /admin/config/user_fields/:id.json`. The older `/admin/customize/user_fields` path returns **404** — for the JSON *and* for the admin page, so a bookmark or an older tutorial will send you to a dead URL.
- **A `200` from the write route does not mean the write landed.** An empty option list is discarded, duplicates are silently merged, and the response is a cheerful copy of the field either way. The readback is the only thing that reports whether an apply happened — [ADR-0014](docs/adr/0014-a-write-is-confirmed-by-reading-it-back.md).

---

## 🧭 How it's put together

The rendering surfaces are thin. Everything that can be reasoned about — and tested — lives in `lib/`.

```
javascripts/discourse/
├── lib/                        ← the whole domain, no Ember, no network
│   ├── profile-links.ts          reads settings → LinkConfig; resolves values → ProfileLinks
│   ├── profile-links-config.ts   binds that to the live `settings` global + Site service
│   ├── user-field-source.ts      lookup, dedupe, cache and retry policy for one member
│   ├── post-user-field-source.ts the one place that knows the values come from card.json
│   └── core-field-rows.ts        which of core's plain-text rows a Profile Link replaces
├── components/                 ← the post Link Surface + the shared row
├── connectors/                 ← the card and profile Link Surfaces
├── modifiers/                  ← hides the duplicated core rows
└── initializers/               ← mounts the post surface, reports Config Problems at boot

migrations/settings/            ← one-shot conversions run by Discourse on update
spec/unit/                      ← vitest, node only
docs/adr/                       ← why things are the way they are
CONTEXT.md                      ← the domain glossary. Read this first.
```

### Naming rules 🏷️

- **Use the glossary.** `CONTEXT.md` defines Profile Link, Custom User Field, Field Mapping, Mapping, Link Surface and User Field Source — and lists what _not_ to call them. Code, comments, commits and ADRs all use those words.
- **Connector directories are dictated by Discourse**, not by us: `connectors/<outlet-name>/<anything>.gts`. Renaming the directory unmounts the surface.
- **`lib/` modules are named for the concept they own**, not for the component that calls them — which is why there are three surfaces but one `profile-links.ts`.
- **Everything in `lib/` stays importable from a plain Node test.** No Discourse imports, no Ember imports, no globals. That constraint is the reason the test suite exists at all.

### The three surfaces

The card and profile surfaces are handed a member's field values in their outlet args. A post carries only a username, so the post surface has to fetch — which is why the User Field Source exists, and why it, rather than the component, owns retries. See [ADR-0007](docs/adr/0007-retrying-a-lookup-belongs-to-the-user-field-source.md).

---

## 🛠 Development

**Requirements:** Node 22+ (see `.nvmrc`) and pnpm 10. The `engines` block rejects npm and yarn on purpose.

```bash
pnpm install
pre-commit install   # 👈 don't skip this
```

| Command | What it does |
|---|---|
| `pnpm lint` | stylelint + eslint + prettier + type-check, in parallel |
| `pnpm lint:fix` | fixes everything auto-fixable |
| `pnpm lint:types` | Glint/TypeScript on its own |
| `pnpm test` | unit tests, once |
| `pnpm test:watch` | unit tests, on change |

The catalogue commands — `export:sheet`, `refresh:catalogue`, `build:settings`, `verify:catalogue`, `apply:catalogue` — are in [their own section above](#-the-cpapcom-product-catalogue), with the credentials each one needs.

### 🪝 Git hooks

`pre-commit` runs the same gates before a commit exists, rather than finding out later. The whole suite takes a couple of seconds, so there's no fast/slow split — everything runs every time:

- 🧹 whitespace, end-of-file, line endings, merge-conflict markers, large files
- 🔒 `settings.yml` and `about.json` parse (a broken one blocks the install, not just the build)
- 🚧 refuses a commit directly to `main`
- 🎨 eslint, prettier, stylelint on the staged files
- 🧠 Glint type-check and the full unit suite on the project
- 🧾 `settings.yml`'s generated `profile_link_fields` default still matches the product catalogue it was built from

> ⚠️ Note the hook runs eslint **without `--cache`**, unlike the `lint:js` script. A cached run once reported this branch clean while it held nineteen real errors. A gate that can do that is worse than no gate.

Run it over everything at any time:

```bash
pre-commit run --all-files
```

### 🧪 Testing

Unit tests live in **`spec/unit/`** and run under Node with vitest — no Discourse instance, no network, no DOM.

They are not in `test/` for a concrete reason: Discourse ingests anything in a theme's top-level `test/` directory and serves it at `/theme-qunit`. That directory is reserved for QUnit tests that need a running Discourse. Putting a vitest file there breaks the theme. See [ADR-0003](docs/adr/0003-unit-tests-live-in-spec-not-test.md).

There are no rendering tests yet, which is the main reason `lib/` carries as much of the logic as it does.

---

## 📚 Going deeper

- **[`CONTEXT.md`](CONTEXT.md)** — the domain glossary. Start here.
- **[`docs/adr/`](docs/adr/)** — the decisions, and why. Settings shape, the config adapter, where tests live, why the surfaces stay separate, how duplicate rows are hidden, the settings migration, where retries belong — and how the catalogue pipeline decides what ships, what it may overwrite, what it refuses to touch, and how a generated value is checked against a rule that only Discourse enforces.
- **[`AGENTS.md`](AGENTS.md)** — issue tracker, triage labels and domain-doc conventions for agent workflows.

---

## 🙏 Credits

Based on [discourse-custom-profile-link](https://github.com/Firepup6500/discourse-custom-profile-link) by Firepup6500.
