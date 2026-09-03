# Build-time scripts

Everything in here runs on a developer's machine or in CI. None of it ships to a
browser — that is what `javascripts/` is for, and putting a script there would
send the catalogue pipeline to every forum visitor.

The commands and what each one is allowed to touch:

| Command                  | Reads                                    | Writes                                                 | Configuration                                                       |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `pnpm export:sheet`      | three allowlisted spreadsheet tabs       | `data/user_*.csv`, `data/collection-assignment.csv`    | `SHEET_WORKBOOK_ID`, `GOOGLE_SERVICE_ACCOUNT_*` (3)                 |
| `pnpm refresh:catalogue` | `data/` Sheet Exports, Shopify Admin API | `data/resolved-products.csv`, `.ig.catalogue-review.md` | `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_API_TOKEN`                          |
| `pnpm build:settings`    | `data/resolved-products.csv`             | `settings.yml`                                         | none, so it runs in CI                                              |
| `pnpm verify:catalogue`  | `data/resolved-products.csv`, cpap.com    | nothing — it prints                                    | none, and it cannot read `.env`                                     |
| `pnpm apply:catalogue`   | `data/resolved-products.csv`, `settings.yml` | one Discourse instance                             | `DISCOURSE_BASE_URL`, `DISCOURSE_API_USERNAME`, `DISCOURSE_API_KEY` |

Configuration comes from an ignored `.env`, read by Node's own
`--env-file-if-exists`, and is never logged, never printed in an error, and
never committed. The two commands that need nothing omit that flag on purpose: a
command that *could* read `.env` is one that might come to depend on it, and then
it could no longer run in CI.

## The Sheet Export refuses more than it accepts

`export:sheet` fetches three tabs. It was written against a workbook that also
held roughly 124,000 real usernames and email addresses two clicks away, and
this repository is public. Those two facts set the design, and it keeps them
now that the workbook is the internally-owned cpap.com Sheet: a guard that only
runs while the danger is visible is a guard you find out about too late.

- **The workbook id is configuration, not a constant.** It names a private
  internal workbook, and this repository is public, so committing it would
  publish which Sheet to go and ask for. It lives in `.env` as
  `SHEET_WORKBOOK_ID` and the run aborts without it. (It is not a public link
  to customer data, which is what the inherited spreadsheet was — the id is
  withheld for a weaker reason than it used to be, and still withheld.)
- **The allowlist is the only way through.** `SHEET_TABS` names the two option
  tables and, for each, the exact header row and the two columns read from it;
  `ASSIGNMENT_TABS` names the Collection Assignment and its eleven. A name becomes a URL
  only via `tabNamed` or `assignmentTabNamed`, each of which refuses anything
  unlisted, and the command itself contains no tab name and builds no URL — a
  test enforces both, because an allowlist you can go around is a convention.
- **Three independent guards, all fail-closed.** The header row must match
  exactly; the row count must stay under a ceiling these tabs are nowhere near
  and the personal-data tabs are far above; no cell may look like an email
  address. Each catches a restructured workbook the other two would miss. A
  surprise stops the run — skipping it is not safe.
- **Nothing is written until every tab passes.** A partial run would leave one
  refreshed export beside a stale one, which is worse than leaving both.

Two shapes of tab, and deliberately not one. The `user_*` option tables reduce
to a Suggested Title and a Suggested URL, which is genuinely all they
contribute. The Collection Assignment is eleven columns of human
curation that reduce to nothing: `Recommended Collection URL` is a proposal,
`Override` can replace it, and `Disposition` decides whether either is used.
Squeezing that into `titleColumn`/`urlColumn` would have to drop columns or lie
about the two it kept, so `AssignmentTab` sits beside `SheetTab` rather than
replacing it — the guards are shared, the shape is not. Reading the Collection
Assignment is all this command does with it: applying an `Override` and refusing an
`undecided` `Disposition` are the transform's decisions, not the export's.

