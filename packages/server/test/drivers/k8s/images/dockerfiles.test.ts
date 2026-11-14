/**
 * Contract tests for the shipped Dockerfiles in DOCKERFILES_DIR: the trusted
 * `base` / `tools` layers and the server image. They test files,
 * not a module, so the one-describe-per-barrel-function rule does not apply.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DOCKERFILES_DIR } from '@yaac/shared/project-paths'
import { LLAMA_CPP_SHA256, LLAMA_CPP_TAG } from '#domain/workspaces/llama-cpp'

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
  'Dockerfile.default', 'Dockerfile.tools', 'Dockerfile.server',
] as const

describe('Dockerfile.default', () => {
  it('ships the pinned upstream base and the session toolbelt, and installs no engine', async () => {
    const content = await read('Dockerfile.default')
    expect(content).toContain('FROM docker.io/ubuntu:26.04')
    expect(content).toContain('gh')
    expect(content).toContain('tmux')
    // A workspace pod holds none of the capabilities a container engine
    // needs, so one could not work there. This checks the Dockerfile text
    // only, not transitive package dependencies.
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
    expect(content).toContain('downloads.claude.ai/claude-code-releases/')
    expect(content).toContain('@openai/codex')
    expect(content).toContain('@opencode/cli')
  })
})

describe('Dockerfile.server', () => {
  it('bakes the llama.cpp release the server would download', async () => {
    const content = await read('Dockerfile.server')
    expect(content).toContain(`ARG LLAMA_CPP_TAG=${LLAMA_CPP_TAG}\n`)
    expect(content).toContain(`ARCH=x64 SHA256=${LLAMA_CPP_SHA256['ubuntu-x64'] ?? 'x'} `)
    expect(content).toContain(`ARCH=arm64 SHA256=${LLAMA_CPP_SHA256['ubuntu-arm64'] ?? 'x'} `)
  })

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
  it('pins every upstream image by digest and checks every download', async () => {
    // A tag or a release asset can be replaced in place upstream; a pinned
    // digest or SHA-256 makes the build fail instead. `${BASE_IMAGE}` is
    // yaac's own layer, already pinned by its content-hash tag.
    for (const name of [...SHIPPED, '../k8s/proxy/Dockerfile', '../k8s/netd/Dockerfile']) {
      const steps = (await read(name)).replace(/\\\n/g, ' ').split('\n')
      for (const from of steps.filter((l) => /^FROM\s/.test(l) && !l.includes('${BASE_IMAGE}'))) {
        expect(from, name).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}(\s|$)/)
      }
      expect(steps.filter((l) => /^ADD\s.*\bhttps?:/.test(l)), name).toEqual([])
      for (const step of steps.filter((l) => /^RUN\s/.test(l))) {
        const where = `${name}: ${step.slice(0, 120)}`
        expect(step, where).not.toMatch(/\bwget\s+[-"'$h]/)
        // Each curl writes a file, and that same file is what a
        // `sha256sum -c` in the step reads.
        const curls = step.replace(/^RUN\s+/, '').split(/&&|\||;/).map((c) => c.trim())
          .filter((c) => /^curl\s/.test(c))
        for (const curl of curls) {
          const url = /\s["']?(https?:\/\/[^\s"']+)/.exec(curl)?.[1] ?? ''
          const file = /\s-o\s+["']?([^\s"']+)/.exec(curl)?.[1]
            ?? (/\s-[a-zA-Z]*O[a-zA-Z]*\s/.test(curl) ? url.slice(url.lastIndexOf('/') + 1) : undefined)
          expect(file, `${where}: curl must write a file`).toBeDefined()
          const escaped = (file ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          expect(step, `${where}: ${file ?? ''} is never checked`)
            .toMatch(new RegExp(`${escaped}["']\\s*\\|\\s*sha256sum -c`))
        }
      }
    }
  })

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
