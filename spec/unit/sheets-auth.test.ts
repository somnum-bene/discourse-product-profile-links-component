import { Buffer } from "node:buffer";
import {
  createPublicKey,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SheetExportError } from "../../scripts/lib/sheet-export";
import {
  accessTokenFor,
  assertionFor,
  claimSetFor,
  credentialsFrom,
  IMPERSONATE_EMAIL_VAR,
  SERVICE_ACCOUNT_EMAIL_VAR,
  SERVICE_ACCOUNT_KEY_VAR,
  SHEETS_READONLY_SCOPE,
  unescapeNewlines,
} from "../../scripts/lib/sheets-auth";

// A throwaway key pair, generated per run rather than committed: a real PEM in
// the repository would be a credential-shaped thing in a public repo, and the
// next person to grep for one should find nothing. 2048 bits because that is
// what Google issues, and the signature length is part of what is asserted.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

// How the key actually arrives: `.env` cannot hold a real newline inside a
// value, so the PEM is written with literal backslash-n and Node's
// `--env-file` hands it over still escaped.
const ESCAPED_KEY = privateKey.replace(/\n/g, "\\n");

// Both addresses are invented. The real service-account address names a live
// GCP project, and this repository is public — the same reason the workbook id
// is configuration rather than a constant. A fixture only has to have the
// shape.
const ENV = {
  [SERVICE_ACCOUNT_EMAIL_VAR]:
    "sheet-reader@example-project.iam.gserviceaccount.com",
  [IMPERSONATE_EMAIL_VAR]: "someone@cpap.com",
  [SERVICE_ACCOUNT_KEY_VAR]: ESCAPED_KEY,
};

const ISSUED_AT = 1_767_225_600;

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

describe("unescapeNewlines", () => {
  it("turns the escaped newlines a .env file carries back into real ones", () => {
    expect(unescapeNewlines(ESCAPED_KEY)).toBe(privateKey);
  });

  it("leaves a key that already holds real newlines alone", () => {
    expect(unescapeNewlines(privateKey)).toBe(privateKey);
  });
});

describe("credentialsFrom", () => {
  it("assembles the three variables into one credential", () => {
    const credentials = credentialsFrom(ENV);

    expect(credentials.email).toBe(ENV[SERVICE_ACCOUNT_EMAIL_VAR]);
    expect(credentials.impersonateEmail).toBe("someone@cpap.com");
    expect(credentials.privateKey).toBe(privateKey);
  });

  it("names every variable that is missing, not just the first", () => {
    expect(() => credentialsFrom({})).toThrow(SheetExportError);
    expect(() => credentialsFrom({})).toThrow(
      new RegExp(
        `${SERVICE_ACCOUNT_EMAIL_VAR}.*${IMPERSONATE_EMAIL_VAR}.*${SERVICE_ACCOUNT_KEY_VAR}`,
        "s"
      )
    );
  });

  it("refuses each variable on its own", () => {
    for (const dropped of [
      SERVICE_ACCOUNT_EMAIL_VAR,
      IMPERSONATE_EMAIL_VAR,
      SERVICE_ACCOUNT_KEY_VAR,
    ]) {
      const partial = { ...ENV, [dropped]: undefined };

      expect(() => credentialsFrom(partial)).toThrow(SheetExportError);
      expect(() => credentialsFrom(partial)).toThrow(new RegExp(dropped));
    }
  });

  it("refuses a key whose newlines were never escaped in the first place", () => {
    // The silent-failure spot. A PEM flattened onto one line is a string that
    // looks like a key, signs nothing, and fails at the token endpoint with an
    // error about the client — which sends whoever hits it to the Admin
    // Console rather than to their .env.
    const flattened = {
      ...ENV,
      [SERVICE_ACCOUNT_KEY_VAR]: privateKey.replace(/\n/g, ""),
    };

    expect(() => credentialsFrom(flattened)).toThrow(SheetExportError);
    expect(() => credentialsFrom(flattened)).toThrow(/newline escaping/);
  });

  it("refuses anything else that is not a private key", () => {
    const nonsense = { ...ENV, [SERVICE_ACCOUNT_KEY_VAR]: "not-a-key" };

    expect(() => credentialsFrom(nonsense)).toThrow(/not a private key/);
  });

  it("does not repeat the key material in the refusal", () => {
    const truncated = privateKey.split("\n").slice(0, 4).join("\\n");
    const broken = { ...ENV, [SERVICE_ACCOUNT_KEY_VAR]: truncated };
    const body = privateKey.split("\n")[1];

    expect(() => credentialsFrom(broken)).toThrow(
      new RegExp(`^(?!.*${body})`, "s")
    );
  });
});

describe("claimSetFor", () => {
  const claims = claimSetFor(credentialsFrom(ENV), ISSUED_AT);

  it("asks for a token as the impersonated user, not as the service account", () => {
    // `sub` is what makes this work at all. The service account has no access
    // to the Sheet and cannot be given any — the org's policy blocks sharing
    // to a gserviceaccount.com address — so it borrows a Workspace user's.
    expect(claims.iss).toBe(ENV[SERVICE_ACCOUNT_EMAIL_VAR]);
    expect(claims.sub).toBe("someone@cpap.com");
    expect(claims.iss).not.toBe(claims.sub);
  });

  it("asks for read-only access to Sheets and nothing else", () => {
    expect(claims.scope).toBe(SHEETS_READONLY_SCOPE);
    expect(claims.scope).toContain(".readonly");
  });

  it("is addressed to the token endpoint it will be posted to", () => {
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
  });

  it("expires an hour out, the longest Google honours", () => {
    expect(claims.iat).toBe(ISSUED_AT);
    expect(claims.exp).toBe(ISSUED_AT + 3600);
  });
});

