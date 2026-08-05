import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FieldMapping } from "../../scripts/lib/build-catalogue";
import { isValidUrl, refusedUrls } from "../../scripts/lib/settings-schema";

// Every expectation below was taken from Discourse rather than reasoned out.
// The accepted and refused lists in the first two suites are the cases in
// Discourse's own `spec/lib/url_helper_spec.rb`; the rest were settled by
// running `UrlHelper.is_valid_url?` itself — the Ruby is quoted in
// settings-schema.ts — over a corpus under both of Ruby's URI parsers, and
// they are cases where the two parsers agree. Nobody can re-derive these from
// the TypeScript, which is the reason to write them down.

function mapping(value: string, url: string) {
  return { value, url };
}

function field(
  user_field_name: string,
  ...mappings: { value: string; url: string }[]
): FieldMapping {
  return { user_field_name, mappings };
}

describe("the URLs Discourse's schema accepts", () => {
  const accepted = [
    "http://www.example.com",
    "https://www.example.com",
    "ftp://example.com",
    "ldap://ldap.example.com/dc=example;dc=com?quer",
    "ldaps://example.com/x",
    "mailto:someone@discourse.org",
    "/some/path",
    "/some/path?query=param",
    "#anchor",
    "#",
  ];

  for (const url of accepted) {
    it(`accepts ${JSON.stringify(url)}`, () => {
      expect(isValidUrl(url)).toBe(true);
    });
  }

  it("accepts a protocol-relative URL, because it reads as a path", () => {
    // Not an oversight in the Ruby so much as a consequence of it: no scheme
    // parses to a URI::Generic, and the check for one is that the string starts
    // with a slash. Worth pinning because it is the kind of thing a stricter
    // mirror would quietly refuse.
    expect(isValidUrl("//cdn.example.com/x")).toBe(true);
  });

  it("accepts a URL far longer than anything this catalogue produces", () => {
    // UrlHelper defines MAX_URL_LENGTH, and the schema validator does not use
    // it. A length ceiling is not one of the reasons a Mapping can be refused.
    expect(
      isValidUrl(`https://www.cpap.com/products/${"a".repeat(3000)}`)
    ).toBe(true);
  });

  it("accepts the punctuation a product handle can legitimately carry", () => {
    for (const url of [
      "https://www.cpap.com/products/x+y",
      "https://www.cpap.com/products/x~y",
      "https://www.cpap.com/products/x'y",
      "https://www.cpap.com/products/x(y)",
      "https://www.cpap.com/products/x,y",
      "https://www.cpap.com/products/x;y",
      "https://www.cpap.com/products/x=y",
      "https://www.cpap.com/products/x&y",
      "https://www.cpap.com/products/x@y",
      "https://www.cpap.com/products/a%20b",
      "https://www.cpap.com/products/x?a=1&b=2",
      "https://www.cpap.com/products/x#frag",
      "https://user:pw@example.com/x",
      "http://example.com:8080/x",
    ]) {
      expect(isValidUrl(url), url).toBe(true);
    }
  });
});

