/**
 * Contract tests for the images feature's shipped build inputs — the
 * Dockerfiles in DOCKERFILES_DIR that `resolveImageChain` assigns the
 * trusted `base` / `tools` / `nestable` layer names to. They cover files,
 * not a module, so the one-describe-per-barrel-function rule that governs
 * the sealed folder's module tests does not apply here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DOCKERFILES_DIR } from '@yaac/shared/project-paths'

const read = (name: string): Promise<string> =>
  fs.readFile(path.join(DOCKERFILES_DIR, name), 'utf8')

describe('Dockerfile.default', () => {
  it('ships the pinned upstream base and the session toolbelt, and installs no engine', async () => {
    const content = await read('Dockerfile.default')
    expect(content).toContain('FROM docker.io/ubuntu:24.04')
    expect(content).toContain('gh')
    expect(content).toContain('tmux')
    // The engine belongs to the nestable layer, and ONLY there. A podman in
    // the base image is not the harmless extra it looks like: the rootless
    // apparatus it needs (uidmap, an overlay mount_program) is not here, so
    // it cannot work, while every probe that reasons "podman is installed,
    // so this pod must have an engine" starts believing a plain worktree
    // has one. Salvage did, and its `sudo podman` — run from the
    // container's workingDir, which is the user's checkout — left a
    // root-owned directory there each time it fired.
    //
    // This pins the Dockerfile TEXT, which is what a reintroduction would
    // look like. A binary arriving as some other package's transitive
    // dependency is invisible here and would need an image-content check.
    expect(content).not.toContain('podman')
  })

  it('runs as the non-root yaac user, built with the injected YAAC_UID', async () => {
    const content = await read('Dockerfile.default')
    expect(content).toContain('USER yaac')
    // The uid is a build arg so idmapped hostPath writes line up with the
    // server process that owns the data dir.
    expect(content).toMatch(/^ARG YAAC_UID=1000$/m)
    expect(content).toContain('useradd -m -u ${YAAC_UID}')
  })

  it('uses catatonit as PID 1 to reap zombies', async () => {
    const content = await read('Dockerfile.default')
    expect(content).toContain('catatonit')
    expect(content).toMatch(/ENTRYPOINT \[.*"catatonit".*\]/)
    // catatonit runs sleep infinity as PID 2 so the container stays up
    expect(content).toContain('sleep')
    expect(content).toContain('infinity')
  })
})

describe('Dockerfile.tools', () => {
  it('installs the agent CLIs as a layer on top of the base', async () => {
    const content = await read('Dockerfile.tools')
    expect(content).toMatch(/^ARG BASE_IMAGE\n/m)
    expect(content).toMatch(/^FROM \$\{BASE_IMAGE\}/m)
    expect(content).toContain('claude.ai/install.sh')
    expect(content).toContain('@openai/codex')
    expect(content).toContain('opencode-ai')
  })
})

describe('Dockerfile.nestable', () => {
  it('layers rootful in-pod podman with the docker CLI on the tools image', async () => {
    const content = await read('Dockerfile.nestable')
    expect(content).toMatch(/^ARG BASE_IMAGE\n/m)
    expect(content).toMatch(/^FROM \$\{BASE_IMAGE\}/m)
    // Engine + build/copy tooling, docker-CLI surface.
    expect(content).toContain('podman')
    expect(content).toContain('skopeo')
    expect(content).toContain('docker-compose')
    // Container-private networks aren't supported in-pod, so no userspace
    // network helper is installed (host netns is the only mode).
    expect(content).not.toContain('default_rootless_network_cmd')
    // Rootful engine: the agent (yaac user) drives it over the rootful
    // podman socket, which session-create opens after `sudo podman system
    // service`. Both CLIs point there — docker via DOCKER_HOST, podman via
    // CONTAINER_HOST (which auto-enables podman's remote mode).
    expect(content).toContain('DOCKER_HOST=unix:///run/podman/podman.sock')
    expect(content).toContain('CONTAINER_HOST=unix:///run/podman/podman.sock')
    // Everything shares the pod's namespaces — nested egress must stay on
    // the pod-netns redirect (locally-originated traffic).
    expect(content).toContain('netns="host"')
    // The rootless apparatus is DELETED under the sentry — no subuid maps,
    // no newuidmap/newgidmap caps, and no rootless workarounds (keyring /
    // pivot_root work as real root in-sandbox).
    expect(content).not.toContain('subuid')
    expect(content).not.toContain('newuidmap')
    expect(content).not.toContain('keyring=false')
    expect(content).not.toContain('no_pivot_root=true')
    // Rootful engine config lives system-wide in /etc/containers.
    expect(content).toContain('/etc/containers/containers.conf')
    expect(content).toContain('/etc/containers/storage.conf')
    // Rootful graphroot at podman's default (a tmpfs is mounted there by
    // the pod spec so setcap builds keep their file caps).
    expect(content).toContain('graphroot = "/var/lib/containers/storage"')
    // ONE read-only lower: the node-local image store, materialized from
    // the project registry by store-writer.ts and hostPath-mounted here.
    // The directory is baked in EMPTY so a session with no generation to
    // mount (a cold node, an inner yaac) still starts.
    expect(content).toContain('additionalimagestores = ["/var/lib/shared-images"]')
    expect(content).toContain('mkdir -p /var/lib/containers /var/lib/shared-images')
  })

  it('auto-trusts the session MITM CA in both trust shapes', async () => {
    const content = await read('Dockerfile.nestable')
    // The ADDITIVE vars point at the bare proxy CA (OpenSSL/Node keep their
    // real roots alongside it); the own-bundle REPLACE vars point at the
    // combined bundle {public roots} ∪ {proxy CA} so curl/requests/cargo/
    // git-libcurl trust both intercepted and tunnelled hosts.
    expect(content).toContain('SSL_CERT_FILE=/etc/yaac/certs/proxy-ca.pem')
    expect(content).toContain('NODE_EXTRA_CA_CERTS=/etc/yaac/certs/proxy-ca.pem')
    expect(content).toContain('CURL_CA_BUNDLE=/etc/yaac/certs/ca-bundle.pem')
    expect(content).toContain('REQUESTS_CA_BUNDLE=/etc/yaac/certs/ca-bundle.pem')
    expect(content).toContain('CARGO_HTTP_CAINFO=/etc/yaac/certs/ca-bundle.pem')
    expect(content).toContain('GIT_SSL_CAINFO=/etc/yaac/certs/ca-bundle.pem')
    // The combined bundle is mounted into nested containers (and build RUN
    // steps) alongside the bare CA.
    expect(content).toContain('/etc/yaac/certs/ca-bundle.pem:/etc/yaac/certs/ca-bundle.pem:ro')
    // Build-time trust: the bare proxy CA is dropped into the ca-certificates
    // source dir. Volumes (unlike env) reach `docker build` RUN steps, so
    // `apt-get install ca-certificates` folds it into the image's real roots.
    expect(content).toContain('/etc/yaac/certs/proxy-ca.pem:/usr/local/share/ca-certificates/yaac-proxy-ca.crt:ro')
    // Must NOT bind-mount over the managed bundle file — rename() onto a
    // bind-mountpoint fails EBUSY and breaks `update-ca-certificates`.
    expect(content).not.toContain(':/etc/ssl/certs/ca-certificates.crt:ro')
    // The replace-vars must never point at the bare proxy CA (that breaks
    // tunnelled hosts — the exact regression the combined bundle fixes).
    expect(content).not.toContain('CURL_CA_BUNDLE=/etc/yaac/certs/proxy-ca.pem')
    // The engine is started by a detached server exec, not an entrypoint
    // override — the image keeps the base catatonit keepalive.
    expect(content).not.toMatch(/^ENTRYPOINT/m)
  })
})
