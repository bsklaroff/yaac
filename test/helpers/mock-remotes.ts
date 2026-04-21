import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { podmanRetry, removeContainer } from '@test/helpers/setup'
import { createAndStartContainerWithRetry, execFileAsync } from '@/lib/container/runtime'

/**
 * Mock LLM + mock git-over-HTTP servers that stand in for the real Anthropic,
 * OpenAI, and GitHub remotes when the proxy's upstream-redirect feature
 * reroutes them. Both run in containers on a podman network (usually the
 * test's proxy network) so the proxy can reach them by IP.
 *
 * Pairing: production traffic flows
 *   session container → HTTPS_PROXY → proxy sidecar (MITM + inject creds)
 *     → https.request(api.anthropic.com)
 * Test traffic flows the same path, but the proxy's upstreamRedirects map
 * swaps the final hop to `mockLLM.networkIp:mockLLM.port` (plain HTTP —
 * mocks don't speak TLS).
 */

const MOCK_LLM_PORT = 9100
const MOCK_GIT_PORT = 9101

export interface MockLLM {
  readonly containerName: string
  readonly networkIp: string
  readonly port: number
  /** Fetch every request the mock has seen, oldest first. */
  transcript(): Promise<MockLLMEntry[]>
  stop(): Promise<void>
}

export interface MockLLMEntry {
  method: string
  url: string
  body: string
  headers: Record<string, string | string[] | undefined>
}

export interface MockGit {
  readonly containerName: string
  readonly networkIp: string
  readonly port: number
  /** Host-side directory containing one bare repo per test (e.g. `repo-demo.git`). */
  readonly reposDir: string
  stop(): Promise<void>
}

/**
 * Resolve the `yaac-test-base` image tag. The image is pre-built by
 * `test/global-setup.ts`; we pick the first `yaac-test-base:*` tag (excluding
 * the `-nestable` variant). Tests that need it without a fresh build should
 * already have it present.
 */
async function resolveTestBaseImage(): Promise<string> {
  const { stdout } = await podmanRetry([
    'images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=yaac-test-base',
  ])
  const tags = stdout.trim().split('\n').filter(Boolean).filter((t) => !t.includes('test-base-nestable'))
  if (tags.length === 0) {
    throw new Error('yaac-test-base image missing — did global-setup.ts run?')
  }
  return tags[0]
}

const MOCK_LLM_SCRIPT = `
  const http = require('http');
  const fs = require('fs');
  const TRANSCRIPT = '/tmp/transcript.ndjson';
  fs.writeFileSync(TRANSCRIPT, '');

  // Minimal Anthropic SSE response: enough for claude-code to parse a single
  // assistant turn and exit cleanly. Not a full conversation — tests that
  // need tool-use etc. should ship a tailored mock.
  // Usage shape must include every field claude-code dereferences — a
  // missing input_tokens on message_delta produced a silent crash in the
  // CLI (undefined is not an object) and a tmux exit.
  function usage(input, output) {
    return {
      input_tokens: input,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: output,
    };
  }

  function anthropicSSE(text) {
    const messageId = 'msg_mock_' + Math.random().toString(36).slice(2, 10);
    const parts = [
      ['message_start', { type: 'message_start', message: {
        id: messageId, type: 'message', role: 'assistant',
        model: 'claude-3-5-sonnet-20241022', content: [],
        stop_reason: null, stop_sequence: null,
        usage: usage(10, 0),
      } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usage(10, 5) }],
      ['message_stop', { type: 'message_stop' }],
    ];
    return parts.map(([ev, d]) => 'event: ' + ev + '\\ndata: ' + JSON.stringify(d) + '\\n\\n').join('');
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      fs.appendFileSync(TRANSCRIPT, JSON.stringify({
        method: req.method, url: req.url, body, headers: req.headers,
      }) + '\\n');

      const pathOnly = (req.url || '').split('?')[0];
      if (req.method === 'POST' && pathOnly === '/v1/messages') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'anthropic-version': '2023-06-01',
        });
        res.end(anthropicSSE('Hello from mock!'));
        return;
      }
      // Catch-all: return an empty JSON object so any tool-probing request
      // (e.g. /v1/models, /v1/me, auth pings) looks "successful enough" to
      // avoid bailing out before the primary /v1/messages call lands. Not a
      // correct response to the real Anthropic API, but sufficient for a
      // mock that only needs to keep claude-code from exiting on startup.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  server.listen(${MOCK_LLM_PORT}, '0.0.0.0', () => console.log('mock-llm ready'));
`

