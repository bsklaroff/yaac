import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runYaac, type RunYaacOptions } from '#support/cli'
import { asTailnet, assignTestGitCredential, makeServerApiClient, signInTestTool } from '@yaac/test-utils/api'
import { freeLocalPort } from '@yaac/test-utils/kubectl-forward'
import { createTestRepo } from '@yaac/test-utils/setup'
import { addTestProject } from '#support/cluster'
import {
  containerlessStateDir,
} from '@yaac/server/drivers/containerless/paths'
import { builtinSkillsDir, sharedSkillRoots } from '@yaac/server/domain/skills'
import { promptFits } from '@yaac/shared/types'
import { serverLogPath } from '@yaac/shared/paths'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import type {
  ResourceReport,
  RoutineEntry,
  SessionEntry,
  WorkspaceChanges,
  WorkspaceTerminalEntry,
} from '@yaac/shared/types'

const execFileAsync = promisify(execFile)
import {
  CAN_RUN,
  CAN_RUN_PORTS,
  CLI_TIME_ZONE,
  GIT_TOKEN,
  NAME,
  OTHER_LOOPBACK,
  USER_SHELL,
  childPids,
  cliEnv,
  createWorkspace,
  createWorkspaceWith,
  firstSession,
  listWorkspaces,
  mainClone,
  origin,
  paneEnv,
  processEnv,
  projectId,
  repoPath,
  reportClaudeConversation,
  restartServer,
  server,
  serverEnv,
  sessionArgv,
  sockFor,
  startForwardCli,
  startRig,
  startedId,
  stopRig,
  testEnv,
  tmux,
  userHome,
  workspaceEnvVar,
} from '#support/containerless-rig'

/**
 * The containerless driver end to end: the real CLI against a real server
 * that runs workspaces as tmux sessions on this host
 * (docs/containerless-driver.md), on the rig in
 * test/support/containerless-rig.ts. The ways a workspace starts are in
 * workspace-starts-suite.test.ts.
 *
 * One test env, server and workspace are shared by the read-only cases;
 * tests that destroy their subject run last.
 */

let workspaceId: string
/** The project the timed cases run in, so their launches stay out of
 *  `NAME`'s listings. */
const SCHED = 'cl-sched'
/** The workspace the timed cases give a one-minute timeout. */
let timedId = ''

beforeAll(startRig)
afterAll(stopRig)

