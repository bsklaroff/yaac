# Cloud identity on AWS and Azure

docs/cloud-identity.md describes how a project's workspaces act as a
cloud identity on GCP: the server mints tokens, the egress proxy stands in
for the metadata server, and a placeholder token is swapped for the real
one on the cloud's API hosts. This plan extends that to AWS and Azure.

## What is already cloud-neutral

- The `projects.cloudIdentity` setting (`host` or a named identity), the
  install-owner check, and the `host` warning.
- The provider interface in `#domain/cloud-identity` (`detect`,
  `validateId`, `obtain`), tried in order at server start. A new cloud adds
  a provider to the list.
- The `CloudCredential` shape and the `yaac-proxy-cloud-creds` Secret,
  apart from `provider`, which names the cloud.

The proxy half (`k8s/proxy/cloud-metadata.ts`) is GCP-shaped and needs a
dispatch on the credential's provider: each cloud's metadata API and its
API hosts.

## Azure

Azure fits the swap model. IMDS
(`/metadata/identity/oauth2/token?resource=…`, header `Metadata: true`)
issues bearer tokens, but one per audience. The provider mints a token for
each audience it supports (`management.azure.com`, storage, Key Vault,
Graph), and the proxy swaps by a host-to-audience table, so the credential
becomes a set of tokens rather than one. Named ids are client ids of
user-assigned managed identities attached to the VM.

## AWS

AWS cannot use the swap. Its credentials are an access key, secret key and
session token, and a request carries a SigV4 signature computed from the
secret rather than the secret itself, so a placeholder secret signs
requests AWS rejects. Re-signing in the proxy breaks on S3 streaming
uploads (a signature on every chunk) and on presigned URLs made in the
workspace.

Instead, the credential passes through: the provider assumes the named
role with `sts:AssumeRole` (with a short duration, optionally narrowed by a
session policy), and the stand-in IMDSv2 (`PUT /latest/api/token`, then
`/latest/meta-data/iam/security-credentials/<role>`) hands the real
temporary credentials to the workspace. The credential is then in the pod
for its lifetime, which is weaker than the swap; the docs and the `host`
warning must say so.

This adds a `mode` to the provider (`swap` or `pass-through`) so the proxy
knows whether to answer with a placeholder or the real credential.