export async function startMockLLM(networkName: string): Promise<MockLLM> {
  const baseImage = await resolveTestBaseImage()
  const containerName = `yaac-mock-llm-${crypto.randomBytes(4).toString('hex')}`

  const container = await createAndStartContainerWithRetry({
    Image: baseImage,
    name: containerName,
    Entrypoint: ['node', '-e', MOCK_LLM_SCRIPT],
    Labels: { 'yaac.test': 'true' },
    HostConfig: { NetworkMode: networkName },
  })
  const info = await container.inspect()
  const networks = info.NetworkSettings.Networks as Record<string, { IPAddress: string }>
  const networkIp = networks[networkName]?.IPAddress
  if (!networkIp) throw new Error(`mock-llm has no IP on network ${networkName}`)

  // Wait for the server to accept connections
  for (let i = 0; i < 40; i++) {
    try {
      await podmanRetry([
        'exec', containerName, 'sh', '-c',
        `node -e "require('net').connect({ host: '127.0.0.1', port: ${MOCK_LLM_PORT} }).once('connect', () => process.exit(0)).once('error', () => process.exit(1))"`,
      ], { timeout: 2000 })
      break
    } catch {
      if (i === 39) throw new Error('mock-llm did not become ready in 10s')
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  return {
    containerName,
    networkIp,
    port: MOCK_LLM_PORT,
    async transcript() {
      const { stdout } = await podmanRetry([
        'exec', containerName, 'cat', '/tmp/transcript.ndjson',
      ])
      return stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line) as MockLLMEntry)
    },
    async stop() { await removeContainer(containerName) },
  }
}

/**
 * Start a mock git server that speaks the "dumb HTTP" protocol. Bare repos
 * live in `reposDir` on the host and are bind-mounted read-write into the
 * container (git needs to rewrite `info/refs` via `git update-server-info`
 * on seed). Read-only: enough for `git fetch` / `git clone`, not push. Add
 * `git-http-backend` CGI wrapping if push support is needed later.
 */
const MOCK_GIT_SCRIPT = `
  const http = require('http');
  const fs = require('fs');
  const path = require('path');
  const ROOT = '/srv/git';

  const CT = {
    '.pack': 'application/x-git-packed-objects',
    '.idx': 'application/x-git-packed-objects-toc',
  };

  http.createServer((req, res) => {
    const url = req.url || '/';
    // Only support GET; dumb HTTP for fetch is read-only.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    // Block smart-protocol probes so the client falls through to dumb HTTP.
    if (url.includes('/info/refs?service=')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const filePath = path.join(ROOT, url);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(400);
      res.end();
      return;
    }
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, {
        'Content-Type': CT[ext] || 'text/plain',
        'Content-Length': st.size,
      });
      fs.createReadStream(filePath).pipe(res);
    });
  }).listen(${MOCK_GIT_PORT}, '0.0.0.0', () => console.log('mock-git ready'));
`

