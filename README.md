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
| 🧪 **Actually tested** | 82 unit tests over the pure modules, runnable in a second with no Discourse instance. |

---

## ⚙️ Configuration

### `profile_link_fields`

The Field Mappings, edited in Discourse's structured settings editor. Each **Field Mapping** names one Custom User Field and nests the **Mappings** that turn its values into Profile Links:

- **`user_field_name`** — the field's name, exactly as it appears in `/admin/customize/user_fields`. **Case-sensitive.**
- **`mappings`** — one or more value/URL pairs:
  - **`value`** — must match the member's field value exactly.
  - **`url`** — where the Profile Link points. Discourse validates it as you type.

A value that matches no Mapping renders nothing. An empty configuration is valid — it just renders nothing at all.

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
| `pnpm build:settings` | regenerates the `profile_link_fields` default from the product catalogue |
| `pnpm build:settings --check` | fails if `settings.yml` and the catalogue disagree — needs no credentials |

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
- **[`docs/adr/`](docs/adr/)** — the decisions, and why. Settings shape, the config adapter, where tests live, why the surfaces stay separate, how duplicate rows are hidden, the settings migration, where retries belong.
- **[`AGENTS.md`](AGENTS.md)** — issue tracker, triage labels and domain-doc conventions for agent workflows.

---

## 🙏 Credits

Based on [discourse-custom-profile-link](https://github.com/Firepup6500/discourse-custom-profile-link) by Firepup6500.
