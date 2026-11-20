# Token clients: machine callers with OIDC tokens

A **token client** is a program, not a person, that calls a yaac server's
HTTP API and proves who it is with an OpenID Connect ID token issued by
someone other than yaac: a Google service account, a GitHub Actions job, an
Azure managed identity, another cluster's service-account token, an Okta or
Auth0 machine client. A user registers the client once, and from then on
its requests act as that user.

The motivating case is a backend on Google Cloud Run that creates and drives
workspaces on a yaac install running on a GCP VM. It cannot join the tailnet
in any natural way: Cloud Run has no long-lived host to run `tailscaled`,
and a tagged device gets no identity from `tailscale serve`
(docs/remote-hosting.md "Client setup"). The alternative, a proxy on the VM
that forwards to the loopback origin, makes every caller the install's owner
with no way to tell callers apart. Cloud Run already holds an identity, its
service account, and can mint a Google-signed ID token for any audience from
its metadata server. This plan lets yaac accept that, without depending on
Google.

## Goals and non-goals

Goals:

- Any issuer that publishes OIDC discovery and a JWKS works, configured with
  data, not code.
- A token client acts as one existing user, through the same `Principal`
  and access checks every route already applies (docs/multi-user.md).
- Both drivers. The motivating install is `k8s`; a host server gets the same
  listener.
- No new way in to the existing origins. Loopback and `tailscale serve`
  keep identifying callers exactly as they do today.

Non-goals:

- **People signing in.** Browsers keep using loopback or the tailnet.
- **yaac issuing credentials.** No API keys, no secret to store or rotate on
  either side. A static-token issuer could be added later behind the same
  listener if a caller has no OIDC identity at all.
- **CLI support.** The motivating backend speaks HTTP. A per-server
  `tokenCommand` in `server.json` for the CLI is a natural follow-up.
- **Cloud plumbing.** Networks, firewalls and service accounts are the
  operator's (see "Example: Cloud Run to a VM").

## Why a separate listener

