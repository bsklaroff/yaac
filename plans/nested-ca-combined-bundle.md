# Nested-container CA trust: combined bundle (+ OS-store-injection options)

## Problem

Nested containers (in-pod podman, `nestedContainers: true`) need to trust the
session's MITM proxy on the hosts the proxy intercepts, **without** losing trust
in the real public roots for the hosts it doesn't. Today the nestable image
(`dockerfiles/Dockerfile.nestable`) only injects the CA into nested containers
through the user-level `containers.conf` `[containers] env`, and only with the
**additive** trust vars:

- `SSL_CERT_FILE` — OpenSSL still also consults the default `SSL_CERT_DIR`
  (`/etc/ssl/certs`), so the real roots remain alongside our CA.
- `NODE_EXTRA_CA_CERTS` — appended to Node's bundled roots.

That covers OpenSSL-default tooling (python `ssl`, ruby, php, openssl CLI,
OpenSSL-linked wget, Go via `crypto/x509`) and Node. It does **not** cover tools
that ship their own CA bundle and ignore `SSL_CERT_FILE`: **curl, Python
`requests`, Cargo's libcurl transport** (and git's libcurl, via `GIT_SSL_CAINFO`,
which is set today). Those each only honor a *single-file* pointer
(`CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO`).

The trap: those single-file vars **replace** the entire trust set rather than
augment it. Pointing them at our lone proxy CA makes the tool trust the MITM
cert but **reject the real cert of every host the proxy tunnels**. The proxy
only MITMs hosts it injects into — tool-auth hosts (`github.com`, `gitlab.com`,
`api.anthropic.com`, `api.openai.com`, …), hosts with `envSecretProxy` rules,
and (test) upstream redirects (`dispatchToUpstream`,
`k8s/proxy/proxy.ts`: `if (rules.length>0 || needsDynMitm || redirect)
handleMitm else handleTunnel`). Everything else allowlisted is **tunnelled**
(TLS passthrough → the container sees the real upstream cert): npm, PyPI,
crates.io, rubygems, maven, distro mirrors, and docker.io/quay in production.

So `CURL_CA_BUNDLE=<proxy-ca>` was reverted (it broke `curl
https://registry.npmjs.org`, `cargo build` against crates.io, etc.). The session
`5d5efc04` symptom — `curl https://github.com` failing with "self-signed
certificate in certificate chain" until `CURL_CA_BUNDLE` was set by hand — is the
mirror-image failure on a MITM'd host. **Neither single-source bundle is
correct; the trust set must be the union `{public roots} ∪ {proxy CA}`.**

## Goal

`docker run`/`docker build` containers trust BOTH the proxy MITM cert (for
intercepted hosts) AND real public certs (for tunnelled hosts), for the
own-bundle tools (curl / requests / cargo / git-libcurl) — out of the box, with
no per-container `-e` and no per-image cooperation. Keep the additive vars as-is.

## Approach A — mount a combined bundle, point the own-bundle vars at it

Produce a single PEM that is `{standard public roots} + {proxy CA}`, make it
available inside every nested container, and set the own-bundle vars to it:

```
CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE / CARGO_HTTP_CAINFO / GIT_SSL_CAINFO
  = /etc/yaac/certs/ca-bundle.pem   # roots + proxy CA
```

Because the file is a superset of the real roots, "replace" semantics become
correct: the tool trusts the proxy on intercepted hosts and the real upstreams
on tunnelled hosts.

Sub-options for *where the combined bundle comes from* (the proxy CA is runtime,
the roots are static):

- **A1 — daemon-written configmap.** The daemon already holds the proxy CA (it
  writes the `yaac-proxy-ca` ConfigMap). Have it write a second artifact
  `ca-bundle.pem = <roots> + <proxy CA>` (new ConfigMap or an extra key), mount
  it into nested containers via a `containers.conf` `volumes` entry, and point
  the vars at it. Needs a source of `<roots>`:
  - vendor a Mozilla roots PEM in the repo (e.g. a pinned `certifi`/`cacert.pem`)
    — simple, but a maintenance/staleness burden (must refresh on root changes);
  - or read the roots out of the **proxy** pod / a base image's
    `/etc/ssl/certs/ca-certificates.crt` at bundle-build time — no vendored
    file, roots track the image's `ca-certificates`.
  - Rotation-friendly: regenerating the bundle on CA change is just a file write
    (no image rebuild). The session's own `SSL_CERT_FILE` can keep pointing at
    the bare proxy CA (additive) or be repointed at the combined bundle.