`data/user_humidifier.csv` is retired rather than deleted (ADR-0022). `Humidifier`
was dropped from `SHEET_TABS` and this command no longer fetches or writes it,
but the file stays as a historical record of what shipped before, the same way
a row leaving `data/resolved-products.csv` is a diff rather than a rewrite of
history. Deleting it was considered and rejected: nothing reads it, so keeping
it costs nothing, and it is the only record of what the tab held.

Exports are written with every field quoted, LF endings and no final newline,
which is why `data/` is exempt from the whitespace-fixing pre-commit hooks.
Every cell is verbatim, but the bytes are **reconstructed** rather than passed
through: the Sheets API answers with JSON row arrays, and `valuesToCsv` writes
them back out in the shape the old CSV endpoint returned. The comment in
`export-sheet.ts` used to claim "byte for byte as the endpoint returned it",
and that stopped being true when the source changed — provenance that
overstates itself is worse than provenance that says what it is.

Two details of that reconstruction are load-bearing. The tab is addressed by
_name_, never by a numeric gid a workbook is free to reassign, because the
allowlist is written in names. And the range is **pinned to the width the
allowlist declares** (`'user_machine'!A1:E`, `'collection-assignment'!A1:K`)
rather than left open, for two reasons: asked for an open range the API returns
whatever width the data happens to occupy, so a twelfth column on an
eleven-column tab would join the export under a header the guard never checked;
and the API omits trailing empty cells, so a row with no `Suggested URL` comes
back three cells wide. `valuesToCsv` pads every row back to the declared width
— which never invents a column, because the width came from the header row the
guard is about to check.

## Reading the Sheet needs a credential, not a sharing setting

The cpap.com Sheet cannot be made link-readable, so the anonymous `fetch()`
this command used against the inherited workbook cannot reach it. Two separate
Workspace policies are in the way, and it is worth knowing both, because the
first one is the one people try to fix and the second is the one that actually
decides the design:

- **"Anyone with the link" is blocked** by org policy. That killed the
  unauthenticated CSV endpoint.
- **Sharing the file _to_ a service account is also blocked** —
  `...iam.gserviceaccount.com` is not an allowlisted domain, and a Workspace
  admin can only allowlist domains they administer, not arbitrary external
  ones. So the obvious fix, "share it with the robot as Viewer", is not
  available either.

What works instead is **domain-wide delegation**: the service account's OAuth
client id is authorised for one scope
(`https://www.googleapis.com/auth/spreadsheets.readonly`) in Admin Console →
Security → API controls, which lets it act as a real Workspace user who already
has ordinary access to the Sheet. The service account holds no access to the
file at all — it borrows some. `lib/sheets-auth.ts` builds the JWT Bearer grant
(RFC 7523) for that by hand with `node:crypto`, on the same grounds `parseCsv`
is hand-rolled: this is the part that holds a private key, and a dependency
that surprises us here is worse than one we can read.

Three variables, in the ignored `.env`:

```
GOOGLE_SERVICE_ACCOUNT_EMAIL              # the JWT's `iss`
GOOGLE_SERVICE_ACCOUNT_IMPERSONATE_EMAIL  # the JWT's `sub` — the user it acts as
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY        # PEM, newlines escaped as \n
```

`sub` is the claim the whole mechanism turns on, and leaving it out fails in
the least helpful way available: the token endpoint answers **200 and hands
over a token** for the service account itself, which then collects a `403
PERMISSION_DENIED` from the first tab it asks for. Nothing in either response
mentions the claim set. Verified against the live endpoint, because the
handoff this was built from claimed the token request fails instead.

`unauthorized_client` is the *other* failure, and it means the opposite: `sub`
was sent, and the delegation grant is missing or still propagating.

### What this key can actually do

Worth stating plainly, because the paragraphs above describe it as borrowing
one configured person's access and that undersells it. `sub` is a claim in an
assertion this code signs, not a restriction the grant imposes. Whoever holds
the private key can sign an assertion naming **any** cpap.com Workspace user as
`sub`, and read every Sheet that user can open. `GOOGLE_SERVICE_ACCOUNT_IMPERSONATE_EMAIL`
is this repository's choice of subject; it is not a limit on the credential.

