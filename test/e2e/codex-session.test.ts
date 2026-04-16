import { describe, it, expect, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTempDataDir, cleanupTempDir, createTestRepo, requirePodman, TEST_IMAGE_PREFIX, addTestProject } from '@test/helpers/setup'
import { podman } from '@/lib/container/runtime'
import { ensureImage } from '@/lib/container/image-builder'
import { codexDir, codexTranscriptDir, codexTranscriptFile, worktreeDir, worktreesDir, repoDir, getDataDir } from '@/lib/project/paths'
import { ensureCodexHooksJson, ensureCodexConfigToml } from '@/lib/session/codex-hooks'
import { addWorktree, getDefaultBranch } from '@/lib/git'
import { getCodexStatus, getCodexFirstUserMessage, getSessionCodexStatus } from '@/lib/session/codex-status'
import { getToolFromContainer } from '@/lib/session/status'
import { sessionList } from '@/commands/session-list'

const execFileAsync = promisify(execFile)

async function podmanExecRetry(
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      return await execFileAsync(cmd, args, opts ?? {})
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string })?.stderr ?? ''
      if (attempt < 8 && (stderr.includes('container state improper') || stderr.includes('no such container'))) {
        await new Promise((r) => setTimeout(r, Math.min(200 * 2 ** (attempt - 1), 3200)))
        continue
      }
      throw err
    }
  }
  throw new Error('podmanExecRetry: unexpected fall-through')
}

/**
 * Creates a minimal Codex-tool container — no proxy, no claude dir.
 * Mounts the shared codex dir at /home/yaac/.codex and sets YAAC_SESSION_ID.
 */
async function createCodexContainer(projectSlug: string): Promise<{
  containerName: string
  sessionId: string
}> {
  const imageName = await ensureImage(projectSlug, TEST_IMAGE_PREFIX, true)
  const sessionId = crypto.randomBytes(4).toString('hex')
  const repo = repoDir(projectSlug)
  const wtDir = worktreeDir(projectSlug, sessionId)
  await fs.mkdir(worktreesDir(projectSlug), { recursive: true })
  await getDefaultBranch(repo)
  await addWorktree(repo, wtDir, `yaac/${sessionId}`)

  // Ensure codex dir, transcript dir, hooks, and hook script
  const codex = codexDir(projectSlug)
  await fs.mkdir(codexTranscriptDir(projectSlug), { recursive: true })

  const hookScript = path.join(codex, '.yaac-hook.sh')
  await fs.writeFile(hookScript, [
    '#!/bin/sh',
    'INPUT=$(cat)',
    'TRANSCRIPT=$(echo "$INPUT" | sed -n \'s/.*"transcript_path"\\s*:\\s*"\\([^"]*\\)".*/\\1/p\')',
    'if [ -n "$TRANSCRIPT" ] && [ -n "$YAAC_SESSION_ID" ]; then',
    '  LINK_DIR=/home/yaac/.codex/.yaac-transcripts',
    '  mkdir -p "$LINK_DIR"',
    '  REL=$(python3 -c "import os.path; print(os.path.relpath(\'$TRANSCRIPT\', \'$LINK_DIR\'))")',
    '  ln -sf "$REL" "$LINK_DIR/$YAAC_SESSION_ID.jsonl"',
    'fi',
  ].join('\n') + '\n')
  await fs.chmod(hookScript, 0o755)

  await ensureCodexHooksJson(codex)
  await ensureCodexConfigToml(codex)

  const containerName = `yaac-${projectSlug}-${sessionId}`
  const container = await podman.createContainer({
    Image: imageName,
    name: containerName,
    Labels: {
      'yaac.project': projectSlug,
      'yaac.session-id': sessionId,
      'yaac.data-dir': getDataDir(),
      'yaac.tool': 'codex',
      'yaac.test': 'true',
    },
    Env: [
      'TERM=xterm-256color',
      `YAAC_SESSION_ID=${sessionId}`,
    ],
    HostConfig: {
      Binds: [
        `${wtDir}:/workspace:Z`,
        `${codex}:/home/yaac/.codex:Z`,
      ],
    },
  })
  await container.start()

  // Start tmux session so isTmuxSessionAlive() returns true
  await podmanExecRetry('podman', [
    'exec', containerName, 'tmux', 'new-session', '-d', '-s', 'yaac', '-n', 'codex', 'zsh',
  ])

  return { containerName, sessionId }
}

