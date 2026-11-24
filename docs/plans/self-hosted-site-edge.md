# A self-hosted edge for public sites

docs/public-sites.md publishes sites through Cloudflare Tunnel, so
Cloudflare holds the DNS zone, ends TLS and absorbs abuse. This plan
replaces the tunnel with an edge the install runs itself, for an operator
who wants no third party in front of their sites. Everything behind the
tunnel stays as it is: the router, the per-site Services and policies,
releases and deploys. Only what reaches the router changes.

It also gives the install one way to get a certificate for a DNS name, which
the edge, the token endpoint (docs/plans/token-endpoint.md) and the tailnet
site tunnel all use.

## What this builds on

docs/plans/token-endpoint.md, for two things: the forwarder container that
publishes an address of the machine into a kind cluster, and the token
listener, to which this plan adds a name.

## Three rules shared with the token endpoint

Everything an install exposes beyond the tailnet follows them, so there is
one way to set each thing up:

1. **Where it listens is an address the admin names.** Public or private
   is only which address that is. Nothing binds a wildcard, and there is no
   default. An address reaches a pod the same way for every listener: the
   forwarder container on kind, an address a node holds on byo.
2. **A certificate is a `tls.crt` and `tls.key` pair that its listener
   re-reads when it changes.** Who fills it follows from one question, not
   from a choice of mechanisms: a listener dialed by address gets a pair
   yaac generates (the token endpoint only), and a listener with a DNS name
   gets a pair the install's issuer fills.
3. **The token endpoint's TLS ends in the server.** The edge parses traffic
   from the whole internet and never carries a bearer token.

## What the edge takes on

| Job | Under the tunnel | Self-hosted |
|---|---|---|
| Inbound reachability | none needed; cloudflared dials out | an address the admin names, on 80 and 443 |
| TLS | Cloudflare | certificates the install's issuer keeps current |
| DNS | the user's Cloudflare zone | an A record per hostname, the user's to set |
| Abuse, DDoS | Cloudflare | the operator's |

## The edge

`yaac cluster install --site-edge-listen <addr>` runs the self-hosted edge.
`<addr>` is an IPv4 literal the machine or a node holds, checked by the
parser the token endpoint's flag uses, with ports 80 and 443 implied. An
install runs one edge for public sites: the tunnel when given
`CF_TUNNEL_TOKEN`, this one when given the flag, and both together are
refused. Switching replaces the objects the other applied, as switching
server frontings does. The live cluster is the record, and
`--no-site-edge-listen` removes it.

The edge is a Deployment of its own, `yaac-site-edge`: stock Envoy, the
image netd pins, in front of the router's public listener, where
cloudflared stands today. On 443 it ends TLS and forwards to the router,
which picks the site by `Host` as it does now. On 80 it redirects to
`https`. The router stays off the internet.

### Reachability

- **kind.** The forwarder container of docs/plans/token-endpoint.md
  ("kind") publishes `<addr>:80` and `<addr>:443` to the edge's NodePort
  Service. Nothing is added to the kind node's port mappings, so turning
  the edge on, moving it and removing it are each one `yaac cluster
  install`, with running workspaces untouched. The forwarder sends the
  PROXY protocol header, which the edge reads, so the edge and its logs
  see the client's address and not the forwarder's.
- **byo.** A Service with `externalIPs: [<addr>]` on 80 and 443, with the
  refusals the token endpoint's Service has: an address no node reports,
  and an address and port another Service names. The edge's pods are pinned
  to the node that holds the address and the Service has
  `externalTrafficPolicy: Local`, so the client's address reaches them. A
  `LoadBalancer` Service is later work, for the edge as for the token
  endpoint.
- **Hetzner k3s.** The address is the control node's public one, and
  `infra/hetzner-k3s` gains a variable that opens 80 and 443 in its
  firewall.

The edge's ingress admits any source on its two ports. Its egress reaches
the router and nothing else. In particular it never reaches the server, on
the API port or on the token port, which admits any source once
`--token-listen` is set. So the server's wall is unchanged, and a
compromised edge is left holding only what any internet client has.

### Certificates

The edge serves one certificate, in the Secret `yaac-site-edge-tls`,
mounted and re-read through Envoy's file-based secret discovery. Its names
are the hostnames of the published public sites. The server keeps that
list current, as it keeps the router's route table: publishing or
unpublishing a site rewrites the names, the issuer issues again, and the
edge picks up the new pair. Until it does, a newly published hostname is
routed but not yet covered.

`yaac site publish` prints the address to point the hostname at. The
`sites` check gate reports a hostname whose record does not resolve to the
edge, and one the certificate does not yet name.

## One issuer

`yaac cluster install --cert-issuer <name>` names a cert-manager
`ClusterIssuer`, and from then on yaac asks it for every named certificate
the install needs. yaac only creates and updates `Certificate` objects. It
never holds a DNS credential and never speaks ACME.

| Certificate | Asked for when | Lands in |
|---|---|---|
| the edge's, for the published hostnames | the self-hosted edge runs | `yaac-site-edge-tls` |
| the token endpoint's, for its name | `--token-name` is set | `yaac-server-token-tls` |
| the tailnet site tunnel's wildcard | the install has a site domain | `yaac-site-tunnel-tailnet-tls` |

- **cert-manager** is the cluster owner's on byo: install checks for it and
  for the issuer being ready, and refuses until both are, as it does for
  the Tailscale operator. On kind install sets cert-manager up from a
  pinned manifest. The issuer is the operator's on both, because it holds
  their DNS credential.
- **Without `--cert-issuer`** the operator fills each Secret by hand, as
  the tailnet tunnel's is filled today. A listener serves whatever pair is
  there, and waits when none is.
