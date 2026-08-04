# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

`CONTEXT.md` is the **only** glossary. If a `UBIQUITOUS_LANGUAGE.md` appears at the repo root, it is a regenerated proposal from the `/ubiquitous-language` skill, which overwrites it wholesale on every run — fold anything worth keeping into `CONTEXT.md`, delete it, and never read it as authoritative. Two glossaries drift, and a glossary that disagrees with itself is worse than one with gaps.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is single-context:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-structured-objects-setting-replaces-csv-strings.md
│   ├── 0002-config-adapter-joins-settings-with-site-user-fields.md
│   ├── 0003-unit-tests-live-in-spec-not-test.md
│   ├── 0004-link-surfaces-stay-separate.md
│   ├── 0005-core-duplicate-rows-are-hidden-by-a-modifier-not-static-css.md
│   ├── 0006-a-settings-migration-replaces-uninstall-and-re-add.md
│   └── 0007-retrying-a-lookup-belongs-to-the-user-field-source.md
└── javascripts/discourse/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0004 (Link Surfaces stay separate) — but worth reopening because…_