- **A2 — bake into the session image at build.** `Dockerfile.default` already
  carries the machinery (`ARG SSL_CERT_FILE` + `cp … && update-ca-certificates`)
  to fold the proxy CA into the image's OS store, producing
  `/etc/ssl/certs/ca-certificates.crt = roots + proxy CA`. Pass the CA at build
  (it isn't passed today), then mount **that** file into nested containers and
  point the vars at it. Downsides: ties the image content to a specific CA →
  rebuild on CA rotation; the build arg threads the CA path through
  `resolveImageChain`.

Recommended: **A1** (daemon-written combined ConfigMap) — decouples the bundle
from image builds, so CA rotation needs no rebuild, and one artifact serves both
the `*_CA_BUNDLE` vars here and (optionally) the session's own trust env.

Tests: extend `test/e2e-cli/nested-containers.test.ts` with a nested container
that (a) reaches a MITM'd host (github-class) via curl AND (b) reaches a tunnelled
host (real cert) via curl/cargo, both succeeding — the exact pair that a single
proxy-CA bundle breaks. Unit: assert the bundle artifact contains both a known
public root and the proxy CA, and that the vars point at it.

## Approach B — inject into the nested container's OS trust store

Make every nested container's OS store itself contain `roots + proxy CA`, so
tools that read the OS store (curl's default, GnuTLS `wget`/`gnutls-cli`, …)
trust both with no env var. This is *additive* by construction (we add our CA to
the image's existing bundle), which is its appeal — but getting the CA *into*
the store of an arbitrary runtime image is the hard part. Options, roughly best
→ worst:

- **B1 — OCI `createContainer` hook.** A containers-common hook
  (`/etc/containers/oci/hooks.d/…`) that runs `update-ca-certificates` /
  `update-ca-trust` in the container's mount namespace after rootfs setup,
  before the entrypoint. Pros: real OS-store install, additive. Cons: runs for
  *every* container (latency); needs the `ca-certificates` tooling + a shell in
  the image, so it fails/no-ops on distroless/scratch/minimal images; distro-
  specific command + cert dir; an extra moving part to maintain.

- **B2 — pre-hashed drop-in via `volumes`.** Mount the proxy CA into the store's
  *hashed* directory (`/etc/ssl/certs/<subject_hash>.0`) so OpenSSL-dir and
  GnuTLS consumers pick it up without regenerating the concatenated bundle. The
  hash is stable for a given CA (computable by the daemon with
  `openssl x509 -subject_hash`), so it can be a static `volumes` entry. Cons:
  only helps consumers that read the *dir* (`SSL_CERT_DIR`/`--capath` style),
  NOT those that read only the single `ca-certificates.crt` file (curl's
  default, many GnuTLS builds) — so it's partial; Alpine/musl layout differs
  (`/etc/ssl/certs` + `/etc/ssl/cert.pem`).

- **B3 — bind-mount over `ca-certificates.crt` — REJECTED.** Mounting our CA
  *over* the concatenated bundle replaces all real roots with just our CA (same
  failure as the single-file env vars). Only viable if we mount a *combined*
  bundle over it — which is Approach A wearing a different hat, and is brittle
  across distro store paths.

- **B4 — document per-image install.** For images the user controls (their
  project Dockerfile / a base they build), install the proxy CA in *that*
  Dockerfile (`COPY` + `update-ca-certificates`). No yaac change; doesn't help
  arbitrary `docker run <upstream-image>`.

B1 is the only general OS-store route, and it's fragile; B2 is a partial,
low-cost complement. Net: **Approach A (combined bundle + env vars) is the
primary recommendation**; OS-store injection (B) is a fallback worth keeping in
mind for OS-store-only tools (GnuTLS `wget`/`gnutls-cli`) that no env var
reaches — but those are uncommon enough that documenting the explicit
`--ca-certificate` workaround may suffice for v1.

## Out of scope / still manual

- **Java/JVM** (own `cacerts` keystore) and **rustls-based** clients (`rustup`,
  `reqwest`+rustls, compiled-in webpki roots) honor neither the OS store nor any
  CA env var. They need `keytool -importcert` / `-Djavax.net.ssl.trustStore` and
  `RUSTUP_USE_CURL=1` respectively. Document, don't auto-handle.
- `GIT_SSL_CAINFO` is set today and has the same single-file replace semantics,
  but git hosts are almost always MITM'd (credential injection), so it rarely
  bites; folding it onto the combined bundle (Approach A) fixes the tunnelled-git
  edge case too.

## Verification

- Manual (nested session): from a `docker run` container, `curl https://github.com`
  (MITM'd → 200 via proxy CA) AND `curl https://registry.npmjs.org` (tunnelled →
  200 via real cert) both succeed with no `-e`; `cargo build` resolving crates.io
  succeeds; `pip`/`requests` to PyPI succeeds.
- e2e: the MITM'd + tunnelled curl pair above; unit: the combined bundle contains
  both a known public root and the proxy CA.
