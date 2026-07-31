# Standalone unit tests live in `spec/`, not `test/`

Discourse ingests a theme's top-level `test/` directory, storing its contents as theme test files and loading them into the Discourse application at `/theme-qunit`. Our unit tests import `vitest` and run under Node against the pure modules, so putting them in `test/` would upload them into Discourse and break the theme's QUnit suite. They live in `spec/`, which Discourse does not recognise as a theme directory and therefore ignores.

They live specifically in `spec/unit/`, because the Discourse theme skeleton already claims `spec/system/` for Ruby rspec system specs. The two suites sit side by side under `spec/` without either one having to know about the other.

## Consequences

`test/` stays free for genuine `/theme-qunit` rendering tests, which need a running Discourse. Adding those later does not conflict with `spec/` — the two suites are independent and run in different places.

The failure mode here is silent: nothing warns you that `test/` is special, and the breakage shows up only when someone loads `/theme-qunit`. That is the reason this is written down rather than left to convention.
