// A read-only access token for the Sheets API, obtained without a person
// present. `pnpm export:sheet` runs on a laptop or in CI with nobody logged in
// to Google, so the interactive OAuth the Drive MCP tools use is not available
// to it — this is the JWT Bearer grant (RFC 7523) instead.
//
// Why there is any of this at all: the cpap.com Sheet cannot be made
// link-readable. The org's Workspace policy blocks "Anyone with the link", and
// it also blocks sharing a file *to* a service account
// (`...iam.gserviceaccount.com` is not an allowlisted domain, and a Workspace
// admin can only allowlist domains they administer). So the service account
// does not hold access to the Sheet at all. It holds domain-wide delegation for
// one scope, and uses it to act as a real Workspace user who does — the `sub`
// claim below. That is the whole reason this file is not thirty lines.
//
// Hand-rolled with `node:crypto` rather than a JWT dependency, on the same
// grounds `parseCsv` is hand-rolled: this is the part that holds a private key,
// and a library that surprises us here is worse than one we can read.

import { Buffer } from "node:buffer";
import { createPrivateKey, createSign } from "node:crypto";
import { SheetExportError } from "./sheet-export.ts";

/**
 * The three variables that make up the credential, in the ignored `.env`
 * beside the workbook id and the Shopify token. The private key is a bearer
 * credential: it is never logged, never printed in an error, and never
 * committed.
 */
export const SERVICE_ACCOUNT_EMAIL_VAR = "GOOGLE_SERVICE_ACCOUNT_EMAIL";
export const SERVICE_ACCOUNT_KEY_VAR = "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY";
export const IMPERSONATE_EMAIL_VAR = "GOOGLE_SERVICE_ACCOUNT_IMPERSONATE_EMAIL";

/**
 * Read-only, and asked for by name so that widening it is a visible edit here
 * rather than a quiet consequence of a console setting. The delegation grant in
 * the Admin Console authorises this exact scope string; anything else fails at
 * the token endpoint rather than half-working.
 */
export const SHEETS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets.readonly";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** The longest Google will honour, and short enough that a leak expires. */
const TOKEN_LIFETIME_SECONDS = 3600;

/** The credential, assembled and checked before anything is signed with it. */
export interface ServiceAccountCredentials {
  /** The service account's own address — the JWT's `iss`. */
  email: string;
  /** The Workspace user it acts as — the JWT's `sub`. See the note below. */
  impersonateEmail: string;
  /** The PEM private key, with real newlines. */
  privateKey: string;
}

/**
 * Assemble the credential from the environment, refusing anything incomplete
 * before a request is built rather than after one fails.
 *
 * The `\n`-unescaping is the reason this is a named function with tests. A PEM
 * holds real newlines, `.env` holds them escaped, and Node's `--env-file`
 * leaves them escaped — so a key used as read is a string that looks right,
 * signs nothing, and fails at the token endpoint with an error about the
 * client rather than about the key. Checking the shape here turns that into one
 * legible refusal.
 */
export function credentialsFrom(
  env: Record<string, string | undefined>
): ServiceAccountCredentials {
  const email = env[SERVICE_ACCOUNT_EMAIL_VAR];
  const impersonateEmail = env[IMPERSONATE_EMAIL_VAR];
  const rawKey = env[SERVICE_ACCOUNT_KEY_VAR];

  const missing = [
    [SERVICE_ACCOUNT_EMAIL_VAR, email],
    [IMPERSONATE_EMAIL_VAR, impersonateEmail],
    [SERVICE_ACCOUNT_KEY_VAR, rawKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new SheetExportError(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
        `The Sheet is not readable without credentials — it cannot be shared ` +
        `publicly or with the service account directly, so the export acts as ` +
        `a Workspace user via domain-wide delegation. The values live in the ` +
        `ignored .env; scripts/README.md says where they come from.`
    );
  }

  const privateKey = unescapeNewlines(rawKey as string);

  try {
    createPrivateKey(privateKey);
  } catch {
    // The key itself is not reported, and neither is the underlying error,
    // which can quote the material it failed to parse.
    throw new SheetExportError(
      `${SERVICE_ACCOUNT_KEY_VAR} is not a private key OpenSSL will read. The ` +
        `usual cause is newline escaping: a PEM holds real newlines, .env ` +
        `holds them as a literal backslash-n, and only the ones written that ` +
        `way survive being unescaped here.`
    );
  }

  return {
    email: email as string,
    impersonateEmail: impersonateEmail as string,
    privateKey,
  };
}

/**
 * The JWT's claims. Separated from the signing so the interesting half can be
 * asserted without a key.
 *
 * `sub` is the claim that makes this work and the one most likely to be left
 * out: without it the service account asks for a token as itself, which is
 * refused with `unauthorized_client` because it has no access to the Sheet and
 * cannot be given any. With it, the token is issued for the Workspace user in
 * `sub`, whose ordinary access is what the export borrows.
 */
export function claimSetFor(
  credentials: ServiceAccountCredentials,
  issuedAt: number
): Record<string, string | number> {
  return {
    iss: credentials.email,
    sub: credentials.impersonateEmail,
    scope: SHEETS_READONLY_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
  };
}

/**
 * The signed assertion the token endpoint exchanges for an access token:
 * base64url header, claims and RS256 signature, joined by dots.
 */
export function assertionFor(
  credentials: ServiceAccountCredentials,
  issuedAt: number
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify(claimSetFor(credentials, issuedAt)));
  const signingInput = `${header}.${claims}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);

  return `${signingInput}.${signer.sign(credentials.privateKey, "base64url")}`;
}

/**
 * Exchange the assertion for an access token. One token per run: the command
 * fetches a handful of tabs and exits well inside the hour, so there is no
 * cache to go stale and no refresh to get wrong.
 */
export async function accessTokenFor(
  credentials: ServiceAccountCredentials,
  issuedAt: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: JWT_BEARER_GRANT,
      assertion: assertionFor(credentials, issuedAt),
    }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    throw new SheetExportError(
      `the token endpoint answered ${response.status} ` +
        `${body.error ?? "with no token"}` +
        `${body.error_description ? `: ${body.error_description}` : ""}.\n` +
        `  \`unauthorized_client\` here is a console problem rather than a ` +
        `code one: the service account's OAuth client id has to be authorised ` +
        `for ${SHEETS_READONLY_SCOPE} under Admin Console → Security → API ` +
        `controls → Domain-wide delegation, and a fresh grant takes a few ` +
        `minutes to take effect.\n` +
        `  \`invalid_grant\` usually means ${IMPERSONATE_EMAIL_VAR} is not a ` +
        `Workspace user who can open the Sheet.`
    );
  }

  return body.access_token;
}

/**
 * Turn the escaped newlines a `.env` file carries back into real ones. Written
 * out rather than done inline because it is the single likeliest thing to be
 * wrong about this credential, and a named function is a thing tests can aim
 * at. A key that already holds real newlines passes through unchanged.
 */
export function unescapeNewlines(key: string): string {
  return key.replace(/\\n/g, "\n");
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
