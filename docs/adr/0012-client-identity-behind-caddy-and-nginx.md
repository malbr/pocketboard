# 0012. Client identity behind Caddy and nginx

- Status: Accepted
- Date: 2026-10-07
- Issue: #51

## Superseded records

None. This narrows how ADR 0001's `TRUSTED_PROXY_IPS` is set in production;
the rules ADR 0001 places on that variable are unchanged.

## Context

Rate limits key on `request.ip`. Fastify resolves it by walking
`X-Forwarded-For` from the right, starting at the socket peer, and stops at the
first address not in `TRUSTED_PROXY_IPS`. Production trusted only the web
container's nginx, but the chain has two proxies:

```text
client ─TLS─▶ host Caddy ─▶ 127.0.0.1:8080 ─▶ nginx 172.31.250.10 ─▶ api
```

Caddy reaches nginx through the loopback-published port, so nginx's peer is the
host side of the `frontend` bridge, `172.31.250.1`. nginx appends that with
`$proxy_add_x_forwarded_for`; the walk stopped there, and every visitor shared
one budget. Anyone could spend the 10-a-minute OAuth budget and lock the owner
out of sign-in.

Caddy's documented default replaces an incoming `X-Forwarded-For` with the
client's address unless `trusted_proxies` covers the client. The host Caddy
config is not in this repository and changing it needs its own gate.

## Decision

`compose.production.yml` sets `TRUSTED_PROXY_IPS` to exactly
`172.31.250.10,172.31.250.1`.

- `172.31.250.10` is nginx, fixed with `ipv4_address`.
- `172.31.250.1` is the `frontend` bridge gateway. Compose fixes the subnet
  `172.31.250.0/24` and sets no `gateway`, so Docker's IPAM assigns the
  subnet's first host address. Every connection the host makes into the bridge
  leaves from that address, whether through `docker-proxy` or the loopback NAT
  rule that replaces it.

The client is the rightmost address that is neither, which is the one Caddy
wrote. nginx and the API stay as they were; Caddy is unchanged.

## Consequences

- Distinct visitors get distinct budgets again.
- A forged `X-Forwarded-For` cannot choose the identity. Caddy discards it by
  default, and even an appending Caddy leaves it left of the client address,
  where the walk stops. A direct peer that is neither trusted address is its
  own identity whatever it sends.
- Trusting the gateway trusts the host: any process on the VPS that calls
  `127.0.0.1:8080` directly, including the owner's other services, can name
  its own client address and so spend another client's budget. That is the
  same trust the host already holds over Caddy and the container runtime.
  Callers with no `X-Forwarded-For`, such as the deploy script's health check,
  count as `172.31.250.1`.
- Two addresses now carry the trust instead of one. Setting a `gateway`,
  changing the subnet, moving nginx, or adding a third proxy breaks identity
  silently, so `packages/api/src/proxy-chain.test.ts` reads the trust list,
  addresses, and nginx header line from the deployment files and fails on
  each of those changes.
- An IPv6 path into `frontend` would arrive from a different gateway and be
  untrusted, which fails closed into one shared budget rather than open.

## Alternatives considered

- **nginx `real_ip` from the gateway, passing one clean value.** Equivalent
  trust, but it moves the decision into the web image, changes what nginx logs
  as the client, and still leaves the API trusting nginx's header, so it adds a
  second place to get right without removing the gateway trust.
- **Trusting all of `172.31.250.0/24`.** Simpler, but it would also trust the
  API's own dynamically assigned address and any container later attached to
  `frontend`.
- **A hop count.** Refused by ADR 0001: it trusts whatever the peer is.
- **Changing Caddy to send a dedicated header.** Needs a host change and its
  own gate, for no gain over the default Caddy already applies.