So the blast radius of a leaked key is *read access to every Google Sheet in
the domain*, not read access to one workbook. That is inherent to domain-wide
delegation, and it is the mechanism we have: the org's policy blocks link
sharing and blocks sharing a file to a service account, which is what the two
bullets above are about. There is no narrower version of this that still works
without a dedicated Workspace user with its own OAuth credentials — a separate
piece of admin work, deliberately not done here.

**Accepted, with these bounds:**

| Control | What it bounds |
| --- | --- |
| One authorised scope | `spreadsheets.readonly` and nothing else. Sheets only, read only — no Drive, no Gmail, no writes. Widening it is an Admin Console change, not a code change. |
| Scope named in code | `SHEETS_READONLY_SCOPE` is asked for by name in `lib/sheets-auth.ts`, so a wider console grant still does not widen what this command requests. |
| Key never in the repository | It lives only in the ignored `.env`. Nothing logs it, nothing prints it in an error, and `credentialsFrom`'s refusals are asserted not to echo the material. |
| Read-only by construction | This code cannot write to the Sheet even if asked to. Correcting the Sheet is a human editing it, followed by a re-export. |
| Revocable in one place | Removing the client id from Admin Console → Security → API controls → Domain-wide delegation kills the credential outright, without touching the repository. |

Raised by code review on PR #45. Accepted for an internal read-only export
rather than redesigned, on the grounds that the alternative is an admin round
trip for a dedicated least-privilege user and the controls above bound it to
domain-wide Sheets *reads* with a single revocation point. Reconsider if this
credential is ever wanted for anything beyond exporting these tabs.

The escaped `\n` is the other trap. A PEM holds real newlines, `.env` cannot,
and Node's `--env-file` hands the value over still escaped — so a key used as
read is a string that looks right, signs nothing, and fails at the token
endpoint with an error about the *client* rather than about the key.
`credentialsFrom` unescapes it and then asks OpenSSL to parse it, so that
becomes one legible refusal at startup rather than a puzzle three layers down.
Neither the key nor the underlying parse error is ever printed: a refusal that
quoted the key would put it in a terminal and a CI transcript.

**This mechanism depends on a real person's access.**
`GOOGLE_SERVICE_ACCOUNT_IMPERSONATE_EMAIL` has to name a Workspace user who can
open the Sheet. If that person loses access, changes address, or leaves, the
export breaks — and it breaks at the token or fetch step with a message about
authorisation, not with anything that says "someone left". Worth knowing before
it happens.

No token caching or refresh: the command gets one read-only token, fetches a
handful of tabs, and exits well inside the hour.

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
cannot fetch a product the transform never consults. Each of the two divisions
is then surveyed for what it currently sells, which is the only way to answer
"what does cpap.com sell that the spreadsheet never mentions". A refused query
arrives as HTTP 200 with an `errors` array, so the body is checked rather than
the status code.

Everything it decides is in `lib/catalogue-refresh.ts` and reached by tests. The
access token is never passed into that file at all: the command reads it and puts
it in a header, so no function that could log something has it.

A field whose tab curates no Suggested columns at all produces no Mappings and
the run says so. An empty field is reported two different ways on purpose —
"expected, the tab curates none" for that case, and "that is a problem" for a
field that curates titles and resolved none of them. Printing one message for
both would make the broken case look like the intended one. No current tab is
in the first state — `user_humidifier` was, until ADR-0022 retired it — but the
distinction stays because a future tab could be.

## The build generates part of a hand-written file, and a gate keeps it honest

`build:settings` turns the Resolved Product Catalogue into the `default:` of
`profile_link_fields`, which is how the catalogue reaches an instance (ADR-0008).
It is the one command that needs no configuration at all — the catalogue is
committed — and the npm script deliberately omits the `--env-file-if-exists` flag
the other two carry, because a build that _could_ read `.env` is a build that
might one day depend on it. That is what lets the gate run in CI.

`settings.yml` is mostly hand-written: the schema the Mappings are validated
against, the descriptions an administrator reads, and a second setting that has
nothing to do with the catalogue. So the generated part is fenced, and only that
part is rewritten:

