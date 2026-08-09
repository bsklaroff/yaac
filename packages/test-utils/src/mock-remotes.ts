import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { baseImageHash } from '@yaac/server/features/image-engine/image-builder'
import { DOCKERFILES_DIR } from '@yaac/shared/project-paths'
import { ensureNamespace } from '@yaac/server/features/cluster/proxy-apply'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  type KubectlExecOptions,
} from '@yaac/server/platform/k8s/kubectl'
import { registryHasTag, registryRef } from '@yaac/server/platform/container/registry'
import { e2eMkdtemp } from '#tmp'

const execFileAsync = promisify(execFile)

/**
 * Mock LLM + mock git-over-HTTP servers that stand in for the real Anthropic,
 * OpenAI, and GitHub remotes when the proxy's upstream-redirect feature
 * reroutes them. Each mock runs as a Pod + ClusterIP Service in the test
 * namespace.
 *
 * Pairing: production traffic flows
 *   worktree pod → HTTPS_PROXY → proxy pod (MITM + inject creds)
 *     → https.request(api.anthropic.com)
 * Test traffic flows the same path, but the proxy's upstreamRedirects map
 * swaps the final hop to `{host: mock.host, port: mock.port}` — the mock
 * Service's ClusterIP (plain HTTP — mocks don't speak TLS). The IP, not the
 * Service DNS name, on purpose: an IP literal needs no resolution, so the
 * same registration works for a host proxy (which could resolve the name)
 * AND a nested worktree's inner proxy (which sinkholes every DNS name by
 * design and could not). The IP is stable for the Service's lifetime.
 */

const MOCK_LLM_PORT = 9100
const MOCK_GIT_PORT = 9101

export interface MockLLM {
  readonly podName: string
  /** The mock Service's ClusterIP — the upstream-redirect target. */
  readonly host: string
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
  readonly podName: string
  /** The mock Service's ClusterIP — the upstream-redirect target. */
  readonly host: string
  readonly port: number
  /** Host-side directory containing one bare repo per test (e.g. `repo-demo.git`). */
  readonly reposDir: string
  stop(): Promise<void>
}

/**
 * Resolve the in-cluster ref of the `yaac-test-base` image. The image is
 * pre-built by `test/global-setup.ts` (same content-hash tag computation)
 * and pushed to the local registry; pods can only pull from the registry,
 * so a missing tag is a fail-fast setup error, never a build trigger.
 * Exported for tests that launch worktree-like probe pods directly.
 */
export async function resolveTestBaseImageRef(): Promise<string> {
  const dockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
  const tag = `yaac-test-base:${await baseImageHash(dockerfile)}`
  if (!await registryHasTag(tag)) {
    throw new Error(
      `${tag} is not in the local registry — did test/global-setup.ts run `
      + 'with the registry reachable?',
    )
  }
  return registryRef(tag)
}


/** `kubectl exec` into a mock pod (argv passthrough, no shell quoting). */
async function execInPod(
  podName: string,
  args: string[],
  opts: KubectlExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return kubectlWithRetry(
    ['exec', '-n', k8sNamespace(), podName, '--', ...args],
    opts,
  )
}

interface MockPodOpts {
  /** Host dir mounted read-only at /srv/git (mock-git's repo store). */
  hostPathDir?: string
}

/**
 * Apply a single-container Pod running `node -e <script>` plus a ClusterIP
 * Service with the same name, then wait until the in-pod server accepts
 * connections on `port`. Returns the Service's allocator-assigned ClusterIP —
 * the address mocks are registered under (see the module docstring for why
 * an IP and not the Service DNS name).
 */
