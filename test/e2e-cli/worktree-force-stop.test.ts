import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import simpleGit from 'simple-git'
import { cloneRepo } from '@yaac/server/domain/git'
import { listWorktreePods } from '@yaac/server/drivers/k8s/substrate/pods'
import { kubectlGetJson, kubectlWithRetry } from '@yaac/server/drivers/k8s/substrate/kubectl'
import { GVISOR_INSTALLER_APP_NAME } from '@yaac/server/drivers/k8s/substrate/gvisor'
import {
  createYaacTestEnv,
  spawnYaacServer,
  runYaac,
  type YaacTestEnv,
  type SpawnedServer,
} from '@yaac/test-utils/cli'
import { requirePodman, requireCluster, cleanupWorktreeJobs } from '@yaac/test-utils/setup'
import {
  startMockLLM,
  startMockGit,
  seedMockGitRepo,
  cleanupMocks,
  type MockLLM,
  type MockGit,
} from '@yaac/test-utils/mock-remotes'

/**
 * A stop whose sandbox will not die (docs/stuck-sandbox-recovery.md): real
 * CLI + real server + real cluster, with the sandbox frozen by hand.
 *
 * `SIGSTOP` on a worktree's `runsc-sandbox` process reproduces a deadlocked
 * sentry's one observable that matters here — `runsc kill` waits on a
 * control socket nothing answers, so the kubelet's stop times out forever
 * — deterministically and on demand. The server is given a force window of
 * seconds instead of minutes, so the stale reaper escalates within a pass
 * or two of the stop.
 *
 * One worktree for the file, and the case destroys it, so it is the only
 * case. The freeze is undone in `afterAll` whatever happened, or the job
 * cleanup would wait on the same stuck delete.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A shell program for the installer pod: signal the runsc-sandbox whose
 *  command line carries the pod's uid (the shim's `--panic-log` path). */
function signalSandboxScript(podUid: string, signal: 'STOP' | 'KILL'): string {
  return [
    'set -u',
    'for p in /proc/[0-9]*; do',
    '  c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null) || continue',
    '  case "$c" in',
    `    "runsc-sandbox "*"_${podUid}/gvisor_panic.log"*) kill -${signal} "\${p#/proc/}" && echo "signalled pid=\${p#/proc/}"; exit 0;;`,
    '  esac',
    'done',
    'echo "no sandbox"; exit 1',
  ].join('\n')
}