```yaml
  # BEGIN GENERATED profile_link_fields default
  # Catalogue digest (sha256): c3c3c7d9…
  default: …
  # END GENERATED profile_link_fields default
```

Reserialising the whole document would reformat and comment-strip parts nobody
edited, and a diff full of incidental reformatting is a diff nobody reads. The
fences are found by exact line match; one that has been edited, moved or deleted
stops the run rather than being guessed at, because they are the only statement
of which part of a hand-written file is not hand-written.

**The digest is recorded because two sinks are generated from one catalogue**
(ADR-0011). The Mappings ship in this file; the Dropdown Options are pushed to a
site separately. Recording which catalogue the shipped Mappings were built from is
what lets the apply step notice it is working from a different one — a site whose
dropdown offers titles the shipped Mappings do not cover produces an Unmatched
Value for every user who picks one, and nothing is logged unless Debug Mode is on.

**`pnpm build:settings --check` is the drift gate**, and it runs in CI and as a
pre-commit hook. It rebuilds the file in memory, compares bytes, and writes
nothing whatever it finds — a gate that repaired what it was inspecting would
report success on a repository nobody had fixed. A hand edit and a catalogue that
moved on without a rebuild look identical in the file and have the same remedy,
so one message covers both: regenerate. The same comparison is also a unit test
against the real files, which is why a stale `settings.yml` fails `pnpm test`
too.

## The gates that stand in front of a bad regeneration

The drift gate answers "is this file what the build would write". It does not
answer "will Discourse accept it", and two separate things could go wrong there,
so two more assertions run against the real `settings.yml` rather than against a
copy of it.

The first feeds the shipped `default:` through the component's own
`readLinkConfig` with the two Managed Fields standing in for the site, and
requires no Config Problems. Those stubs are named from the Sheet Export
allowlist rather than derived from the file, and that is the whole point: a stub
list built from the shipped Field Mappings would rename itself along with a
renamed field and pass a value no instance could use.

The second is `refusedUrls`, and it exists because `readLinkConfig` checks that a
Mapping has a URL, not that the URL is one. URL syntax is the schema's
`validations: url: true`, enforced server-side by Ruby, on an administrator's
input — a generated `default:` never passes through it during development. And a
single refusal invalidates the entire `profile_link_fields` value rather than the
one offending Mapping (ADR-0006), so one bad URL takes all 55 Profile Links down
with it.

So `settings-schema.ts` mirrors `UrlHelper.is_valid_url?`, which is the method
that validation reaches. The Ruby is quoted in the module, the expectations were
settled by running it rather than by reading it, and two of its behaviours are
worth knowing before you debug a rejected setting:

- **An uppercase scheme is refused.** `uri.scheme` comes back downcased and is
  interpolated into a match against the raw string, so `HTTPS://example.com` can
  never satisfy it.
- **A URL the Ruby parser refuses outright never reaches the scheme check.** A
  space, a `™`, an unfinished `%` escape: the parser raises and the raise is
  rescued into `false`.

The mirror is deliberately narrower than Discourse in three places, all listed in
the module. Narrowing can only raise a false alarm about a URL shape this
pipeline does not generate; accepting one Discourse refuses is the failure a gate
exists to prevent, and narrowing cannot cause it.

Nothing in the build re-decides anything. Which titles ship, what they link to
and the order they appear in are settled by `buildCatalogue` and recorded in the
catalogue file, and the build lays out the order it was given. A catalogue edited
by hand after it was approved is refused before any of that: it is read through
`readResolvedProducts`, which recomputes the digest on its first line.

## The apply step decides before it writes, and refuses by default

`planApply` is the whole decision, and it is a function rather than a command:
give it one instance's Custom User Field definitions as data and the Resolved
Product Catalogue, and it returns an Apply Plan — the writes, the refusals, the
warnings, and the fields already holding exactly the right options. It touches
no network, and the command that will carry the plan out is not built yet.

