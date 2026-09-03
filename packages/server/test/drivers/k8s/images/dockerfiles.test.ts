/**
 * Contract tests for the images feature's shipped build inputs — the
 * Dockerfiles in DOCKERFILES_DIR: the ones `resolveImageChain` assigns the
 * trusted `base` / `tools` / `nestable` layer names to, plus the server's
 * own. They cover files, not a module, so the one-describe-per-barrel-
 * function rule that governs the sealed folder's module tests does not
 * apply here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DOCKERFILES_DIR } from '@yaac/shared/project-paths'

const read = (name: string): Promise<string> =>
  fs.readFile(path.join(DOCKERFILES_DIR, name), 'utf8')

/**
 * Every line that STARTS a `RUN` instruction, paired with the `USER` in
 * effect there. Continuation lines and heredoc bodies belong to the
 * instruction above them and are skipped, so a `RUN` inside a heredoc
 * cannot masquerade as a step.
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

  it('runs as a non-root yaac user whose uid the pod may override', async () => {
    const content = await read('Dockerfile.default')
    expect(content).toContain('USER yaac')
    // A FIXED uid with primary group 0, and a home group 0 can write: the
    // pod supplies its own uid at runtime and picks the grant up through
    // group 0 (docs/arbitrary-uid-images.md). Nothing about the building
    // host may reach the image — that is what makes one image serve every
    // host and lets the chain be shipped prebuilt.
    expect(content).toContain('useradd -m -u 1000 -g 0')
    expect(content).toContain('chmod -R g=u /home/yaac')
    expect(content).not.toContain('YAAC_UID')
  })

  it('leaves /etc/passwd writable so the running uid can claim the yaac name', async () => {
    const content = await read('Dockerfile.default')
    // getpwuid() has no answer for an arbitrary uid, and the things that
    // ask do not degrade: ssh exits 255, and sudo stops matching the
    // NOPASSWD line (which names the user, not the number). The rewrite
    // itself lives in worktree-bin/yaac-worktree-init.
    expect(content).toContain('chgrp 0 /etc/passwd && chmod g=u /etc/passwd')
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
  it('bakes its support files in group-writable too', async () => {
    const content = await read('Dockerfile.tools')
    // opencode rewrites this catalog in place when it refreshes, so the
    // COPY has to land it group-0 writable like everything else — a
    // `--chown=yaac:yaac` would not even resolve, since the image has no
    // `yaac` group.
    expect(content).toContain('COPY --chown=yaac:0 --chmod=0664 opencode-models.json')
  })

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

describe('Dockerfile.server', () => {
  it('runs the server as the same uid-agnostic yaac user', async () => {
    const content = await read('Dockerfile.server')
    // The server pod runs as the install host's uid exactly like a worktree
    // pod, so its image takes the same shape and the same fixed uid — and,
    // like the worktree chain, bakes nothing about the host that built it.
    expect(content).toContain('useradd -m -u 1000 -g 0')
    expect(content).toContain('chgrp 0 /etc/passwd && chmod g=u /etc/passwd')
    expect(content).not.toContain('YAAC_UID')
  })

  it('starts through the entrypoint that claims the running uid', async () => {
    const content = await read('Dockerfile.server')
    // A Deployment has no postStart hook, so the passwd rewrite a worktree
    // gets from yaac-worktree-init has to ride the entrypoint here. It
    // still execs catatonit, which stays PID 1 to reap what the server
    // spawns.
    expect(content).toContain('ENTRYPOINT ["/opt/yaac/dockerfiles/server-entrypoint.sh"]')
    expect(content).toContain('CMD ["server", "run"]')

    const entrypoint = await read('server-entrypoint.sh')
    expect(entrypoint).toContain('exec /usr/bin/catatonit -- node /opt/yaac/cli.js "$@"')
    // REPLACE the entry, never append: getpwnam and getpwuid have to agree
    // or a later `chown yaac` lands on uid 1000 instead of on the pod.
    expect(entrypoint).toContain('s/^yaac:x:[0-9]*:[0-9]*:/yaac:x:$(id -u):$(id -g):/')
    // And truncate in place: `sed -i` renames a temp file over /etc/passwd,
    // which needs write permission on /etc, which the pod does not have.
    const code = entrypoint.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
    expect(code).toContain('> /etc/passwd')
    expect(code).not.toContain('sed -i')
  })
})

describe('every shipped Dockerfile', () => {
  it('sets umask 002 on every RUN step that runs as yaac', async () => {
    // The arbitrary-uid pattern's one rule for image AUTHORS
    // (docs/arbitrary-uid-images.md): a step running as `yaac` must create
    // group-writable files, because the pod that reads them runs as a
    // different uid and reaches them through group 0. A `chgrp -R` sweep in
    // a later layer is not an alternative — it copies the whole tree up.
    //
    // This is where the pattern silently rots: a new `RUN` without the umask
    // builds fine, works on a uid-1000 Linux host, and fails with EACCES
    // everywhere else. So the walk covers all four rather than the two that
    // have such steps today — nestable and the server image end on `USER
    // yaac`, and a `RUN` added after that is exactly the case this catches.
    let walked = 0
    for (const name of SHIPPED) {
      for (const { line } of runSteps(await read(name)).filter((s) => s.user === 'yaac')) {
        expect(line, `${name}: ${line}`).toMatch(/^RUN umask 002 &&/)
        walked++
      }
    }
    // The walk is only worth anything if it is finding steps at all — a
    // parser that silently matched nothing would pass every assertion above.
    expect(walked).toBeGreaterThan(10)
  })
})
