# A self-hosted edge for public sites

docs/public-sites.md publishes sites through Cloudflare Tunnel, so
Cloudflare holds the DNS zone, ends TLS and absorbs abuse. This plan
replaces the tunnel with an edge the install runs itself, for an operator
who wants no third party in front of their sites. Everything behind the
tunnel stays as it is: the router, the per-site Services and policies,
releases and deploys. Only what reaches the router changes.

## What the edge takes on

| Job | Under the tunnel | Self-hosted |
|---|---|---|
| Inbound reachability | none needed; cloudflared dials out | a public IP on 80 and 443 |
| TLS | Cloudflare | ACME certificates, renewed in the cluster |
| DNS | the user's Cloudflare zone | an A/AAAA record per hostname, the user's to set |
| Abuse, DDoS | Cloudflare | the operator's |

## Reachability

- **byo.** A `LoadBalancer` Service in front of a TLS-terminating proxy, with
  `externalTrafficPolicy: Local` so the client's address reaches the pod
  and its logs.
- **kind on a machine with a public IP.** kind writes port mappings only
  when a cluster is created (docs/server-in-cluster.md "On kind: a
  forwarder"), so 80 and 443 must be in the cluster's `extraPortMappings`
  from the start, bound to the public interface. An existing cluster needs
  a `yaac cluster delete` and install. A NodePort suffices here, since the
  edge admits any source address, unlike the server.

The edge's ingress admits the internet on 80 and 443. It is not the server
and none of its egress reaches the server, so the server's wall is unchanged.

## TLS

Two options; pick one.

- **cert-manager plus an ingress controller or Gateway.** Standard and
  well understood. On byo these are the cluster owner's, and install only
  checks for them and refuses until present, as it does the Tailscale
  operator. On kind install sets them up from pinned manifests.
- **Envoy ending TLS itself**, with certificates issued by cert-manager into
  Secrets the router reads through SDS. One proxy fewer, but the router
  becomes internet-facing.

HTTP-01 challenges need port 80 open and each hostname already pointed at
the edge. DNS-01 avoids both, and allows wildcard certificates, but needs
credentials for the user's DNS provider.

## DNS

The user sets each hostname's record. `yaac site create` prints the address
to point at, and the `sites` check gate reports a hostname whose record
does not resolve to the edge. external-dns could create the records for a
supported provider; whether that is worth its credentials is an open
question.

## Choosing the edge

An install runs one edge, chosen at `yaac cluster install`: the tunnel when
given `CF_TUNNEL_TOKEN`, the self-hosted edge with `--site-edge
self-hosted`. Switching edges replaces the objects the old one applied, as
switching server frontings does.

## Volume backups

Production data in a volume needs backups before this edge matters much.
That work is in docs/plans/cluster-backups.md, which does not yet cover
volumes (docs/workspace-volumes.md "Not yet").

## Open questions

- Which TLS option, and HTTP-01 or DNS-01.
- Rate limiting and request size limits at the edge, which Cloudflare
  provides under the tunnel.
- IPv6 on kind's port mappings.