async function startMockPod(
  name: string,
  script: string,
  port: number,
  opts: MockPodOpts = {},
): Promise<string> {
  const ns = k8sNamespace()
  await ensureNamespace()
  const image = await resolveTestBaseImageRef()

  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: ns,
      labels: { 'app': name, 'yaac.test': 'true' },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      containers: [
        {
          name: 'mock',
          image,
          imagePullPolicy: 'IfNotPresent',
          command: ['node', '-e', script],
          ports: [{ containerPort: port }],
          ...(opts.hostPathDir
            ? { volumeMounts: [{ name: 'repos', mountPath: '/srv/git', readOnly: true }] }
            : {}),
        },
      ],
      ...(opts.hostPathDir
        ? { volumes: [{ name: 'repos', hostPath: { path: opts.hostPathDir, type: 'Directory' } }] }
        : {}),
    },
  })
  await kubectlApply({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: ns,
      labels: { 'yaac.test': 'true' },
    },
    spec: {
      type: 'ClusterIP',
      selector: { app: name },
      ports: [{ port, targetPort: port }],
    },
  })
  const svc = await kubectlGetJson<{ spec?: { clusterIP?: string } }>([
    'get', 'service', name, '-n', ns,
  ])
  const clusterIp = svc?.spec?.clusterIP
  if (!clusterIp || clusterIp === 'None') {
    throw new Error(`mock service ${name} has no ClusterIP`)
  }

  // Phase 1: wait for the pod to be Running (covers image pull).
  interface RawPod { status?: { phase?: string } }
  let phase = 'Pending'
  for (let i = 0; i < 120; i++) {
    const pod = await kubectlGetJson<RawPod>(['get', 'pod', name, '-n', ns])
    phase = pod?.status?.phase ?? 'Unknown'
    if (phase === 'Running') break
    if (phase === 'Failed' || phase === 'Succeeded') {
      throw new Error(`mock pod ${name} reached terminal phase ${phase}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (phase !== 'Running') {
    throw new Error(`mock pod ${name} not Running after 60s (phase ${phase})`)
  }

  // Phase 2: wait for the node server inside to accept connections.
  for (let i = 0; i < 40; i++) {
    try {
      await execInPod(name, [
        'sh', '-c',
        `node -e "require('net').connect({ host: '127.0.0.1', port: ${port} }).once('connect', () => process.exit(0)).once('error', () => process.exit(1))"`,
      ], { timeout: 5000 })
      return clusterIp
    } catch {
      if (i === 39) throw new Error(`mock pod ${name} server did not become ready in 10s`)
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error(`mock pod ${name} server did not become ready`)
}

/** Delete a mock's Pod + Service, swallowing every error. */
async function deleteMockPod(name: string): Promise<void> {
  const ns = k8sNamespace()
  await kubectlWithRetry([
    'delete', 'pod', name, '-n', ns,
    '--ignore-not-found', '--wait=false', '--grace-period=1',
  ]).catch(() => { /* already gone */ })
  await kubectlWithRetry([
    'delete', 'service', name, '-n', ns, '--ignore-not-found',
  ]).catch(() => { /* already gone */ })
}

const MOCK_LLM_SCRIPT = `
  const http = require('http');
  const fs = require('fs');
  const zlib = require('zlib');
  const TRANSCRIPT = '/tmp/transcript.ndjson';
  fs.writeFileSync(TRANSCRIPT, '');

  // Best-effort decode of the inbound body so the test transcript stores
  // plain UTF-8 JSON rather than gzip/brotli-compressed bytes. Codex ships
  // its prompts with Content-Encoding: zstd or gzip; failing to decode
  // means tests can't grep for prompt text in the request body.
  function decodeBody(raw, encoding) {
    if (!encoding || encoding === 'identity') return raw.toString('utf8');
    try {
      const enc = String(encoding).toLowerCase();
      if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(raw).toString('utf8');
      if (enc === 'br') return zlib.brotliDecompressSync(raw).toString('utf8');
      if (enc === 'deflate') return zlib.inflateSync(raw).toString('utf8');
      // zstd was added in Node 22.15 as zlib.zstdDecompressSync. Fall back
      // to the raw bytes (losslessly round-tripped as a latin1 string) if
      // we can't decode, so body-shaped assertions still have something
      // to match against — just not guaranteed to be human-readable.
      if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') {
        return zlib.zstdDecompressSync(raw).toString('utf8');
      }
    } catch (err) {
      // fall through
    }
    return raw.toString('utf8');
  }

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

  // OpenAI Responses API SSE response: the shape codex-cli consumes on
  // chatgpt.com/backend-api/responses. Enough events for codex to render a
  // single assistant message and finish its turn. Event names / field
  // structure mirror the public Responses API documentation.
  function responsesSSE(text) {
    const responseId = 'resp_mock_' + Math.random().toString(36).slice(2, 10);
    const itemId = 'msg_mock_' + Math.random().toString(36).slice(2, 10);
    const baseResponse = {
      id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress', model: 'gpt-5-codex',
      output: [], usage: null, error: null, incomplete_details: null,
    };
    const completedResponse = {
      ...baseResponse,
      status: 'completed',
      output: [{
        id: itemId, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    const parts = [
      ['response.created', { type: 'response.created', response: baseResponse }],
      ['response.in_progress', { type: 'response.in_progress', response: baseResponse }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: {
        id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [],
      } }],
      ['response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
      ['response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: text }],
      ['response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text }],
      ['response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: {
        id: itemId, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      } }],
      ['response.completed', { type: 'response.completed', response: completedResponse }],
    ];
    return parts.map(([ev, d]) => 'event: ' + ev + '\\ndata: ' + JSON.stringify(d) + '\\n\\n').join('');
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = decodeBody(raw, req.headers['content-encoding']);
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
      if (req.method === 'POST' && pathOnly === '/backend-api/codex/responses') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(responsesSSE('Hello from mock!'));
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

export async function startMockLLM(): Promise<MockLLM> {
  const podName = `yaac-mock-llm-${crypto.randomBytes(4).toString('hex')}`
  const clusterIp = await startMockPod(podName, MOCK_LLM_SCRIPT, MOCK_LLM_PORT)

  return {
    podName,
    host: clusterIp,
    port: MOCK_LLM_PORT,
    async transcript() {
      const { stdout } = await execInPod(podName, [
        'cat', '/tmp/transcript.ndjson',
      ])
      return stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line) as MockLLMEntry)
    },
    async stop() { await deleteMockPod(podName) },
  }
}

/**
 * Start a mock git server that speaks the "dumb HTTP" protocol. Bare repos
 * live in `reposDir` on the host and reach the pod through a read-only
 * hostPath mount at /srv/git (seeding runs host-side git, including
 * `git update-server-info`, so the pod never writes). Read-only: enough
 * for `git fetch` / `git clone`, not push. Add `git-http-backend` CGI
 * wrapping if push support is needed later.
 *
 * NOTE: hostPath mounts assume the cluster node can see the host's temp
 * dir (kind: TMPDIR under the home extraMount, or an extra mount for
 * /tmp) — the same wiring worktree pods need for their data-dir mounts.
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

export async function startMockGit(): Promise<MockGit> {
  const podName = `yaac-mock-git-${crypto.randomBytes(4).toString('hex')}`
  const reposDir = await e2eMkdtemp('yaac-mock-git-')
  // The container process runs as a non-root user; the repos dir must be
  // world-readable so it can stat+stream the files.
  await fs.chmod(reposDir, 0o755)

  const clusterIp = await startMockPod(podName, MOCK_GIT_SCRIPT, MOCK_GIT_PORT, { hostPathDir: reposDir })

  return {
    podName,
    host: clusterIp,
    port: MOCK_GIT_PORT,
    reposDir,
    async stop() {
      await deleteMockPod(podName)
      await fs.rm(reposDir, { recursive: true, force: true })
    },
  }
}

/**
 * Create a bare repo under `mockGit.reposDir`/`<name>.git` with the given
 * file set committed on the default branch, then run `git update-server-info`
 * so the dumb-HTTP protocol can serve it. Uses the host's git binary, not
 * the pod's — simpler and avoids round-tripping through kubectl exec.
 *
 * `extraBranches` pushes additional branches forked from the default branch,
 * each layering its own files on top — the fixture for reference-branch
 * tests. A project cloned after seeding carries remote-tracking refs for
 * every branch, which is what the skip-fetch e2e paths rely on.
 */
export async function seedMockGitRepo(
  mockGit: MockGit,
  name: string,
  opts: {
    files: Record<string, string>
    branch?: string
    extraBranches?: Record<string, Record<string, string>>
    authorName?: string
    authorEmail?: string
  } = { files: {} },
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

    for (const [extraBranch, extraFiles] of Object.entries(opts.extraBranches ?? {})) {
      await runGit(workdir, ['checkout', '-b', extraBranch, branch])
      for (const [relPath, content] of Object.entries(extraFiles)) {
        const abs = path.join(workdir, relPath)
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.writeFile(abs, content)
      }
      await runGit(workdir, ['add', '-A'])
      await runGit(workdir, ['commit', '-m', `commit on ${extraBranch}`])
      await runGit(workdir, ['push', 'origin', extraBranch])
      await runGit(workdir, ['checkout', branch])
    }

    await execFileAsync('git', ['update-server-info'], { cwd: bareDir })

    // Ensure mock-git's pod user can read everything
    await execFileAsync('chmod', ['-R', 'a+rX', bareDir])
  } finally {
    await fs.rm(workdir, { recursive: true, force: true })
  }
}

/**
 * Drop all state for both mocks. Safe to call even if a mock has already
 * stopped — each `stop()` swallows "not found" errors.
 */
export async function cleanupMocks(
  mocks: Array<{ stop: () => Promise<void> } | null | undefined>,
): Promise<void> {
  const live = mocks.filter((m): m is { stop: () => Promise<void> } => m !== null && m !== undefined)
  await Promise.all(live.map((m) => m.stop().catch(() => { /* ok */ })))
}
