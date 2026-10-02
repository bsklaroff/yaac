import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureNamespace } from '@yaac/server/drivers/k8s/cluster/proxy-apply'
import {
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
  type KubectlExecOptions,
} from '@yaac/server/drivers/k8s/substrate/kubectl'
import { e2eMkdtemp } from '#tmp'
import { resolveTestBaseImageRef, waitForPod } from '#test-pods'

const execFileAsync = promisify(execFile)

/**
 * Mock LLM and git-over-HTTP servers standing in for Anthropic, OpenAI and
 * GitHub. Each runs as a Pod + ClusterIP Service in the test namespace.
 *
 * Traffic takes the production path (workspace pod → proxy pod → upstream),
 * but the proxy's upstreamRedirects map sends the final hop to the mock
 * Service's ClusterIP over plain HTTP. An IP literal needs no DNS lookup and
 * is stable for the Service's lifetime.
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
 * Apply a Pod running `node -e <script>` and a same-named ClusterIP
 * Service, then wait until the server accepts connections on `port`.
 * Returns the Service's ClusterIP.
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
          // Ready once the server accepts connections. An exec probe, so no
          // network policy stands between it and the server.
          readinessProbe: {
            exec: {
              command: ['node', '-e', `require('net').connect({ host: '127.0.0.1', port: ${String(port)} })`
                + `.once('connect', () => process.exit(0)).once('error', () => process.exit(1))`],
            },
            periodSeconds: 1,
            // A cold `node` start through the exec path can take seconds.
            timeoutSeconds: 5,
          },
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

  // Covers the image pull and the server's startup.
  await waitForPod(name, { ready: true, timeoutMs: 70_000 })
  return clusterIp
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

  // Decode compressed bodies (codex sends zstd or gzip) so tests can grep
  // the recorded prompt text.
  function decodeBody(raw, encoding) {
    if (!encoding || encoding === 'identity') return raw.toString('utf8');
    try {
      const enc = String(encoding).toLowerCase();
      if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(raw).toString('utf8');
      if (enc === 'br') return zlib.brotliDecompressSync(raw).toString('utf8');
      if (enc === 'deflate') return zlib.inflateSync(raw).toString('utf8');
      // zlib.zstdDecompressSync needs Node 22.15+. Otherwise keep the raw
      // bytes as a latin1 string.
      if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') {
        return zlib.zstdDecompressSync(raw).toString('utf8');
      }
    } catch (err) {
      // fall through
    }
    return raw.toString('utf8');
  }

  // Minimal Anthropic SSE response: one assistant turn. The usage objects
  // must include every field claude-code reads, or it crashes.
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

  // OpenAI Responses API SSE response, as codex reads it from
  // chatgpt.com/backend-api/responses: one assistant message and turn end.
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
      // codex (>= 0.156) won't start unless the account it sent in this
      // header is listed here. NO_CONSTRAINT keeps its requests on the
      // chatgpt.com host the proxy redirects to this mock.
      if (req.method === 'GET' && pathOnly === '/backend-api/wham/accounts/check') {
        const id = req.headers['chatgpt-account-id'] || 'mock-account';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          accounts: [{
            id, plan_type: 'plus',
            workspace_backend_origin: 'NO_CONSTRAINT',
            account_routing_override: 'NO_CONSTRAINT',
          }],
          account_ordering: [id],
          default_account_id: id,
        }));
        return;
      }
      // Catch-all: an empty JSON object for startup probes (/v1/models,
      // auth pings) so claude-code doesn't exit before /v1/messages.
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
 * Start a read-only mock git server speaking the "dumb HTTP" protocol
 * (fetch and clone, no push). Bare repos live in `reposDir`, a host dir
 * under testTmpBase() mounted read-only at /srv/git; seeding runs host-side.
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
  // The pod runs as non-root, so the repos must be world-readable.
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
 * Create a bare repo `<reposDir>/<name>.git` with `files` committed on the
 * default branch, using host git, and run `git update-server-info` so dumb
 * HTTP can serve it.
 *
 * `extraBranches` adds branches forked from the default branch, each with
 * its own files on top, for reference-branch tests.
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
 * Drop all state for both mocks. Safe after a mock has already stopped.
 */
export async function cleanupMocks(
  mocks: Array<{ stop: () => Promise<void> } | null | undefined>,
): Promise<void> {
  const live = mocks.filter((m): m is { stop: () => Promise<void> } => m !== null && m !== undefined)
  await Promise.all(live.map((m) => m.stop().catch(() => { /* ok */ })))
}