- **The server's ClusterRole** gains `certificates` in its own namespace,
  for the edge's list of names.

### The DNS challenge

A certificate authority issues for a name only to someone who proves they
control it. There are two common proofs, and the issuer here uses the DNS
one:

1. cert-manager asks the authority (Let's Encrypt, say) for a certificate
   for `shop.example.com`.
2. The authority answers with a value to publish.
3. cert-manager creates a TXT record `_acme-challenge.shop.example.com`
   holding that value, through the DNS provider's API.
4. The authority looks the record up in public DNS, sees the value, and
   issues. cert-manager deletes the record and writes the pair to the
   Secret.
5. It repeats this before the certificate expires, with no one involved.

The authority never connects to the thing being certified. That is why
this is the one proof that fits every certificate in the table:

- **A private address works.** The token endpoint can have a real
  certificate for a name that resolves to `10.0.1.2`, and so can a name
  only the tailnet resolves.
- **A wildcard works**, which the tailnet tunnel needs. The other proof
  cannot issue one.
- **Nothing has to be reachable first.** A site's certificate can be ready
  before its A record points at the edge.

The other proof, answering an HTTP request on port 80 at the name, is not
used. It works only for a name that already reaches the edge from the
internet, cannot issue a wildcard, and would need an ingress controller or
gateway in the cluster for cert-manager to answer through.

What the DNS challenge asks of the operator:

- **The names' zones are in public DNS, at a provider with an API**
  cert-manager supports (Cloudflare, Route 53, Google Cloud DNS, Azure DNS
  and others directly, more through webhooks). Only the challenge record
  has to be public: the address record of a private name can stay in a
  private zone.
- **A credential for that API, in a Secret cert-manager reads.** Many
  providers scope such a credential to a whole zone, and whoever holds it
  can repoint any name in the zone. Two things narrow that: a credential
  limited to TXT records where the provider allows it, and delegating
  `_acme-challenge.<name>` by CNAME to a small zone kept only for
  challenges, so the credential covers nothing else. The yaac server's
  ClusterRole reads Secrets cluster-wide, so a compromised server could
  read this one.
- **Issued names are public.** Every certificate is logged publicly, so a
  private name's existence is visible, though not its address.
- **Issuance takes a minute or two**, while the record spreads, and the
  authority limits how many certificates a domain gets in a week. One
  certificate for all the edge's hostnames keeps well inside that.

docs/public-sites.md gains this section when the plan ships, with one
worked `ClusterIssuer`.

## A name for the token endpoint

`yaac cluster install --token-name <host>` gives the token endpoint a DNS
name beside the address `--token-listen` sets. It changes one thing: the
pair in `yaac-server-token-tls` is the issuer's, for that name, and not one
yaac generates. Callers then dial the name and verify it the ordinary way,
with nothing to pin, and the address behind the name can change without
their noticing.

- It needs `--token-listen` and `--cert-issuer`. The user points the name
  at the address.
- The name may be private or public, since the DNS challenge does not care
  which.
- The listener, its port and its hardening do not change, and TLS still
  ends in the server. Install replaces a pair yaac generated with the
  issued one, which the listener's re-read picks up.
- `--no-token-name` goes back to a generated pair, on a new key, so callers
  that pin must be given the new fingerprint.
- It is k8s only. A containerless server has no issuer.
- **Beside the edge** it is one more listener on the same address, on its
  own port. Install refuses a token port of 80 or 443 on the edge's
  address. Serving the token endpoint on the edge's 443, by passing that
  name's TLS through to the server, is possible later and changes none of
  the rules.

## After Kubernetes

Under docs/plans/off-kubernetes.md the edge is a unit on the host's network
that binds the address itself, and the forwarder and the Services go with
the `k8s` driver. The pairs are directories of the data dir, and the
listeners keep re-reading them. What fills a named one is then an ACME
client run as a unit, making the same DNS challenge, in cert-manager's
place.

## Volume backups

Production data in a volume needs backups before this edge matters much.
That work is in docs/plans/cluster-backups.md, which does not yet cover
volumes (docs/workspace-volumes.md "Not yet").

## Tests

- **Unit**: the edge's manifests, its Service and policies, the forwarder's
  two ports, the three `Certificate` objects and the edge's list of names
  following publish and unpublish, under `drivers/k8s/…` and
  `domain/sites/`, against `fakeCluster`.
- **E2e**: `--site-edge-listen`, `--cert-issuer`, `--token-name` and their
  `--no-` forms get their flag refusals in `test/e2e-cli/cluster-cli.test.ts`,
  with the missing-issuer refusal against its fake cluster. The site suite
  gains one case: the harness applies the edge with a pair it made itself,
  runs the forwarder on free loopback ports, and a request to a published
  hostname through it reaches the release over TLS and carries the
  client's address.
- **Not covered by e2e**, and said so in the change that ships it: a real
  issuer and a real DNS challenge, which need a domain and a provider
  credential. One manual run, on Hetzner, issuing the edge's certificate,
  a private token name and the tailnet wildcard.

## Open questions

- **One certificate for every hostname.** Let's Encrypt allows 100 names
  on one, and a single hostname in a zone the issuer cannot write to fails
  the whole request, leaving later sites uncovered until it is unpublished.
  The alternative is a certificate per hostname, which needs the edge to
  load a set of pairs that changes at runtime.
- **`externalTrafficPolicy: Local` with `externalIPs`**, and Envoy's
  file-based secrets following a Secret's rotation, are both documented
  behaviour this plan has not run.
- Rate limiting and request size limits at the edge, which Cloudflare
  provides under the tunnel.
- IPv6.
