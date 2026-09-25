# ADR 0008: sslip.io POC hostname

## Status

Accepted

## Date

2026-09-25

## Superseded records

None.

## Context

`CONTEXT.md` assumed a free deSEC `*.dedyn.io` hostname for the production
VPS. That account was unavailable, so the TLS/hostname gate approved in
https://github.com/malbr/pocketboard/issues/8#issuecomment-5826022831 and
https://github.com/malbr/pocketboard/issues/8#issuecomment-5826053819 chose
`pocketboard.43-156-84-63.sslip.io` instead: a wildcard DNS service that
resolves any `<label>.<IP>.sslip.io` name to the embedded IP address, needing
no account, token, or DNS record.

## Decision

- The production hostname is `pocketboard.43-156-84-63.sslip.io`, embedding
  the VPS's current IPv4 address `43.156.84.63`.
- This is accepted for the non-critical POC only. It is not a general
  replacement for an owned domain.
- The reviewed host state, completed in
  https://github.com/malbr/pocketboard/issues/8#issuecomment-5826103589:
  the Ubuntu `caddy` package (installed with `libnss3-tools`, no other
  package changed) reverse-proxies exactly this hostname to
  `127.0.0.1:8080`, obtains and renews its public TLS certificate
  automatically through Let's Encrypt HTTP-01, and returns `502` for now
  because nothing yet listens on 8080. That `502` is expected and is not an
  application health signal.

## Consequences

- **Third-party dependent.** sslip.io must keep resolving `*.sslip.io` to the
  embedded IP for the hostname to work; PocketBoard does not control that
  service.
- **IP-coupled.** The hostname is only valid while the VPS keeps IPv4
  `43.156.84.63`. If the VPS is rebuilt or its IP changes, every reference to
  this hostname (`PUBLIC_URL` in `/etc/pocketboard/deploy.env`, the Caddy
  site block, and the production GitHub OAuth App's homepage and callback
  URLs) needs a coordinated migration to the new `<label>.<new-IP>.sslip.io`
  name, approved the same way as the original TLS/hostname gate.
  `docs/deployment.md` and `deploy/vps/config/deploy.env.example` name the
  current hostname directly rather than as a placeholder, so a migration must
  update those files in the same change.
- **Replace when PocketBoard matters.** If PocketBoard moves past a
  non-critical POC, replace this hostname with an owned domain under
  `malbr`'s control instead of continuing to depend on sslip.io.
- This decision does not authorize application deployment, migration,
  database access, secrets, OAuth App configuration, or GitHub Environment
  changes; https://github.com/malbr/pocketboard/issues/8#issuecomment-5826103589
  lists what remains before the first deploy.