describe("assertionFor", () => {
  const credentials = credentialsFrom(ENV);
  const assertion = assertionFor(credentials, ISSUED_AT);
  const [header, claims, signature] = assertion.split(".");

  it("is three base64url segments", () => {
    expect(assertion.split(".")).toHaveLength(3);
    // base64url, so none of base64's three unsafe characters survive.
    expect(assertion).not.toMatch(/[+/=]/);
  });

  it("declares the algorithm it actually signs with", () => {
    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("carries the claim set verbatim", () => {
    expect(decodeSegment(claims)).toEqual(claimSetFor(credentials, ISSUED_AT));
  });

  it("signs the header and claims with the private key", () => {
    // Verified against the public half rather than compared to a recorded
    // signature: the assertion has to be one Google's verifier accepts, and
    // that is a property of the signature, not of its bytes.
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);

    expect(
      verifier.verify(createPublicKey(publicKey), signature, "base64url")
    ).toBe(true);
  });

  it("does not verify once a claim has been altered", () => {
    const tampered = Buffer.from(
      JSON.stringify({ ...claimSetFor(credentials, ISSUED_AT), scope: "*" }),
      "utf8"
    ).toString("base64url");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${tampered}`);

    expect(
      verifier.verify(createPublicKey(publicKey), signature, "base64url")
    ).toBe(false);
  });

  it("signs a different assertion for a different hour", () => {
    expect(assertionFor(credentials, ISSUED_AT + 3600)).not.toBe(assertion);
  });
});

// The one function here that reaches the network. Everything above it is pure
// and asserted directly; this is the part that can only be wrong about a real
// response, so the responses are stubbed rather than the module.
describe("accessTokenFor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubTokenEndpoint(
    response: Partial<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }> = {}
  ) {
    const call = vi.fn(async () => ({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: response.json ?? (async () => ({ access_token: "a-test-token" })),
    }));

    vi.stubGlobal("fetch", call);

    return call;
  }

  const credentials = credentialsFrom(ENV);

  it("hands back the token the endpoint issued", async () => {
    stubTokenEndpoint();

    await expect(accessTokenFor(credentials, ISSUED_AT)).resolves.toBe(
      "a-test-token"
    );
  });

  it("posts the signed assertion as a form-encoded JWT bearer grant", async () => {
    // The encoding is the part Google is strict about: a JSON body, or the
    // assertion under any other parameter name, is refused at the endpoint
    // rather than here — so it is worth pinning.
    const call = stubTokenEndpoint();
    await accessTokenFor(credentials, ISSUED_AT);

    const [url, init] = call.mock.calls[0] as unknown as [string, RequestInit];
    const body = init.body as URLSearchParams;

    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer"
    );
    expect(body.get("assertion")).toBe(assertionFor(credentials, ISSUED_AT));
  });

  it("refuses a response that carries an error instead of a token", async () => {
    stubTokenEndpoint({
      ok: false,
      status: 401,
      json: async () => ({
        error: "unauthorized_client",
        error_description: "Client is unauthorized",
      }),
    });

    await expect(accessTokenFor(credentials, ISSUED_AT)).rejects.toThrow(
      SheetExportError
    );
    await expect(accessTokenFor(credentials, ISSUED_AT)).rejects.toThrow(
      /401 unauthorized_client: Client is unauthorized/
    );
  });

  it("says which side of the setup to look at for each error it names", async () => {
    // The two errors worth telling apart. `unauthorized_client` is a console
    // grant that is missing or still propagating; `invalid_grant` is the
    // assertion itself. Neither is a statement about the Sheet.
    stubTokenEndpoint({ ok: false, status: 400, json: async () => ({}) });

    const message = await accessTokenFor(credentials, ISSUED_AT).catch(
      (error: Error) => error.message
    );

    expect(message).toMatch(/Domain-wide delegation/);
    expect(message).toMatch(/invalid_grant` is about the assertion/);
    expect(message).toMatch(/403 when a tab is fetched/);
  });

  it("refuses a body that is not JSON at all", async () => {
    // An HTML error page from a proxy, which is what a network in the way
    // looks like. `response.json()` rejects, and the refusal has to survive
    // that rather than becoming an unhandled rejection about parsing.
    stubTokenEndpoint({
      ok: false,
      status: 503,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    });

    await expect(accessTokenFor(credentials, ISSUED_AT)).rejects.toThrow(
      /503 with no token/
    );
  });

  it("refuses a 200 that came back without a token", async () => {
    // Fail closed on the shape, not only on the status: an OK response with
    // no `access_token` would otherwise be returned as `undefined` and sent
    // as the word "Bearer undefined".
    stubTokenEndpoint({ json: async () => ({ scope: SHEETS_READONLY_SCOPE }) });

    await expect(accessTokenFor(credentials, ISSUED_AT)).rejects.toThrow(
      /200 with no token/
    );
  });
});
