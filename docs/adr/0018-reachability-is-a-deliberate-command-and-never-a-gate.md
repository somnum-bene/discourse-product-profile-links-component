# Reachability is a deliberate command, and never a gate

Every other check in this repository runs itself. `pnpm lint`, the unit suite and `pnpm build:settings --check` are pre-commit hooks and CI steps, because a gate nobody has to remember is worth more than one they do. The reachability pass is deliberately not one of them, and it is the only check here that is not.

It sends fifty-five requests to a third party's storefront. Adding it to the hooks would mean a commit cannot be made while cpap.com is rate-limiting, deploying, or simply slow — a failure with no relationship to the change being committed, on infrastructure nobody in this repository controls. Adding it to CI would mean the same thing for every pull request, plus fifty-five requests per push from a shared GitHub runner, which is the shape of traffic a rate limiter is built to refuse. A gate that fails for reasons the author cannot fix teaches people to bypass gates.

The pass is also paced, which is the second reason it cannot be a gate: sequential requests with a pause between them, and up to four attempts each with the backoff growing. Eight concurrent requests produced 429 on sixty-eight of eighty-six URLs during planning, so concurrency is not available as a way to make this fast enough to be invisible. It takes about a minute in the good case and longer when the storefront is busy. That is a fine cost for a command someone runs before applying a catalogue, and an unacceptable one for a hook that runs on every commit.

What keeps this from being an untested claim is that "absent from the hooks" is asserted rather than intended: unit tests read `package.json`, `.pre-commit-config.yaml` and `.github/workflows/ci.yml` and fail if the command's name appears in any of them, including inside another npm script — because anything `pnpm build:settings` called would gate CI just as surely as a step of its own.

## Consequences

Nothing runs this automatically, so **an unverified catalogue can be committed, and can be applied**. That is a real hole and it is the intended trade-off: the alternative is a gate that fails when a storefront is busy. What closes it is sequence rather than enforcement — the pass is run before a Catalogue Apply, and its exit code is non-zero on anything unshippable, so a human or a script running the two in order gets the answer. If that turns out not to be enough in practice, the fix is a step in the apply command, not a hook.

The pass needs no credentials at all — not Shopify's, not the Discourse instance's. Shopify's verdict on each product already travels in the Resolved Product Catalogue's `status` column, and the only thing being requested is a public product page. So its npm script does not read `.env`, and a test asserts that neither the command nor its library mentions any credential name. That is what would let this run somewhere shared if the trade-off above is ever revisited.

It takes no arguments, and the refusal lives in the library with the rest of the decisions rather than in the command. Every flag it could plausibly have — check one field, accept an unresolved entry, go faster, ignore a failure — is a way of declaring the catalogue verified without having verified it. A pass whose result can be narrowed from the command line reports on whatever the last person chose to look at.