async function installerPodOn(nodeName: string): Promise<{ name: string; namespace: string }> {
  const list = await kubectlGetJson<{
    items: Array<{ metadata: { name: string; namespace: string } }>
  }>([
    'get', 'pods', '-A', '-l', `app=${GVISOR_INSTALLER_APP_NAME}`,
    '--field-selector', `spec.nodeName=${nodeName},status.phase=Running`,
  ])
  const pod = list?.items[0]?.metadata
  if (!pod) throw new Error(`no ${GVISOR_INSTALLER_APP_NAME} pod on node ${nodeName}`)
  return pod
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, everyMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${String(timeoutMs)}ms`)
    await sleep(everyMs)
  }
}

describe('yaac worktree stop on a sandbox that ignores its delete (real CLI + real server + real cluster)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer | null = null
  let mockLLM: MockLLM | null = null
  let mockGit: MockGit | null = null
  let serverEnv: NodeJS.ProcessEnv
  /** What this file froze, to be thawed by force in afterAll. */
  let frozen: { uid: string; installer: { name: string; namespace: string } } | null = null

  beforeAll(async () => {
    await requirePodman()
    await requireCluster()
    testEnv = await createYaacTestEnv()

    const credsDir = path.join(testEnv.dataDir, '.credentials')
    await fs.mkdir(credsDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(credsDir, 'github.json'), JSON.stringify({
      tokens: [{ pattern: 'github.com/test-org/*', token: 'fake-ghp-token' }],
    }) + '\n')
    await fs.writeFile(path.join(credsDir, 'claude.json'), JSON.stringify({
      kind: 'api-key', savedAt: new Date().toISOString(), apiKey: 'sk-ant-fake-real-key',
    }) + '\n')
    await fs.writeFile(
      testEnv.gitConfigPath,
      '[user]\n\tname = Test User\n\temail = test@example.com\n',
    )

    mockLLM = await startMockLLM()
    mockGit = await startMockGit()
    const llmTarget = { host: mockLLM.host, port: mockLLM.port, tls: false }
    const gitTarget = { host: mockGit.host, port: mockGit.port, tls: false }
    serverEnv = {
      ...testEnv.env,
      YAAC_E2E_UPSTREAM_REDIRECTS: JSON.stringify({
        'github.com': gitTarget,
        'api.github.com': gitTarget,
        'api.anthropic.com': llmTarget,
        'statsig.anthropic.com': llmTarget,
        'api.statsig.com': llmTarget,
        'platform.claude.com': llmTarget,
        'docs.claude.com': llmTarget,
        'code.claude.com': llmTarget,
        'claude.com': llmTarget,
        'claude.ai': llmTarget,
        'mcp-proxy.anthropic.com': llmTarget,
      }),
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
      // The escalation under test: seconds, not the production minutes.
      YAAC_FORCE_KILL_AFTER_MS: '15000',
      YAAC_STARTING_GRACE_MS: '5000',
    }
    server = await spawnYaacServer(serverEnv)
  })

  afterAll(async () => {
    if (frozen) {
      await kubectlWithRetry([
        'exec', '-n', frozen.installer.namespace, frozen.installer.name, '--',
        'sh', '-c', signalSandboxScript(frozen.uid, 'KILL'),
      ], { timeout: 60_000, maxAttempts: 1 }).catch(() => { /* already gone */ })
    }
    if (server) await server.stop()
    server = null
    await cleanupWorktreeJobs()
    await cleanupMocks([mockLLM, mockGit])
    mockLLM = null
    mockGit = null
    await testEnv.cleanup()
  })

  it('force-kills the sandbox, keeps its stack dump, and finishes the stop', async () => {
    const slug = 'wedge'
    await seedMockGitRepo(mockGit!, slug, { files: { 'README.md': '# wedge\n' } })
    const projectPath = path.join(testEnv.dataDir, 'projects', slug)
    await fs.mkdir(path.join(projectPath, 'claude'), { recursive: true })
    await cloneRepo(path.join(mockGit!.reposDir, `${slug}.git`), path.join(projectPath, 'repo'), null)
    const fakeRemote = `https://github.com/test-org/${slug}.git`
    await simpleGit(path.join(projectPath, 'repo')).remote(['set-url', 'origin', fakeRemote])
    await fs.writeFile(path.join(projectPath, 'project.json'), JSON.stringify({
      slug, remoteUrl: fakeRemote, addedAt: new Date().toISOString(),
    }) + '\n')

    const create = await runYaac(serverEnv, 'worktree', 'create', slug, '--tool', 'claude')
    expect(create.exitCode, `create failed:\n${create.stdout}\n${create.stderr}`).toBe(0)
    const pod = (await listWorktreePods(slug))[0]
    expect(pod?.uid).toBeTruthy()
    expect(pod?.nodeName).toBeTruthy()

    // Freeze the sandbox where a force lands. From here the kubelet's stop
    // can never complete on its own.
    const installer = await installerPodOn(pod.nodeName!)
    const freeze = await kubectlWithRetry([
      'exec', '-n', installer.namespace, installer.name, '--',
      'sh', '-c', signalSandboxScript(pod.uid!, 'STOP'),
    ], { timeout: 60_000, maxAttempts: 1 })
    expect(freeze.stdout).toContain('signalled pid=')
    frozen = { uid: pod.uid!, installer }

    const stop = await runYaac(serverEnv, 'worktree', 'stop', pod.worktreeId)
    expect(stop.exitCode, `stop failed:\n${stop.stdout}\n${stop.stderr}`).toBe(0)

    // The reaper's escalation: the delete outlasts the force window, the
    // sandbox is killed from outside, the pod finalizes.
    await waitFor(async () => (await listWorktreePods(slug)).length === 0, 300_000)
    frozen = null

    // What the runtime captured on the way — a frozen sentry cannot answer
    // the stack dump, and the deadline covers that; the kill still landed.
    const dump = await fs.readFile(
      path.join(projectPath, 'meta', `${pod.worktreeId}.sandbox-stacks.txt`), 'utf8',
    )
    expect(dump).toContain('yaac-force-kill: sandbox pid=')
    expect(dump).toContain('yaac-force-kill: killed pid=')

    // An ordinary stopped worktree is what is left: its checkout kept, its
    // row restartable.
    const stopped = await runYaac(serverEnv, 'worktree', 'list', '-s')
    expect(stopped.stdout).toContain(pod.worktreeId.slice(0, 8))
    await expect(fs.access(path.join(projectPath, 'worktrees', pod.worktreeId))).resolves.toBeUndefined()
  }, 420_000)
})
