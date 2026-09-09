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

describe("every request this pipeline makes is bounded", () => {
  /**
   * Swept rather than listed, for the reason the file header gives. Only
   * `verify-catalogue.ts` passed a signal; the other four `fetch` calls — the
   * Google token exchange, the Sheet read, the Shopify survey and the
   * Discourse write loop — could hang indefinitely with nothing on stdout to
   * say why. A fifth call site added later is covered here the moment it
   * exists, without anybody remembering to come back.
   */
  const commandFiles = [
    ...readdirSync("scripts")
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `scripts/${name}`),
    ...readdirSync("scripts/lib")
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `scripts/lib/${name}`),
  ].sort();

  it("finds the call sites at all, so the sweep is not vacuous", () => {
    const withFetch = commandFiles.filter(
      (path) => fetchCallsIn(path, readFileSync(path, "utf8")).length > 0
    );

    expect(withFetch.length).toBeGreaterThanOrEqual(5);
  });

  /**
   * The argument list of the `fetch(` beginning at `from`, found by balancing
   * brackets rather than by looking for a closing line at a fixed indentation.
   *
   * The delimiter this used to use was `\n  });`, which only matched a call
   * closed at exactly two spaces. `scripts/export-sheet.ts` closes its fetch at
   * four, so `indexOf` returned -1, `slice(0, -1)` handed back all but one
   * character of the rest of the file, and a `signal:` belonging to a later
   * call would have carried an earlier unbounded one. A sweep that can be
   * satisfied by a different call site than the one it is looking at is not a
   * gate.
   *
   * Returns null when the brackets do not close, which the caller asserts
   * against — an unparseable call is a failure here, not a pass.
   */
  function fetchArguments(source: string, from: number): string | null {
    let depth = 0;

    for (let at = from; at < source.length; at += 1) {
      if ("({[".includes(source[at] as string)) {
        depth += 1;
      } else if (")}]".includes(source[at] as string)) {
        depth -= 1;

        if (depth === 0) {
          return source.slice(from + 1, at);
        }
      }
    }

    return null;
  }

  /**
   * A call to `fetch`, however it is spelled.
   *
   * Discovery used to be `indexOf("await fetch(")`, which is a promise this
   * sweep could not keep: `return fetch(...)`, a call assigned before it is
   * awaited, and `await fetch (url)` are all invisible to it, and the floor
   * assertion below stays green on the five it can see while a sixth,
   * unbounded, goes unchecked. The claim in the header is that a call site
   * added later is covered the moment it exists, so discovery has to be about
   * the call expression rather than one way of writing it.
   *
   * The leading character class is what keeps `client.fetch(` and
   * `prefetch(` out: a member call on some other object is a different
   * function, and the global `fetch` is the only one this pipeline has to
   * bound. `globalThis.fetch(` is the one member call that *is* that global,
   * so it is spelled out — excluding it by the same rule that excludes
   * `client.fetch(` left a standard spelling of the API this sweep exists to
   * bound invisible, and an unbounded one could be added with the floor
   * assertion still green.
   */
  const FETCH_CALL = /(^|[^\w.$])(?:globalThis\.)?fetch\s*\(/gu;

  function fetchCallsIn(
    path: string,
    source: string
  ): { path: string; args: string | null }[] {
    return [...source.matchAll(FETCH_CALL)].map((match) => ({
      path,
      // The index of the `(` itself, which is where the bracket balance starts.
      args: fetchArguments(source, (match.index ?? 0) + match[0].length - 1),
    }));
  }

  /** Every `fetch` call in the pipeline, with its arguments. */
  const fetchCalls = commandFiles.flatMap((path) =>
    fetchCallsIn(path, readFileSync(path, "utf8"))
  );

  it("finds a fetch that is not spelled `await fetch(`", () => {
    // Non-vacuity for discovery itself, rather than for the assertion it
    // feeds. Three calls here, none of them the spelling the old scan looked
    // for, and two near-misses that are not calls to the global at all.
    const spellings = [
      "const pending = fetch(url, { signal });",
      "  return fetch(url, { signal });",
      "await fetch (url, { signal });",
      "await globalThis.fetch(url, { signal });",
      "const body = await client.fetch(url);",
      "const cached = prefetch(url);",
    ].join("\n");

    expect(fetchCallsIn("synthetic", spellings)).toHaveLength(4);
  });

  it("parses every call it found, so no scan runs off the end", () => {
    // The old delimiter failed silently on two of the five. This is the
    // assertion that would have said so.
    for (const call of fetchCalls) {
      expect(
        call.args,
        `${call.path} has a fetch this sweep cannot parse`
      ).not.toBeNull();
    }

    expect(fetchCalls.length).toBeGreaterThanOrEqual(5);
  });

  it("stops at the end of the call, not at the end of the file", () => {
    // The failure mode in one assertion: no parsed call may reach as far as
    // the file it lives in. `export-sheet.ts` scanned 4315 of 4316 remaining
    // characters before this.
    for (const call of fetchCalls) {
      const source = readFileSync(call.path, "utf8");

      expect(
        (call.args ?? "").length,
        `${call.path}: the sweep read the rest of the file`
      ).toBeLessThan(source.length / 2);
    }
  });

  it("passes an AbortSignal to every one of them", () => {
    for (const call of fetchCalls) {
      expect(call.args ?? "", `${call.path} has an unbounded fetch`).toContain(
        "signal: AbortSignal.timeout("
      );
    }
  });
});
