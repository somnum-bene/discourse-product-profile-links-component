import { defineConfig } from "vitest/config";

// Unit tests deliberately live in spec/unit rather than test/ — Discourse
// ingests a theme's top-level test/ directory and serves it at /theme-qunit,
// so vitest files placed there would break the theme's QUnit suite.
// See docs/adr/0003-unit-tests-live-in-spec-not-test.md.
export default defineConfig({
  test: {
    include: ["spec/unit/**/*.test.ts"],
    environment: "node",
  },
});
