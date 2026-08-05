// What Discourse's own schema will accept for `profile_link_fields`, decided
// here so the generated default can be checked before it ships.
//
// `readLinkConfig` reports Config Problems, which is a different question: it
// checks that a Mapping has a URL, not that the URL is one. URL syntax is
// enforced server-side by the `validations: url: true` in settings.yml, and a
// refused URL invalidates the entire `profile_link_fields` value rather than the
// one offending Mapping (ADR-0006). The generated default never passes through
// that validator during development — it is a default, not an administrator's
// input — so it is checked here or nowhere.
//
// Nothing in this module touches the filesystem, the network or the environment.

import type { FieldMapping } from "./build-catalogue.ts";

/**
 * The schemes `UrlHelper.is_valid_url?` accepts in `scheme://host` form, keyed
 * by the downcased scheme Ruby's parser reports.
 *
 * `URI::HTTPS` and `URI::LDAPS` are subclasses of `URI::HTTP` and `URI::LDAP`,
 * so the `is_a?` checks in the Ruby admit them; `file`, `ws` and `wss` parse to
 * classes that are not in the list and are refused.
 */
const AUTHORITY_SCHEMES = new Set(["http", "https", "ftp", "ldap", "ldaps"]);

// RFC 3986 character classes, as Ruby's RFC3986 parser spells them.
const PCT_ENCODED = "%[0-9A-Fa-f]{2}";
const UNRESERVED = "A-Za-z0-9\\-._~";
const SUB_DELIMS = "!$&'()*+,;=";
const PCHAR = `(?:${PCT_ENCODED}|[${UNRESERVED}${SUB_DELIMS}:@])`;
const PATH = `(?:${PCHAR}|/)*`;
const QUERY_OR_FRAGMENT = `(?:${PCT_ENCODED}|[${UNRESERVED}${SUB_DELIMS}:@/?])*`;
const USERINFO = `(?:${PCT_ENCODED}|[${UNRESERVED}${SUB_DELIMS}:])*`;
const REG_NAME = `(?:${PCT_ENCODED}|[${UNRESERVED}${SUB_DELIMS}])*`;
const AUTHORITY = `(?:${USERINFO}@)?${REG_NAME}(?::\\d*)?`;
const HIER_PART = `(?://${AUTHORITY}(?:/${PATH})?|(?!//)${PATH})`;
const TAIL = `(?:\\?${QUERY_OR_FRAGMENT})?(?:#${QUERY_OR_FRAGMENT})?`;

/** An absolute URI: a scheme, then everything the scheme introduces. */
const URI_FORM = new RegExp(
  `^(?<scheme>[A-Za-z][A-Za-z0-9+\\-.]*):${HIER_PART}${TAIL}$`
);

/** A URI reference with no scheme — a path, an anchor, or `//host/path`. */
const RELATIVE_FORM = new RegExp(`^${HIER_PART}${TAIL}$`);

/**
 * An addr-spec `mailto:` will accept. Deliberately narrower than RFC 6068: the
 * only thing this gate needs from it is that `mailto:` with nothing after it is
 * refused, which is what Ruby does by raising rather than returning false.
 */
const MAILTO_ADDRESS = /^[^\s@]+@[^\s@]+$/;

/**
 * Whether Discourse's schema will accept `url` for a property declaring
 * `validations: url: true`. Mirrors `UrlHelper.is_valid_url?`, which is what
 * `SchemaSettingsObjectValidator` reaches for:
 *
 *     def self.is_valid_url?(url)
 *       uri = URI.parse(url)
 *       return true if uri.is_a?(URI::Generic) && url.starts_with?("/") ||
 *                      url.match?(/\A\#([^#]*)/)
 *       if uri.scheme
 *         return true if uri.is_a?(URI::MailTo)
 *         if url.match?(%r{\A#{uri.scheme}://[^/]}) &&
 *              (uri.is_a?(URI::HTTP) || uri.is_a?(URI::HTTPS) ||
 *               uri.is_a?(URI::FTP) || uri.is_a?(URI::LDAP))
 *           return true
 *         end
 *       end
 *       false
 *     rescue URI::InvalidURIError
 *       false
 *     end
 *
 * Two details of that are easy to miss and both are mirrored here. `uri.scheme`
 * comes back downcased while the `\A#{uri.scheme}://` match runs against the
 * raw string, so `HTTPS://example.com` is **refused** — the interpolated
 * lowercase scheme cannot match the uppercase original. And a URL Ruby's parser
 * refuses outright never reaches the branches at all, so a space, an unfinished
 * `%` escape or a non-ASCII character is refused before scheme or host matter.
 *
 * The parse step mirrors Ruby's RFC3986 parser — the default from Ruby 3.4, and
 * the one Discourse's own `url_helper_spec.rb` expectations match — with three
 * deliberate narrowings: an IP-literal host (`http://[::1]/`), an IPvFuture
 * host, and a `mailto:` whose address this does not recognise are all refused
 * here though Discourse would accept them. Narrowing can only raise a false
 * alarm on a URL shape this pipeline does not generate; the failure that
 * matters for a gate is accepting one Discourse refuses, and these cannot cause
 * it.
 *
 * The two Ruby parsers disagree on exactly one thing this could not rule out
 * either way: an underscore in the host, which RFC3986 accepts and RFC2396
 * refuses. Nothing here decides it, because the shipped catalogue's host is
 * pinned to `www.cpap.com` by a separate assertion, where an underscore cannot
 * appear.
 */
export function isValidUrl(url: string): boolean {
  const asUri = URI_FORM.exec(url);
  const scheme = asUri?.groups?.scheme;

  if (scheme === undefined && !RELATIVE_FORM.test(url)) {
    // Ruby raises URI::InvalidURIError, which is rescued into false.
    return false;
  }

  if (scheme === undefined) {
    // No scheme parses to a URI::Generic, so a path is accepted and an anchor
    // is accepted. Anything else relative — a bare `example.com/x` — is not.
    return url.startsWith("/") || url.startsWith("#");
  }

  const downcased = scheme.toLowerCase();

  if (downcased === "mailto") {
    return MAILTO_ADDRESS.test(url.slice("mailto:".length));
  }

  if (!AUTHORITY_SCHEMES.has(downcased)) {
    return false;
  }

  // `\A#{uri.scheme}://[^/]` — the raw string, against the downcased scheme,
  // with a character required after the two slashes and a third one refused.
  // `https://` alone therefore fails, which is what makes `https:///host` fail
  // too. The scheme comes from the set above, so it needs no escaping.
  return new RegExp(`^${downcased}://[^/]`).test(url);
}

/** A Mapping whose URL the schema would refuse, and so the whole setting with it. */
export interface RefusedUrl {
  user_field_name: string;
  value: string;
  url: string;
}

/**
 * Every Mapping in a `profile_link_fields` value whose URL Discourse's schema
 * would refuse. Empty is the only passing answer: one refusal takes down the
 * entire setting, so this is a list of causes rather than a count of damage.
 */
export function refusedUrls(fields: readonly FieldMapping[]): RefusedUrl[] {
  const refused: RefusedUrl[] = [];

  for (const field of fields) {
    for (const mapping of field.mappings ?? []) {
      if (!isValidUrl(mapping.url)) {
        refused.push({
          user_field_name: field.user_field_name,
          value: mapping.value,
          url: mapping.url,
        });
      }
    }
  }

  return refused;
}