describe("the URLs Discourse's schema refuses", () => {
  const refused = [
    "",
    "http//www.example.com",
    "http:/www.example.com",
    "https:///www.example.com",
    "mailtoooo:someone@discourse.org",
    "ftp://",
    "http://",
    "https://",
    "ldap://",
  ];

  for (const url of refused) {
    it(`refuses ${JSON.stringify(url)}`, () => {
      expect(isValidUrl(url)).toBe(false);
    });
  }

  it("refuses a scheme it does not know, whatever the scheme claims to be", () => {
    // `file`, `ws` and `wss` parse to real URI classes and are still refused,
    // which is the same answer `javascript:` and `data:` get. The list of four
    // classes in the Ruby is the whole allowance.
    for (const url of [
      "file:///etc/passwd",
      "ws://example.com/x",
      "wss://example.com/x",
      // eslint-disable-next-line no-script-url -- being refused is the assertion
      "javascript:alert(1)",
      "data:text/html,x",
      "h1t.tp+x://example.com/",
    ]) {
      expect(isValidUrl(url), url).toBe(false);
    }
  });

  it("refuses a host with no scheme in front of it", () => {
    // The shape a hand-edited Mapping is most likely to arrive in, and the one
    // that would resolve a Profile Link to a path under the forum's own domain
    // if it were accepted.
    for (const url of [
      "www.cpap.com/products/x",
      "sleeping.com/products/x",
      "x",
      "1https://example.com/",
      "+https://example.com/",
    ]) {
      expect(isValidUrl(url), url).toBe(false);
    }
  });

  it("refuses an empty mailto", () => {
    expect(isValidUrl("mailto:someone@discourse.org")).toBe(true);
    expect(isValidUrl("mailto:")).toBe(false);
  });
});

describe("the URLs that never reach a scheme at all", () => {
  // Ruby's parser raises before `is_valid_url?` gets to look at the scheme, and
  // the raise is rescued into false. These are the cases a mirror written from
  // the branch structure alone would wrongly accept.

  it("refuses whitespace anywhere in the URL", () => {
    for (const url of [
      " https://www.cpap.com/products/x",
      "https://www.cpap.com/products/x ",
      "https://www.cpap.com/products/x\n",
      "https://www.cpap.com/products/x\ty",
      "https://www.cpap.com/products/a b",
      "https://exa mple.com/",
    ]) {
      expect(isValidUrl(url), JSON.stringify(url)).toBe(false);
    }
  });

  it("refuses a non-ASCII character, which is how a Suggested Title leaks in", () => {
    // The instance's hand-entered Machine options carry `™` (ADR-0011). A URL
    // built from a title rather than from a Shopify handle would carry it too.
    expect(isValidUrl("https://www.cpap.com/products/aircurve™")).toBe(false);
  });

  it("refuses an unfinished percent escape", () => {
    expect(isValidUrl("https://www.cpap.com/products/x%")).toBe(false);
    expect(isValidUrl("https://www.cpap.com/products/x%zz")).toBe(false);
    expect(isValidUrl("https://www.cpap.com/products/x%20y")).toBe(true);
  });

  it("refuses a path or an anchor that does not parse", () => {
    // The parse runs before the branch that accepts a leading slash or hash, so
    // a path is not waved through for starting with one. Skipping the parse and
    // trusting the branches is the shape of mirror this catches: every other
    // case here would still come out false without it.
    for (const url of [
      "/some path",
      "/products/x™",
      "/a|b",
      "#a b",
      "#a#b",
      "#a%",
      "/some/path#a#b",
      "//cdn.example.com/a b",
    ]) {
      expect(isValidUrl(url), JSON.stringify(url)).toBe(false);
    }

    expect(isValidUrl("#anchor?x")).toBe(true);
  });

  it("refuses the characters RFC 3986 leaves out of a path", () => {
    for (const url of [
      "https://www.cpap.com/products/x|y",
      "https://www.cpap.com/products/x<y>",
      'https://www.cpap.com/products/x"y',
      "https://www.cpap.com/products/x{y}",
      "https://www.cpap.com/products/x^y",
      "https://www.cpap.com/products/x`y",
      "https://www.cpap.com/products/x\\y",
      "https://www.cpap.com/products/[x]",
    ]) {
      expect(isValidUrl(url), url).toBe(false);
    }
  });
});