describe.skipIf(!CAN_RUN)('containerless workspaces (real CLI + real server, no cluster)', () => {
  it('reports the containerless driver on /health, before any credential', async () => {
    const res = await fetch(`${origin()}/api/health`)
    const body = await res.json() as { driver: string }
    // The CLI reads this to decide whether `yaac cluster` applies, so it
    // needs no credential.
    expect(body.driver).toBe('containerless')
  })

  it('yaac host check verifies the host instead of a cluster', async () => {
    const { stdout, exitCode } = await runYaac(serverEnv, 'host', 'check')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('tmux')
    // The warning that workspaces are not isolated.
    expect(stdout).toContain('isolation')
  })

  it('yaac cluster check refuses rather than pretending there is a cluster', async () => {
    const { stderr, exitCode } = await runYaac(serverEnv, 'cluster', 'check')
    expect(exitCode).toBe(1)
    expect(stderr).toContain('containerless')
    expect(stderr).toContain('yaac host check')
  })

  it('yaac config git-identity shows and sets the identity a create commits under', async () => {
    // Create refuses without an identity, so this runs before the first one.
    const unset = await runYaac(serverEnv, 'config', 'git-identity')
    expect(unset.exitCode).toBe(0)
    expect(unset.stdout).toContain('You have no git identity set')

    // Both parts are required.
    const half = await runYaac(serverEnv, 'config', 'git-identity', '--name', 'Test')
    expect(half.exitCode).toBe(1)
    expect(half.stderr).toContain('--name and --email')

    const set = await runYaac(
      serverEnv, 'config', 'git-identity', '--name', 'Test', '--email', 'test@test.com',
    )
    expect(set.exitCode).toBe(0)
    expect(set.stdout).toContain('Git identity: Test <test@test.com>')
    expect((await runYaac(serverEnv, 'config', 'git-identity')).stdout)
      .toContain('Test <test@test.com>')
  })

  it('yaac config workspace-auto-delete shows the setting, sets it only once confirmed on a terminal, and turns it off', async () => {
    const run = (...args: Array<string | RunYaacOptions>): ReturnType<typeof runYaac> =>
      runYaac(serverEnv, 'config', 'workspace-auto-delete', NAME, ...args)
    const answer = (send: string): RunYaacOptions => ({ tty: true, stdinOnPrompt: [{ when: /Continue\? \[y\/N\]/, send }] })
    expect((await run()).stdout).toContain(`${NAME} keeps stopped workspaces until you delete them.`)

    // With no terminal to confirm on it refuses; on one, Enter means no.
    const unconfirmed = await run('30')
    expect(unconfirmed.exitCode).toBe(1)
    expect(unconfirmed.stderr).toContain('only turned on from a terminal')
    const declined = await run('30', answer('\r'))
    expect(declined.stdout).toContain('0 workspace(s) are already past that and will be deleted irretrievably')
    expect(declined.stdout).toContain('Aborted — nothing was changed or deleted.')
    expect((await run()).stdout).toContain('keeps stopped workspaces')

    // None has been stopped a day yet, so nothing goes.
    const set = await run('30', answer('y\r'))
    expect(set.exitCode, set.stdout).toBe(0)
    expect(set.stdout).toContain('once it has been stopped 30 days; deleted 0 now')
    expect((await run()).stdout).toContain(`${NAME} deletes a workspace once it has been stopped 30 days.`)

    const off = await run('off')
    expect(off.exitCode).toBe(0)
    expect((await run()).stdout).toContain('keeps stopped workspaces')
    const bad = await run('0')
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain('not a whole number of days')
  })

  it('yaac config scratch-dirs shows the defaults with their caps, replaces them, clears them with --none, and refuses a bad dir', async () => {
    const run = (...args: string[]): ReturnType<typeof runYaac> => runYaac(serverEnv, 'config', 'scratch-dirs', NAME, ...args)
    expect((await run()).stdout)
      .toContain(`Scratch directories in ${NAME}: node_modules (16 GiB, the default), target (16 GiB, the default)`)

    // A dir named without a cap gets the default.
    const set = await run('node_modules:4', 'target:32', 'web/node_modules/')
    expect(set.exitCode, set.stderr).toBe(0)
    // What was stored, normalized, not what was typed.
    expect(set.stdout).toContain(
      `Scratch directories in ${NAME} are now: node_modules (4 GiB), target (32 GiB), web/node_modules (16 GiB, the default).`,
    )
    expect((await run('target')).stdout)
      .toContain(`Scratch directories in ${NAME} are now: target (16 GiB, the default).`)

    expect((await run('--none')).exitCode).toBe(0)
    expect((await run()).stdout).toContain(`Scratch directories in ${NAME}: none`)
    const both = await run('target', '--none')
    expect(both.exitCode).toBe(1)
    expect(both.stderr).toContain('not both')
    const bad = await run('../up')
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain('must not contain')
    const tooBig = await run('target:2000')
    expect(tooBig.exitCode).toBe(1)

    // Put back what the cases below run with.
    expect((await run('node_modules', 'target')).exitCode).toBe(0)
  })

  it('creates a workspace as a tmux session on this host, with the project\'s plain variables in its environment', async () => {
    const env = await fetch(`${origin()}/api/project/${NAME}/env`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'YAAC_TEST_VAR', value: 'hello-from-host' }),
    })
    expect(env.status, await env.text()).toBe(200)
    workspaceId = await createWorkspace('--effort', 'high', '--agent-option', 'idle-compaction=on')
    expect((await paneEnv(workspaceId)).YAAC_TEST_VAR).toBe('hello-from-host')
    // A tmux server of its own on this host.
    const windows = await tmux(workspaceId, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')
    expect(windows).toContain('claude')
    // The named effort rides the launch (docs/effort-levels.md).
    expect(await tmux(workspaceId, 'display', '-p', '-t', 'yaac:claude', '#{pane_start_command}'))
      .toContain('--effort high')
    // So do its agent options: claude's terminal UI takes its own as a flag,
    // and every agent finds them on its window (docs/sessions.md).
    expect(await tmux(workspaceId, 'display', '-p', '-t', 'yaac:claude', '#{pane_start_command}'))
      .toMatch(/--settings \S*idleCompaction\S*:true\S* /)
    expect((await tmux(workspaceId, 'show-options', '-wqv', '-t', 'yaac:claude', '@yaac-idle-compaction')).trim()).toBe('on')
    // The agent keeps the session's first pane, so its history limit must be
    // set before the session exists: it is the scrollback the webapp seeds.
    expect((await tmux(workspaceId, 'display', '-p', '-t', 'yaac:claude', '#{history_limit}')).trim()).toBe('200000')

    // Every create picks a model (the fallback here, nothing remembered
    // yet); the fake agent reports nothing, so this comes from the launch.
    const res = await fetch(`${origin()}/api/workspace/list`)
    const { workspaces } = await res.json() as {
      workspaces: Array<{ workspaceId: string; sessions: SessionEntry[] }>
    }
    expect(workspaces.find((w) => w.workspaceId === workspaceId)?.sessions[0])
      .toMatchObject({ model: FALLBACK_MODELS.claude, modelName: 'Opus 5.5' })
  }, 120_000)

  it('launches the workspace in the zone the CLI reported, not the server host\'s', async () => {
    const res = await fetch(`${origin()}/api/config/time-zone`)
    expect(await res.json()).toEqual({ timeZone: CLI_TIME_ZONE, pinned: false })
    expect((await paneEnv(workspaceId)).TZ).toBe(CLI_TIME_ZONE)
  })

  // The timed cases (docs/routines.md) act on the server's minute resync, so
  // a one-minute timeout or start lands within two. They start here, in a
  // project of their own so their launches never land in this project's
  // listings, and are checked near the end of the file, so the wait overlaps
  // the cases between.
  it('queues a timed workspace and a scheduled one, and lists both with their times', async () => {
    const schedRepo = await createTestRepo(path.join(testEnv.scratchDir, SCHED))
    await addTestProject(server, schedRepo, { remoteUrl: `https://github.com/test/${SCHED}.git` })
    await assignTestGitCredential(server, SCHED, GIT_TOKEN)

    const timed = await runYaac(cliEnv(), 'workspace', 'create', SCHED, '--tool', 'claude', '--mode', 'tui',
      '--timeout', '1m', '--prompt', 'timed')
    expect(timed.exitCode, timed.stderr).toBe(0)
    timedId = startedId(timed.stdout)
    expect((await listWorkspaces()).find((w) => w.workspaceId === timedId)?.deadline).toBeDefined()
    const child = await fetch(`${origin()}/api/workspace/queue/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: SCHED, parent: timedId, prompt: 'after the timeout', tool: 'claude', mode: 'tui' }),
    })
    expect(child.status, await child.clone().text()).toBe(200)

    const scheduled = await runYaac(cliEnv(), 'workspace', 'create', SCHED, '--tool', 'claude', '--mode', 'tui',
      '--start-in', '1m', '--prompt', 'scheduled start')
    expect(scheduled.exitCode, scheduled.stderr).toBe(0)
    // Shown in the zone the CLI reported.
    expect(scheduled.stdout).toMatch(new RegExp(`^Queued workspace [0-9a-f-]{36}: starts at about .+ ${CLI_TIME_ZONE}\\.`))

    const list = await runYaac(cliEnv(), 'workspace', 'list', SCHED)
    expect(list.stdout).toMatch(new RegExp(`STOPS \\(${CLI_TIME_ZONE}\\)`))
    expect(list.stdout).toContain('Scheduled:')
    expect(list.stdout).toContain('scheduled start')
  }, 120_000)

  it('sets and clears a running workspace\'s timeout, which its agent reads through yaac-mama', async () => {
    const set = await runYaac(cliEnv(), 'workspace', 'timeout', workspaceId.slice(0, 8), '3h')
    expect(set.exitCode, set.stderr).toBe(0)
    expect(set.stdout).toMatch(new RegExp(`stops at about .+ ${CLI_TIME_ZONE}\\.$`, 'm'))
    const { out } = await runMama('list', workspaceId.slice(0, 8))
    expect(out).toMatch(new RegExp(`STOPS \\(${CLI_TIME_ZONE}\\)`))
    expect(out).toMatch(/\(in (2h 59m|3h)\)/)
    const cleared = await runYaac(cliEnv(), 'workspace', 'timeout', workspaceId, 'none')
    expect(cleared.stdout).toContain('has no timeout')
    expect((await listWorkspaces()).find((w) => w.workspaceId === workspaceId)?.deadline).toBeUndefined()
  })

  it('reports the running workspace\'s memory, and the host\'s, on the server health report', async () => {
    // The port sweep's `ps` tables feed it, so wait out a sweep or two.
    await vi.waitFor(async () => {
      const report = await (await fetch(`${origin()}/api/server/usage`)).json() as ResourceReport
      expect(report.driver).toBe('containerless')
      expect(report.totals.memoryCapacityBytes).toBeGreaterThan(0)
      expect(report.totals.disks[0]?.capacityBytes).toBeGreaterThan(0)
      expect(report.components.find((c) => c.key === 'server')?.memoryBytes).toBeGreaterThan(0)
      const mine = report.workspaces.find((w) => w.workspaceId === workspaceId)
      expect(mine).toMatchObject({ running: true, projectName: NAME })
      expect(mine?.memoryBytes).toBeGreaterThan(0)
    }, { timeout: 20_000, interval: 1_000 })
  })

  it('gives the workspace a real checkout on the host, which is what the agent sees', async () => {
    const dir = path.join(
      testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', workspaceId,
    )
    // The server's checkout is the workspace itself.
    await expect(fs.stat(path.join(dir, 'README.md'))).resolves.toBeDefined()
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
    expect(stdout.trim()).toBe(`agent/${workspaceId}`)
    // Its own clone, borrowing objects from the main clone.
    expect((await fs.stat(path.join(dir, '.git'))).isDirectory()).toBe(true)
    expect(await fs.readFile(path.join(dir, '.git', 'objects', 'info', 'alternates'), 'utf8'))
      .toBe(`${path.join(mainClone(), '.git', 'objects')}\n`)
  })

  it('runs the review diff with host git in that checkout, and reads a file at its base', async () => {
    const dir = path.join(
      testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', workspaceId,
    )
    await fs.writeFile(path.join(dir, 'NEW.md'), '# added by the test\n')
    const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8')
    await fs.appendFile(path.join(dir, 'README.md'), 'appended\n')
    try {
      const res = await fetch(`${origin()}/api/workspace/${workspaceId}/changes?diff=0`)
      const changes = await res.json() as WorkspaceChanges
      const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f]))
      expect(byPath['NEW.md'].stages).toEqual({ untracked: { additions: 1, deletions: 0 } })
      expect(byPath['README.md'].stages).toEqual({ modified: { additions: 1, deletions: 0 } })
      expect(changes).not.toHaveProperty('diff')

      const at = await fetch(`${origin()}/api/workspace/${workspaceId}/file-at?path=README.md&rev=${changes.base}`)
      expect(await at.json()).toEqual({ exists: true, content: readme })
    } finally {
      await fs.writeFile(path.join(dir, 'README.md'), readme)
    }
  })

  it('edits the checkout over HTTP: create, list, read, a stale save refused, then saved', async () => {
    const api = (route: string, init: RequestInit = {}): Promise<Response> => fetch(
      `${origin()}/api/workspace/${workspaceId}${route}`,
      { ...init, headers: { 'content-type': 'application/json' } },
    )
    const put = (body: object): Promise<Response> => api('/file', { method: 'PUT', body: JSON.stringify(body) })

    // A save with no base creates the file and its folders.
    const created = await put({ path: 'notes/todo.md', content: 'one\n', baseVersion: null })
    expect(created.status).toBe(200)
    const { version } = await created.json() as { version: string }
    expect((await put({ path: '.gitignore', content: 'node_modules/\n', baseVersion: null })).status).toBe(200)
    const checkout = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', workspaceId)
    await fs.mkdir(path.join(checkout, 'node_modules', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(checkout, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')

    const { listing: files } = await (await api('/changes?diff=0&listing=full')).json() as WorkspaceChanges
    if (!files) throw new Error('the changes answer carries no listing')
    expect(files.paths).toEqual(expect.arrayContaining(['README.md', 'notes/todo.md']))
    expect(files.ignored).toContain('node_modules/')
    expect(files.conflicted).toEqual([])

    const read = await (await api('/file?path=notes/todo.md')).json() as { version: string; content: string }
    expect(read).toMatchObject({ version, content: 'one\n' })

    // After an outside write, a save against the old version is refused
    // with the current version.
    await fs.writeFile(path.join(checkout, 'notes', 'todo.md'), 'theirs\n')
    const stale = await put({ path: 'notes/todo.md', content: 'mine\n', baseVersion: version })
    expect(stale.status).toBe(409)
    const { version: current } = await stale.json() as { version: string }
    expect(await fs.readFile(path.join(checkout, 'notes', 'todo.md'), 'utf8')).toBe('theirs\n')
    expect((await put({ path: 'notes/todo.md', content: 'mine\n', baseVersion: current })).status).toBe(200)
    expect(await fs.readFile(path.join(checkout, 'notes', 'todo.md'), 'utf8')).toBe('mine\n')
    // An oversized body is refused before it is buffered: on its declared
    // length alone, so only the headers are sent. Writing the body would race
    // the server dropping the connection, failing the write with EPIPE.
    const huge = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${origin()}/api/workspace/${workspaceId}/file`, {
        method: 'PUT',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) },
      }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
        req.destroy()
      })
      req.on('error', reject)
      req.flushHeaders()
    })
    expect(huge).toBe(413)

    const dir = await (await api('/dir?path=node_modules')).json() as { entries: Array<{ name: string; dir: boolean }> }
    expect(dir.entries).toEqual([{ name: 'pkg', dir: true }])
  })

  it('gives the workspace\'s own git the project\'s credential', async () => {
    // The checkout's `origin` has no token and the user's git config does
    // not apply, so real git must get the credential from the config the
    // create wrote.
    const state = containerlessStateDir(projectId, workspaceId)
    const dir = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', workspaceId)
    // Read from the workspace's tmux environment, which also shows the
    // launch set it. The host's own GIT_CONFIG_GLOBAL would otherwise leak in.
    const gitConfigGlobal = await workspaceEnvVar(workspaceId, 'GIT_CONFIG_GLOBAL')
    expect(gitConfigGlobal).toBe(path.join(state, 'gitconfig'))
    const filled = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'git', ['credential', 'fill'],
        {
          cwd: dir,
          // GIT_CONFIG_GLOBAL picks the config, which names the credential
          // store, so the user's HOME holds none. No prompt, so a failure
          // fails instead of hanging.
          env: {
            ...process.env,
            HOME: userHome(),
            GIT_CONFIG_GLOBAL: gitConfigGlobal,
            GIT_TERMINAL_PROMPT: '0',
          },
        },
        (err, stdout) => (err
          ? reject(err instanceof Error ? err : new Error('git credential fill failed'))
          : resolve(stdout)),
      )
      child.stdin?.end('protocol=https\nhost=github.com\n\n')
    })
    expect(filled).toContain('username=x-access-token')
    // The real token: there is no proxy to swap in a placeholder
    // (docs/containerless-driver.md).
    expect(filled).toContain(`password=${GIT_TOKEN}`)
    await expect(fs.access(path.join(userHome(), '.git-credentials'))).rejects.toThrow()
  })

  it('opens and kills a shell window, and the listing follows both', async () => {
    const res = await fetch(`${origin()}/api/workspace/${workspaceId}/terminals`, {
      method: 'POST',
    })
    expect(res.ok).toBe(true)
    const shell = await res.json() as WorkspaceTerminalEntry
    const windows = await tmux(workspaceId, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')
    expect(windows).toContain('shell')
    // The status watcher sees tmux announce the window and re-lists.
    const terminals = async (): Promise<WorkspaceTerminalEntry[] | undefined> =>
      (await listWorkspaces()).find((w) => w.workspaceId === workspaceId)?.terminals
    await vi.waitFor(async () => expect(await terminals()).toContainEqual(shell), { timeout: 10_000 })

    const kill = await fetch(`${origin()}/api/workspace/${workspaceId}/terminals/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: shell.target }),
    })
    expect(kill.status).toBe(204)
    await vi.waitFor(async () => expect(await terminals()).not.toContainEqual(shell), { timeout: 10_000 })
  })

  it('serves a webapp terminal from its pane: snapshot, raw output, input, paste and resize', async () => {
    // A pane that floods numbered lines, then echoes its input visibly.
    const window = (await tmux(workspaceId, 'new-window', '-d', '-P', '-F', '#{window_id}', '-t', '=yaac:',
      '-n', 'mirror', "sh -c 'seq 1 100000; stty raw -echo; exec cat -v'")).trim()
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(server.lock.port)}/api/pty/attach?id=${workspaceId}&target=window:${window}&cols=100&rows=30`)
    const frames: Array<string | Buffer> = []
    ws.on('message', (data: Buffer, isBinary) => frames.push(isBinary ? data : data.toString('utf8')))
    try {
      const bytes = (): string => frames.filter((f): f is Buffer => typeof f !== 'string')
        .map((f) => f.toString('latin1')).join('')
      // Attached mid-flood: wait for the end of it.
      await vi.waitFor(() => expect(bytes()).toContain('100000'), { timeout: 30_000, interval: 200 })

      // The pane's size, then a snapshot that resets the client.
      expect(JSON.parse(frames[0] as string)).toEqual({ type: 'size', cols: 100, rows: 30 })
      expect((frames[1] as Buffer).subarray(0, 2).toString('latin1')).toBe('\x1bc')
      // The snapshot and the output after it hold every line exactly once,
      // in order: nothing the capture holds is sent again and nothing after
      // it is lost.
      const numbers = bytes()
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[c=]/g, '')
        .match(/\d+/g)?.map(Number) ?? []
      expect(numbers.at(-1)).toBe(100000)
      const gaps = numbers.filter((n, i) => i > 0 && n !== numbers[i - 1] + 1)
      expect(gaps).toEqual([])
      expect(numbers.length).toBeGreaterThan(4000)

      // Keystrokes and a bracketed paste reach the pane through tmux; `cat`
      // never asked for bracketed paste, so tmux delivers it bare.
      ws.send(Buffer.from('ab'))
      ws.send(Buffer.from('\x1b[200~x$y\x1b[201~'))
      await vi.waitFor(async () => {
        // -J rejoins a wrapped line: `stty raw` can take effect before all of
        // `seq`'s output has gone through the tty, leaving the cursor anywhere.
        expect(await tmux(workspaceId, 'capture-pane', '-p', '-J', '-t', window)).toContain('abx$y')
        // And its echo comes back.
        expect(bytes()).toContain('abx$y')
      }, { timeout: 10_000, interval: 200 })

      // A resize sizes the window, and the new size comes back as a frame.
      ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 25 }))
      await vi.waitFor(() => expect(frames.filter((f) => typeof f === 'string').map((f) => JSON.parse(f) as unknown))
        .toContainEqual({ type: 'size', cols: 90, rows: 25 }), { timeout: 10_000, interval: 200 })
      expect((await tmux(workspaceId, 'display', '-p', '-t', window, '#{window_width}x#{window_height}')).trim())
        .toBe('90x25')
    } finally {
      ws.close()
      await tmux(workspaceId, 'kill-window', '-t', window)
    }
  }, 60_000)

  // The CLI resolves a prefix to the exact id the terminal socket needs.
  it('attaches and opens a shell by a unique id prefix', async () => {
    const prefix = workspaceId.slice(0, 8)
    // Type only once the far end draws, or early bytes can be flushed. The
    // first Enter answers zsh's new-user menu, should a shell show one.
    const shell = await runYaac(serverEnv, 'workspace', 'shell', prefix, {
      stdinOnPrompt: [
        { when: /Type one of the keys|[%$#] /, send: '\n' },
        { when: /[%$#] /, send: 'echo "prefix-$((6*7))"; exit\n' },
      ],
    })
    expect(shell.exitCode, shell.stderr).toBe(0)
    expect(shell.stdout).toContain('prefix-42')

    // `C-b d` detaches, sent once tmux is drawing.
    const attach = await runYaac(serverEnv, 'workspace', 'attach', prefix, {
      stdinOnPrompt: [{ when: /\x1b\[/, send: '\x02d' }],
    })
    expect(attach.exitCode, attach.stderr).toBe(0)
    expect(attach.stderr).not.toMatch(/not found|error/i)

    // --agent lands on that agent's window, whichever window tmux has
    // current: the status line marks it current (`*`) before the detach.
    const session = await firstSession(workspaceId)
    await tmux(workspaceId, 'select-window', '-t', '=yaac:=_yaac')
    const onSession = await runYaac(serverEnv, 'workspace', 'attach', '--agent', session.sessionId.slice(0, 8), prefix, {
      stdinOnPrompt: [{ when: new RegExp(`${session.window}\\*`), send: '\x02d' }],
    })
    expect(onSession.exitCode, onSession.stderr).toBe(0)

    // Each attach's view session is reclaimed when its connection closes.
    await vi.waitFor(async () => expect(await tmux(workspaceId, 'list-sessions', '-F', '#{session_name}'))
      .not.toMatch(/^view-/m), { timeout: 10_000, interval: 200 })
  }, 90_000)

  it.skipIf(!CAN_RUN_PORTS)('tunnels a connection onto a port the workspace is listening on', async () => {
    // A loopback dev server under the workspace's tmux server (the process
    // tree the port sweep walks), reached through `/api/forward/attach` as a
    // remote client would.
    const devPort = await freeLocalPort()
    const script = path.join(testEnv.scratchDir, 'dev-server.cjs')
    await fs.writeFile(script, `
      require('http').createServer((req, res) => res.end('hello from the workspace'))
        .listen(${String(devPort)}, '127.0.0.1')
    `)
    await tmux(workspaceId, 'new-window', '-d', '-t', '=yaac:', '-n', 'dev',
      `'${process.execPath}' '${script}'`)
    // Detection is a poll.
    await vi.waitFor(async () => {
      const me = (await listWorkspaces()).find((w) => w.workspaceId === workspaceId)
      expect(me?.forwardedPorts).toEqual([{ containerPort: devPort, hostPort: devPort }])
    }, { timeout: 20_000, interval: 500 })

    // Against a local server the CLI refuses without `--bind` (see the last
    // case in the file), since the same host port would clash with the dev
    // server. A bare `-p <n>` binds the same port on both sides, so it goes
    // on another loopback address.
    const host = OTHER_LOOPBACK.includes(':') ? `[${OTHER_LOOPBACK}]` : OTHER_LOOPBACK
    const forwarder = startForwardCli(workspaceId, '--bind', OTHER_LOOPBACK, '-p', String(devPort))
    try {
      await forwarder.ready()
      expect(forwarder.output()).toContain(`forwarding ${OTHER_LOOPBACK}:${String(devPort)} -> ${workspaceId.slice(0, 8)}:${String(devPort)}\n`)
      const res = await fetch(`http://${host}:${String(devPort)}/`)
      expect(await res.text()).toBe('hello from the workspace')
    } finally {
      await forwarder.stop()
    }
    // With no workspace named, every running workspace's ports, as the
    // server's `/events` snapshots offer them. Something else already
    // answers there, so the forwarder moves to the next free port and says
    // which.
    const squatter = http.createServer((_req, res) => res.end('some other app'))
    await new Promise<void>((resolve) => squatter.listen(devPort, OTHER_LOOPBACK, resolve))
    const offered = startForwardCli('--bind', OTHER_LOOPBACK)
    try {
      await offered.ready()
      const moved = new RegExp(`forwarding \\S+:(\\d+) -> ${workspaceId.slice(0, 8)}:${String(devPort)} \\(port ${String(devPort)} is in use here\\)`)
      const localPort = Number(moved.exec(offered.output())?.[1])
      expect(localPort, offered.output()).toBeGreaterThan(devPort)
      const res = await fetch(`http://${host}:${String(localPort)}/`)
      expect(await res.text()).toBe('hello from the workspace')
    } finally {
      await offered.stop()
      squatter.close()
      await tmux(workspaceId, 'kill-window', '-t', 'yaac:dev')
    }
    // A port the workspace is not listening on is refused, not relayed to
    // whatever else on this host holds it.
    const hostPort = await freeLocalPort()
    const stray = startForwardCli(
      workspaceId, '--bind', '127.0.0.1', '--port', `${String(server.lock.port)}:${String(hostPort)}`,
    )
    try {
      await stray.ready()
      await expect(fetch(`http://127.0.0.1:${String(hostPort)}/health`)).rejects.toThrow()
      expect(stray.output()).toMatch(/dial failed/)
    } finally {
      await stray.stop()
    }
  }, 60_000)

  it.skipIf(!CAN_RUN_PORTS)('gives each workspace of a project its own port for a config entry, served at its own hostname', async () => {
    // Two workspaces whose init starts the same dev server would collide on
    // its port, since they share the host's (docs/workspace-hostnames.md).
    // The project's config names one port; each workspace's server binds
    // the one it was told in YAAC_PORT_<n>, and the server routes each
    // workspace's hostname to its own.
    const PORTS = 'cl-ports'
    const base = await freeLocalPort()
    const portsRepo = await createTestRepo(path.join(testEnv.scratchDir, PORTS))
    const portsProject = await addTestProject(server, portsRepo, { remoteUrl: `https://github.com/test/${PORTS}.git` })
    await assignTestGitCredential(server, PORTS, GIT_TOKEN)
    const script = path.join(testEnv.scratchDir, 'port-dev.cjs')
    await fs.writeFile(script, `
      const port = Number(process.env.YAAC_PORT_${String(base)})
      require('http').createServer((req, res) => res.end(process.env.YAAC_WORKSPACE_ID + ' ' + req.headers.host))
        .listen(port, '127.0.0.1')
    `)
    const put = await fetch(`${origin()}/api/project/${portsProject}/port-forwards`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ports: [{ containerPort: base, hostPortStart: base }] }),
    })
    expect(put.status, await put.text()).toBe(200)
    const steps = await fetch(`${origin()}/api/workflow/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: portsProject, name: 'init', init: true, steps: { dev: { run: `'${process.execPath}' '${script}'`, service: true } } }),
    })
    expect(steps.status, await steps.text()).toBe(200)

    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const made = await runYaac(cliEnv(), 'workspace', 'create', PORTS, '--tool', 'claude', '--mode', 'tui')
      expect(made.exitCode, made.stderr).toBe(0)
      ids.push(startedId(made.stdout))
    }
    try {
      const ports = await vi.waitFor(async () => {
        const listed = (await listWorkspaces()).filter((w) => ids.includes(w.workspaceId))
        const found = ids.map((id) => listed.find((w) => w.workspaceId === id)?.forwardedPorts[0]?.containerPort)
        expect(found.every((p) => p !== undefined)).toBe(true)
        return found as number[]
      }, { timeout: 30_000, interval: 500 })
      expect(new Set(ports).size).toBe(2)
      for (const [i, id] of ids.entries()) {
        expect(ports[i]).toBeGreaterThanOrEqual(base)
        expect(await workspaceEnvVar(id, `YAAC_PORT_${String(base)}`)).toBe(String(ports[i]))
      }

      // Each name reaches its own workspace through the server's own port,
      // with the Host the browser sent.
      for (const [i, id] of ids.entries()) {
        const host = `${String(ports[i])}.${id.slice(0, 8)}.localhost:${String(server.lock.port)}`
        const body = await new Promise<string>((resolve, reject) => {
          http.get({ host: '127.0.0.1', port: server.lock.port, path: '/', headers: { host }, agent: false }, (res) => {
            let got = ''
            res.on('data', (c: Buffer) => { got += c.toString('utf8') })
            res.on('end', () => resolve(got))
          }).on('error', reject)
        })
        expect(body).toBe(`${id} ${host}`)
      }
      // The CLI lists the names.
      const list = await runYaac(cliEnv(), 'workspace', 'list', PORTS)
      expect(list.stdout).toContain(`http://${String(ports[0])}.${ids[0].slice(0, 8)}.localhost:${String(server.lock.port)}/`)
    } finally {
      for (const id of ids) await runYaac(cliEnv(), 'workspace', 'stop', id.slice(0, 8))
    }
  }, 120_000)

  it('records a conversation started by hand in a new terminal, through the registered hook', async () => {
    // Each link fails silently: the command registered in settings.json,
    // the script on the workspace's PATH, the pane option it sets, and the
    // watcher on a pane that is not an agent window. The command must not
    // name an in-image path.
    const project = path.join(testEnv.dataDir, 'global', 'projects', projectId)
    const commandsIn = async (file: string, event: string): Promise<string[]> => {
      const { hooks } = JSON.parse(await fs.readFile(file, 'utf8')) as
        { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }
      return hooks?.[event]?.flatMap((m) => m.hooks?.map((h) => h.command ?? '') ?? []) ?? []
    }
    const command = (await commandsIn(path.join(project, 'claude', 'settings.json'), 'SessionStart'))
      .find((c) => c.includes('yaac-agent-links'))
    expect(command).toBe('yaac-agent-links "$CLAUDE_CONFIG_DIR" claude')
    // codex runs the same script from its own home.
    expect(await commandsIn(path.join(project, 'codex', 'hooks.json'), 'SessionStart'))
      .toEqual(['yaac-agent-links "$CODEX_HOME" codex'])

    const binDir = path.join(project, 'sessions', workspaceId, 'bin')
    await expect(fs.access(path.join(binDir, 'yaac-agent-links'), fs.constants.X_OK))
      .resolves.toBeUndefined()

    // A new terminal (as the webapp's New Shell) and a transcript in the
    // tool home.
    const pane = (await tmux(workspaceId, 'new-window', '-d', '-n', 'shell-e2e', '-t', '=yaac:', '-P', '-F', '#{pane_id}')).trim()
    await fs.mkdir(path.join(project, 'claude', 'projects', '-e2e'), { recursive: true })
    await fs.writeFile(path.join(project, 'claude', 'projects', '-e2e', 'e2e-conv.jsonl'), `${JSON.stringify({
      type: 'user', message: { role: 'user', content: 'asked from a shell' },
    })}\n`)

    // Run the registered command as claude in that pane would: `sh -c` with
    // the workspace's PATH, claude home and the pane's tmux variables.
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'sh', ['-c', command ?? ''],
        {
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: path.join(project, 'claude'),
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            TMUX: `${sockFor(workspaceId)},0,0`,
            TMUX_PANE: pane,
          },
        },
        (err) => (err ? reject(err instanceof Error ? err : new Error('hook failed')) : resolve()),
      )
      child.stdin?.end(JSON.stringify({
        session_id: 'e2e-conv',
        transcript_path: path.join(project, 'claude', 'projects', '-e2e', 'e2e-conv.jsonl'),
      }))
    })

    const conv = async () => (await listWorkspaces())
      .find((w) => w.workspaceId === workspaceId)?.conversations.find((s) => s.conversationId === 'e2e-conv')
    await vi.waitFor(async () => {
      expect(await conv()).toMatchObject({ tool: 'claude', active: true, prompt: 'asked from a shell' })
    }, { timeout: 30_000, interval: 250 })

    // Closing the terminal keeps the record but marks it inactive.
    await tmux(workspaceId, 'kill-pane', '-t', pane)
    await vi.waitFor(async () => {
      expect(await conv()).toMatchObject({ active: false })
    }, { timeout: 30_000, interval: 250 })
  })


  /** The workspace's own yaac-mama credentials, memoized per file. */
  let mamaEnv: Record<string, string> | undefined
  const mamaCreds = async (): Promise<Record<string, string>> =>
    (mamaEnv ??= await paneEnv(workspaceId))

  /**
   * Run `yaac-mama` as the workspace would. With no proxy, it posts directly
   * to the server using the URL and bearer token from the workspace's
   * environment.
   */
  async function runMama(...args: string[]): Promise<{ code: number; out: string }> {
    const creds = await mamaCreds()
    const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
    const { stdout } = await execFileAsync('sh', ['-c',
      `YAAC_MAMA_URL='${creds.YAAC_MAMA_URL}' YAAC_MAMA_TOKEN='${creds.YAAC_MAMA_TOKEN}' `
      + `${path.join(process.cwd(), 'workspace-bin', 'yaac-mama')} ${quoted} 2>&1; echo "EXIT:$?"`,
    ])
    const m = /EXIT:(\d+)\s*$/.exec(stdout)
    if (!m) throw new Error(`no exit marker:\n${stdout}`)
    return { code: Number(m[1]), out: stdout.slice(0, m.index) }
  }

  // Every command the script knows (the list its unknown-command error
  // names) has help of its own, so `<cmd> --help` never runs the command.
  // Only a trailing --help asks for it: one given as an option's value is
  // sent, here to be refused for naming no workspace.
  it('prints each yaac-mama command\'s own help, and sends a --help given as a value', async () => {
    const unknown = await runMama('bogus', '--help')
    expect(unknown.code).toBe(2)
    const commands = /\(expected: ([^)]+)\)/.exec(unknown.out)?.[1].split(', ') ?? []
    expect(commands).toContain('create')
    for (const cmd of commands) {
      const { code, out } = await runMama(cmd, '--help')
      expect(code, cmd).toBe(0)
      expect(out, cmd).toMatch(new RegExp(`^Usage:\\n {2}yaac-mama ${cmd} `))
      expect(out, cmd).not.toMatch(/^@/m)
    }
    const create = await runMama('create', '--tool', 'claude', '-h')
    expect(create.out).toContain('create also takes')
    expect(create.out).not.toContain('yaac-mama stop')
    const value = await runMama('send', '--agent', '-h', 'no-such-workspace', 'hi')
    expect(value.code).toBe(1)
    expect(value.out).not.toContain('Usage:')
    // An option the script does not know, such as a retired one, is refused
    // before anything is sent, never taken as the prompt.
    const retired = await runMama('create', '--no-session')
    expect(retired.code).toBe(2)
    expect(retired.out).toContain('yaac-mama: unknown option --no-session')
  })

  it('hands the workspace a yaac-mama credential and server address', async () => {
    const creds = await mamaCreds()
    expect(creds.YAAC_MAMA_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(creds.YAAC_MAMA_TOKEN).toBeTruthy()
    // The token is never written to the marker a restarted server rebuilds
    // the environment from.
    const marker = await fs.readFile(path.join(
      testEnv.dataDir, 'global', 'projects', projectId, 'sessions', workspaceId,
      'containerless', 'workspace.json',
    ), 'utf8')
    expect(marker).toContain(creds.YAAC_MAMA_URL)
    expect(marker).not.toContain(creds.YAAC_MAMA_TOKEN)
  })

  it('resolves its tool homes from the project, not the server user', async () => {
    // Unit tests check the env the driver computes; this checks what a pane
    // actually gets, with bogus values in the server's env (`beforeAll`).
    const env = await paneEnv(workspaceId)

    // Overrides with no replacement are removed, as are the variables of a
    // claude session that started the server.
    for (const key of [
      'OPENCODE_CONFIG_DIR', 'OMP_PROFILE',
      'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'GIT_EDITOR',
    ]) {
      expect(env[key], `${key} reached the workspace`).toBeUndefined()
    }
    // The user's own HOME and XDG layout are kept; only opencode's wrapper
    // sets XDG dirs of its own.
    expect(env.HOME).toBe(userHome())
    expect(env.XDG_CONFIG_HOME).toBe('/nowhere/config')
    expect(env.XDG_DATA_HOME).toBe('/nowhere/share')
    // Replaced ones point at the project's directories, not per-workspace
    // paths (claude keys its macOS Keychain item on this string).
    const projectDir = path.join(testEnv.dataDir, 'global', 'projects', projectId)
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(projectDir, 'claude'))
    expect(env.CODEX_HOME).toBe(path.join(projectDir, 'codex'))
    expect(env.PI_CODING_AGENT_DIR).toBe(path.join(projectDir, 'pi', 'agent'))
    expect(env.YAAC_OMP_AGENT_DIR).toBe(path.join(projectDir, 'omp', 'agent'))
    // Per-workspace ones name the history directory itself, not a link.
    expect(env.PI_CODING_AGENT_SESSION_DIR)
      .toBe(path.join(projectDir, 'history', workspaceId, 'pi'))
    expect(env.CODEX_SQLITE_HOME)
      .toBe(path.join(projectDir, 'history', workspaceId, 'codex-sqlite'))
    // pnpm uses one store per project, not one per workspace. It lives
    // in `node-local/`, keyed by project id
    // (docs/containerless-driver.md, "Storage"). pnpm itself is asked, since
    // a misnamed variable would fail silently.
    const store = env.pnpm_config_store_dir ?? ''
    const nodeLocalProject = path.join(testEnv.dataDir, 'node-local', 'projects', projectId)
    expect(store).toBe(path.join(nodeLocalProject, '.cached-packages', 'pnpm-store'))
    expect(env.npm_config_store_dir).toBe(store)
    // A moved store path relinks `node_modules` instead of aborting a
    // non-TTY install.
    expect(env.pnpm_config_confirm_modules_purge).toBe('false')
    expect(env.npm_config_confirm_modules_purge).toBe('false')
    // Nothing else is node-local here; opencode opens its global data
    // directly.
    expect((await fs.readdir(nodeLocalProject)).sort()).toEqual(['.cached-packages'])
    const state = containerlessStateDir(projectId, workspaceId)
    expect(await fs.realpath(path.join(state, 'opencode', 'data', 'opencode')))
      .toBe(await fs.realpath(path.join(projectDir, 'opencode-data', workspaceId)))
    const { stdout: storePath } = await execFileAsync('pnpm', ['store', 'path'], {
      env, cwd: path.join(projectDir, 'workspaces', workspaceId),
    })
    expect(storePath.trim().split('\n').pop()?.startsWith(store), storePath).toBe(true)

    // claude reads `$CLAUDE_CONFIG_DIR/.claude.json`, so the onboarding seed
    // must be there or every launch shows the wizard and trust dialog.
    const seeded = JSON.parse(await fs.readFile(
      path.join(env.CLAUDE_CONFIG_DIR ?? '', '.claude.json'), 'utf8',
    )) as { hasCompletedOnboarding?: boolean; projects?: Record<string, unknown> }
    expect(seeded.hasCompletedOnboarding).toBe(true)
    expect(seeded.projects?.[path.join(projectDir, 'workspaces', workspaceId)])
      .toEqual({ hasTrustDialogAccepted: true })
    // gh never sees the user's own login.
    expect(env.GH_CONFIG_DIR).toBe(path.join(state, 'gh'))
  })

  it('runs opencode through a wrapper on the project\'s dirs and the workspace\'s own state', async () => {
    // opencode has no home variable, so its XDG dirs are set for it alone.
    // An `opencode` typed in a pane finds the wrapper first, as yaac's own
    // launch does.
    const state = path.join(containerlessStateDir(projectId, workspaceId), 'opencode')
    const child = spawn('opencode', [], { env: await paneEnv(workspaceId), stdio: 'ignore' })
    try {
      let reported: Record<string, string> = {}
      await vi.waitFor(async () => {
        reported = await processEnv(String(child.pid))
        expect(reported.XDG_STATE_HOME).toBeDefined()
      }, { timeout: 30_000, interval: 250 })
      expect(reported).toMatchObject({
        XDG_CONFIG_HOME: path.join(state, 'config'),
        XDG_DATA_HOME: path.join(state, 'data'),
        XDG_STATE_HOME: path.join(state, 'state'),
        XDG_CACHE_HOME: path.join(state, 'cache'),
      })
      expect(await fs.realpath(path.join(reported.XDG_CONFIG_HOME ?? '', 'opencode')))
        .toBe(await fs.realpath(path.join(testEnv.dataDir, 'global', 'projects', projectId, 'opencode-config')))
    } finally {
      child.kill()
    }
  })

  it.skipIf(USER_SHELL === '')('runs launches, panes and init commands in the user\'s shell, under yaac\'s settings', async () => {
    const project = path.join(testEnv.dataDir, 'global', 'projects', projectId)
    const claude = path.join(project, 'claude')
    // An agent launch runs in the user's shell (`zsh -c` reads .zshenv) with
    // yaac's settings put back over the rc's (`writeUserRc`).
    const agent = await paneEnv(workspaceId)
    expect(agent).toMatchObject({ CLAUDE_CONFIG_DIR: claude, GH_TOKEN: GIT_TOKEN, SHELL: USER_SHELL })
    expect(agent.PATH?.split(':')[0]).toBe(path.join(project, 'sessions', workspaceId, 'bin'))
    // Only an interactive shell reads .zshrc.
    expect(agent.YAAC_DATA_DIR).toBeUndefined()

    // A new terminal, as the webapp opens one, gets the user's shell and rc,
    // then yaac's settings over them, and names the checkout in its prompt.
    const out = path.join(testEnv.scratchDir, 'rc-e2e')
    await fs.mkdir(out, { recursive: true })
    const checkout = path.join(project, 'workspaces', workspaceId)
    const pane = (await tmux(workspaceId, 'new-window', '-d', '-n', 'rc-e2e', '-t', '=yaac:', '-c', checkout, '-P', '-F', '#{pane_id}')).trim()
    try {
      await vi.waitFor(async () => {
        expect(await tmux(workspaceId, 'capture-pane', '-p', '-t', pane)).toMatch(/~workspace ?[%$]/)
      }, { timeout: 30_000, interval: 250 })
      // A shell the pane starts reads the user's rc again, and yaac's
      // settings again after it.
      const show = 'printf \'%s\\n\' "$CLAUDE_CONFIG_DIR" "$GH_TOKEN" "$SHELL" "$YAAC_DATA_DIR" "$PATH"'
      await tmux(workspaceId, 'send-keys', '-t', pane,
        `{ ${show}; "$SHELL" -c '${show.replace(/'/g, '"')}' | head -2; } > ${out}/pane`, 'Enter')
      await vi.waitFor(() => fs.access(path.join(out, 'pane')), { timeout: 30_000, interval: 250 })
      const [config, ghToken, shell, dataDir, panePath = '', nestedConfig, nestedToken] =
        (await fs.readFile(path.join(out, 'pane'), 'utf8')).split('\n')
      expect(config).toBe(claude)
      // The project's own GitHub token, not the user's personal one.
      expect(ghToken).toBe(GIT_TOKEN)
      expect([nestedConfig, nestedToken]).toEqual([claude, GIT_TOKEN])
      // The user's shell, not the one tmux runs commands with.
      expect(shell).toBe(USER_SHELL)
      // What yaac does not depend on stays as the user's rc set it.
      expect(dataDir).toBe('/from/user/rc/yaac')
      // yaac's helpers and pinned agents first, the user's own dirs after.
      expect(panePath.split(':')[0]).toBe(path.join(project, 'sessions', workspaceId, 'bin'))
      expect(panePath).toContain('/from/user/rc/bin')
    } finally {
      await tmux(workspaceId, 'kill-pane', '-t', pane)
    }

    // An init command runs as `$SHELL -c` (`initWindowCommand`), which zsh
    // starts through yaac's startup files too.
    const shell = await workspaceEnvVar(workspaceId, 'SHELL')
    expect(shell).toBe(USER_SHELL)
    await tmux(workspaceId, 'new-window', '-d', '-n', 'init-e2e', '-t', '=yaac:', shell, '-c', `printf '%s' "$CLAUDE_CONFIG_DIR" > ${out}/init`)
    await vi.waitFor(async () => {
      expect(await fs.readFile(path.join(out, 'init'), 'utf8')).toBe(claude)
    }, { timeout: 30_000, interval: 250 })
  })

  it('lists this project’s workspaces from inside the workspace', async () => {
    const { code, out } = await runMama('list')
    expect(code).toBe(0)
    expect(out).toMatch(/WORKSPACE\s+TOOL\s+STATUS\s+GROUP\s+PROMPT/)
    // The token alone identifies the caller.
    expect(out).toContain(`${workspaceId.slice(0, 8)} (you)`)

    // Naming ids narrows the list and adds each one's full prompt.
    const named = await runMama('list', workspaceId.slice(0, 8))
    expect(named.code).toBe(0)
    expect(named.out).toContain(`Prompt of ${workspaceId.slice(0, 8)}:`)
    // The script decodes the server's escaping in one pass, so backslashes
    // arrive as sent rather than as newlines and tabs.
    const unknown = await runMama('list', workspaceId.slice(0, 8), 'C:\\new\\temp')
    expect(unknown.code).not.toBe(0)
    expect(unknown.out).toContain("no workspace 'C:\\new\\temp'")
  })

  it('makes a group and files itself into it, without a proxy anywhere', async () => {
    const made = await runMama('group', 'create', 'nightly')
    expect(made.code).toBe(0)

    const moved = await runMama('group', 'move', workspaceId.slice(0, 8), 'nightly')
    expect(moved.code).toBe(0)

    // Visible through the ordinary API.
    const res = await fetch(`${origin()}/api/workspace/group/list?project=${NAME}`)
    const { groups } = await res.json() as { groups: Array<{ groupId: string; name: string }> }
    expect(groups.map((g) => g.name)).toContain('nightly')

    const listed = await runMama('list')
    expect(listed.out).toMatch(new RegExp(`${workspaceId.slice(0, 8)}[^\\n]*nightly`))
  })

  it('renames itself, which the server records against the caller\u2019s own id', async () => {
    // No id needed: the token identifies the caller.
    const renamed = await runMama('rename', 'wiring up the mama channel')
    expect(renamed.code).toBe(0)
    expect(renamed.out).toContain('wiring up the mama channel')

    const res = await fetch(`${origin()}/api/workspace/list?project=${NAME}`)
    const body = await res.json() as { workspaces: Array<{ workspaceId: string; title?: string }> }
    const mine = body.workspaces.find((w) => w.workspaceId === workspaceId)
    expect(mine?.title).toBe('wiring up the mama channel')
  })

  it('sets, saves and removes its project\'s icon, refusing a directory and one too large to send', async () => {
    const png = path.join(testEnv.scratchDir, 'mama-icon.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 300 }, (_, i) => i % 256)])
    await fs.writeFile(png, bytes)
    const set = await runMama('icon', 'set', png)
    expect(set.code, set.out).toBe(0)
    expect(set.out).toContain('Set the project\'s icon')
    expect(Buffer.from(await (await fetch(`${origin()}/api/project/${projectId}/icon`)).arrayBuffer())).toEqual(bytes)
    const out = path.join(testEnv.scratchDir, 'mama-icon-out.png')
    expect(await runMama('icon', 'get', out)).toEqual({ code: 0, out: `Saved the project's icon (image/png, ${bytes.length} bytes) to ${out}.\n` })
    expect(await fs.readFile(out)).toEqual(bytes)

    // The largest icon the server takes gets there whole, though its base64
    // runs far past the prompt cap; one byte more is refused before sending.
    const big = path.join(testEnv.scratchDir, 'mama-icon-big.png')
    const largest = Buffer.concat([bytes, Buffer.alloc(512 * 1024 - bytes.length)])
    await fs.writeFile(big, largest)
    expect((await runMama('icon', 'set', big)).code).toBe(0)
    expect(Buffer.from(await (await fetch(`${origin()}/api/project/${projectId}/icon`)).arrayBuffer()).equals(largest)).toBe(true)
    await fs.writeFile(big, Buffer.concat([largest, Buffer.alloc(1)]))
    const refused = await runMama('icon', 'set', big)
    expect(refused.code).toBe(2)
    expect(refused.out).toContain('over the 512 KiB an icon may be')
    const dir = await runMama('icon', 'set', testEnv.scratchDir)
    expect(dir).toEqual({ code: 2, out: `yaac-mama: cannot read ${testEnv.scratchDir}\n` })

    expect((await runMama('icon', 'remove')).out).toContain('Removed the project\'s icon')
    expect((await fetch(`${origin()}/api/project/${projectId}/icon`)).status).toBe(404)
    const none = await runMama('icon', 'get', out)
    expect(none.code).toBe(1)
    expect(none.out).toContain('has no icon (HTTP 422)')
  })

  it('rebases its own diff onto another branch on origin, and refuses one origin lacks', async () => {
    const project = path.join(testEnv.dataDir, 'global', 'projects', projectId)
    const checkout = path.join(project, 'workspaces', workspaceId)
    const { stdout: main } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])
    // The remote is fake, so the branch is planted where a fetch would put
    // it. set-base copies it into the checkout.
    await execFileAsync('git', ['-C', mainClone(), 'update-ref', 'refs/remotes/origin/pr/stacked', 'HEAD'])
    try {
      const usage = await runMama('set-base')
      expect(usage.code).toBe(2)
      const ghost = await runMama('set-base', 'ghost')
      expect(ghost.code).toBe(1)
      expect(ghost.out).toContain('branch "ghost" not found on origin')

      const set = await runMama('set-base', 'pr/stacked')
      expect(set.code).toBe(0)
      const changes = await (await fetch(`${origin()}/api/workspace/${workspaceId}/changes?diff=0`)).json() as WorkspaceChanges
      expect(changes.branch).toBe('pr/stacked')
      expect(changes.comparison?.ref).toBe('origin/pr/stacked')
    } finally {
      expect((await runMama('set-base', main.trim())).code).toBe(0)
      for (const repo of [mainClone(), checkout]) {
        await execFileAsync('git', ['-C', repo, 'update-ref', '-d', 'refs/remotes/origin/pr/stacked'])
      }
    }
  })

  it('spawns a sibling with the create form\u2019s options, never above its own posture', async () => {
    // The caller has the containerless default, which caps its siblings.
    const above = await runMama('create', '--permission-mode', 'bypass', 'x')
    expect(above.code).toBe(1)
    expect(above.out).toContain("more permissive than the caller's ceiling ('accept-edits')")

    const { stdout: branch } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])
    // An effort the model lacks is refused before anything starts.
    const unoffered = await runMama('create', '--model', 'claude-opus-4-6', '--effort', 'xhigh', 'x')
    expect(unoffered.code).toBe(1)
    expect(unoffered.out).toContain('no "xhigh" effort')

    // A brief near the prompt cap, multibyte, from a file, which the agent
    // is launched with.
    const brief = `plan the work\n${'Pläase ✓ the 🙂 step\n'.repeat(4_900)}`
    expect(Buffer.byteLength(brief)).toBeGreaterThan(120 * 1024)
    expect(promptFits(brief)).toBe(true)
    const briefFile = path.join(testEnv.dataDir, 'sibling-brief.md')
    await fs.writeFile(briefFile, brief)
    const made = await runMama(
      'create', '--permission-mode', 'plan', '--effort', 'low', '--ui-mode', 'tui', '--branch', branch.trim(),
      '--prompt-file', briefFile,
    )
    expect(made.code).toBe(0)
    const sibling = made.out.trim()
    try {
      // Recorded whole, as its first conversation's prompt.
      await vi.waitFor(async () => {
        const listed = await (await fetch(`${origin()}/api/workspace/list?project=${projectId}`)).json() as {
          workspaces: Array<{ workspaceId: string; prompt?: string }>
        }
        expect(listed.workspaces.find((w) => w.workspaceId === sibling)?.prompt === brief).toBe(true)
      }, { timeout: 60_000, interval: 500 })
      // The id comes back before launch; wait for the launch command.
      await vi.waitFor(async () => {
        const cmd = await tmux(sibling, 'display', '-p', '-t', 'yaac:claude', '#{pane_start_command}')
        expect(cmd).toContain('--permission-mode plan')
        expect(cmd).toContain('--effort low')
      }, { timeout: 60_000, interval: 500 })
    } finally {
      await runYaac(serverEnv, 'workspace', 'stop', sibling)
    }
  }, 120_000)

  it('makes and manages a routine through the script, never above its own posture', async () => {
    const above = await runMama('routine', 'create', '--name', 'r', '--cron', '@daily', '--permission-mode', 'bypass', 'x')
    expect(above.code).toBe(1)
    expect(above.out).toContain("more permissive than the caller's ceiling ('accept-edits')")
    expect((await runMama('routine', 'frobnicate', 'x')).code).toBe(2)
    expect((await runMama('routine', 'pause')).code).toBe(2)

    const made = await runMama('routine', 'create', '--name', 'Nightly e2e', '--cron', '0 3 * * *', '--tz', 'UTC',
      '--timeout', '30m', 'check the build')
    expect(made.code).toBe(0)
    // The id on stdout, then the note the script sends to stderr.
    const [id, note] = made.out.trim().split('\n')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(note).toMatch(/^note: next runs at about .* 03:00, .*\(UTC\)$/)
    const short = id.slice(0, 8)
    const routine = async () => (await (await fetch(`${origin()}/api/routine/list`)).json() as RoutineEntry[])
      .find((r) => r.id === id)
    try {
      expect(await routine()).toMatchObject({
        name: 'Nightly e2e', prompt: 'check the build', permissionMode: 'accept-edits', timeoutMinutes: 30,
      })
      expect((await runMama('list')).out).toMatch(new RegExp(`${short}\\s+\\S+\\s+Nightly e2e\\s+0 3 \\* \\* \\* \\(UTC\\)`))

      const edited = await runMama('routine', 'edit', '--cron', '0 4 * * *', '--timeout', '15m', short, 'check it twice')
      expect(edited.code).toBe(0)
      expect(edited.out).toContain(`Updated routine ${short} ("Nightly e2e"): 0 4 * * *`)
      expect(await routine()).toMatchObject({ cron: '0 4 * * *', prompt: 'check it twice', timeoutMinutes: 15 })
      expect((await runMama('routine', 'edit', '--timeout', '1h', short)).code).toBe(0)
      expect(await routine()).toMatchObject({ timeoutMinutes: 60 })
      expect((await runMama('routine', 'edit', '--timeout', 'next', short)).code).toBe(0)
      expect((await routine())?.timeoutMinutes).toBeUndefined()
      expect((await runMama('routine', 'pause', short)).out).toContain(`Paused routine ${short}`)
      expect(await routine()).toMatchObject({ paused: true })
      expect((await runMama('routine', 'resume', short)).code).toBe(0)
      expect(await routine()).toMatchObject({ paused: false })
    } finally {
      expect((await runMama('routine', 'delete', short)).code).toBe(0)
    }
    expect(await routine()).toBeUndefined()
  })

  it('attributes a request to the token\u2019s OWN workspace, not the one asking', async () => {
    // Requests never name the caller, so the token alone must decide it:
    // another workspace's token retitles that workspace, not this one.
    const otherId = await createWorkspace()
    try {
      const theirs = await paneEnv(otherId)
      expect(theirs.YAAC_MAMA_TOKEN).not.toBe((await mamaCreds()).YAAC_MAMA_TOKEN)

      const res = await fetch(`${origin()}/api/workspace/mama`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${theirs.YAAC_MAMA_TOKEN}`,
        },
        body: JSON.stringify({ command: 'rename', args: {}, body: 'named by its own token' }),
      })
      expect(res.status).toBe(200)

      const listed = await fetch(`${origin()}/api/workspace/list?project=${NAME}`)
      const body = await listed.json() as {
        workspaces: Array<{ workspaceId: string; title?: string }>
      }
      const byId = new Map(body.workspaces.map((w) => [w.workspaceId, w.title]))
      expect(byId.get(otherId)).toBe('named by its own token')
      expect(byId.get(workspaceId)).not.toBe('named by its own token')
    } finally {
      await runYaac(serverEnv, 'workspace', 'stop', otherId)
    }
  }, 120_000)

  it('refuses a command outside the allowlist, and an unknown token', async () => {
    const denied = await runMama('delete', workspaceId)
    expect(denied.code).toBe(2)
    expect(denied.out).toContain('unknown command')

    // An empty argument (e.g. `stop "$id"` with $id unset) is a usage error,
    // not a self-stop.
    const empty = await runMama('stop', '')
    expect(empty.code).toBe(2)
    expect(empty.out).toContain('omit the workspace to stop yourself')

    // The server itself refuses the command and an unknown token.
    const post = async (token: string, command: string): Promise<number> => {
      const res = await fetch(`${origin()}/api/workspace/mama`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ command, args: {}, body: 'x' }),
      })
      return res.status
    }
    const token = (await mamaCreds()).YAAC_MAMA_TOKEN
    expect(await post(token, 'delete')).toBe(422)
    expect(await post('not-a-real-token', 'list')).toBe(401)
  })

  it('stops a workspace it names, stops ITSELF when it names none, and the stopped one stays readable, findable and restartable', async () => {
    // Its own subject: the self-stop takes down the tmux server the command
    // runs in.
    const doomed = await createWorkspace()
    const theirs = await paneEnv(doomed)
    const conv = await reportClaudeConversation(projectId, doomed)
    const asDoomed = async (...args: string[]): Promise<{ code: number; out: string }> => {
      const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
      const { stdout } = await execFileAsync('sh', ['-c',
        `YAAC_MAMA_URL='${theirs.YAAC_MAMA_URL}' YAAC_MAMA_TOKEN='${theirs.YAAC_MAMA_TOKEN}' `
        + `${path.join(process.cwd(), 'workspace-bin', 'yaac-mama')} ${quoted} 2>&1; echo "EXIT:$?"`,
      ])
      const m = /EXIT:(\d+)\s*$/.exec(stdout)
      if (!m) throw new Error(`no exit marker:\n${stdout}`)
      return { code: Number(m[1]), out: stdout.slice(0, m.index) }
    }

    const missing = await asDoomed('stop', 'no-such-workspace')
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('no workspace')

    // Build output it leaves behind is ignored; notes are only untracked.
    const doomedCheckout = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', doomed)
    await fs.appendFile(path.join(doomedCheckout, '.git', 'info', 'exclude'), '/build-output/\n')
    await fs.mkdir(path.join(doomedCheckout, 'build-output'))
    await fs.writeFile(path.join(doomedCheckout, 'build-output', 'bundle.js'), '')
    await fs.writeFile(path.join(doomedCheckout, 'notes.txt'), '')

    // With no workspace named it stops itself. The reply may not survive,
    // so assert that the tmux server goes away.
    await asDoomed('stop').catch(() => undefined)
    await vi.waitFor(async () => {
      await expect(tmux(doomed, 'has-session', '-t', 'yaac')).rejects.toThrow()
    }, { timeout: 60_000, interval: 250 })
    // A stop keeps the checkout, with its untracked files but not its
    // ignored ones, which go before the tmux server does.
    await expect(fs.stat(path.join(doomedCheckout, 'notes.txt'))).resolves.toBeDefined()
    await expect(fs.stat(path.join(doomedCheckout, 'build-output'))).rejects.toMatchObject({ code: 'ENOENT' })

    // ...and its committed work stays readable: this workspace fetches it
    // into its own checkout, standing in that checkout as an agent does.
    await execFileAsync('git', ['-C', doomedCheckout, '-c', 'user.email=t@t', '-c', 'user.name=T',
      'commit', '--allow-empty', '-qm', 'left behind'])
    const mine = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', workspaceId)
    // As the workspace's agent runs it: with its own YAAC_WORKSPACE_DIR,
    // which tells yaac-mama that `mine` is one of its checkouts.
    const creds = await mamaCreds()
    const mama = (...args: string[]) => execFileAsync(path.join(process.cwd(), 'workspace-bin', 'yaac-mama'), args, {
      cwd: mine,
      env: {
        ...process.env,
        YAAC_MAMA_URL: creds.YAAC_MAMA_URL,
        YAAC_MAMA_TOKEN: creds.YAAC_MAMA_TOKEN,
        YAAC_WORKSPACE_DIR: creds.YAAC_WORKSPACE_DIR,
      },
    })
    const short = doomed.slice(0, 8)
    const { stdout } = await mama('fetch', short)
    expect(stdout).toContain(`yaac/peers/${short}/HEAD`)
    const { stdout: subject } = await execFileAsync('git', ['-C', mine, 'log', '-1', '--format=%s', `yaac/peers/${short}/HEAD`])
    expect(subject.trim()).toBe('left behind')

    // Its conversation history stays readable too. The session's claude
    // conversation runs under the session id; give it a subagent.
    const conversations = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'history', doomed, 'claude', '-workspace')
    await fs.mkdir(path.join(conversations, conv, 'subagents'), { recursive: true })
    await fs.appendFile(path.join(conversations, `${conv}.jsonl`), '{"left":"behind"}\n')
    await fs.writeFile(path.join(conversations, conv, 'subagents', 'agent-e2e.jsonl'), '{"sub":"agent"}\n')
    expect((await mama('history', short)).stdout).toMatch(new RegExp(`${conv}\\s+claude\\s+tui`))
    const printed = (await mama('history', short, conv.slice(0, 12))).stdout
    expect(printed).toContain('{"left":"behind"}\n')
    expect(printed.endsWith('{"sub":"agent"}\n')).toBe(true)
    const saved = path.join(testEnv.scratchDir, `history-of-${short}`)
    const written = (await mama('history', short, '-o', saved)).stdout
    expect(written).toContain(`${saved}/${conv}/${conv}/subagents/agent-e2e.jsonl`)
    expect(await fs.readFile(path.join(saved, conv, conv, 'subagents', 'agent-e2e.jsonl'), 'utf8'))
      .toBe('{"sub":"agent"}\n')

    // It is found by what it was about, and a message waits for a restart.
    await mama('rename', short, 'left behind by the e2e')
    const found = (await mama('list', '--stopped', '--search', 'LEFT BEHIND', '--limit', '5')).stdout
    expect(found).toMatch(new RegExp(`^${short}\\s+claude\\s+\\S+ \\S+\\s+stopped\\s+left behind by the e2e`, 'm'))
    expect((await mama('list', short)).stdout).toContain('Stopped workspaces:')
    // Earlier cases stopped others, so a one-row page leads on to the next.
    const page = (await mama('list', '--stopped', '--limit', '1')).stdout
    const more = /^More: yaac-mama (list --stopped --limit 1 --cursor \S+)$/m.exec(page)?.[1]
    expect(more, page).toBeDefined()
    const next = (await mama(...more!.split(' '))).stdout
    const firstId = /^([0-9a-f]{8})\s/m.exec(page)?.[1]
    expect(next).toMatch(/^[0-9a-f]{8}\s+\S+\s+\S+ \S+\s/m)
    expect(next).not.toMatch(new RegExp(`^${firstId!}\\s`, 'm'))
    const unsent = await runMama('send', short, 'hello')
    expect(unsent.code).toBe(1)
    expect(unsent.out).toContain(`restart it with yaac-mama restart ${short}`)

    // Restarted, it is back on a live tmux server under the same id.
    expect((await mama('restart', short)).stdout).toContain(`Restarting ${short}`)
    try {
      await vi.waitFor(async () => { await tmux(doomed, 'has-session', '-t', 'yaac') }, { timeout: 60_000, interval: 1_000 })
      expect((await mama('list', '--stopped', '--search', 'LEFT BEHIND')).stdout).not.toContain(short)
      const again = await runMama('restart', short)
      expect(again.code).toBe(1)
    } finally {
      await runYaac(serverEnv, 'workspace', 'stop', doomed)
    }
  }, 240_000)

  it('offers yaac\'s builtin skills where the agent\'s own home looks for them', async () => {
    // A pod mounts the skills; here they are symlinked into the project's
    // shared tool roots. Read them the way the agent does, through its
    // config dir.
    const entries = await fs.readdir(builtinSkillsDir(), { withFileTypes: true })
    const names: string[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const hasSkill = await fs.access(path.join(builtinSkillsDir(), e.name, 'SKILL.md'))
        .then(() => true, () => false)
      if (hasSkill) names.push(e.name)
    }
    expect(names.length).toBeGreaterThan(0)

    const home = (await paneEnv(workspaceId)).CLAUDE_CONFIG_DIR ?? ''
    for (const name of names) {
      const viaHome = path.join(home, 'skills', name, 'SKILL.md')
      expect(await fs.readFile(viaHome, 'utf8')).toContain('---')
    }
    // Linked, not copied, so an upgrade reaches every workspace. The target
    // is the built server's install, so only its shape is checked.
    for (const root of sharedSkillRoots(projectId)) {
      const target = await fs.readlink(path.join(root, names[0]))
      expect(target.endsWith(path.join('builtin-skills', names[0]))).toBe(true)
      await expect(fs.access(path.join(target, 'SKILL.md'))).resolves.toBeUndefined()
    }
  })

  it('signs in with a real bundle, then lets a running workspace\'s refresh win', async () => {
    // The credential cycle with no proxy, in the order it happens.
    const projectCreds = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'claude', '.credentials.json')
    const readBundle = async (p: string): Promise<Record<string, unknown>> => {
      const parsed = JSON.parse(await fs.readFile(p, 'utf8')) as { claudeAiOauth: Record<string, unknown> }
      return parsed.claudeAiOauth
    }

    // 1. A sign-in reaches the project home as the real bundle, not a
    //    placeholder (there is no proxy to swap it).
    const signedIn = {
      accessToken: 'sk-ant-oat01-signed-in',
      refreshToken: 'sk-ant-ort01-signed-in',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    }
    await signInTestTool(server, 'claude', { kind: 'oauth', bundle: signedIn })
    expect(await readBundle(projectCreds)).toEqual(signedIn)

    // 2. The agent refreshes its own token in the project home; the
    //    owner's store still has the old one.
    const refreshed = {
      ...signedIn,
      accessToken: 'sk-ant-oat01-refreshed',
      refreshToken: 'sk-ant-ort01-refreshed',
      expiresAt: signedIn.expiresAt + 3_600_000,
    }
    await fs.writeFile(projectCreds, JSON.stringify({ claudeAiOauth: refreshed }, null, 2))

    // 3. Another create must not overwrite it with the stale stored copy,
    //    which would log the running agent out.
    const second = await createWorkspace()
    try {
      expect(await readBundle(projectCreds)).toMatchObject({
        accessToken: 'sk-ant-oat01-refreshed',
        refreshToken: 'sk-ant-ort01-refreshed',
      })
      // The owner's store picks up the refreshed token (`…shed`).
      const listed = await (await makeServerApiClient(server).auth.list.$get()).json()
      expect(listed.toolAuth.find((t) => t.tool === 'claude')).toMatchObject({ kind: 'oauth', keyPreview: '***shed' })
    } finally {
      await runYaac(serverEnv, 'workspace', 'stop', second)
    }
  }, 120_000)

  it('creates a workspace without running what was planted in the main clone or a sibling', async () => {
    // A checkout gets a git dir and config of its own (docs/server-git.md).
    // Plant a filter driver and hooks (each leaves a marker) in the main
    // clone and a sibling; the new checkout must run none of them.
    const gitDir = path.join(mainClone(), '.git')
    const markers = path.join(testEnv.scratchDir, 'planted-markers')
    const hooks = path.join(testEnv.scratchDir, 'planted-hooks')
    const evil = path.join(testEnv.scratchDir, 'planted.sh')
    await fs.mkdir(markers, { recursive: true })
    await fs.mkdir(hooks, { recursive: true })
    await fs.writeFile(evil, `#!/bin/sh\ntouch "${markers}/$1"\ncat\n`)
    await fs.chmod(evil, 0o755)
    for (const hook of ['post-checkout', 'reference-transaction']) {
      await fs.writeFile(path.join(hooks, hook), `#!/bin/sh\n"${evil}" ${hook} </dev/null\n`)
      await fs.chmod(path.join(hooks, hook), 0o755)
    }
    const configPath = path.join(gitDir, 'config')
    const attributesPath = path.join(gitDir, 'info', 'attributes')
    const configBefore = await fs.readFile(configPath, 'utf8')
    const sibling = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', workspaceId, '.git')
    const siblingConfigBefore = await fs.readFile(path.join(sibling, 'config'), 'utf8')
    for (const [key, value] of [
      ['filter.planted.smudge', `"${evil}" smudge`],
      ['filter.planted.clean', `"${evil}" clean`],
      ['core.hooksPath', hooks],
    ]) {
      await execFileAsync('git', ['--git-dir', gitDir, 'config', key, value])
      await execFileAsync('git', ['--git-dir', sibling, 'config', key, value])
    }
    await fs.mkdir(path.dirname(attributesPath), { recursive: true })
    await fs.writeFile(attributesPath, '* filter=planted\n')

    let id: string | undefined
    try {
      id = await createWorkspace()
      const checkout = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', id)
      expect(await fs.readFile(path.join(checkout, 'README.md'), 'utf8')).toBe('# Test repo\n')
      expect(await fs.readdir(markers)).toEqual([])
      await expect(execFileAsync('git', ['-C', checkout, 'config', 'core.hooksPath'])).rejects.toThrow()
    } finally {
      // Remove the planted config before later cases.
      await fs.writeFile(configPath, configBefore)
      await fs.writeFile(path.join(sibling, 'config'), siblingConfigBefore)
      await fs.rm(attributesPath, { force: true })
      if (id !== undefined) await runYaac(serverEnv, 'workspace', 'stop', id)
    }
  }, 120_000)

  // The webapp's new-workspace pane: the title and group are recorded before
  // the prompt, so the auto-title sweep never replaces the title.
  it('creates a workspace titled and filed as the new-workspace pane asks', async () => {
    const res = await fetch(`${origin()}/api/workspace/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: NAME, tool: 'claude', mode: 'tui', prompt: 'a founding ask', title: 'Dialog title',
        group: 'dialog-group',
      }),
    })
    expect(res.status).toBe(200)
    const { workspaceId: id } = await consumeNdjsonStream<{ workspaceId: string }>(res, () => {})
    try {
      const groups = await (await fetch(`${origin()}/api/workspace/group/list?project=${NAME}`)).json() as {
        groups: Array<{ groupId: string; name: string }>
      }
      const group = groups.groups.find((g) => g.name === 'dialog-group')
      expect((await listWorkspaces()).find((w) => w.workspaceId === id))
        .toMatchObject({ title: 'Dialog title', groupId: group?.groupId })
    } finally {
      await runYaac(serverEnv, 'workspace', 'stop', id)
    }
  }, 120_000)

  // A project yaac hosts (docs/hosted-projects.md): made empty with no
  // credential, given its default branch by the first create, pushed to by a
  // workspace's own git through the server as that workspace, seen by its
  // sibling without a fetch, refused to another project's workspace, and
  // cloned by the user.
  it('hosts a new project\'s remote: a workspace pushes through the server and its sibling sees it', async () => {
    const created = await runYaac(cliEnv(), 'project', 'create', 'cl-hosted')
    expect(created.exitCode, created.stderr).toBe(0)
    // The project's id names its workspaces' dirs, its repo's id the remote.
    const { id: hostedId, repos: [{ id: hostedRepo }] } = await (await fetch(`${origin()}/api/project/cl-hosted`))
      .json() as { id: string; repos: Array<{ id: string }> }

    const create = async (): Promise<string> => {
      const res = await fetch(`${origin()}/api/workspace/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'cl-hosted', tool: 'claude', mode: 'tui' }),
      })
      expect(res.status).toBe(200)
      return (await consumeNdjsonStream<{ workspaceId: string }>(res, () => {})).workspaceId
    }
    const pusher = await create()
    const sibling = await create()
    try {
      const checkout = (id: string): string => path.join(testEnv.dataDir, 'global', 'projects', hostedId, 'workspaces', id)
      // The workspace's own git, configured as its launch configured it.
      const wsGit = async (id: string, ...args: string[]): Promise<string> => (await execFileAsync('git', args, {
        cwd: checkout(id),
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: await workspaceEnvVar(id, 'GIT_CONFIG_GLOBAL'),
          GIT_TERMINAL_PROMPT: '0',
        },
      })).stdout
      // Origin names the remote as a pod would; the gitconfig sends it to
      // this server.
      expect((await wsGit(pusher, 'config', 'remote.origin.url')).trim())
        .toBe(`http://yaac.internal/api/workspace/git/${hostedRepo}.git`)
      expect((await wsGit(pusher, 'remote', 'get-url', 'origin')).trim())
        .toBe(`${origin()}/api/workspace/git/${hostedRepo}.git`)

      // The first create pushed an empty commit to the empty repository, so
      // main exists before any workspace pushes, and both start on it.
      expect((await wsGit(sibling, 'rev-parse', '--abbrev-ref', '@{u}')).trim()).toBe('origin/main')
      expect((await wsGit(sibling, 'log', '--format=%s', '@{u}')).trim()).toBe('Initial commit')
      expect((await wsGit(sibling, 'ls-remote', 'origin', 'refs/heads/main')).split('\t')[0])
        .toBe((await wsGit(sibling, 'rev-parse', '@{u}')).trim())

      await fs.writeFile(path.join(checkout(pusher), 'hello.txt'), 'hello\n')
      await wsGit(pusher, 'add', 'hello.txt')
      await wsGit(pusher, 'commit', '-q', '-m', 'hello')
      await wsGit(pusher, 'push', '-q', 'origin', 'HEAD:main')
      const tip = (await wsGit(pusher, 'rev-parse', 'HEAD')).trim()

      // The push lands in the main clone and fans out to running workspaces.
      await vi.waitFor(async () => {
        expect((await wsGit(sibling, 'rev-parse', 'refs/remotes/origin/main')).trim()).toBe(tip)
      }, { timeout: 30_000, interval: 250 })

      // The guard is on by default: a rewrite of main is refused.
      await wsGit(pusher, 'commit', '-q', '--amend', '-m', 'rewritten')
      await expect(wsGit(pusher, 'push', '-q', '--force', 'origin', 'HEAD:main')).rejects.toThrow(/cannot be force-pushed/)

      // Another project's workspace, with its own valid token, is refused.
      const other = await paneEnv(workspaceId)
      const refused = await fetch(`${origin()}/api/workspace/git/${hostedRepo}.git/info/refs?service=git-upload-pack`, {
        headers: { authorization: `Bearer ${other.YAAC_MAMA_TOKEN}` },
      })
      expect(refused.status).toBe(403)

      // The user clones it to this machine.
      const local = path.join(testEnv.scratchDir, 'hosted-local')
      expect((await runYaac(cliEnv(), 'project', 'clone', 'cl-hosted', local)).exitCode).toBe(0)
      expect(await fs.readFile(path.join(local, 'hello.txt'), 'utf8')).toBe('hello\n')
      // A clone made while a project had one repo names the project in its
      // URL, which still answers (docs/legacy-compat-shims.md).
      const { stdout: viaProject } = await execFileAsync('git', ['ls-remote', `${origin()}/api/project/${hostedId}/git`, 'refs/heads/main'])
      const { stdout: viaRepo } = await execFileAsync('git', ['ls-remote', `${origin()}/api/repo/${hostedRepo}/git`, 'refs/heads/main'])
      expect(viaProject).toBe(viaRepo)
      expect(viaRepo).toMatch(/\trefs\/heads\/main\n$/)
    } finally {
      await runYaac(serverEnv, 'workspace', 'stop', pusher)
      await runYaac(serverEnv, 'workspace', 'stop', sibling)
    }
  }, 180_000)

  // In the scheduling project, since a create remembers its tool's mode
  // and the acp cases rely on nothing here having made pi a terminal agent.
  it('launches a terminal agent with its opening message, on the pane\'s terminal', async () => {
    const made = await runYaac(cliEnv(), 'workspace', 'create', SCHED, '--tool', 'pi', '--mode', 'tui', '--prompt', '@notes say hi')
    expect(made.exitCode, made.stderr).toBe(0)
    const id = startedId(made.stdout)
    try {
      // A leading space, so pi does not read the message as a file to attach.
      await vi.waitFor(async () => expect((await sessionArgv(id)).slice(-2)).toEqual(['--', ' @notes say hi']),
        { timeout: 30_000, interval: 250 })
      await new Promise((r) => setTimeout(r, 1000))
      expect((await tmux(id, 'display-message', '-p', '-t', `yaac:${(await firstSession(id)).window}`, '#{pane_dead}')).trim())
        .toBe('0')
    } finally {
      await runYaac(serverEnv, 'workspace', 'stop', id)
    }
  }, 120_000)

  /**
   * The permission mode a TUI agent reports: claude's prompt hook sets a
   * pane option, which the server records. Checked through the
   * `yaac-mama create` ceiling here and the restart below. Runs after the
   * mama cases, since it changes the shared workspace's posture.
   */
  it('follows a mode the agent reports, down and back up past the one it was created in', async () => {
    const settings = JSON.parse(await fs.readFile(
      path.join(testEnv.dataDir, 'global', 'projects', projectId, 'claude', 'settings.json'), 'utf8',
    )) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }
    const command = settings.hooks?.UserPromptSubmit
      ?.flatMap((m) => m.hooks?.map((h) => h.command) ?? [])
      .find((c) => c?.includes('yaac-agent-report'))
    expect(command).toBeDefined()

    // claude runs with $TMUX hidden, so the launch passes it as $YAAC_TMUX.
    // Read it from the running agent's environment.
    const pane = (await tmux(workspaceId, 'display-message', '-p', '-t', 'yaac:claude', '#{pane_id}')).trim()
    const pid = (await tmux(workspaceId, 'display-message', '-p', '-t', 'yaac:claude', '#{pane_pid}')).trim()
    const agentEnv = async (p: string): Promise<string | undefined> => {
      const env = (await processEnv(p)).YAAC_TMUX
      if (env !== undefined) return env
      for (const kid of await childPids(p)) {
        const found = await agentEnv(kid)
        if (found !== undefined) return found
      }
      return undefined
    }
    const yaacTmux = await agentEnv(pid)
    expect(yaacTmux?.split(',')[0]).toBe(sockFor(workspaceId))

    const binDir = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'sessions', workspaceId, 'bin')
    // Run the registered command through `sh -c`, as claude does.
    const prompt = (permissionMode: string, effort?: string): Promise<string> => new Promise((resolve, reject) => {
      const child = execFile('sh', ['-c', command ?? ''], {
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          TMUX: '',
          TMUX_PANE: pane,
          YAAC_TMUX: yaacTmux ?? '',
        },
      }, (err, out) => (err ? reject(err instanceof Error ? err : new Error('hook failed')) : resolve(out)))
      child.stdin?.end(JSON.stringify({
        session_id: workspaceId, hook_event_name: 'UserPromptSubmit', prompt: 'go', permission_mode: permissionMode,
        ...(effort !== undefined ? { effort: { level: effort } } : {}),
      }))
    })
    const ceiling = async (): Promise<string> => (await runMama('create', '--permission-mode', 'bypass', 'x')).out

    // Switch to plan, reported with the next prompt. The hook must print
    // nothing: UserPromptSubmit output goes to the model.
    expect(await prompt('plan')).toBe('')
    expect((await tmux(workspaceId, 'show-options', '-p', '-t', pane, '-v', '@yaac-permission-mode')).trim())
      .toBe('plan')
    await vi.waitFor(async () => {
      expect(await ceiling()).toContain("more permissive than the caller's ceiling ('plan')")
    }, { timeout: 30_000, interval: 500 })

    // A move above the created posture is recorded too, and left for the
    // restart case, as is an `/effort` reported with the same prompt.
    await prompt('auto', 'max')
    await vi.waitFor(async () => {
      expect(await ceiling()).toContain("more permissive than the caller's ceiling ('auto')")
    }, { timeout: 30_000, interval: 500 })
    expect((await tmux(workspaceId, 'show-options', '-p', '-t', pane, '-v', '@yaac-effort')).trim()).toBe('max')
    await vi.waitFor(async () => {
      const { workspaces } = await (await fetch(`${origin()}/api/workspace/list`)).json() as {
        workspaces: Array<{ workspaceId: string; sessions: SessionEntry[] }>
      }
      expect(workspaces.find((w) => w.workspaceId === workspaceId)?.sessions[0]?.effort).toBe('max')
    }, { timeout: 30_000, interval: 500 })
  }, 120_000)

  it('stops the timed workspace at its deadline, starting its child, and starts the scheduled one', async () => {
    const stoppedAs = async (): Promise<string> =>
      (await runYaac(cliEnv(), 'workspace', 'list', SCHED, '--stopped')).stdout
    await vi.waitFor(async () => {
      expect(await stoppedAs()).toMatch(new RegExp(`${timedId.slice(0, 8)}.*timed out`))
    }, { timeout: 180_000, interval: 2_000 })
    await vi.waitFor(async () => {
      const prompts = (await listWorkspaces()).map((w) => w.prompt)
      expect(prompts).toContain('after the timeout')
      expect(prompts).toContain('scheduled start')
    }, { timeout: 180_000, interval: 2_000 })

    // A restart clears the timeout unless it sets one, counted from the restart.
    const restarted = await runYaac(cliEnv(), 'workspace', 'restart', timedId, '--timeout', '1h')
    expect(restarted.exitCode, restarted.stderr).toBe(0)
    const deadline = (await listWorkspaces()).find((w) => w.workspaceId === timedId)?.deadline ?? ''
    expect(new Date(deadline).getTime()).toBeGreaterThan(Date.now() + 55 * 60_000)
    for (const w of await listWorkspaces()) {
      if (w.projectId !== projectId) await runYaac(serverEnv, 'workspace', 'stop', w.workspaceId)
    }
  }, 400_000)

  it('runs a routine now, filed in its group and stopped at its next tick', async () => {
    const created = await runYaac(cliEnv(), 'routine', 'create', SCHED, '--name', 'Half-hourly sweep', '--cron', '*/30 * * * *',
      '--prompt', 'sweep', '--tool', 'claude', '--mode', 'tui')
    expect(created.exitCode, created.stderr).toBe(0)
    const routineId = /Created routine ([0-9a-f-]{36})/.exec(created.stdout)?.[1] ?? ''
    const routine = ((await (await fetch(`${origin()}/api/routine/list`)).json()) as Array<{
      id: string; groupId?: string; nextRuns: string[]
    }>).find((r) => r.id === routineId)
    const nextTick = new Date(routine?.nextRuns[0] ?? '').getTime()

    const ran = await runYaac(cliEnv(), 'routine', 'run', routineId.slice(0, 8))
    expect(ran.exitCode, ran.stderr).toBe(0)
    const runId = /Started workspace ([0-9a-f-]{36})/.exec(ran.stdout)?.[1] ?? ''
    await vi.waitFor(async () => {
      const run = (await listWorkspaces()).find((w) => w.workspaceId === runId)
      expect(run).toMatchObject({ routineId, groupId: routine?.groupId })
      // Exactly the next tick, however close to it the run started.
      expect(new Date(run?.deadline ?? '').getTime()).toBe(nextTick)
    }, { timeout: 60_000, interval: 500 })
    await runYaac(serverEnv, 'workspace', 'stop', runId)
    await runYaac(cliEnv(), 'routine', 'delete', routineId)
  }, 120_000)

  // Destroys its subject — keep last.
  it('stops the workspace by taking its tmux server down, with what its panes started and detached from', async () => {
    // Here scratch dirs live in the checkout, and stop removes them
    // (checked in the next case).
    const checkout = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', workspaceId)
    await fs.mkdir(path.join(checkout, 'node_modules', 'left-pad'), { recursive: true })

    // A window that leaves two things running after it closes: a daemon in
    // a session of its own, and a tmux server of its own with a pane. Init
    // adopts both, so no parent link leads back to the workspace.
    const pidFile = path.join(testEnv.scratchDir, 'detached.pids')
    // In the OS temp dir: the scratch dir is too long for a socket path.
    const ownSockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-own-tmux-'))
    const ownSock = path.join(ownSockDir, 's')
    let detached: number[] = []
    const alive = (): number[] => detached.filter((pid) => {
      try {
        return process.kill(pid, 0)
      } catch {
        return false
      }
    })
    try {
      await tmux(workspaceId, 'new-window', '-d', '-t', '=yaac:',
        `setsid nohup sh -c 'echo $$ >> ${pidFile}; exec sleep 100000' >/dev/null 2>&1 & `
        + `tmux -S ${ownSock} -f /dev/null new-session -d 'sleep 100001'; `
        + `tmux -S ${ownSock} display-message -p '#{pid} #{pane_pid}' >> ${pidFile}`)
      await vi.waitFor(async () => {
        detached = (await fs.readFile(pidFile, 'utf8')).trim().split(/\s+/).map(Number)
        expect(detached).toHaveLength(3)
      }, { timeout: 20_000, interval: 250 })
      expect(alive()).toEqual(detached)

      const { exitCode } = await runYaac(serverEnv, 'workspace', 'stop', workspaceId)
      expect(exitCode).toBe(0)
      // Polled: teardown is detached, so the kill can land after `stop`
      // returns.
      await vi.waitFor(
        async () => { await expect(tmux(workspaceId, 'has-session', '-t', 'yaac')).rejects.toThrow() },
        { timeout: 20_000, interval: 250 },
      )
      // The teardown removes the scratch dirs last, so by then it has
      // waited for everything the workspace started to exit. That needs
      // the systemd slice a launch asks for, which not every host can give.
      const contained = await execFileAsync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'])
        .then(() => true, () => false)
      await vi.waitFor(
        async () => { await expect(fs.stat(path.join(checkout, 'node_modules'))).rejects.toThrow() },
        { timeout: 20_000, interval: 50 },
      )
      if (contained) expect(alive()).toEqual([])
    } finally {
      for (const pid of alive()) process.kill(pid, 'SIGKILL')
      await fs.rm(ownSockDir, { recursive: true, force: true })
    }
  }, 90_000)

  it('leaves the checkout behind, and stays stopped rather than flickering back', async () => {
    const dir = path.join(
      testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', workspaceId,
    )
    await expect(fs.stat(dir)).resolves.toBeDefined()
    // Without its scratch dirs, which would otherwise be a full copy of
    // every dependency. Polled, since teardown is detached.
    await vi.waitFor(
      async () => { await expect(fs.stat(path.join(dir, 'node_modules'))).rejects.toThrow() },
      { timeout: 20_000, interval: 250 },
    )

    // A workspace the driver failed to forget would reappear as
    // "stopping…" on each stale-reaper pass. A status watcher left running
    // for it would keep re-dialling its socket, and an attach to a dead
    // socket starts a tmux server there, leaving the socket file behind.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1_000))
      expect((await listWorkspaces()).map((w) => w.workspaceId)).not.toContain(workspaceId)
      await expect(fs.stat(sockFor(workspaceId))).rejects.toThrow()
    }
    const log = await fs.readFile(serverLogPath(), 'utf8')
    const afterStop = log.slice(log.lastIndexOf(`session teardown: session=${workspaceId}`))
    expect(afterStop).toContain(workspaceId)
    expect(afterStop).not.toContain(`status-watcher ${workspaceId}`)
  }, 60_000)

  it('still reads the checkout\'s files once the workspace is stopped, but lists them only while it runs', async () => {
    const res = await fetch(`${origin()}/api/workspace/${workspaceId}/file?path=notes/todo.md`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ path: 'notes/todo.md', content: 'mine\n' })
    // Listing runs git inside the workspace, so it needs it running.
    expect((await fetch(`${origin()}/api/workspace/${workspaceId}/changes?listing=paths`)).status).toBe(409)
  })

  // The launch updates the checkout's `origin/*` from the main clone.
  it('restarts the stopped workspace back onto a live tmux server', async () => {
    const repoGit = path.join(mainClone(), '.git')
    const checkout = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', workspaceId)
    const base = (await execFileAsync('git', ['--git-dir', repoGit, 'symbolic-ref', 'refs/remotes/origin/HEAD'])).stdout.trim()
    const upstream = (await execFileAsync('git', [
      '--git-dir', repoGit, 'commit-tree', '-p', base, '-m', 'upstream', `${base}^{tree}`,
    ], { env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } })).stdout.trim()
    await execFileAsync('git', ['--git-dir', repoGit, 'update-ref', base, upstream])
    // History a pod leaves in the workspace's `history/`, which this host
    // reaches through links (docs/workspace-storage.md, "Agent history").
    const project = path.join(testEnv.dataDir, 'global', 'projects', projectId)
    const history = path.join(project, 'history', workspaceId)
    const rollout = path.join('2026', '09', '29', 'rollout-2026-09-29T08-32-40-pod-thread.jsonl')
    for (const [file, body] of [
      [path.join(history, 'claude', '-workspace', 'pod-conv.jsonl'), '{"from":"the pod"}\n'],
      [path.join(history, 'claude-file-history', 'pod-conv', 'edit@v1'), 'before\n'],
      [path.join(history, 'codex', rollout), '{"type":"session_meta","payload":{"id":"pod-thread"}}\n'],
    ]) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, body)
    }

    const { stdout, stderr, exitCode } = await runYaac(
      serverEnv, 'workspace', 'restart', workspaceId,
    )
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
    const windows = await tmux(workspaceId, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')
    expect(windows).toContain('claude')
    // Relaunched in the last reported posture and effort (auto and max, from
    // the case above).
    await vi.waitFor(async () => {
      const command = await tmux(workspaceId, 'display', '-p', '-t', 'yaac:claude', '#{pane_start_command}')
      expect(command).toContain('--permission-mode auto')
      expect(command).toContain('--effort max')
    }, { timeout: 30_000, interval: 250 })

    expect((await fs.stat(path.join(checkout, '.git'))).isDirectory()).toBe(true)
    expect(await fs.readFile(path.join(checkout, '.git', 'objects', 'info', 'alternates'), 'utf8'))
      .toBe(`${path.join(repoGit, 'objects')}\n`)
    await expect(execFileAsync('git', ['-C', checkout, 'status', '--porcelain']))
      .resolves.toBeDefined()
    expect((await execFileAsync('git', ['-C', checkout, 'rev-parse', base])).stdout.trim())
      .toBe(upstream)
    const { listing: files } = await (
      await fetch(`${origin()}/api/workspace/${workspaceId}/changes?diff=0&listing=paths`)
    ).json() as WorkspaceChanges
    expect(files?.paths).toEqual(expect.arrayContaining(['README.md', 'notes/todo.md']))

    // The pod's conversations resume here: claude's project folder for this
    // checkout links to the history, and each file-history dir and rollout
    // is linked where its tool looks.
    const projects = path.join(project, 'claude', 'projects')
    const linked: string[] = []
    for (const name of await fs.readdir(projects)) {
      const real = await fs.realpath(path.join(projects, name)).catch(() => '')
      if (real === await fs.realpath(path.join(history, 'claude', '-workspace'))) linked.push(name)
    }
    expect(linked.length).toBeGreaterThan(0)
    expect(await fs.readFile(path.join(projects, linked[0], 'pod-conv.jsonl'), 'utf8')).toBe('{"from":"the pod"}\n')
    expect(await fs.readFile(path.join(project, 'claude', 'file-history', 'pod-conv', 'edit@v1'), 'utf8')).toBe('before\n')
    expect((await fs.lstat(path.join(project, 'codex', 'sessions', rollout))).isSymbolicLink()).toBe(true)
    await runYaac(serverEnv, 'workspace', 'stop', workspaceId)
  }, 180_000)
  // codex conversations are known only through its hook: the title
  // session fires the same hook, a resume fires none until the next turn,
  // and an unprompted workspace has no conversation.
  it('keeps resuming a codex conversation across restarts, and starts one never prompted anew', async () => {
    const launches = async (id: string): Promise<string[]> => (await fs.readFile(
      path.join(testEnv.dataDir, 'global', 'projects', projectId, 'codex', `launches-${id}`), 'utf8',
    ).catch(() => '')).split('\n').filter(Boolean)
    const codexSessions = async (id: string) => (await listWorkspaces())
      .find((w) => w.workspaceId === id)?.conversations.filter((s) => s.tool === 'codex' && s.active) ?? []
    const restart = async (id: string): Promise<void> => {
      const { stdout, stderr, exitCode } = await runYaac(serverEnv, 'workspace', 'restart', id)
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
    }

    // Launched with its prompt, whose first turn reports the conversation.
    const prompted = await createWorkspaceWith('codex', '--prompt', 'hello')
    let thread = ''
    await vi.waitFor(async () => {
      thread = (await codexSessions(prompted)).find((s) => s.conversationId.startsWith('thread-'))?.conversationId ?? ''
      expect(thread).not.toBe('')
    }, { timeout: 30_000, interval: 250 })

    // Restart twice with no turn between. A resume reports nothing, so the
    // launch must record the conversation itself for the second restart to
    // find it. The title session must not take its place. Each resume keeps
    // the model the workspace launched on.
    const model = (await launches(prompted))[0]?.match(/ --model (\S+) -- hello$/)?.[1] ?? ''
    expect(model).not.toBe('')
    for (const n of [2, 3]) {
      await restart(prompted)
      await vi.waitFor(async () => {
        expect((await launches(prompted))).toHaveLength(n)
        expect((await launches(prompted)).at(-1)).toMatch(new RegExp(` resume ${thread} --model ${model.replaceAll('.', '\\.')}$`))
        const active = await codexSessions(prompted)
        expect(active.map((s) => s.conversationId)).toEqual([thread])
        // Its session is back on it, with a live status.
        const [session] = (await listWorkspaces()).find((w) => w.workspaceId === prompted)?.sessions ?? []
        expect(session?.conversationId).toBe(thread)
        expect(session?.status).toBeDefined()
      }, { timeout: 30_000, interval: 250 })
    }

    // An unprompted workspace has nothing to resume, and a bad
    // `resume` would kill the window.
    const unprompted = await createWorkspaceWith('codex')
    await restart(unprompted)
    await vi.waitFor(async () => {
      expect(await launches(unprompted)).toHaveLength(2)
    }, { timeout: 30_000, interval: 250 })
    expect((await launches(unprompted)).at(-1)).not.toContain('resume')
    expect(await tmux(unprompted, 'list-windows', '-t', 'yaac', '-F', '#{window_name}')).toContain('codex')

    await runYaac(serverEnv, 'workspace', 'stop', prompted)
    await runYaac(serverEnv, 'workspace', 'stop', unprompted)
  }, 180_000)
})

