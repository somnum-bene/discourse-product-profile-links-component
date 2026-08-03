# Retrying a lookup belongs to the User Field Source, not the post surface

The post Link Surface is the only one that has to fetch: the user card and the user profile receive a user's Custom User Field values in their outlet args, while a post carries only a username. When that fetch fails, the author's Profile Links are missing from the post.

The failure has to be recovered from somewhere, and the surface is the wrong place. A post sitting on screen has no reason to re-render, so a component that merely stopped caching the failure — leaving itself free to ask again — would be waiting for an event that may never arrive. It would look retryable and behave permanently. Driving a retry from the component's own tracked state is worse: the value the getter reads is the value the retry has to change, so a persistent outage turns into a render loop unless it is bounded, and bounding it means a counter, a timer and a teardown in a component that has no automated test coverage at all.

So the retry lives in `lib/user-field-source.ts`, which already owns request dedupe, cache lifetime and failure policy, and which the unit tests in `spec/unit` drive directly. One lookup tries three times with a widening backoff before it reports failure, and every caller that arrives while those retries play out joins the same in-flight request — so a topic full of posts by one author still costs one lookup's worth of requests however many times it has to be retried. The sleep is injected, so the tests exercise the retries without waiting for them.

The surface keeps one responsibility from this: it stores a successful lookup and not a failed one. That is not a retry, it is the absence of a permanent record of failure, and it is what makes the recycling case correct — a result arriving after the post has changed to a different author is dropped without poisoning the author it was for.

## Considered options

- **Retry in the component, driven by tracked state.** Rejected above: a render loop unless bounded, and the bounding lives where nothing can test it.
- **Schedule a further retry after the source gives up.** Rejected. It closes a real gap — an outage lasting longer than the retry window leaves the post without Profile Links until something re-renders it — but the thing being recovered is supplementary. The post, its author, and its content all render; some links beside them do not. Paying for that with a timer and a destroy hook in the one module the test suite cannot reach is the wrong trade. If it turns out to matter in practice, widen the source's retry window first, since that costs nothing and is covered by tests.

## Consequences

`createUserFieldSource` takes an options argument — `attempts`, `wait` and `backoff` — solely so the tests can collapse the backoff. Production passes none of them.

An outage that outlasts roughly three quarters of a second still leaves a post without its Profile Links until the component next renders. This is accepted, and is the gap the second considered option would close.

Nothing about this is visible on the user card or the user profile, which do not fetch.