describe("the two details of the Ruby that are easiest to mirror wrongly", () => {
  it("refuses an uppercase scheme", () => {
    // `uri.scheme` is downcased, the match runs against the raw string, and the
    // two cannot agree. So a URL that works perfectly well in a browser is
    // refused by the schema, and this is the only place that fact is written
    // down for this repository.
    expect(isValidUrl("https://www.cpap.com/products/x")).toBe(true);
    expect(isValidUrl("HTTPS://WWW.CPAP.COM/products/x")).toBe(false);
    expect(isValidUrl("HTTP://example.com")).toBe(false);
    expect(isValidUrl("Https://example.com/x")).toBe(false);
  });

  it("requires a character after the two slashes, and refuses a third", () => {
    expect(isValidUrl("https://a")).toBe(true);
    expect(isValidUrl("https://")).toBe(false);
    expect(isValidUrl("https:///www.example.com")).toBe(false);
  });

  it("does not require the host to be a host", () => {
    // `is_valid_url?` is a syntax check, not a reachability one, and it does not
    // look hard at the authority either. A Mapping to a nonsense host is the
    // schema's business only in the sense that it passes.
    expect(isValidUrl("https://.com/x")).toBe(true);
  });
});

describe("where this is deliberately narrower than Discourse", () => {
  it("refuses an IP-literal host that Discourse would accept", () => {
    // The RFC 3986 IP-literal production is recursive and is not transcribed
    // here. Refusing one raises a false alarm on a URL shape this pipeline
    // cannot generate; accepting one Discourse refuses is the failure a gate
    // exists to prevent, and narrowing cannot cause it.
    expect(isValidUrl("http://[::1]/x")).toBe(false);
    expect(isValidUrl("https://192.168.0.1/x")).toBe(true);
  });
});

describe("the Mappings whose URL would sink the whole setting", () => {
  it("finds nothing to report in a value the schema accepts", () => {
    expect(
      refusedUrls([
        field(
          "Machine",
          mapping("AirSense 11 AutoSet", "https://www.cpap.com/products/a"),
          mapping("AirMini", "https://www.cpap.com/products/b")
        ),
      ])
    ).toEqual([]);
  });

  it("names the field and the value, not only the URL", () => {
    // A refused URL invalidates the entire `profile_link_fields` value rather
    // than the one Mapping (ADR-0006), so what is wanted from a failure is which
    // Mapping to go and look at.
    expect(
      refusedUrls([
        field("Machine", mapping("AirSense 11 AutoSet", "www.cpap.com/a")),
      ])
    ).toEqual([
      {
        user_field_name: "Machine",
        value: "AirSense 11 AutoSet",
        url: "www.cpap.com/a",
      },
    ]);
  });

  it("reports every refusal rather than stopping at the first", () => {
    expect(
      refusedUrls([
        field("Machine", mapping("A", "https://www.cpap.com/a b")),
        field(
          "Mask",
          mapping("B", "https://www.cpap.com/ok"),
          mapping("C", "HTTPS://www.cpap.com/c")
        ),
      ]).map((refusal) => refusal.value)
    ).toEqual(["A", "C"]);
  });

  it("survives a field carrying no Mappings, present or absent", () => {
    // `readLinkConfig` calls that a Config Problem; this function has no opinion
    // about it and must not throw over it, or the two gates would report the
    // same fault and only one of them usefully. `mappings` missing entirely is
    // the shape the setting can deliver and an empty list is the shape the
    // generator can, so both are worth pinning.
    expect(refusedUrls([field("Humidifier")])).toEqual([]);
    expect(
      refusedUrls([{ user_field_name: "Humidifier" } as FieldMapping])
    ).toEqual([]);
  });
});

describe("what this file is allowed to do", () => {
  const lib = readFileSync("scripts/lib/settings-schema.ts", "utf8");

  it("decides URL validity without reading a file or a URL", () => {
    // The mirror is a decision about a string. Anything that reached the network
    // to answer it would be answering a different question — whether the page
    // exists — which is #15's, and which the schema never asks.
    expect([...lib.matchAll(/from "(node:[^"]+)"/g)]).toEqual([]);
    expect(lib).not.toContain("fetch(");
    expect(lib).not.toContain("process.env");
  });
});