That split is not tidiness. Writing Dropdown Options destroys site data no commit
can restore, and a User holding a removed value silently stops getting a Profile
Link, with nothing logged unless Debug Mode is on. Discovering this behaviour by
running it against a live instance is how that data gets lost, so every question
worth arguing about is answered against a fixture — and the fixture is the test
instance's own two Managed Fields, because every hard case is already in them.

**Refusal is about removal, not authorship** (ADR-0013). There is nowhere in
Discourse to record that this pipeline wrote an option, so an option we wrote
last month and one an administrator typed are the same bytes. An option the
catalogue still carries is kept; anything else is something the write would take
away, and that needs `replace`. The refusal names every option it would remove,
and annotates each with the target option it is probably a respelling of —
`AirCurve™ 11 VAuto with HumidAir™` against `AirCurve 11 VAuto with HumidAir` is
the real case, and no amount of reading the two lists side by side reveals it.
That annotation never decides anything: matching stays exact, because Discourse
stores what the User picked.

A refusal on one field empties the write list for all of them. A field already
correct produces no writes and is named rather than passed over, which is what
makes a second run safe. And a field this pipeline does not cover is never
touched as a side effect of populating `Machine` and `Mask` (ADR-0012).

## The apply step believes the reread, not the response code

`apply:catalogue` carries a plan out against the instance named by
`DISCOURSE_BASE_URL`, which is the only thing that differs between the test and
production sites. It writes each field with one `PUT` to
`/admin/config/user_fields/:id.json` — the `/admin/customize/` path the admin UI
shows in its own address bar answers 404 for JSON and will convince you the API
does not exist.

```bash
pnpm apply:catalogue --plan               # decide and print, write nothing
pnpm apply:catalogue                      # apply, refusing any removal
pnpm apply:catalogue --replace            # authorise removals, having read them
pnpm apply:catalogue --clear "Sleep Position" # refused: see below
```

**The route answers `200 OK` to a write it discards** (ADR-0014). An empty
`options` array is ignored, because Rails turns an empty array parameter into
`nil` before the controller sees it, and a repeated option is silently
deduplicated. The response body echoes the server's version, so it is no help
either. That is why the command rereads the field definitions afterwards and
compares them against the catalogue, and why a run can otherwise be green from
end to end and have changed nothing.

The same probing established that **a dropdown cannot be emptied at all**
(ADR-0015), which contradicts a promise ADR-0011 made. Five payload shapes were
tried; the ones that are not ignored leave the field offering one blank choice.
The only operations that reach zero destroy every value Users have stored, so
`--clear` is refused before the first request rather than doing the nearest thing
that appears to work. A field this pipeline does not populate keeps whatever
options it already has and the run says so every time.

Three more things it does before writing anything, in this order:

- **Compares the two digests.** `settings.yml` records the catalogue its Mappings
  were built from; the catalogue declares its own. A difference means the two
  sinks would come from different catalogues, so it refuses — the fix is one
  command.
- **Asks the instance what Mappings its component actually has.** The digest
  cannot be compared against a site: it is a comment in `settings.yml` and
  comments do not ship. So the Mappings themselves are compared, and a component
  that is not installed, or is behind, or has been overridden through the theme
  settings UI, is reported as a warning. Not a refusal — the two sinks land at
  different times by different mechanisms, and an undeployed theme is an ordinary
  state of the world.
- **Finds the component by the setting it defines**, not by a theme id in `.env`.
  A second per-instance variable is a second thing that can go stale and report
  the wrong site's configuration confidently.

Each write is one whole field, and every key the instance reported comes back
unchanged except `options` — omitted keys were observed to survive, but the
update route takes a field object rather than a patch and there is no reason to
depend on that. An interrupted run is repeated rather than repaired: the next run
replans against whatever the instance now holds.

## The reachability pass is the one check that is not a gate

