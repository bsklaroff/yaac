# Nested-container CA trust: combined bundle

> Status: SHIPPED. This is the current-state reference for how nested
> containers (in-pod podman, `nestedContainers: true`) trust the session's
> MITM proxy. It is cited from several source files as the canonical
> rationale; keep it in sync with the code. The chosen design is **Approach
> A1** (server-written combined bundle), plus a **build-time `ca-certificates`
> drop-in** that the original proposal did not anticipate. The other
> approaches below are retained as design rationale (why combined bundle, why
> the alternatives were rejected).

## Problem

Nested containers need to trust the session's MITM proxy on the hosts the
proxy intercepts, **without** losing trust in the real public roots for the
hosts it doesn't. The challenge is that CA-trust configuration splits into two
incompatible shapes depending on what each tool reads:

- **Additive** vars layer our CA *on top of* the image's existing roots:
  - `SSL_CERT_FILE` — OpenSSL still also consults the default `SSL_CERT_DIR`
    (`/etc/ssl/certs`), so the real roots remain alongside our CA. Covers
    OpenSSL-default tooling (python `ssl`, ruby, php, openssl CLI,
    OpenSSL-linked wget, Go via `crypto/x509`).
  - `NODE_EXTRA_CA_CERTS` — appended to Node's bundled roots.

- **Replace** vars point at a *single file* that becomes the tool's entire
  trust set: `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `CARGO_HTTP_CAINFO`,
  `GIT_SSL_CAINFO`. These are the only knobs honored by tools that ship their
  own CA bundle and ignore `SSL_CERT_FILE`: **curl, Python `requests`, Cargo's
  libcurl transport, git's libcurl**.

The trap: pointing the replace vars at our lone proxy CA makes the tool trust
the MITM cert but **reject the real cert of every host the proxy tunnels**. The
proxy only MITMs hosts it injects into — tool-auth hosts (`github.com`,
`gitlab.com`, `api.anthropic.com`, `api.openai.com`, …), hosts with
`envSecretProxy` rules, and (test) upstream redirects (`dispatchToUpstream`,
`k8s/proxy/proxy.ts`: MITM when `rules.length > 0 || needsDynMitm || redirect`,
else tunnel). Everything else allowlisted is **tunnelled** (TLS passthrough →
the container sees the real upstream cert): npm, PyPI, crates.io, rubygems,
maven, distro mirrors, and docker.io/quay in production.

Symmetrically, the original additive-only setup (`CURL_CA_BUNDLE` unset) failed
the *other* way: `curl https://github.com` rejected the MITM cert with
"self-signed certificate in certificate chain" until `CURL_CA_BUNDLE` was set by
hand (session `5d5efc04`). **Neither single-source bundle is correct; the trust
set for the replace vars must be the union `{public roots} ∪ {proxy CA}`.**

## Goal (met)

`docker run`/`docker build` containers trust BOTH the proxy MITM cert (for
intercepted hosts) AND real public certs (for tunnelled hosts), for the
own-bundle tools (curl / requests / cargo / git-libcurl) — out of the box, with
no per-container `-e` and no per-image cooperation. The additive vars are kept
as-is for the OpenSSL/Node tools.

## Shipped design — Approach A1: server-written combined bundle

A single PEM that is `{standard public roots} + {proxy CA}` is produced at
runtime, made available inside every session pod and nested container, and the
own-bundle replace vars are pointed at it. Because the file is a *superset* of
the real roots, "replace" semantics become correct: the tool trusts the proxy
on intercepted hosts and the real upstreams on tunnelled hosts.

How it is wired, end to end:

1. **Roots source — the proxy pod itself.** The combined bundle reads its
   public roots from the proxy image's own `ca-certificates`, at
   `/etc/ssl/certs/ca-certificates.crt` (`SYSTEM_ROOTS_PATH`,
   `k8s/proxy/ca-bundle.ts`). No vendored Mozilla PEM — the roots track the
   image's `ca-certificates` package, so there is no separate staleness burden.

2. **Concatenation.** `combineCaBundle(rootsPem, caPem)`
   (`k8s/proxy/ca-bundle.ts`) returns `roots + sep + caPem`, inserting a
   newline only when the roots block doesn't already end with one (so the
   boundary `…END CERTIFICATE----------BEGIN CERTIFICATE…` is never produced).
   It is pure (no I/O) so it is unit-testable.

