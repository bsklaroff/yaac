/**
 * Contract tests for the shipped Dockerfiles in DOCKERFILES_DIR: the trusted
 * `base` / `tools` / `nestable` layers and the server image. They test files,
 * not a module, so the one-describe-per-barrel-function rule does not apply.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DOCKERFILES_DIR } from '@yaac/shared/project-paths'

const read = (name: string): Promise<string> =>
  fs.readFile(path.join(DOCKERFILES_DIR, name), 'utf8')

/**
 * Every line that starts a `RUN` instruction, with the `USER` in effect.
 * Continuation lines and heredoc bodies are skipped, so a `RUN` inside a
 * heredoc is not counted as a step.
 */
function runSteps(content: string): Array<{ user: string; line: string }> {
  const steps: Array<{ user: string; line: string }> = []
  let user = 'root'
  let continued = false
  let heredoc: string | null = null
  for (const line of content.split('\n')) {
    if (heredoc !== null) {
      if (line.trimEnd() === heredoc) heredoc = null
      continue
    }
    const startsStep = !continued
    continued = /\\\s*$/.test(line)
    const opened = /<<-?'?([A-Za-z_][A-Za-z0-9_]*)'?/.exec(line)
    if (opened && !continued) heredoc = opened[1]
    if (!startsStep) continue
    const asUser = /^USER\s+(\S+)/.exec(line)
    if (asUser) user = asUser[1]
    else if (/^RUN\s/.test(line)) steps.push({ user, line })
  }
  return steps
}

/** Every shipped Dockerfile, in the order a chain builds them. */
const SHIPPED = [
  'Dockerfile.default', 'Dockerfile.tools', 'Dockerfile.nestable', 'Dockerfile.server',
] as const

describe('Dockerfile.default', () => {
  it('ships the pinned upstream base and the session toolbelt, and installs no engine', async () => {
    const content = await read('Dockerfile.default')
    expect(content).toContain('FROM docker.io/ubuntu:24.04')
    expect(content).toContain('gh')
    expect(content).toContain('tmux')
    // podman belongs only in the nestable layer. In the base image it could
    // not work, yet probes that check "is podman installed?" would treat a
    // plain workspace as having an engine (salvage's `sudo podman` would then
    // leave root-owned files in the user's checkout). This checks the
    // Dockerfile text only, not transitive package dependencies.
    expect(content).not.toContain('podman')
  })

  it('runs as a non-root yaac user whose uid the pod may override', async () => {
    const content = await read('Dockerfile.default')
    expect(content).toContain('USER yaac')
    // A fixed uid with primary group 0 and a group-writable home: the pod
    // runs as its own uid and gets access through group 0
    // (docs/arbitrary-uid-images.md). Nothing about the building host
    // reaches the image, so one image serves every host.
    expect(content).toContain('useradd -m -u 1000 -g 0')
    expect(content).toContain('chmod -R g=u /home/yaac')
    expect(content).not.toContain('YAAC_UID')
  })

  it('leaves /etc/passwd writable so the running uid can claim the yaac name', async () => {
    const content = await read('Dockerfile.default')
    // Without a passwd entry for the running uid, ssh exits 255 and sudo
    // stops matching the NOPASSWD line. workspace-bin/yaac-workspace-init
    // does the rewrite.
    expect(content).toContain('chgrp 0 /etc/passwd && chmod g=u /etc/passwd')
  })

  it('uses catatonit as PID 1 to reap zombies', async () => {
    const content = await read('Dockerfile.default')
    expect(content).toContain('catatonit')
    expect(content).toMatch(/ENTRYPOINT \[.*"catatonit".*\]/)
    // catatonit runs `sleep infinity` as PID 2 to keep the container up.
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
    expect(content).toContain('@opencode/cli')
  })
})

