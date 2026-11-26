import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createYaacTestEnv, spawnYaacServer, setTestGitIdentity, runYaac, type RunYaacOptions, type YaacTestEnv } from '#support/cli'
import type { SpawnedServer } from '@yaac/test-utils/api'
import { createTestRepo, requireCluster, TEST_IMAGE_PREFIX } from '@yaac/test-utils/setup'
import { kubectl } from '@yaac/test-utils/kubectl'
import { addTestProject, cleanupWorkspaceJobs, requirePodman } from '#support/cluster'
import { k8sNamespace } from '@yaac/server/drivers/k8s/substrate/api'
import { registryPodHost } from '@yaac/server/drivers/k8s/cluster/registry'
import { STOCK_IMAGE_ID, type ImageBuild, type ImageSummary, type QueuedWorkspaceEntry } from '@yaac/shared/types'

/**
 * e2e coverage for `yaac image` and `yaac workspace create --use-image
 * --await-build`, on a real cluster, sharing one server and one project
 * (`demo`) across the file.
 *
 * Tests run in declaration order and build on each other: the image
 * `tiny` is created, edited, built and restored in turn, the user image
 * comes after the workspace case (it would top the chain that case reads),
 * and `rm` runs last. Every Dockerfile is a small layer on the stock image
 * with a per-run nonce, since the registry outlives a run and a tag it
 * already holds builds nothing.
 *
 * A build pulls the stock image into a fresh builder pod, minutes each,
 * so what the builder itself enforces is checked on builds the commands
 * start anyway (docs/image-builds.md): a host the allowlist refused is
 * recorded on the build, a later revision reads the steps it shares with
 * an earlier one from the project's cache, and the source policy refuses
 * another project's image as a parent.
 */

const NONCE = crypto.randomBytes(4).toString('hex')
const layer = (...steps: string[]): string => ['ARG BASE_IMAGE', 'FROM ${BASE_IMAGE}', ...steps, ''].join('\n')
/** A step the project's allowlist refuses: curl fails, the step carries
 *  on, and the build records the host. */
const REFUSED_FETCH = `RUN curl -sS -m 20 -o /dev/null https://example.org/ || echo refused-${NONCE}`
/**
 * The acceptance test's half in a `RUN` step (docs/workspace-egress.md), as
 * root: the apiserver's Service, the cloud metadata address and an internet
 * address each get the proxy's 403 on a completed plain-HTTP request (every
 * dial connects, and port 443 is read as TLS), and no unix socket is in
 * reach, and the step holds no CAP_NET_RAW (bit 13 of its bounding set).
 * Any other answer fails the build.
 */
const SANDBOXED = 'USER root\nRUN for u in http://kubernetes.default.svc.cluster.local/ http://169.254.169.254/ http://1.1.1.1/; '
  + 'do c=$(curl -s -o /dev/null -m 20 -w "%{http_code}" "$u"); [ "$c" = 403 ] || { echo "reached $u: $c"; exit 1; }; done; '
  + 'b=$(awk \'/^CapBnd/ { print $2 }\' /proc/self/status); [ $(( 0x$b >> 13 & 1 )) = 0 ] || { echo "holds CAP_NET_RAW: $b"; exit 1; }; '
  + `! find / -xdev -type s 2>/dev/null | grep . && echo sandboxed-${NONCE}\nUSER yaac`
const COPYING = layer(`RUN echo tiny-${NONCE}`, REFUSED_FETCH, SANDBOXED, 'COPY conf/a.txt /tmp/a.txt')

let testEnv: YaacTestEnv
let server: SpawnedServer
let projectId: string
/** A context dir: a Dockerfile, the file it copies, and an ignored dir. */
let ctx: string

const yaac = (...args: Array<string | RunYaacOptions>): ReturnType<typeof runYaac> => runYaac(testEnv.env, ...args)
/** Run it, failing the test unless it exits 0. */
const ok = async (...args: Array<string | RunYaacOptions>): Promise<{ stdout: string; stderr: string }> => {
  const run = await yaac(...args)
  expect(run.exitCode, `${args.filter((a) => typeof a === 'string').join(' ')}: ${run.stderr}`).toBe(0)
  return run
}
const refused = async (...args: Array<string | RunYaacOptions>): Promise<string> => {
  const run = await yaac(...args)
  expect(run.exitCode, args.filter((a) => typeof a === 'string').join(' ')).not.toBe(0)
  return run.stderr
}
const api = async <T>(route: string): Promise<T> =>
  await (await fetch(`http://127.0.0.1:${String(server.lock.port)}/api${route}`)).json() as T
const tinyId = async (): Promise<string> =>
  (await api<ImageSummary[]>(`/image/project/${projectId}`)).find((i) => i.name === 'tiny')!.id