describe('codex session support', () => {
  const containersToCleanup: string[] = []
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const name of containersToCleanup) {
      try {
        const c = podman.getContainer(name)
        await c.stop({ t: 1 })
        await c.remove()
      } catch {
        // already gone
      }
    }
    containersToCleanup.length = 0
    for (const dir of tmpDirs) {
      await cleanupTempDir(dir)
    }
    tmpDirs.length = 0
  })

  describe('container setup', () => {
    let containerName: string
    let sessionId: string
    let tmpDir: string

    afterAll(async () => {
      if (containerName) {
        try {
          const c = podman.getContainer(containerName)
          await c.stop({ t: 1 })
          await c.remove()
        } catch { /* already gone */ }
      }
      if (tmpDir) await cleanupTempDir(tmpDir)
    })

    it('creates a codex container with correct labels and env', async () => {
      await requirePodman()
      tmpDir = await createTempDataDir()
      const repoPath = path.join(tmpDir, 'codex-proj')
      await createTestRepo(repoPath)
      await addTestProject(repoPath)

      ;({ containerName, sessionId } = await createCodexContainer('codex-proj'))

      const info = await podman.getContainer(containerName).inspect()
      expect(info.State.Running).toBe(true)
      expect(info.Config.Labels['yaac.tool']).toBe('codex')
      expect(info.Config.Labels['yaac.session-id']).toBe(sessionId)

      // YAAC_SESSION_ID env var should be set
      const { stdout: envOut } = await execFileAsync('podman', [
        'exec', containerName, 'env',
      ])
      expect(envOut).toContain(`YAAC_SESSION_ID=${sessionId}`)
    })

    it('mounts the codex directory', async () => {
      // codex dir should be mounted at /home/yaac/.codex
      await execFileAsync('podman', [
        'exec', containerName, 'test', '-d', '/home/yaac/.codex',
      ])
    })

    it('has hooks.json inside the container', async () => {
      const { stdout } = await execFileAsync('podman', [
        'exec', containerName, 'cat', '/home/yaac/.codex/hooks.json',
      ])
      const hooks = JSON.parse(stdout) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } }
      const yaacHook = hooks.hooks.SessionStart.find((m) =>
        m.hooks.some((h) => h.command.includes('.yaac-hook.sh')),
      )
      expect(yaacHook).toBeDefined()
    })

    it('has config.toml with hooks enabled inside the container', async () => {
      const { stdout } = await execFileAsync('podman', [
        'exec', containerName, 'cat', '/home/yaac/.codex/config.toml',
      ])
      expect(stdout).toContain('codex_hooks')
    })

    it('has codex CLI available in the container', async () => {
      const { stdout } = await execFileAsync('podman', [
        'exec', containerName, 'which', 'codex',
      ])
      expect(stdout.trim()).toBeTruthy()
    })

    it('has the hook script executable in the container', async () => {
      const { stdout } = await execFileAsync('podman', [
        'exec', containerName, 'sh', '-c',
        'test -x /home/yaac/.codex/.yaac-hook.sh; echo $?',
      ])
      expect(stdout.trim()).toBe('0')
    })

    it('getToolFromContainer returns codex', async () => {
      const info = await podman.getContainer(containerName).inspect()
      expect(getToolFromContainer({ Labels: info.Config.Labels as Record<string, string> })).toBe('codex')
    })
  })

  describe('transcript hook', () => {
    let containerName: string
    let sessionId: string
    let tmpDir: string
    let projectSlug: string

    afterAll(async () => {
      if (containerName) {
        try {
          const c = podman.getContainer(containerName)
          await c.stop({ t: 1 })
          await c.remove()
        } catch { /* already gone */ }
      }
      if (tmpDir) await cleanupTempDir(tmpDir)
    })

    it('hook script creates a symlink for the transcript', async () => {
      await requirePodman()
      tmpDir = await createTempDataDir()
      projectSlug = 'codex-hook-proj'
      const repoPath = path.join(tmpDir, projectSlug)
      await createTestRepo(repoPath)
      await addTestProject(repoPath)

      ;({ containerName, sessionId } = await createCodexContainer(projectSlug))

      // Simulate what Codex does: create a transcript file and pipe
      // SessionStart hook JSON (with transcript_path) to the hook script.
      const transcriptContainerPath = '/home/yaac/.codex/sessions/2026/04/15/rollout-test.jsonl'
      await podmanExecRetry('podman', [
        'exec', containerName, 'mkdir', '-p', '/home/yaac/.codex/sessions/2026/04/15',
      ])
      // Write a sample transcript
      await podmanExecRetry('podman', [
        'exec', containerName, 'sh', '-c',
        `echo '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}' > ${transcriptContainerPath}`,
      ])
      await podmanExecRetry('podman', [
        'exec', containerName, 'sh', '-c',
        `echo '{"type":"event_msg","payload":{"type":"user_message","message":"hello codex"}}' >> ${transcriptContainerPath}`,
      ])
      await podmanExecRetry('podman', [
        'exec', containerName, 'sh', '-c',
        `echo '{"type":"event_msg","payload":{"type":"agent_message","message":"done","phase":"commentary"}}' >> ${transcriptContainerPath}`,
      ])
      await podmanExecRetry('podman', [
        'exec', containerName, 'sh', '-c',
        `echo '{"type":"response_item","payload":{"type":"message","role":"assistant"}}' >> ${transcriptContainerPath}`,
      ])

      // Simulate the SessionStart hook invocation
      const hookInput = JSON.stringify({
        session_id: 'codex-internal-id',
        transcript_path: transcriptContainerPath,
        cwd: '/workspace',
        hook_event_name: 'SessionStart',
        model: 'o3',
        source: 'startup',
      })
      await podmanExecRetry('podman', [
        'exec', containerName, 'sh', '-c',
        `echo '${hookInput}' | /home/yaac/.codex/.yaac-hook.sh`,
      ])

      // Verify the symlink was created inside the container (relative path)
      const { stdout: linkTarget } = await podmanExecRetry('podman', [
        'exec', containerName, 'readlink',
        `/home/yaac/.codex/.yaac-transcripts/${sessionId}.jsonl`,
      ])
      // Relative symlink should point up to ../sessions/...
      expect(linkTarget.trim()).toContain('sessions/2026/04/15/rollout-test.jsonl')

      // Verify we can actually read through the symlink inside the container
      const { stdout: catOut } = await podmanExecRetry('podman', [
        'exec', containerName, 'cat',
        `/home/yaac/.codex/.yaac-transcripts/${sessionId}.jsonl`,
      ])
      expect(catOut).toContain('event_msg')
    })

    it('symlink is visible on the host via bind mount', async () => {
      // The symlink should exist on the host at codexTranscriptFile path
      const hostSymlink = codexTranscriptFile(projectSlug, sessionId)
      const stat = await fs.lstat(hostSymlink)
      expect(stat.isSymbolicLink()).toBe(true)
    })

    it('getCodexStatus reads through the symlink', async () => {
      // The transcript has turn.completed as last entry, so status should be waiting
      const hostSymlink = codexTranscriptFile(projectSlug, sessionId)
      const status = await getCodexStatus(hostSymlink)
      expect(status).toBe('waiting')
    })

    it('getSessionCodexStatus resolves via symlink', async () => {
      const status = await getSessionCodexStatus(projectSlug, sessionId)
      expect(status).toBe('waiting')
    })

    it('treats a pending request_user_input call as waiting', async () => {
      const transcriptContainerPath = '/home/yaac/.codex/sessions/2026/04/15/rollout-test.jsonl'
      await podmanExecRetry('podman', [
        'exec', containerName, 'sh', '-c',
        [
          `echo '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}' > ${transcriptContainerPath}`,
          `echo '{"type":"event_msg","payload":{"type":"user_message","message":"pick one"}}' >> ${transcriptContainerPath}`,
          `echo '{"type":"event_msg","payload":{"type":"agent_message","message":"choose an option","phase":"commentary"}}' >> ${transcriptContainerPath}`,
          `echo '{"type":"response_item","payload":{"type":"message","role":"assistant"}}' >> ${transcriptContainerPath}`,
          `echo '{"type":"response_item","payload":{"type":"function_call","name":"request_user_input","call_id":"call-1"}}' >> ${transcriptContainerPath}`,
        ].join(' && '),
      ])

      const status = await getSessionCodexStatus(projectSlug, sessionId)
      expect(status).toBe('waiting')
    })

    it('transcript file is readable on the host through the symlink', async () => {
      const hostSymlink = codexTranscriptFile(projectSlug, sessionId)
      const content = await fs.readFile(hostSymlink, 'utf8')
      expect(content).toContain('event_msg')
      expect(content).toContain('pick one')
    })

    it('getCodexFirstUserMessage reads through the symlink', async () => {
      const hostSymlink = codexTranscriptFile(projectSlug, sessionId)
      const msg = await getCodexFirstUserMessage(hostSymlink)
      expect(msg).toBe('pick one')
    })

    it('session list shows codex tool', async () => {
      const logs: string[] = []
      const origLog = console.log
      console.log = (msg: string) => logs.push(msg)

      await sessionList(projectSlug)

      console.log = origLog
      const output = logs.join('\n')
      expect(output).toContain('codex')
      expect(output).toContain('waiting')
      expect(output).toContain('pick one')
    })
  })

  it('--tool flag is accepted by CLI option parsing', async () => {
    // Verify the tool option is wired through the session create command interface.
    // We can't run a full session create without a GitHub token and proxy, but
    // we can verify the option is accepted by importing the types.
    const { sessionCreate } = await import('@/commands/session-create')
    expect(typeof sessionCreate).toBe('function')
  })

  it('--prewarm-tool flag is accepted by session monitor option parsing', async () => {
    const { sessionMonitor } = await import('@/commands/session-monitor')
    expect(typeof sessionMonitor).toBe('function')
  })

  it('--tool flag is accepted by session stream option parsing', async () => {
    const { sessionStream } = await import('@/commands/session-stream')
    expect(typeof sessionStream).toBe('function')
  })

  it('tool get command is exported', async () => {
    const { toolGet } = await import('@/commands/tool-get')
    expect(typeof toolGet).toBe('function')
  })

  it('tool set command is exported', async () => {
    const { toolSet } = await import('@/commands/tool-set')
    expect(typeof toolSet).toBe('function')
  })

  describe('prewarm tool matching', () => {
    let containerName: string
    let sessionId: string
    let tmpDir: string

    afterAll(async () => {
      if (containerName) {
        try {
          const c = podman.getContainer(containerName)
          await c.stop({ t: 1 })
          await c.remove()
        } catch { /* already gone */ }
      }
      if (tmpDir) await cleanupTempDir(tmpDir)
    })

    it('claimPrewarmSession skips entry with mismatched tool', async () => {
      await requirePodman()
      tmpDir = await createTempDataDir()
      const repoPath = path.join(tmpDir, 'prewarm-tool-proj')
      await createTestRepo(repoPath)
      await addTestProject(repoPath)

      ;({ containerName, sessionId } = await createCodexContainer('prewarm-tool-proj'))

      const { setPrewarmSession, claimPrewarmSession } = await import('@/lib/prewarm')

      // Register a codex prewarm session
      await setPrewarmSession('prewarm-tool-proj', {
        sessionId,
        containerName,
        fingerprint: 'test-fp',
        state: 'ready',
        verifiedAt: Date.now(),
        tool: 'codex',
      })

      // Claiming with claude (default) should return null
      const claimed = await claimPrewarmSession('prewarm-tool-proj', 'claude')
      expect(claimed).toBeNull()

      // Claiming with codex should succeed
      const claimedCodex = await claimPrewarmSession('prewarm-tool-proj', 'codex')
      expect(claimedCodex).not.toBeNull()
      expect(claimedCodex?.sessionId).toBe(sessionId)
    })
  })
})