The existing API port treats a request that did not come through serve and
names a loopback `Host` as the owner (docs/remote-hosting.md "Security
model"). `Host` is the caller's to choose, so that port can never be exposed
beyond loopback and the node, which is why a host server refuses a
non-loopback bind and why the in-cluster server's ingress policy is part of
authentication (docs/server-in-cluster.md "The ingress policy is the
wall").

Token clients therefore get their own port. On it, the bearer token is the
only identity: the loopback and serve rules never run, and a request
without a valid token is refused whatever its headers say. The API port's
rules and its wall stay as they are.

## Identifying a token client

1. The request carries `Authorization: Bearer <JWT>` (also on WebSocket
   upgrades, so terminals and `/events` work).
2. The server reads the unverified `iss`, fetches
   `<iss>/.well-known/openid-configuration` and the `jwks_uri` it names,
   and caches both. An issuer must be `https`.
3. It checks the signature, `exp`/`nbf` with a small clock skew, and that
   `aud` contains the install's **audience**.
4. It looks up the registered client for `(iss, sub)`. None is a 401.
5. The request runs as that client's owner. `/whoami` reports a new caller
   kind, `token`, with the client's label, and the request log names it.

Matching is on `sub`, not `email`: every issuer sets `sub`, and it is
stable where email is not. For a Google service account it is the
account's numeric unique id; for GitHub Actions it is a string such as
`repo:org/repo:ref:refs/heads/main`.

The audience is install-wide and is what stops a token minted for another
service from being replayed against yaac. It is any string the operator
picks; it need not be a URL.

## Who may register a client

A user registers clients that act as themselves, and no one else. A row in
a new `token_clients` table holds `owner`, `issuer`, `subject`, `label` and
creation time, with `(issuer, subject)` unique. Routes to add, list and
remove them are owner-scoped, like git credentials, with a matching
Settings pane.

Because a client can only act as the user who trusted it, the install needs
no allowlist of issuers. Whoever controls an issuer can at most act as a
user who chose to trust it. Admins can list every user's clients and remove
any, so a leaked identity can be cut off without its owner.

A token client is never a person for `requirePerson` (docs/multi-user.md
"Authorization"): it cannot approve privileged launches or change published
sites, as a workspace's agent cannot.

## Configuring the listener

Two install-time settings, recorded with the access mode so a later start
cannot drop or change them silently:

```sh
yaac cluster install --token-listen <addr>:<port> --token-audience <aud>
yaac server start    --token-listen <addr>:<port> --token-audience <aud>
```

Every later start or install must repeat them or pass `--no-token-listen`,
as `--tailnet` works today. The listener works in either access mode; in a
`local` install the only user is the built-in one, so every client acts as
it.

### TLS

The listener serves TLS itself, so the feature is safe without a load
balancer in front: a bearer token should not cross a network in clear text,
even a private one. The certificate is either one the operator supplies
(`--token-tls-cert`/`--token-tls-key`, stored as a Secret under `k8s`), or a
self-signed one install generates and keeps, printing its SHA-256
fingerprint for clients to pin.

### Under `k8s`

- The server Deployment gains a `token` container port, and its Service a
  `token` port.
- A third NetworkPolicy, `yaac-server-ingress-token`, admits any source on
  the token port only. The node and fronting halves keep guarding the API
  port.
- **kind**: a second `extraPortMapping` delivers `<addr>:<port>` on the host
  to the token port, through the forwarder (or a second listener on it).
  kind writes port mappings only when a cluster is created, so adding the
  listener to an existing cluster takes `yaac cluster delete` then `yaac
  cluster install`, the fix the docs already give for a missing mapping;
  install refuses with that instruction.
- **byo**: only the Service port. Exposing it (a LoadBalancer, an internal
  load balancer, an Ingress) is the cluster owner's.
- The server's own egress policy (docs/server-in-cluster.md "The server's
  own egress") must allow the discovery and JWKS hosts of the issuers
  clients use. Either the token clients' issuers are opened as they are
  registered, or the operator lists them at install.

### Under `containerless`

The host server opens the token listener beside its loopback port; this is
the one non-loopback bind it allows. It adds no separation: any workspace
can already act as any user there (docs/multi-user.md "Trust model").

## Example: Cloud Run to a VM

yaac side, on the VM and as the user the backend acts as:

```sh
yaac cluster install --token-listen 10.128.0.5:8443 --token-audience yaac-prod
yaac token-client add --issuer https://accounts.google.com \
  --subject <service account unique id> --label cloud-run-backend
```

GCP side, outside yaac:

- The Cloud Run service runs as a dedicated service account, with Direct
  VPC egress into the VM's network.
- A VPC firewall rule admits the Cloud Run subnet to `10.128.0.5:8443` and
  nothing else.
- The backend fetches an ID token from
  `http://metadata/computeMetadata/v1/instance/service-accounts/default/identity?audience=yaac-prod`
  (the Google auth libraries do this and refresh it), and sends it as
  `Authorization: Bearer …`, pinning the listener's certificate.

## Work

- Server: the token listener and verifier beside `identify()` in
  `api/http/web-auth.ts`; a `token` caller kind in `Principal` and
  `/whoami`.
- DB: `token_clients`, with a Drizzle migration; the token-client store
  behind `#db`.
- Routes: add/list/remove, with rows in `test/api/route-matrix.ts` for both
  drivers; a Settings pane.
- CLI: `yaac token-client add|list|remove`, and the install/start flags,
  each with an e2e test.
- k8s install: the port, Service port, NetworkPolicy, kind mapping, TLS
  Secret, and server egress.
- Docs: a "Token clients" section in docs/remote-hosting.md and the
  ownership rules in docs/multi-user.md; delete this plan.

## Open questions

- **Registration by any user, or by admins only.** Admin-only is tighter
  but makes admins hand out identities. This plan picks any user, for
  themselves.
- **Issuer egress.** Open per registered issuer automatically, or require
  the operator to list issuers at install.
- **Matching on more than `sub`.** Some issuers put the useful constraint in
  other claims (GitHub's `repository_owner`, `job_workflow_ref`). An exact
  `sub` match covers the motivating case; a claim filter could come later.
- **Revocation latency.** Removing a client takes effect on the next
  request, but a token already issued stays valid at the issuer until it
  expires (an hour for Google). That only matters if the issuer is the
  thing compromised.
