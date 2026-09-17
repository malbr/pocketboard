# 0001. Owner-only GitHub OAuth with server-side sessions

- Status: Accepted
- Date: 2026-09-16
- Issue: #3

## Context

PocketBoard is a single-user board. It needs exactly one authenticated
principal — the human owner — and no user management, roles, or sign-up. The
first slice (#2) shipped with no authentication at all, so every card route was
world-writable.

GitHub is already the system of record for this project and the owner already
has an account there, so GitHub can supply identity without PocketBoard storing
any credential of its own.

## Decision

**Identity comes from GitHub OAuth, authorization comes from one numeric id.**
The OAuth authorization-code flow runs with `state` and PKCE `S256`, and
requests **no scopes**. The callback exchanges the code, calls GitHub's
authenticated-user endpoint once, compares the returned immutable numeric user
id against the configured owner id, and then discards the access token. The
token is never persisted, logged, or returned to the browser.

The numeric id is the authorization subject because GitHub login handles are
mutable and a released handle can be claimed by somebody else.

**Sessions are server-side.** A row in `sessions` holds the session payload;
the browser holds only an opaque, signed session id in a cookie that is
`HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in production. Sessions
expire eight hours after login, as an absolute cap with no sliding renewal. The
session id is rotated on every successful login and the row is deleted on
logout.

The eight-hour cap is enforced in the `on conflict` clause, not only in
application code: an update keeps `least(existing, proposed)`, because a later
write knows the request's cookie but not what the stored row already promised.
A row that is simply abandoned is never presented again, so a sweep every
fifteen minutes deletes expired rows; its timer is unreferenced and stopped by
the app's `onClose` hook.

**Local origins are spelled `127.0.0.1`, never `localhost`.** GitHub matches a
registered callback URL exactly, so the approved local OAuth app's homepage
(`http://127.0.0.1:5173`) and callback
(`http://127.0.0.1:5173/api/auth/github/callback`) fix the spelling for every
local default in the repository — `APP_BASE_URL`, the Vite dev server bind and
proxy target, the Playwright base URL, and the PostgreSQL connection defaults.
Mixing the two spellings would produce a redirect-URI mismatch at the callback.

**Configuration is file-based.** The OAuth client id, client secret, session
secret, and owner id are read from files whose paths are named by environment
variables, matching the root-owned VPS secret files described in `CONTEXT.md`.
Any missing, unreadable, empty, or invalid value aborts startup.

**The proxy boundary is named, never inferred.** A `Secure` cookie is only
issued over a connection the server can see as TLS, and behind a
TLS-terminating reverse proxy that is knowable only from `X-Forwarded-Proto` —
a header any caller can write. `TRUSTED_PROXY_IPS` lists the addresses or CIDR
networks whose forwarded headers are believed; everything else is ignored.
Blanket values (`true`, `*`, a hop count, a hostname, any `/0` network) are
refused at startup, and production refuses to start until the variable is set
to a list or to the literal `none`. Requiring the statement is deliberate: the
failure it prevents is silent, since login would redirect successfully and set
no cookie at all.

**Failures the API did not intend say nothing about themselves.** One error
handler turns every unexpected `>=500` into `{"error":"internal_error"}` and
writes the real error to the server log. Driver messages name tables, columns,
and constraints; a caller who can provoke one must not be able to read the
schema back out of the response. Deliberate 4xx responses keep their own bodies,
and the CSRF plugin's typed errors become a stable `403 csrf_token_invalid`
rather than the plugin's `FST_CSRF_*` code.

**Official plugins, not hand-rolled primitives.** `@fastify/cookie`,
`@fastify/session`, `@fastify/csrf-protection`, and `@fastify/oauth2` own
cookie parsing, session lifecycle, CSRF, and the OAuth exchange respectively.
The only bespoke pieces are the PostgreSQL session store and the expiry
arithmetic behind it.

## Threat boundary

Everything below `/api` is untrusted input until `requireOwner` has run.

| Threat | Control |
| --- | --- |
| Anonymous access to board data | `requireOwner` on every card route; deterministic 401 `authentication_required` |
| A non-owner GitHub account signing in | Numeric id compared at callback; 403 `access_denied`, and no session row is created |
| An owner id change leaving stale access | The guard re-checks identity per request, not at login only, and destroys the mismatched session |
| Session fixation | `session.regenerate()` on every successful login; the pre-login id stops working |
| Stolen session id | Opaque, signed, `HttpOnly` (unreadable from JS), `Secure` in production, eight-hour cap |
| Cross-site request forgery | `SameSite=Lax` plus `@fastify/csrf-protection` on logout and card creation; the secret lives in the server-side session |
| Authorization-code interception | PKCE `S256` (`code_challenge` on authorize, `code_verifier` on exchange) plus `state` |
| Over-broad GitHub access | No scopes requested, so the short-lived token grants no repository or account access |
| Token leakage | The access token never leaves the callback's scope; `sessionSchema` is `.strict()` so an accidental extra field fails tests |
| A forged `X-Forwarded-Proto` claiming TLS | Only `TRUSTED_PROXY_IPS` peers are believed; blanket values are refused and production will not start unconfigured |
| A session quietly outliving its eight-hour cap | `least(existing, proposed)` in the upsert, so no later write can move the deadline forward |
| An abandoned session row sitting in the table indefinitely | A fifteen-minute sweep deletes expired rows; the timer is unreferenced and cleared on app close |
| An internal error describing the schema to its caller | One error handler answers `500 internal_error` and logs the real message server-side |
| Secrets in the repo or environment | Only file *paths* are configured; startup fails closed on any bad value, and errors name the variable, never the contents |
| A test double reaching production | `buildApp` takes the provider as a dependency; `composition-root.test.ts` fails if any production module imports a fake, or if a bypass flag appears |

## Consequences

- Card routes are now owner-only. Existing card behaviour is unchanged once
  authenticated, but every API test must establish a session first.
- `buildApp` is async and takes a dependency object rather than a bare
  `Database`, because the plugins register asynchronously.
- Migration `0001_owner_sessions` adds the `sessions` table and its expiry
  index. It is additive and backward-compatible: the previous release keeps
  working against the new schema, so no destructive-migration approval is
  needed.
- End-to-end browser coverage is limited to the unauthenticated path, since
  completing a real OAuth exchange in CI would require a real GitHub account.
  Owner, wrong-user, rotation, expiry, logout-invalidation, and CSRF paths are
  covered by API integration tests using an injected fake OAuth adapter.
- Local development now requires four secret files; `.env.example` documents
  how to create throwaway ones.
- A production deployment must set `TRUSTED_PROXY_IPS` before the API will
  start. This is a new gate on the first deploy, and the reverse proxy's address
  has to be known at that point.
- PostgreSQL-backed suites still self-skip locally, but an unreachable database
  fails them when `CI` is set, so the pipeline cannot report green having run
  none of the authorization and session cases.
- PKCE is implemented per GitHub's OAuth App documentation, which supports and
  recommends `code_challenge`/`code_challenge_method=S256` with `code_verifier`
  on the exchange.

## Alternatives considered

- **A signed stateless session cookie.** Rejected: logout and rotation could not
  invalidate an already-issued cookie before its expiry.
- **Authorizing on the GitHub login handle.** Rejected: handles are mutable and
  re-claimable.
- **Hand-rolled cookie, CSRF, and OAuth handling.** Rejected on review; the
  maintained Fastify plugins carry the security-relevant edge cases.