/**
 * Two teammates on one install (docs/multi-user.md). Runs last: it restarts
 * the file's server in tailnet mode, which refuses every loopback CLI call
 * the cases above make. The built-in user, owner of everything above,
 * becomes alice; bob arrives through serve with nothing of his own.
 * Containerless separates no credentials from the other workspaces, so what
 * is checked is ownership: who may read, attach and write, that each
 * project's tool home is seeded from its own owner's sign-in, and whose
 * projects the CLI acts on.
 */
describe.skipIf(!CAN_RUN)('two users on a tailnet install', () => {
  const HOST = 'srv.tailnet.ts.net'
  const ALICE = asTailnet('alice@example.com', HOST)
  const BOB = asTailnet('bob@example.com', HOST)
  const BOB_PROJECT = 'bob-demo'
  const BOB_TOKEN = 'sk-ant-oat01-bob-b0b5'
  let bobProjectId = ''
  let bobWorkspace = ''

  const as = (who: Record<string, string>, route: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${origin()}/api${route}`, {
      ...init,
      headers: { ...who, 'content-type': 'application/json', ...init.headers as Record<string, string> },
    })

  /** The claude bundle seeded into a project's shared tool home. */
  const projectClaudeToken = async (id: string): Promise<unknown> =>
    (JSON.parse(await fs.readFile(
      path.join(testEnv.dataDir, 'global', 'projects', id, 'claude', '.credentials.json'), 'utf8',
    )) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken

  beforeAll(async () => {
    await restartServer({
      ...serverEnv,
      YAAC_ACCESS_MODE: 'tailnet',
      YAAC_ACCESS_ADMINS: 'alice@example.com',
      YAAC_ALLOWED_HOSTS: HOST,
    })

    // Bob's own project, credentials and identity, all set as bob.
    const repo = await createTestRepo(path.join(testEnv.scratchDir, BOB_PROJECT))
    bobProjectId = await addTestProject(server, repo, {
      remoteUrl: `https://github.com/bob/${BOB_PROJECT}.git`, headers: BOB,
    })
    await assignTestGitCredential(server, bobProjectId, 'ghp_bob', 'bob token', BOB)
    await signInTestTool(server, 'claude', {
      kind: 'oauth',
      bundle: {
        accessToken: BOB_TOKEN, refreshToken: 'sk-ant-ort01-bob',
        expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'], subscriptionType: 'pro',
      },
    }, BOB)
    expect((await as(BOB, '/config/git-identity', {
      method: 'PUT', body: JSON.stringify({ name: 'Bob', email: 'bob@example.com' }),
    })).status).toBe(200)
    const res = await as(BOB, '/workspace/create', {
      method: 'POST', body: JSON.stringify({ project: bobProjectId, tool: 'claude', mode: 'tui' }),
    })
    expect(res.status).toBe(200)
    bobWorkspace = (await consumeNdjsonStream<{ workspaceId: string }>(res, () => {})).workspaceId
  }, 180_000)

  it('makes the built-in user alice, and bob a user of his own', async () => {
    const alice = await (await as(ALICE, '/whoami')).json() as { userId: string; users: Array<{ login: string }> }
    const bob = await (await as(BOB, '/whoami')).json() as { userId: string }
    expect(alice.userId).toBe('00000000-0000-0000-0000-000000000000')
    expect(bob.userId).not.toBe(alice.userId)
    expect(alice.users.map((u) => u.login).sort()).toEqual(['alice@example.com', 'bob@example.com'])
    // Loopback is refused now, bar a workspace's own yaac-mama, which acts
    // as its project's owner.
    expect((await fetch(`${origin()}/api/whoami`)).status).toBe(401)
    const mama = await execFileAsync(path.join(process.cwd(), 'workspace-bin', 'yaac-mama'), ['list'], {
      cwd: path.join(testEnv.dataDir, 'global', 'projects', bobProjectId, 'workspaces', bobWorkspace),
      env: {
        ...process.env,
        YAAC_MAMA_URL: await workspaceEnvVar(bobWorkspace, 'YAAC_MAMA_URL'),
        YAAC_MAMA_TOKEN: await workspaceEnvVar(bobWorkspace, 'YAAC_MAMA_TOKEN'),
      },
    })
    expect(mama.stdout).toContain(bobWorkspace.slice(0, 8))
  })

  it('seeds each project\'s tool home from its own owner\'s sign-in', async () => {
    expect(await projectClaudeToken(bobProjectId)).toBe(BOB_TOKEN)
    expect(await projectClaudeToken(projectId)).not.toBe(BOB_TOKEN)
    const listed = async (who: Record<string, string>): Promise<unknown> =>
      ((await (await as(who, '/auth/list')).json()) as { toolAuth: Array<{ tool: string; keyPreview: string }> })
        .toolAuth.find((t) => t.tool === 'claude')?.keyPreview
    expect(await listed(BOB)).toBe('***b0b5')
    expect(await listed(ALICE)).toBe('***shed')
  })

  it('lets bob read alice\'s transcript, but not attach to or write her workspace', async () => {
    // Her workspace is stopped by now. A claude in its shell reported this
    // conversation, and its restart moved the transcript into its history.
    const conv = 'e2e-conv'
    const conversation = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'history', workspaceId,
      'claude', '-workspace', `${conv}.jsonl`)
    await expect(fs.stat(conversation)).resolves.toBeDefined()
    await fs.appendFile(conversation, JSON.stringify({
      type: 'user', uuid: 'u-two-users', parentUuid: null, sessionId: conv, cwd: '/workspace',
      timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'for bob to read' },
    }) + '\n')
    const sessions = await as(BOB, `/workspace/${workspaceId}/conversations`)
    expect(sessions.status).toBe(200)
    expect((await sessions.json() as Array<{ conversationId: string }>).map((s) => s.conversationId))
      .toContain(conv)
    const transcript = await as(BOB, `/workspace/${workspaceId}/conversations/${conv}/transcript`)
    expect(transcript.status).toBe(200)
    expect(JSON.stringify(await transcript.json())).toContain('for bob to read')

    const upgrade = (who: Record<string, string>, id: string): Promise<number> => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(server.lock.port)}/api/pty/attach?id=${id}`, { headers: who })
      ws.once('open', () => { ws.close(); resolve(101) })
      ws.once('unexpected-response', (_req, res) => { ws.terminate(); resolve(res.statusCode ?? 0) })
      ws.once('error', reject)
    })
    expect(await upgrade(BOB, workspaceId)).toBe(403)
    expect(await upgrade(ALICE, workspaceId)).toBe(101)
    expect(await upgrade(BOB, bobWorkspace)).toBe(101)

    const save = await as(BOB, `/workspace/${workspaceId}/file`, {
      method: 'PUT', body: JSON.stringify({ path: 'from-bob.txt', content: 'hi', baseVersion: null }),
    })
    expect(save.status).toBe(403)
    const checkout = path.join(testEnv.dataDir, 'global', 'projects', projectId, 'workspaces', workspaceId)
    await expect(fs.stat(path.join(checkout, 'from-bob.txt'))).rejects.toThrow()
    // Nor may he start one in her project.
    expect((await as(BOB, '/workspace/create', {
      method: 'POST', body: JSON.stringify({ project: projectId, tool: 'claude', mode: 'tui' }),
    })).status).toBe(403)
  }, 60_000)

  it('lets alice follow bob\'s running conversation as claude writes it, without driving it', async () => {
    const conv = await reportClaudeConversation(bobProjectId, bobWorkspace, BOB)
    const conversation = path.join(testEnv.dataDir, 'global', 'projects', bobProjectId, 'history', bobWorkspace,
      'claude', '-workspace', `${conv}.jsonl`)
    const line = (uuid: string, parentUuid: string | null, content: string): string => JSON.stringify({
      type: 'user', uuid, parentUuid, sessionId: conv, cwd: '/workspace',
      timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content },
    }) + '\n'
    await fs.mkdir(path.dirname(conversation), { recursive: true })
    await fs.appendFile(conversation, line('u-bob-1', null, 'for alice to follow'))

    const frames: Array<{ type: string }> = []
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(server.lock.port)}/api/acp/observe?id=${bobWorkspace}&session=${conv}`, { headers: ALICE },
    )
    ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8')) as { type: string }))
    try {
      await vi.waitFor(() => expect(JSON.stringify(frames), 'what alice was sent').toMatch(/"hello".*for alice to follow/),
        { timeout: 15_000, interval: 100 })
      expect(frames.find((f) => f.type === 'hello')).toMatchObject({ history: true })
      await fs.appendFile(conversation, line('u-bob-2', 'u-bob-1', 'and this, as it happens'))
      await vi.waitFor(() => expect(JSON.stringify(frames.filter((f) => f.type === 'event'))).toContain('and this, as it happens'),
        { timeout: 15_000, interval: 100 })
    } finally {
      ws.close()
    }
  }, 60_000)

  /**
   * The CLI's environment as `who`: a loopback proxy that plays tailscale
   * serve, adding `who`'s identity to every request. Closed when the test
   * ends.
   */
  async function cliAs(who: Record<string, string>): Promise<NodeJS.ProcessEnv> {
    const proxy = http.createServer((req, res) => {
      const upstream = http.request({
        host: '127.0.0.1', port: server.lock.port, path: req.url, method: req.method,
        headers: { ...req.headers, ...who },
      }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      })
      req.pipe(upstream)
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => new Promise<void>((resolve) => { proxy.close(() => resolve()) }))
    return { ...cliEnv(), YAAC_SERVER_URL: `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}` }
  }

  // Last in the file: it stops bob's workspace.
  it('scopes the CLI to the caller\'s projects, and to a teammate\'s with --user, and shares a hosted repo between them', async () => {
    const [alice, bob] = await Promise.all([cliAs(ALICE), cliAs(BOB)])

    // Alice's hosted project, whose repo she shares with bob, who links it
    // into a project of his own under the same name.
    expect((await runYaac(alice, 'project', 'create', 'shared-app')).exitCode).toBe(0)
    const projects = await (await as(ALICE, '/project/list')).json() as Array<{ name: string; repos: Array<{ id: string }> }>
    const repoId = projects.find((p) => p.name === 'shared-app')!.repos[0].id
    const shared = await runYaac(alice, 'repo', 'share', 'shared-app/shared-app', 'bob@example.com')
    expect(shared.exitCode, shared.stderr).toBe(0)
    expect(shared.stdout).toContain(`Repo ${repoId.slice(0, 8)} is now shared with bob@example.com`)
    // The table cuts its last column to the terminal's width, so only the
    // start of the login is sure to show.
    expect((await runYaac(alice, 'repo', 'list')).stdout).toMatch(new RegExp(`${repoId.slice(0, 8)}.*with bob@`))
    expect((await runYaac(bob, 'repo', 'list')).stdout).toMatch(new RegExp(`${repoId.slice(0, 8)}.*by alice@`))
    // Only its owner shares it on.
    expect((await runYaac(bob, 'repo', 'share', repoId, 'alice@example.com')).exitCode).not.toBe(0)
    expect((await runYaac(bob, 'project', 'create', 'shared-app')).exitCode).toBe(0)
    const linked = await runYaac(bob, 'project', 'repo', 'add', 'shared-app', '--repo-id', repoId, '--dir', 'upstream')
    expect(linked.exitCode, linked.stderr).toBe(0)
    expect(linked.stdout).toContain(`Project "shared-app" now links repo ${repoId} in the folder upstream.`)

    const own = await runYaac(alice, 'project', 'list')
    expect(own.stdout).toContain(NAME)
    expect(own.stdout).not.toContain(BOB_PROJECT)
    // Before or after the command, by login or display name.
    for (const args of [['--user', 'bob@example.com', 'project', 'list'], ['project', 'list', '--user', 'bob']]) {
      const bobs = await runYaac(alice, ...args)
      expect(bobs.stdout).toContain(BOB_PROJECT)
      expect(bobs.stdout).toContain('shared-app')
      expect(bobs.stdout).not.toContain(NAME)
    }

    // The name picks each caller's own project; in bob's, --repo names
    // alice's repo beside his own.
    for (const [env, who, repo] of [[alice, 'alice', []], [bob, 'bob', ['--repo', 'upstream']]] as const) {
      const dir = path.join(testEnv.scratchDir, `shared-app-${who}`)
      const cloned = await runYaac(env, 'project', 'clone', 'shared-app', dir, ...repo)
      expect(cloned.exitCode, cloned.stderr).toBe(0)
      expect((await execFileAsync('git', ['-C', dir, 'remote', 'get-url', 'origin'])).stdout.trim()).toContain(`/api/repo/${repoId}/git`)
    }

    // Unsharing ends bob's use of the repo; his project keeps its link.
    const unshared = await runYaac(alice, 'repo', 'unshare', repoId, 'bob')
    expect(unshared.exitCode, unshared.stderr).toBe(0)
    expect(unshared.stdout).toContain(`Repo ${repoId.slice(0, 8)} is no longer shared with bob`)
    expect((await runYaac(bob, 'repo', 'list')).stdout).not.toContain(repoId.slice(0, 8))
    expect((await runYaac(bob, 'project', 'repo', 'list', 'shared-app')).stdout).toMatch(/upstream\s+\S+\s+\(none needed\)/)

    const group = await as(BOB, '/workspace/group/create', {
      method: 'POST', body: JSON.stringify({ projectId: bobProjectId, name: 'bob-group' }),
    })
    expect(group.status).toBe(200)
    expect((await runYaac(alice, 'group', 'list')).stdout).not.toContain('bob-group')
    expect((await runYaac(alice, 'group', 'list', '--user', 'bob@example.com')).stdout).toContain('bob-group')

    const id8 = bobWorkspace.slice(0, 8)
    expect((await runYaac(alice, 'workspace', 'list')).stdout).not.toContain(id8)
    expect((await runYaac(alice, 'workspace', 'list', BOB_PROJECT, '--user', 'bob@example.com')).stdout).toContain(id8)
    const notMine = await runYaac(alice, 'workspace', 'list', BOB_PROJECT)
    expect(notMine.exitCode).toBe(1)
    expect(notMine.stderr).toContain(`You have no project ${BOB_PROJECT}; pass --user <user> for a teammate's.`)
    // A full id names anyone's project.
    expect((await runYaac(alice, 'workspace', 'list', bobProjectId)).stdout).toContain(id8)

    const nobody = await runYaac(alice, '--user', 'carol@example.com', 'project', 'list')
    expect(nobody.exitCode).toBe(1)
    expect(nobody.stderr).toContain('No user "carol@example.com" on this server')

    // The stopped listing pages through the scoped user's projects alone.
    expect((await as(BOB, '/workspace/stop', { method: 'POST', body: JSON.stringify({ workspaceId: bobWorkspace }) })).status)
      .toBe(200)
    await vi.waitFor(async () => {
      expect((await runYaac(alice, 'workspace', 'list', '-s', '--user', 'bob@example.com')).stdout).toContain(id8)
    }, { timeout: 60_000, interval: 2000 })
    expect((await runYaac(alice, 'workspace', 'list', '-s')).stdout).not.toContain(id8)
  }, 180_000)
})
