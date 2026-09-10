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

  /**
   * The source with every comment and string literal blanked out, character
   * for character, so offsets and line structure are unchanged.
   *
   * The sweep below reads source text, and text is satisfied by anything that
   * looks right. An unbounded `fetch(url, {})` whose options hold nothing but
   * a commented-out `signal:` is discovered, its argument slice contains the
   * substring the gate demands, and the request passes the check that exists
   * to catch it — the same trick works with a `signal:` mentioned inside a
   * string. Blanking
   * rather than deleting, because the bracket balancer walks indices: a
   * comment or string holding an unmatched `)` would otherwise end the
   * argument slice early, or run it to the end of the file.
   *
   * A template literal is blanked in pieces, because only its literal chunks
   * are text: the body of a `${...}` is code, and blanking it along with the
   * rest would hide a call rather than reveal one — this function's own
   * failure, arrived at from the other side. So each interpolation goes back
   * through `scan` as the source it is, which is also what lets it hold a
   * nested template, a comment or a string of its own.
   *
   * Not a parser. A parser is what this wants to be, and `typescript` is only
   * present here as a transitive dependency of `@glint/ember-tsc` — importing
   * it would be reaching through a package this repository does not declare.
   * What the scan below has to survive is the code in `scripts/`, and the
   * assertions that follow check it did: every call still found, every one
   * parsed, and none of them reading past its own call.
   */
  function blanked(source: string): string {
    const out = [...source];
    // Whether a `/` here can open a regular expression rather than divide.
    // Division only ever follows a value, and none of these end one.
    const opensRegex = (before: string): boolean =>
      before === "" || "([{,;:=!&|?+-*%~^<>".includes(before);

    const blank = (from: number, to: number): void => {
      for (let index = from; index < to; index += 1) {
        // Newlines are kept so a line number is still a line number, and so a
        // `//` comment cannot swallow the code beneath it.
        if (out[index] !== "\n") {
          out[index] = " ";
        }
      }
    };

    /**
     * Blanks the literal chunks of the template opening at `from`, handing
     * every `${...}` body back to `scan`. Returns the index of the closing
     * backtick, or the end of the source if it never closes.
     */
    function template(from: number): number {
      let at = from + 1;

      while (at < source.length) {
        const char = source[at] as string;

        if (char === "\\") {
          blank(at, Math.min(at + 2, source.length));
          at += 2;
          continue;
        }

        if (char === "`") {
          return at;
        }

        if (char === "$" && source[at + 1] === "{") {
          at = scan(at + 2, true) + 1;
          continue;
        }

        blank(at, at + 1);
        at += 1;
      }

      return source.length;
    }

    /**
     * Blanks every comment and literal from `from` onward. With `untilBrace`
     * it is walking the body of a `${...}` and stops at the `}` that closes
     * it, counting the braces of any object or block it passes on the way —
     * a `}` inside a string or a comment is already gone by then.
     */
    function scan(from: number, untilBrace: boolean): number {
      let at = from;
      let depth = 0;

      while (at < source.length) {
        const two = source.slice(at, at + 2);
        const char = source[at] as string;

        if (two === "//") {
          const end = source.indexOf("\n", at);
          const to = end === -1 ? source.length : end;

          blank(at, to);
          at = to;
          continue;
        }

        if (two === "/*") {
          const end = source.indexOf("*/", at + 2);
          const to = end === -1 ? source.length : end + 2;

          blank(at, to);
          at = to;
          continue;
        }

        if (char === "`") {
          at = template(at) + 1;
          continue;
        }

        if (char === '"' || char === "'" || char === "/") {
          if (char === "/") {
            const before = source.slice(0, at).trimEnd().slice(-1);

            if (!opensRegex(before)) {
              at += 1;
              continue;
            }
          }

          let index = at + 1;

          while (index < source.length) {
            const inner = source[index] as string;

            if (inner === "\\") {
              index += 2;
              continue;
            }

            if (inner === char) {
              break;
            }

            // An unterminated literal would otherwise blank the rest of the
            // file, and a newline ends every one of these.
            if (inner === "\n") {
              break;
            }

            index += 1;
          }

          blank(at + 1, Math.min(index, source.length));
          at = index + 1;
          continue;
        }

        if (untilBrace) {
          if (char === "{") {
            depth += 1;
          } else if (char === "}") {
            if (depth === 0) {
              return at;
            }

            depth -= 1;
          }
        }

        at += 1;
      }

      return source.length;
    }

    scan(0, false);

    return out.join("");
  }

  /** Every source file this sweep reads, with its text already blanked. */
  const blankedSources = new Map(
    commandFiles.map((path) => [path, blanked(readFileSync(path, "utf8"))])
  );

  function sourceOf(path: string): string {
    const source = blankedSources.get(path);

    if (source === undefined) {
      throw new Error(`${path} is not one of the files this sweep reads`);
    }

    return source;
  }

  it("blanks a comment without moving anything after it", () => {
    // The property the bracket balancer depends on: same length, same lines,
    // so an index into the blanked text is an index into the real file.
    for (const path of commandFiles) {
      const source = readFileSync(path, "utf8");

      expect(sourceOf(path)).toHaveLength(source.length);
      expect(sourceOf(path).split("\n")).toHaveLength(
        source.split("\n").length
      );
    }
  });

  it("hides a signal that is only mentioned, not passed", () => {
    // The hole this closes, stated as the two ways of faking a bound request.
    const faked = [
      "await fetch(url, { /* signal: AbortSignal.timeout(1) */ });",
      "await fetch(other, { headers: { note: 'signal: AbortSignal.timeout(' } });",
      "// await fetch(third, { signal: AbortSignal.timeout(1) });",
    ].join("\n");
    const scrubbed = blanked(faked);

    expect(scrubbed).not.toContain("signal: AbortSignal.timeout(");
    // The first two calls are still calls; only the third was a comment.
    expect(fetchCallsIn("synthetic", scrubbed)).toHaveLength(2);
  });

  it("keeps a call that lives inside a template interpolation", () => {
    // The body of a `${...}` is code, not text. Blanking it along with the
    // literal chunks around it hides an unbounded request from the sweep
    // outright — the hole a comment gave, entered from the other side, and
    // worse: a commented-out call at least left the real one visible.
    const interpolated = [
      "const body = `${await fetch(url, { method: 'GET' })}`;",
      "const twice = `${label(`${await fetch(other, { method: 'GET' })}`)}`;",
    ].join("\n");
    const scrubbed = blanked(interpolated);
    const calls = fetchCallsIn("synthetic", scrubbed);

    expect(calls).toHaveLength(2);

    for (const call of calls) {
      expect(call.args).toContain("method:");
    }

    // The literal text on either side of the interpolation is still gone,
    // including the string inside the nested template.
    expect(scrubbed).not.toContain("GET");
    expect(scrubbed).toHaveLength(interpolated.length);
  });

  it("finds the call sites at all, so the sweep is not vacuous", () => {
    const withFetch = commandFiles.filter(
      (path) => fetchCallsIn(path, sourceOf(path)).length > 0
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
   * The `RequestInit` of a `fetch` call: its second top-level argument, or
   * null when it has none.
   *
   * Split on the commas at depth zero, because a comma inside the options
   * object, inside an array, or inside a nested call is not an argument
   * boundary — `fetchArguments` already handed back a balanced slice, so
   * counting brackets across it is enough to find the ones that are.
   */
  function initArgument(args: string): string | null {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;

    for (let at = 0; at < args.length; at += 1) {
      const char = args[at] as string;

      if ("({[".includes(char)) {
        depth += 1;
      } else if (")}]".includes(char)) {
        depth -= 1;
      } else if (char === "," && depth === 0) {
        parts.push(args.slice(start, at));
        start = at + 1;
      }
    }

    parts.push(args.slice(start));

    return parts.length < 2 ? null : (parts[1] as string).trim();
  }

  /**
   * Whether `args` bounds its request: whether it passes an
   * `AbortSignal.timeout()` as the `signal` of an options object written out
   * at the call, which is the only place `fetch` reads one from.
   *
   * Three versions of this check have now been satisfied by something other
   * than a bounded request. `toContain("signal: AbortSignal.timeout(")` over
   * the whole argument list accepted `{ headers: { signal: ... } }`, a header
   * that happens to be named `signal`. Depth alone then accepted two more:
   * `fetch({ signal: AbortSignal.timeout(1000) })`, where the object is the
   * `Request` and `fetch` never reads a `signal` off it, and
   * `fetch(url, cond ? { signal: ... } : {})`, which is unbounded on one of
   * its two branches. Each time the gate was reading something adjacent to
   * the property it is asking about.
   *
   * So the question is asked positionally and structurally: the second
   * top-level argument, required to be an object literal — a variable or a
   * conditional is not something this sweep can vouch for, and returning
   * false is the fail-closed answer — with `signal:` among its own
   * properties, one level in. Depth is counted the way `fetchArguments`
   * balances brackets, over the blanked source, so a brace inside a string
   * or a comment is already gone by the time it is counted.
   */
  function boundsItsRequest(args: string): boolean {
    const init = initArgument(args);

    if (init === null || !init.startsWith("{") || !init.endsWith("}")) {
      return false;
    }

    const depths: number[] = [];
    let depth = 0;

    for (const char of init) {
      if (")}]".includes(char)) {
        depth -= 1;
      }

      depths.push(depth);

      if ("({[".includes(char)) {
        depth += 1;
      }
    }

    return [...init.matchAll(/signal\s*:\s*AbortSignal\.timeout\s*\(/gu)].some(
      (match) => depths[match.index ?? 0] === 1
    );
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
   * bound. `globalThis.fetch(` and Node's `global.fetch(` are the two member
   * calls that *are* that global, so both are spelled out — excluding them by
   * the same rule that excludes `client.fetch(` left standard spellings of
   * the API this sweep exists to bound invisible, and an unbounded one could
   * be added with the floor assertion still green.
   */
  const FETCH_CALL = /(^|[^\w.$])(?:global(?:This)?\.)?fetch\s*\(/gu;

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
    fetchCallsIn(path, sourceOf(path))
  );

  it("finds a fetch that is not spelled `await fetch(`", () => {
    // Non-vacuity for discovery itself, rather than for the assertion it
    // feeds. Three calls here, none of them the spelling the old scan looked
    // for, and three near-misses that are not calls to the global at all —
    // including `myglobal.fetch(`, which the `global` alternative must not
    // start matching in the middle of a longer identifier.
    const spellings = [
      "const pending = fetch(url, { signal });",
      "  return fetch(url, { signal });",
      "await fetch (url, { signal });",
      "await globalThis.fetch(url, { signal });",
      "await global.fetch(url, { signal });",
      "const body = await client.fetch(url);",
      "const cached = prefetch(url);",
      "const stale = myglobal.fetch(url);",
    ].join("\n");

    expect(fetchCallsIn("synthetic", spellings)).toHaveLength(5);
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
      const source = sourceOf(call.path);

      expect(
        (call.args ?? "").length,
        `${call.path}: the sweep read the rest of the file`
      ).toBeLessThan(source.length / 2);
    }
  });

  it("passes an AbortSignal to every one of them", () => {
    for (const call of fetchCalls) {
      expect(
        boundsItsRequest(call.args ?? ""),
        `${call.path} has an unbounded fetch`
      ).toBe(true);
    }
  });

  it("does not count a `signal` outside the options object it must be in", () => {
    // Depth alone was not the question. Both of these put an
    // `AbortSignal.timeout(` exactly one level in, and neither bounds a
    // request: the first has no options argument at all — the object is the
    // `Request`, and `fetch` does not read a `signal` off it — and the second
    // is unbounded whenever the condition is false.
    const [asRequest] = fetchCallsIn(
      "synthetic",
      "await fetch({ signal: AbortSignal.timeout(1000) });"
    );
    const [conditional] = fetchCallsIn(
      "synthetic",
      "await fetch(url, cond ? { signal: AbortSignal.timeout(1000) } : {});"
    );

    expect(initArgument(asRequest?.args ?? "")).toBeNull();
    expect(boundsItsRequest(asRequest?.args ?? "")).toBe(false);
    expect(boundsItsRequest(conditional?.args ?? "")).toBe(false);

    // The comma that separates the arguments is the one at depth zero, not
    // the ones inside the options object.
    const [ordinary] = fetchCallsIn(
      "synthetic",
      "await fetch(urlFor(a, b), { method: 'POST', signal: AbortSignal.timeout(1000) });"
    );

    expect(boundsItsRequest(ordinary?.args ?? "")).toBe(true);
  });

  it("does not count a `signal` that belongs to a nested option", () => {
    // `fetch` reads `signal` off the options object and nowhere else, so a
    // `signal` one level further in is a header named `signal` and the
    // request is unbounded. Both spellings below contain the substring the
    // old assertion looked for, which is what made it a gate that could not
    // fail — and the bounded one is here so the depth rule is not simply
    // rejecting everything.
    const [buried] = fetchCallsIn(
      "synthetic",
      "await fetch(url, { headers: { signal: AbortSignal.timeout(1000) } });"
    );
    const [bounded] = fetchCallsIn(
      "synthetic",
      "await fetch(url, { signal: AbortSignal.timeout(1000), headers: {} });"
    );

    expect(buried?.args).toContain("signal: AbortSignal.timeout(");
    expect(boundsItsRequest(buried?.args ?? "")).toBe(false);
    expect(boundsItsRequest(bounded?.args ?? "")).toBe(true);
  });
});