3. **Served by the proxy.** `GET /ca-bundle.pem` (`k8s/proxy/proxy.ts`) reads
   the system roots and returns `combineCaBundle(roots, ca.pem)` (503 until the
   CA is ready, 500 if the roots can't be read). The bare proxy CA stays on the
   existing `GET /ca.pem`.

4. **Server stores it in the ConfigMap.** The server fetches it with
   `ProxyClient.getCaBundle()` (`src/lib/container/proxy-client.ts`) and
   `ensureCaConfigMap(caPem, caBundlePem)` (`src/lib/k8s/bootstrap.ts`) writes
   BOTH keys into the existing `yaac-proxy-ca` ConfigMap: `proxy-ca.pem`
   (bare CA) and `ca-bundle.pem` (combined). It chose the proposal's
   "extra key in the existing ConfigMap" option, not a second ConfigMap. The
   write is skipped when both stored values already match (the common case —
   the proxy persists its CA in `/data` and regenerates only when that volume
   is lost), so CA rotation is just a file write, no image rebuild.

5. **Mounted into pods and nested containers.** `pod-spec.ts` mounts the
   ConfigMap at `CA_MOUNT_DIR = /etc/yaac/certs`, giving
   `CA_CERT_PATH = /etc/yaac/certs/proxy-ca.pem` and
   `CA_BUNDLE_PATH = /etc/yaac/certs/ca-bundle.pem`. The nestable image's
   `containers.conf` (`dockerfiles/Dockerfile.nestable`) re-exposes both files
   to nested containers via `[containers] volumes`.

6. **Env-var split (additive vs replace).** `ProxyClient.getCaTrustEnv()`
   (`src/lib/container/proxy-client.ts`) emits the two shapes:
   - additive → bare CA: `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS` =
     `/etc/yaac/certs/proxy-ca.pem`;
   - replace → combined bundle: `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`,
     `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO` = `/etc/yaac/certs/ca-bundle.pem`
     (plus `GIT_TERMINAL_PROMPT=0`).
   The nestable image's `containers.conf` `[containers] env` sets the same
   split for `podman run` inside the pod.

## Build-time path — `ca-certificates` drop-in (addendum to the proposal)

The original proposal assumed env vars + the volume mount would cover nested
containers. They don't cover `docker build` RUN steps: buildah does **not**
apply `containers.conf [containers] env` to build RUN steps (it applies only
`[containers] volumes`) — verified by the e2e test, where `CURL_CA_BUNDLE` is
empty inside a build. So build-time trust must ride a volume, not an env var.

The shipped mechanism is a **`ca-certificates` drop-in**: the bare proxy CA is
bind-mounted (via `[containers] volumes`) as a source cert at
`/usr/local/share/ca-certificates/yaac-proxy-ca.crt`
(`dockerfiles/Dockerfile.nestable`). When a build runs
`update-ca-certificates` (which `apt-get install ca-certificates` and many
package triggers do — the usual way a build gains HTTPS), it folds the drop-in
into the image's real roots, producing the correct union in the image's own
`/etc/ssl/certs/ca-certificates.crt`, which curl reads by default with no env.

This is a deliberately *non-B3* form of OS-store injection (see Approach B
below). Bind-mounting our cert directly **over**
`/etc/ssl/certs/ca-certificates.crt` was tried and reverted: that file is what
`update-ca-certificates` rewrites (temp file + `rename`), and `rename()` onto a
bind-mountpoint fails EBUSY ("Device or resource busy"), so the
`ca-certificates` postinst — and the whole build — fails. The drop-in composes
with `update-ca-certificates` instead of fighting it. This confirms the B3
rejection below in practice.

Caveat: a build that runs curl against a MITM'd host **without** ever
installing/refreshing `ca-certificates` won't pick up the drop-in; that case is
still covered at run time by the env vars, or by running
`update-ca-certificates` explicitly.

## Rejected / not-taken alternatives (rationale)

- **A2 — bake the CA into the session image at build.** `Dockerfile.default`
  already has the machinery (`ARG SSL_CERT_FILE` + `update-ca-certificates`),
  but it ties image content to a specific CA → rebuild on rotation, and threads
  the CA path through `resolveImageChain`. Not taken: A1 decouples the bundle
  from image builds (rotation = a file write).

- **Approach B — inject into the nested container's OS trust store** so tools
  that read the store trust both with no env var. Additive by construction, but
  getting the CA into an arbitrary runtime image's store is the hard part:
  - **B1 — OCI `createContainer` hook** running `update-ca-certificates` in the
    container before the entrypoint. General but fragile: runs for every
    container (latency), needs the tooling + a shell (no-ops on
    distroless/scratch), distro-specific. Not taken.
  - **B2 — pre-hashed drop-in via `volumes`** at
    `/etc/ssl/certs/<subject_hash>.0`. Only helps consumers that read the
    *dir*, not the single concatenated file (curl's default). Partial. Not
    taken. (The build-time drop-in we *did* ship is the
    `/usr/local/share/ca-certificates/` source-cert variant, which
    `update-ca-certificates` folds into the single file — different from B2.)
  - **B3 — bind-mount over `ca-certificates.crt` — REJECTED**, and confirmed
    rejected by the EBUSY failure above. Mounting our bare CA over the
    concatenated bundle also replaces all real roots (same failure as the
    single-file replace vars); mounting a *combined* bundle over it is just
    Approach A wearing a different hat and is brittle across distro store paths.
  - **B4 — document per-image install** for images the user controls. No yaac
    change; doesn't help arbitrary `docker run <upstream-image>`.

## Out of scope / still manual

- **Java/JVM** (own `cacerts` keystore) and **rustls-based** clients (`rustup`,
  `reqwest`+rustls, compiled-in webpki roots) honor neither the OS store nor any
  CA env var. They need `keytool -importcert` / `-Djavax.net.ssl.trustStore`
  and `RUSTUP_USE_CURL=1` respectively. Documented, not auto-handled.
- **OS-store-only tools with no env knob** (GnuTLS `wget`/`gnutls-cli`) at run
  time: no env var reaches them and they read only the in-image store, which we
  don't rewrite at run time. Uncommon enough that the explicit
  `--ca-certificate` workaround suffices for now.
- `GIT_SSL_CAINFO` has the same single-file replace semantics; git hosts are
  almost always MITM'd (credential injection) so it rarely bit, but folding it
  onto the combined bundle fixes the tunnelled-git edge case too.

## Tests

- **Unit — `test/unit/proxy-ca-bundle.test.ts`.** Exercises `combineCaBundle`:
  asserts the result is the union (both a public root and the proxy CA present,
  exactly two `BEGIN CERTIFICATE` blocks), that the newline separator is
  inserted only when the roots lack a trailing newline, the no-op concatenation
  case, the empty-roots case, and that the roots are read from
  `SYSTEM_ROOTS_PATH`.

- **e2e — `test/e2e-cli/nested-containers.test.ts`** ("trusts the MITM CA for
  own-bundle tools (curl) via the combined bundle"):
  - curl from the session reaches a **MITM'd** host (`github.com`, allowlisted
    and redirected to the mock git server), validating the proxy-signed leaf
    against the combined bundle;
  - a **structural-superset** assertion in place of a live tunnelled fetch: the
    bundle parses to >100 certs (public roots present) AND contains subject
    `yaac Proxy CA` — proving tunnelled upstreams would still validate. The
    test env has no real public egress, so a live
    `curl https://registry.npmjs.org` is not run; the superset check is the
    stand-in;
  - nested-container wiring: `docker run` shows all four replace vars pointing
    at `/etc/yaac/certs/ca-bundle.pem` and the file has >100 certs;
  - build-time drop-in: a `docker build` RUN asserts
    `/usr/local/share/ca-certificates/yaac-proxy-ca.crt` IS the proxy CA, and
    that replacing the managed bundle the way `update-ca-certificates` does
    (temp file + `mv`) succeeds — i.e. the EBUSY regression is gone.

## Manual verification (nested session)

From a `docker run` container: `curl https://github.com` (MITM'd → 200 via proxy
CA) AND `curl https://registry.npmjs.org` (tunnelled → 200 via real cert) both
succeed with no `-e`; `cargo build` resolving crates.io succeeds; `pip`/
`requests` to PyPI succeeds.