/** The image's last build of `revision` once it has ended, and its log. */
const settled = async (revision: number): Promise<{ build: ImageBuild; log: string }> => {
  const id = await tinyId()
  const build = await vi.waitFor(async () => {
    const found = (await api<ImageBuild[]>(`/image/builds?imageId=${id}`)).find((b) => b.revisionNumber === revision && b.layer === 'project')
    expect(found?.status, `revision ${String(revision)}'s build`).toMatch(/^(succeeded|failed|cancelled)$/)
    return found!
  }, { timeout: 600_000, interval: 1_000 })
  return { build, log: (await api<{ text: string }>(`/image/builds/${build.id}/log?offset=0`)).text }
}

beforeAll(async () => {
  await requirePodman()
  await requireCluster()
  testEnv = await createYaacTestEnv()
  server = await spawnYaacServer(testEnv.env)
  // `workspace create` refuses a project whose owner has no git identity.
  await setTestGitIdentity(testEnv.env)
  const repo = path.join(testEnv.scratchDir, 'demo')
  await createTestRepo(repo)
  projectId = await addTestProject(server, repo)

  ctx = path.join(testEnv.scratchDir, 'ctx')
  await fs.mkdir(path.join(ctx, 'conf'), { recursive: true })
  await fs.mkdir(path.join(ctx, 'skip'))
  await fs.writeFile(path.join(ctx, 'Dockerfile'), COPYING)
  await fs.writeFile(path.join(ctx, 'conf', 'a.txt'), 'alpha\n')
  await fs.writeFile(path.join(ctx, 'skip', 'big.bin'), 'not shipped\n')
  await fs.writeFile(path.join(ctx, '.containerignore'), 'skip\n')
})

afterAll(async () => {
  await server.stop()
  await cleanupWorkspaceJobs()
  await testEnv.cleanup()
})

