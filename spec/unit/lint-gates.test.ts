import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The lint gates are defined twice — once as npm scripts, which is what CI
 * runs, and once as pre-commit hook `files:` patterns, which is what decides
 * whether a hook fires on a staged file. Both were scoped to a list of source
 * directories, so the root configuration files that *define* the gates were
 * checked by neither. These tests pin the widening in both places, because a
 * gate that stops covering something goes on reporting success.
 */

/**
 * Discovered rather than listed: a fifth root config file added next year is
 * covered by the same widening, and should be held to it without anyone
 * remembering to edit this file.
 */
const rootConfigFiles = readdirSync(".")
  .filter((name) => /\.(js|mjs|cjs)$/.test(name))
  .sort();

const preCommit = parse(readFileSync(".pre-commit-config.yaml", "utf8")) as {
  repos: { hooks: { id: string; files?: string }[] }[];
};

const scripts = (
  JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

/**
 * pre-commit matches a hook's `files:` against the repository-relative path of
 * each staged file. The patterns here use nothing the two regex dialects
 * disagree about, so reading them with `RegExp` tests the pattern that will
 * actually run rather than a restatement of it.
 */
function hookPattern(id: string): RegExp {
  const hook = preCommit.repos
    .flatMap((repo) => repo.hooks)
    .find((candidate) => candidate.id === id);

  if (!hook?.files) {
    throw new Error(`No pre-commit hook named ${id} carries a files pattern`);
  }

  return new RegExp(hook.files);
}

const eslintHook = hookPattern("eslint");
const prettierHook = hookPattern("prettier");

describe("the files that decide how everything else is linted", () => {
  it("finds the root config files this repository actually has", () => {
    // A floor rather than an exact list: a fifth root config file should be
    // picked up and held to the same gates without failing this test first.
    // Some floor is needed, though — without it the discovery above could
    // quietly return nothing and every other test here would pass over an
    // empty list.
    expect(rootConfigFiles).toEqual(
      expect.arrayContaining([
        ".prettierrc.cjs",
        "eslint.config.mjs",
        "stylelint.config.mjs",
        "vitest.config.mjs",
      ])
    );
  });

  it.each(rootConfigFiles)("stages %s into the eslint hook", (file) => {
    expect(eslintHook.test(file)).toBe(true);
  });

  it.each(rootConfigFiles)("stages %s into the prettier hook", (file) => {
    expect(prettierHook.test(file)).toBe(true);
  });

  it("hands the repository root to eslint in CI, not only to the hook", () => {
    // A hook is per-clone and bypassable with --no-verify; the npm script is
    // the copy CI runs. Both dotted and undotted names, because .prettierrc.cjs
    // is matched by neither pattern alone.
    for (const script of [scripts["lint:js"], scripts["lint:js:fix"]]) {
      expect(script).toContain("'*.{js,mjs,cjs}'");
      expect(script).toContain("'.*.{js,mjs,cjs}'");
    }
  });

  it("hands the repository root to prettier in CI, not only to the hook", () => {
    for (const script of [
      scripts["lint:prettier"],
      scripts["lint:prettier:fix"],
    ]) {
      expect(script).toContain("'*.{js,mjs,cjs}'");
      expect(script).toContain("'.*.{js,mjs,cjs}'");
    }
  });

  it("accepts .mjs and .cjs inside the source directories too", () => {
    // The prettier gates listed js/gjs/ts/gts/mts/cts, so a .mjs added under
    // scripts/ would have been skipped for its extension even though the
    // directory matched. No such file exists yet — this is the gap closed
    // before something lands in it.
    expect(prettierHook.test("scripts/lib/something.mjs")).toBe(true);
    expect(prettierHook.test("scripts/lib/something.cjs")).toBe(true);

    for (const script of [
      scripts["lint:prettier"],
      scripts["lint:prettier:fix"],
    ]) {
      expect(script).toContain("{js,gjs,mjs,cjs,ts,gts,mts,cts}");
    }
  });
});

describe("what the widened gates still leave alone", () => {
  it("reaches the repository root and no deeper", () => {
    // `[^/]+` rather than `.*`: the point was four files beside package.json,
    // not every JavaScript file in the checkout.
    for (const path of [
      "node_modules/some-package/index.js",
      "node_modules/some-package/index.cjs",
    ]) {
      expect(eslintHook.test(path)).toBe(false);
      expect(prettierHook.test(path)).toBe(false);
    }
  });

  it("keeps markdown outside prettier", () => {
    // Deliberate and older than this change: thirteen tracked .md files would
    // reformat, and the prose in them is hand-wrapped for reading.
    for (const path of ["README.md", "scripts/README.md", "docs/adr/0001.md"]) {
      expect(prettierHook.test(path)).toBe(false);
    }

    for (const script of [
      scripts["lint:prettier"],
      scripts["lint:prettier:fix"],
    ]) {
      expect(script).not.toContain("md,");
      expect(script).not.toContain(",md");
      expect(script).not.toContain(".md");
    }
  });

  it("still covers everything it covered before", () => {
    // The alternation is the kind of edit that closes one gap by opening
    // another, and a lint gate that stops matching reports success.
    expect(eslintHook.test("javascripts/discourse/lib/profile-links.ts")).toBe(
      true
    );
    expect(eslintHook.test("spec/unit/lint-gates.test.ts")).toBe(true);
    expect(
      eslintHook.test(
        "migrations/settings/0002-drop-empty-profile-link-fields-override.js"
      )
    ).toBe(true);

    expect(
      prettierHook.test("javascripts/discourse/lib/profile-links.ts")
    ).toBe(true);
    expect(prettierHook.test("common/common.scss")).toBe(true);
  });
});
