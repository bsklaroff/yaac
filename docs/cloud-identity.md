# Cloud identity for workspaces

A k8s-driver workspace can act as a cloud identity, so gcloud and the
Google client libraries inside it work without a key file. Only GCP is
supported; other clouds are planned in
docs/plans/cloud-workload-identity.md. Under `containerless` there is
nothing to lend: a workspace is a host process and already uses the host's
own credentials, so the routes refuse with `NOT_SUPPORTED`.

## Why workspaces cannot use the metadata server

The proxy's egress policy (`wideEgress`, docs/server-in-cluster.md)
excludes `169.254.169.254`, so no workspace reaches the real metadata
server. It hands out more than tokens: startup scripts, SSH keys, instance
attributes, and on some clouds a node's join credentials. Most installs do
not want every workspace to hold the machine's identity, so a workspace
gets one only when its project asks for it.

## How it works

The server obtains real tokens, and the egress proxy stands in for the
metadata server, handing out a placeholder:

1. **A project setting names the identity.** `projects.cloudIdentity` is
   `host` (the server's own identity), a service account email to
   impersonate, or null for none.
2. **The server finds its cloud once, at start.** `#domain/cloud-identity`
   probes the metadata server (the server pod is outside the world-egress
   deny). A response carrying `Metadata-Flavor: Google` means GCP, and gives
   the server's service account email and project. Anything else means no
   cloud, and no project can be given an identity.
3. **The server mints and refreshes tokens.** For `host`, from the metadata
   server; for a named account, through IAM Credentials
   `generateAccessToken`, called with the server's own token, which needs
   `roles/iam.serviceAccountTokenCreator` on that account. A token is
   minted before the setting is saved, so an account the server cannot act
   as is refused with Google's reason. Every minute the server re-mints any
   token within ten minutes of expiry and pushes the set through the
   driver's `syncCloudCredentials` verb.
4. **The proxy answers metadata requests itself.** The k8s driver writes the
   set into the `yaac-proxy-cloud-creds` Secret, which the proxy watches
   (docs/workspace-egress.md "What the proxy is told, and how"). A
   workspace's plain-HTTP request to `169.254.169.254` or
   `metadata.google.internal` is answered by `cloud-metadata.ts` and never
   dialed, before the allowlist is consulted.
5. **The proxy swaps the token in.** The workspace gets
   `yaac-ph-cloud-token` as its access token. On `*.googleapis.com`, which
   the proxy MITMs for a project with a credential, a bearer of that
   placeholder is replaced with the real token. The real token never enters
   the workspace. gcloud ignores the usual CA variables, so workspaces also
   get `CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE` pointing at the combined bundle
   (docs/nested-containers.md).

## What the stand-in metadata server answers

Only what gcloud and the auth libraries read to find a service account and
fetch its token, and only with `Metadata-Flavor: Google` on the request:

- the probe (`/`, `/computeMetadata/v1/`);
- the account under `default` or its email: the token, `email`, `aliases`,
  `scopes` (`cloud-platform`), and the `?recursive=true` listings;
- `project/project-id` and `project/numeric-project-id`, the server's own
  project.

Everything else is `404`, including instance and project attributes and
identity tokens. A project with no identity gets `404` without the
`Metadata-Flavor` header, which the libraries read as "not on GCE". A token
the server failed to refresh, and that has now expired, answers `503`
rather than handing out a placeholder that would fail later.

## Who may set it

An identity spends the server's own cloud authority, so only the install
owner (the built-in user, docs/remote-hosting.md "Access modes") may set
one, on any project. A workspace acting through yaac-mama is refused, so an
agent cannot give itself an identity. Wherever `host` is chosen (the
webapp's project settings, `yaac config cloud-identity`), yaac names the
server's identity and warns that sessions in the project inherit all of its
permissions. A named account is the better choice: the server's own often
also serves the machine (logs, image pulls, a GKE node), and projects
sharing it share its permissions and look alike in Cloud Audit Logs.

## Limits

- **Access tokens only.** Identity tokens for Cloud Run or IAP are sent to
  arbitrary hosts, which a host-scoped swap cannot follow.
- **Bearer headers on `*.googleapis.com` only.** Artifact Registry's docker
  login (`*-docker.pkg.dev`) and `storage.cloud.google.com` get no swap.
- **The placeholder works only where it is swapped.** A tool that sends the
  token elsewhere, or checks it with `oauth2.googleapis.com/tokeninfo`, sees
  it fail.
- **Builder pods get no identity.** They keep the metadata block.
- **On GKE**, the server's identity is whatever its pod's metadata server
  returns: its Workload Identity account if one is bound.