describe('Dockerfile.nestable', () => {
  it('layers rootful in-pod podman with the docker CLI on the tools image', async () => {
    const content = await read('Dockerfile.nestable')
    expect(content).toMatch(/^ARG BASE_IMAGE\n/m)
    expect(content).toMatch(/^FROM \$\{BASE_IMAGE\}/m)
    expect(content).toContain('podman')
    expect(content).toContain('skopeo')
    expect(content).toContain('docker-compose')
    // Only host networking is supported in-pod, so no userspace network
    // helper is installed.
    expect(content).not.toContain('default_rootless_network_cmd')
    // The yaac user drives a rootful engine over its socket, started by
    // `sudo podman system service` at workspace create. docker uses
    // DOCKER_HOST, podman uses CONTAINER_HOST (which enables remote mode).
    expect(content).toContain('DOCKER_HOST=unix:///run/podman/podman.sock')
    expect(content).toContain('CONTAINER_HOST=unix:///run/podman/podman.sock')
    // Nested containers share the pod's network so egress still goes
    // through the pod's redirect.
    expect(content).toContain('netns="host"')
    // No rootless setup under gVisor: no subuid maps, no newuidmap caps,
    // no keyring/pivot_root workarounds (they work as root in the sandbox).
    expect(content).not.toContain('subuid')
    expect(content).not.toContain('newuidmap')
    expect(content).not.toContain('keyring=false')
    expect(content).not.toContain('no_pivot_root=true')
    expect(content).toContain('/etc/containers/containers.conf')
    expect(content).toContain('/etc/containers/storage.conf')
    // Graphroot at podman's default; the pod spec mounts a tmpfs there so
    // setcap builds keep their file caps.
    expect(content).toContain('graphroot = "/var/lib/containers/storage"')
    // One read-only image store: the node-local store written by
    // store-writer.ts and hostPath-mounted here. The directory is created
    // empty so a workspace with nothing to mount still starts.
    expect(content).toContain('additionalimagestores = ["/var/lib/shared-images"]')
    expect(content).toContain('mkdir -p /var/lib/containers /var/lib/shared-images')
  })

  it('auto-trusts the session MITM CA in both trust shapes', async () => {
    const content = await read('Dockerfile.nestable')
    // Additive vars (OpenSSL, Node) point at the bare proxy CA. Vars that
    // replace the trust set (curl, requests, cargo, git) point at the
    // combined bundle of public roots plus the proxy CA.
    expect(content).toContain('SSL_CERT_FILE=/etc/yaac/certs/proxy-ca.pem')
    expect(content).toContain('NODE_EXTRA_CA_CERTS=/etc/yaac/certs/proxy-ca.pem')
    expect(content).toContain('CURL_CA_BUNDLE=/etc/yaac/certs/ca-bundle.pem')
    expect(content).toContain('REQUESTS_CA_BUNDLE=/etc/yaac/certs/ca-bundle.pem')
    expect(content).toContain('CARGO_HTTP_CAINFO=/etc/yaac/certs/ca-bundle.pem')
    expect(content).toContain('GIT_SSL_CAINFO=/etc/yaac/certs/ca-bundle.pem')
    // Both are mounted into nested containers and build RUN steps.
    expect(content).toContain('/etc/yaac/certs/ca-bundle.pem:/etc/yaac/certs/ca-bundle.pem:ro')
    // The proxy CA also goes in the ca-certificates source dir. Volumes
    // (unlike env) reach `docker build` RUN steps, so installing
    // ca-certificates adds it to the image's roots.
    expect(content).toContain('/etc/yaac/certs/proxy-ca.pem:/usr/local/share/ca-certificates/yaac-proxy-ca.crt:ro')
    // Never bind-mount over the managed bundle: rename() onto a mountpoint
    // fails with EBUSY and breaks `update-ca-certificates`.
    expect(content).not.toContain(':/etc/ssl/certs/ca-certificates.crt:ro')
    // Pointing a replace var at the bare CA would break tunnelled hosts.
    expect(content).not.toContain('CURL_CA_BUNDLE=/etc/yaac/certs/proxy-ca.pem')
    // The server starts the engine with a detached exec, so the image keeps
    // the base catatonit entrypoint.
    expect(content).not.toMatch(/^ENTRYPOINT/m)
  })
})

describe('Dockerfile.server', () => {
  it('runs the server as the same uid-agnostic yaac user', async () => {
    const content = await read('Dockerfile.server')
    // The server pod runs as the install host's uid, like a workspace pod,
    // so it uses the same fixed-uid pattern.
    expect(content).toContain('useradd -m -u 1000 -g 0')
    expect(content).toContain('chgrp 0 /etc/passwd && chmod g=u /etc/passwd')
    expect(content).not.toContain('YAAC_UID')
  })

  it('starts through the entrypoint that claims the running uid', async () => {
    const content = await read('Dockerfile.server')
    // The server does the passwd rewrite in its entrypoint (a workspace
    // gets it from yaac-workspace-init), then execs catatonit as PID 1.
    expect(content).toContain('ENTRYPOINT ["/opt/yaac/dockerfiles/server-entrypoint.sh"]')
    expect(content).toContain('CMD ["server", "run"]')

    const entrypoint = await read('server-entrypoint.sh')
    expect(entrypoint).toContain('exec /usr/bin/catatonit -- node /opt/yaac/cli.js "$@"')
    // Replace the entry rather than append, so getpwnam and getpwuid agree
    // and `chown yaac` uses the pod's uid, not 1000.
    expect(entrypoint).toContain('s/^yaac:x:[0-9]*:[0-9]*:/yaac:x:$(id -u):$(id -g):/')
    // Truncate in place: `sed -i` renames a temp file over /etc/passwd,
    // which needs write access to /etc.
    const code = entrypoint.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
    expect(code).toContain('> /etc/passwd')
    expect(code).not.toContain('sed -i')
  })
})

describe('every shipped Dockerfile', () => {
  it('sets umask 002 on every RUN step that runs as yaac', async () => {
    // A step running as `yaac` must create group-writable files, since the
    // pod runs as another uid and reaches them through group 0
    // (docs/arbitrary-uid-images.md). A missing umask works on a uid-1000
    // host and fails with EACCES elsewhere, so every Dockerfile is checked.
    let walked = 0
    for (const name of SHIPPED) {
      for (const { line } of runSteps(await read(name)).filter((s) => s.user === 'yaac')) {
        expect(line, `${name}: ${line}`).toMatch(/^RUN umask 002 &&/)
        walked++
      }
    }
    // Guard against a parser that silently matches nothing.
    expect(walked).toBeGreaterThan(10)
  })
})
