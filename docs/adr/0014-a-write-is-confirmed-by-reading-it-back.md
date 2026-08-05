# A write is confirmed by reading it back, not by the response code

The Discourse admin API answers `200 OK` to a Dropdown Options write it discarded. This was found by probing the running test instance on a throwaway Custom User Field rather than by reasoning about it, and it is not an edge case: two of the shapes this pipeline can produce are affected.

An empty `options` array is ignored. Rails converts an empty array parameter to `nil` before the controller sees it, and the controller replaces the option list only when `options` is present, so `PUT` with `options: []` returns 200 with the previous options intact. A list containing the same option twice is silently deduplicated, so a write of three options can succeed and leave two. Both cases return the updated field in the response body — showing the *server's* version, which is why the response is no help either.

So a status code here means "the request was well formed". It does not mean the site holds what was sent. The Catalogue Apply therefore rereads the field definitions after writing and compares the live option lists against the Mapping values in the checked-out catalogue, and reports any difference. That readback is not a precaution; it is the only thing in the pipeline that reports whether the apply happened. A run can be green from end to end and have changed nothing at all.

The same reasoning settles a question the ticket asked differently. It asked the command to warn when the catalogue digest disagrees with "what the target instance's component reports", and no such digest exists: the digest is a comment in `settings.yml` (ADR-0011), and comments do not reach an instance — a theme ships setting *values*, not the file's commentary. Rather than adding a setting to carry a digest, the command asks the instance for the Mappings its component is actually using and compares those against the checked-out catalogue. That is what the digest was standing in for, and it is strictly more informative: it names which Mappings differ instead of reporting that something does.

The component is found on the instance by the setting it defines rather than by a theme id in `.env`, because the base URL is meant to be the only thing that differs between instances. A theme id is a second per-instance variable that can go stale — pointing at a theme that was deleted and recreated — and report the wrong site's configuration with complete confidence.

## Consequences

Two digests still have to agree before anything is sent: the one `settings.yml` records for the Mappings it ships and the one the catalogue declares for itself. That comparison is local, it is the same one `pnpm build:settings --check` makes, and the apply refuses rather than warns when it fails, because a one-command fix exists.

An instance whose component reports Mappings the catalogue does not have, or none at all, is a warning rather than a refusal. The two sinks land at different times by different mechanisms, so a deployment that has not happened yet is an ordinary state of the world rather than a fault — and refusing would make it impossible to configure a site before installing the component on it. The first real run surfaced exactly that: theme 19 on the test instance reports zero Mappings, because the commit carrying the generated default has not been pushed.

An override saved through the theme settings UI is detected as part of the same read, by comparing the setting's value against its default. That is the trap ADR-0008 accepts, and it is now something the apply step reports rather than something an administrator has to remember.