`pnpm verify:catalogue` asks cpap.com whether each of the 55 catalogue URLs
serves a page. It is in no pre-commit hook and no CI step, unlike every other
check here, and unit tests read `package.json`, `.pre-commit-config.yaml` and
`.github/workflows/ci.yml` to keep it that way — including inside another npm
script, because anything `pnpm build:settings` called would gate CI just as
surely (ADR-0018). The reason is the storefront's rate limiter: eight concurrent
requests produced 429 on 68 of 86 URLs during planning, so the pass is sequential
with a pause between requests, and a commit that cannot be made while cpap.com is
busy is a gate failing for reasons nobody here controls.

Three things about it are worth knowing before changing it.

**A 2XX is not proof the page exists.** cpap.com serves a product handle it no
longer has by redirecting to its homepage, with a 200 — measured, not
hypothesised: `/products/airsense-11-autoset` answers 200 from
`https://www.cpap.com/#erid51316016`. So the landing URL is part of the verdict.
A redirect that stays on `/products/<handle>` is a moved product and still
verified, with a correction proposed; a redirect off it is a Soft 404 and fails
with its 200 intact (ADR-0017). This is why the pass follows redirects rather
than handling them itself, and why it uses `GET` rather than `HEAD`.

**Unresolved is a third outcome, not a flaky failure.** A URL that answered 429
or 503 on every attempt, or that nothing answered at all, produces no evidence
either way — so it is neither a pass nor a failure, it blocks shipping, and the
pass is run again. Folding it into either of the other two is exactly the mistake
the outcome exists to prevent: cpap.com throttling reads as a broken product page
otherwise. A 500 or a 502, by contrast, *is* an answer and is reported as a
failure with its status, because retrying past it would substitute a guess for
the human judgement it needs.

**The command decides nothing.** What a status code means, how long to wait, when
to stop asking, what to propose and whether the catalogue is shippable are all in
`lib/catalogue-verify.ts`, including the refusal to accept any command-line
argument — every flag the pass could plausibly have is a way of declaring the
catalogue verified without having verified it, and a refusal in an untested shell
is one a mistake can quietly remove.

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

## What the lint gates actually cover

`pnpm lint` is four gates, and three of them decide for themselves which files
they look at: `lint:js` (eslint), `lint:prettier` and `lint:css` (stylelint) take
globs, while `lint:types` follows `tsconfig.json`'s `include` instead. The
pre-commit hooks run the same tools over the same paths, expressed as `files:`
regexes rather than globs — one intention written down twice, which is why
`spec/unit/lint-gates.test.ts` asserts the two stay in step.

The paths are the source directories — `javascripts`, `migrations`, `scripts`,
`data`, `test`, `spec` — **and the repository root itself**. The root is in
there because the files deciding how everything else gets linted live beside
`package.json` rather than inside any of those directories: `.prettierrc.cjs`,
`eslint.config.mjs`, `stylelint.config.mjs` and `vitest.config.mjs` were checked
by nothing at all until the gates were widened to reach them. Root coverage is
one level and no deeper — `[^/]+` in the hooks, an unstarred glob in the
scripts — and it accepts `.js`, `.mjs` and `.cjs`, which is what a config file
at that level is written in. A new root config file is picked up by the same
patterns without anyone editing them; the test discovers the files rather than
listing them, so it is covered too.

**Markdown is deliberately outside prettier**, and pulling it in is not a
tidy-up: every tracked `.md` file would reformat, and the prose in them is
wrapped by hand for reading. A test asserts the exclusion, so a later widening
cannot take markdown along with it by accident.

## Where the logic lives

`buildCatalogue`, `settingsWithCatalogue`, `isValidUrl`, `planApply`, the verify
pass's `resultFrom` / `shippability`, and the apply transport's
own judgements — which URL, what payload, whether the instance did what it was
asked — hold every decision worth testing, and they are pure: no network, no
filesystem, no clock. The commands around them are thin shells: fetch, read,
write, execute a plan. If a bug can hide in a shell, logic has leaked out of a
transform and belongs back inside it. The one thing the apply command decides for
itself is *when* to consult the plan, and a test pins that order, because it is
the only mistake a shell can make on its own.

Tests live in `spec/unit/`, never in `test/` — Discourse serves a theme's
`test/` directory at `/theme-qunit`. See `docs/adr/0003`.