describe('yaac image (real CLI + real server)', () => {
  it('list shows the stock image as the default; show refuses it, and an unknown name lists the images', async () => {
    expect((await ok('image', 'list', 'demo')).stdout).toMatch(/IMAGE\s+DEFAULT\s+STATE\s+REVISION\s+BUILT\n[\s\S]*yaac\s+yes\s+ready\s+-\s+-/)
    expect(await refused('image', 'show', 'demo', 'yaac')).toContain('yaac is the stock image')
    expect(await refused('image', 'show', 'demo', 'nope')).toContain('demo has no image "nope"; its images are yaac.')
  })

  it('create uploads --context less what .containerignore lists, with a --note, and refuses a bad name or no --file', async () => {
    const created = await ok('image', 'create', 'demo', 'tiny', '--file', path.join(ctx, 'Dockerfile'), '--context', ctx, '--note', 'first')
    expect(created.stdout).toContain('Created image tiny in demo.\nSaved tiny as revision 1.\n')
    expect(created.stdout).toMatch(/Follow it with `yaac image logs \S+ --follow`\./)
    const shown = await ok('image', 'show', 'demo', 'tiny')
    expect(shown.stdout).toBe(COPYING)
    expect(shown.stderr).toMatch(/the current one, saved by .*: first\n/)
    expect(shown.stderr).toContain('conf/a.txt (6 B)')
    expect(shown.stderr).not.toContain('skip')
    expect(await refused('image', 'create', 'demo', 'yaac', '--file', '-', { stdin: COPYING })).toMatch(/not `yaac`/)
    expect(await refused('image', 'create', 'demo', 'other')).toContain('required option \'--file <path>\'')
    expect((await ok('image', 'list', 'demo')).stdout).toMatch(/tiny\s+(building|ready|failed)\s+\d+/)
  })

  it('edit from stdin keeps the files, says when nothing changed, and --context with a --note saves a new revision', async () => {
    expect((await ok('image', 'edit', 'demo', 'tiny', '--file', '-', { stdin: COPYING })).stdout)
      .toContain('tiny already has that content, at revision 1; nothing was saved.')
    await fs.writeFile(path.join(ctx, 'conf', 'a.txt'), 'alpha two\n')
    const edited = await ok('image', 'edit', 'demo', 'tiny', '--file', path.join(ctx, 'Dockerfile'), '--context', ctx, '--note', 'new a.txt')
    expect(edited.stdout).toContain('Saved tiny as revision 2.')
    expect((await ok('image', 'show', 'demo', 'tiny', '--revision', '1')).stderr).toContain('tiny revision 1, saved by')
    const revisions = (await ok('image', 'revisions', 'demo', 'tiny')).stdout
    expect(revisions).toMatch(/REV\s+BUILD\s+AUTHOR\s+SAVED/)
    expect(revisions).toMatch(/2 \(current\)\s+\S+\s+.*new a\.txt/)
    expect(revisions).toContain('first')
    expect(await refused('image', 'show', 'demo', 'tiny', '--revision', '99')).toContain('tiny has no revision 99; its revisions are 1 to 2.')
  })

  it('workspace create --use-image launches an image, waiting with --await-build for the revision being built', async () => {
    const id = await tinyId()
    const queued = async (name: string): Promise<string | undefined> => {
      const run = await ok('workspace', 'create', 'demo', '--prompt', 'later', '--start-in', '2h', '--use-image', name)
      const entryId = /Queued workspace ([0-9a-f-]{36})/.exec(run.stdout)?.[1] ?? ''
      const entry = (await api<QueuedWorkspaceEntry[]>('/workspace/queue/list')).find((e) => e.id === entryId)
      await ok('workspace', 'delete', entryId)
      return entry?.imageId
    }
    expect(await queued('tiny')).toBe(id)
    expect(await queued('yaac')).toBe(STOCK_IMAGE_ID)
    expect(await refused('workspace', 'create', 'demo', '--no-agent', '--use-image', 'nope')).toContain('has no image "nope"')
    expect(await refused('workspace', 'create', 'demo', '--prompt', 'later', '--start-in', '2h', '--await-build'))
      .toContain('--await-build waits for a create now')

    // Revision 2's build ran the refused fetch, and pushed its steps to the
    // project's cache.
    const second = await settled(2)
    expect(second.build, `${second.build.error ?? ''}\n${second.log}`).toMatchObject({ status: 'succeeded' })
    expect(second.build.blockedHosts).toContain('example.org')

    // A save starts a build; the create waits for it rather than launching
    // the revision built before. Revision 3 is revision 2 and one step more,
    // so its builder pod reads the shared steps from the cache.
    const awaited = layer(`RUN echo tiny-${NONCE}`, REFUSED_FETCH, 'COPY conf/a.txt /tmp/a.txt', `RUN echo awaited-${NONCE}`)
    expect((await ok('image', 'edit', 'demo', 'tiny', '--file', '-', { stdin: awaited })).stdout)
      .toContain('Saved tiny as revision 3.')
    const created = await ok('workspace', 'create', 'demo', '--no-agent', '--no-repos', '--use-image', 'tiny', '--await-build')
    const workspaceId = /Workspace ([0-9a-f-]{36}) is running/.exec(created.stdout)?.[1] ?? ''
    const build = (await api<ImageBuild[]>(`/image/builds?imageId=${id}`)).find((b) => b.revisionNumber === 3 && b.status === 'succeeded')
    expect(build, 'a succeeded build of the awaited revision').toBeDefined()
    expect(build!.cachedSteps).toBeGreaterThanOrEqual(2)
    expect((await api<{ text: string }>(`/image/builds/${build!.id}/log?offset=0`)).text).toContain('CACHED')
    const { stdout: images } = await kubectl(['get', 'job', '-n', k8sNamespace(), `yaac-${workspaceId}`,
      '-o', 'jsonpath={.spec.template.spec.containers[*].image}'])
    expect(images).toContain(build!.tag)
    await ok('workspace', 'stop', workspaceId)
  }, 900_000)

  it('build --revision --no-cache --wait follows the log; builds lists them; logs prints and follows one, failing with a failed build', async () => {
    const built = await ok('image', 'build', 'demo', 'tiny', '--revision', '1', '--no-cache', '--wait')
    // The image's own build is the chain's last.
    const buildId = [...built.stdout.matchAll(/Build ([0-9a-f-]{36}) succeeded\./g)].at(-1)?.[1] ?? ''
    expect(built.stdout).toContain(`tiny-${NONCE}`)
    expect(built.stdout).toContain(`sandboxed-${NONCE}`)
    expect(await refused('image', 'build', 'demo', 'tiny', '--revision', '99')).toContain('tiny has no revision 99')
    expect((await ok('image', 'build', 'demo', 'tiny')).stdout).toMatch(/already built|Follow it with/)

    const all = (await ok('image', 'builds', 'demo')).stdout
    expect(all).toMatch(/BUILD\s+IMAGE\s+REV\s+LAYER\s+REASON\s+STATUS/)
    expect(all).toMatch(new RegExp(`${buildId}\\s+tiny\\s+1\\s+\\S+\\s+manual \\(no cache\\)\\s+succeeded`))
    expect((await ok('image', 'builds', 'demo', 'tiny')).stdout).toContain(buildId)
    expect((await ok('image', 'logs', buildId)).stdout).toContain(`tiny-${NONCE}`)
    expect((await ok('image', 'logs', buildId, '--follow')).stdout).toContain(`Build ${buildId} succeeded.`)

    // The source policy admits only a build's own parent from the registry,
    // so another project's image cannot be read through FROM; the build
    // fails there, before pulling anything.
    const stolen = `FROM ${registryPodHost()}/${TEST_IMAGE_PREFIX}-proj-${crypto.randomUUID()}:0000000000000000\nRUN echo ${NONCE}\n`
    const failing = await ok('image', 'edit', 'demo', 'tiny', '--file', '-', { stdin: stolen })
    const failedId = /yaac image logs (\S+) --follow/.exec(failing.stdout)?.[1] ?? ''
    const followed = await yaac('image', 'logs', failedId, '--follow')
    expect(followed.exitCode).not.toBe(0)
    expect(followed.stderr).toContain(`Build ${failedId} failed`)
    const failed = await api<ImageBuild>(`/image/builds/${failedId}`)
    expect(`${failed.error ?? ''}\n${followed.stdout}`).toMatch(/denied/i)
  }, 900_000)

  it('restore saves an old revision anew, and default prints and sets the project default', async () => {
    // Revision 4 is the failing one the case above saved.
    expect((await ok('image', 'restore', 'demo', 'tiny', '1')).stdout).toContain('Saved tiny as revision 5')
    expect((await ok('image', 'show', 'demo', 'tiny')).stderr).toContain('tiny revision 5, the current one')
    expect(await refused('image', 'restore', 'demo', 'tiny', '99')).toContain('tiny has no revision 99')

    expect((await ok('image', 'default', 'demo')).stdout).toContain('demo\'s default image is yaac')
    expect((await ok('image', 'default', 'demo', 'tiny')).stdout).toContain('demo\'s default image is now tiny.')
    expect((await ok('image', 'list', 'demo')).stdout).toMatch(/tiny\s+yes/)
    expect(await refused('image', 'default', 'demo', 'nope')).toContain('demo has no image "nope"')
    expect((await ok('image', 'default', 'demo', 'yaac')).stdout).toContain('now yaac.')
  }, 300_000)

  it('user show, edit, revisions, restore, build and builds manage your Dockerfile.user', async () => {
    expect(await refused('image', 'user', 'show')).toContain('You have no Dockerfile.user')
    expect(await refused('image', 'user', 'edit', '--file', '-', { stdin: 'FROM scratch\n' })).toMatch(/BASE_IMAGE/)
    const first = layer(`RUN echo user-${NONCE}`)
    expect((await ok('image', 'user', 'edit', '--file', '-', '--note', 'one', { stdin: first })).stdout).toMatch(/Saved your Dockerfile\.user as revision 1/)
    const userCtx = path.join(testEnv.scratchDir, 'user-ctx')
    await fs.mkdir(userCtx)
    await fs.writeFile(path.join(userCtx, 'note.txt'), 'hi\n')
    const second = layer(`RUN echo user-${NONCE}`, 'COPY note.txt /tmp/note.txt')
    await fs.writeFile(path.join(testEnv.scratchDir, 'Dockerfile.user'), second)
    expect((await ok('image', 'user', 'edit', '--file', path.join(testEnv.scratchDir, 'Dockerfile.user'), '--context', userCtx, '--note', 'two')).stdout)
      .toMatch(/Saved your Dockerfile\.user as revision 2/)
    const shown = await ok('image', 'user', 'show')
    expect(shown.stdout).toBe(second)
    expect(shown.stderr).toContain('note.txt (3 B)')
    expect((await ok('image', 'user', 'show', '--revision', '1')).stdout).toBe(first)
    expect((await ok('image', 'user', 'revisions')).stdout).toMatch(/2 \(current\)[^\n]*two/)
    expect((await ok('image', 'user', 'restore', '1')).stdout).toMatch(/Saved your Dockerfile\.user as revision 3/)

    const built = await ok('image', 'user', 'build', 'demo', '--no-cache', '--wait')
    expect(built.stdout).toMatch(/Build \S+ succeeded\./)
    expect((await ok('image', 'user', 'builds')).stdout).toContain('Dockerfile.user')
    expect((await ok('image', 'user', 'builds', 'demo')).stdout).toMatch(/Dockerfile\.user\s+3\s+user\s+manual \(no cache\)\s+succeeded/)
  }, 900_000)

  // Last: it deletes the image the cases above share.
  it('rm deletes an image with its revisions', async () => {
    expect((await ok('image', 'rm', 'demo', 'tiny')).stdout).toContain('Deleted image tiny, with its revisions and builds.')
    expect((await ok('image', 'list', 'demo')).stdout).not.toContain('tiny')
    expect(await refused('image', 'rm', 'demo', 'tiny')).toContain('demo has no image "tiny"')
  })
})