export async function startMockGit(networkName: string): Promise<MockGit> {
  const baseImage = await resolveTestBaseImage()
  const containerName = `yaac-mock-git-${crypto.randomBytes(4).toString('hex')}`
  const reposDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-mock-git-'))
  // The `node` user (uid 1000 in the image) owns the container's process;
  // the repos dir must be world-readable so `node` can stat+stream the files.
  await fs.chmod(reposDir, 0o755)

  const container = await createAndStartContainerWithRetry({
    Image: baseImage,
    name: containerName,
    Entrypoint: ['node', '-e', MOCK_GIT_SCRIPT],
    Labels: { 'yaac.test': 'true' },
    HostConfig: {
      NetworkMode: networkName,
      Binds: [`${reposDir}:/srv/git:Z`],
    },
  })
  const info = await container.inspect()
  const networks = info.NetworkSettings.Networks as Record<string, { IPAddress: string }>
  const networkIp = networks[networkName]?.IPAddress
  if (!networkIp) throw new Error(`mock-git has no IP on network ${networkName}`)

  for (let i = 0; i < 40; i++) {
    try {
      await podmanRetry([
        'exec', containerName, 'sh', '-c',
        `node -e "require('net').connect({ host: '127.0.0.1', port: ${MOCK_GIT_PORT} }).once('connect', () => process.exit(0)).once('error', () => process.exit(1))"`,
      ], { timeout: 2000 })
      break
    } catch {
      if (i === 39) throw new Error('mock-git did not become ready in 10s')
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  return {
    containerName,
    networkIp,
    port: MOCK_GIT_PORT,
    reposDir,
    async stop() {
      await removeContainer(containerName)
      await fs.rm(reposDir, { recursive: true, force: true })
    },
  }
}

/**
 * Create a bare repo under `mockGit.reposDir`/`<name>.git` with the given
 * file set committed on the default branch, then run `git update-server-info`
 * so the dumb-HTTP protocol can serve it. Uses the host's git binary, not
 * the container's — simpler and avoids round-tripping through podman exec.
 */
export async function seedMockGitRepo(
  mockGit: MockGit,
  name: string,
  opts: { files: Record<string, string>; branch?: string; authorName?: string; authorEmail?: string } = { files: {} },
): Promise<void> {
  const branch = opts.branch ?? 'main'
  const bareDir = path.join(mockGit.reposDir, `${name}.git`)
  await fs.mkdir(bareDir, { recursive: true })

  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-mock-git-seed-'))
  try {
    const runGit = (cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> =>
      execFileAsync('git', args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: opts.authorName ?? 'yaac test',
          GIT_AUTHOR_EMAIL: opts.authorEmail ?? 'yaac-test@example.com',
          GIT_COMMITTER_NAME: opts.authorName ?? 'yaac test',
          GIT_COMMITTER_EMAIL: opts.authorEmail ?? 'yaac-test@example.com',
        },
      })

    await runGit(workdir, ['init', '-b', branch])
    for (const [relPath, content] of Object.entries(opts.files)) {
      const abs = path.join(workdir, relPath)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content)
    }
    await runGit(workdir, ['add', '-A'])
    await runGit(workdir, ['commit', '-m', 'initial commit'])

    // Init the bare repo and push from workdir
    await execFileAsync('git', ['init', '--bare', '-b', branch], { cwd: bareDir })
    await runGit(workdir, ['remote', 'add', 'origin', bareDir])
    await runGit(workdir, ['push', 'origin', branch])
    await execFileAsync('git', ['update-server-info'], { cwd: bareDir })

    // Ensure mock-git's container user can read everything
    await execFileAsync('chmod', ['-R', 'a+rX', bareDir])
  } finally {
    await fs.rm(workdir, { recursive: true, force: true })
  }
}

/**
 * Drop all state for both mocks. Safe to call even if a mock has already
 * stopped — each `stop()` swallows "container not found" errors.
 */
export async function cleanupMocks(
  mocks: Array<{ stop: () => Promise<void> } | null | undefined>,
): Promise<void> {
  const live = mocks.filter((m): m is { stop: () => Promise<void> } => m !== null && m !== undefined)
  await Promise.all(live.map((m) => m.stop().catch(() => { /* ok */ })))
}
