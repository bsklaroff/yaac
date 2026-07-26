import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONFIG_DUMP_PATH,
  ListenerRejectedError,
  ListenerTimeoutError,
  adminGet,
  listenerGateStatus,
  parseListenerView,
  waitForListeners,
} from 'yaac-netd/envoy-admin'

const LISTENERS_TYPE = 'type.googleapis.com/envoy.admin.v3.ListenersConfigDump'

/** A `/config_dump` body, with the noise Envoy really includes around it. */
function dump(version: string | null, listeners: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    configs: [
      { '@type': 'type.googleapis.com/envoy.admin.v3.BootstrapConfigDump', bootstrap: {} },
      {
        '@type': LISTENERS_TYPE,
        ...(version === null ? {} : { version_info: version }),
        dynamic_listeners: listeners,
      },
      { '@type': 'type.googleapis.com/envoy.admin.v3.ClustersConfigDump' },
    ],
  })
}

function bound(name: string, port: number): Record<string, unknown> {
  return {
    name,
    active_state: {
      // Envoy stamps the version the listener was CREATED at here and
      // never restamps it on an in-place filter chain update, which is
      // why the gate must not read it.
      version_info: 'creation-version',
      listener: { address: { socket_address: { address: '0.0.0.0', port_value: port } } },
    },
  }
}

const NAME = 'yaac-listener-yaac-https'
const EXPECTED = { names: [NAME], version: 'v2', ports: [15100] }

describe('parseListenerView', () => {
  it('reads the applied LDS version and each listener\'s bound port', () => {
    const view = parseListenerView(dump('v2', [bound(NAME, 15100)]))
    expect(view.appliedVersion).toBe('v2')
    expect(view.listeners).toEqual([
      { name: NAME, ports: [15100], errorVersion: null, errorDetails: null },
    ])
  })

  it('reads a rejected update\'s version and details', () => {
    const view = parseListenerView(dump('v1', [{
      name: NAME,
      error_state: { version_info: 'v2', details: 'error adding listener: address already in use' },
    }]))
    expect(view.appliedVersion).toBe('v1')
    expect(view.listeners[0]?.errorVersion).toBe('v2')
    expect(view.listeners[0]?.errorDetails).toMatch(/already in use/)
  })

  it('returns nothing for a body it cannot read, so the gate withholds readiness', () => {
    for (const body of ['', '<html>404</html>', '{"configs":"nope"}', '{"configs":[]}']) {
      expect(parseListenerView(body)).toEqual({ appliedVersion: null, listeners: [] })
    }
  })

  it('drops entries with no name rather than guessing', () => {
    expect(parseListenerView(dump('v2', [{ active_state: {} }])).listeners).toEqual([])
  })
})

describe('listenerGateStatus', () => {
  it('is ready when Envoy applied this version AND the listener is bound', () => {
    expect(listenerGateStatus(parseListenerView(dump('v2', [bound(NAME, 15100)])), EXPECTED))
      .toEqual({ ready: true, rejected: [], pending: [] })
  })

  it('ignores the per-listener version, which never moves on a filter chain update', () => {
    // Verified against Envoy 1.34: adding a source prefix to a filter
    // chain moves the LDS version and leaves this one at creation. Gating
    // on it would pass once and then time out on every pod change.
    const view = parseListenerView(dump('v2', [bound(NAME, 15100)]))
    expect(view.listeners[0]).not.toHaveProperty('activeVersion')
    expect(listenerGateStatus(view, EXPECTED).ready).toBe(true)
  })

  it('is pending while Envoy still serves the PREVIOUS document', () => {
    const status = listenerGateStatus(parseListenerView(dump('v1', [bound(NAME, 15100)])), EXPECTED)
    expect(status.ready).toBe(false)
    expect(status.pending.join()).toContain('lds version v1 != v2')
  })

  it('is pending when Envoy reports nothing yet', () => {
    const status = listenerGateStatus({ appliedVersion: null, listeners: [] }, EXPECTED)
    expect(status.ready).toBe(false)
    expect(status.pending.join()).toContain('absent')
  })

  it('is pending when the version landed but the listener bound another port', () => {
    const status = listenerGateStatus(parseListenerView(dump('v2', [bound(NAME, 15999)])), EXPECTED)
    expect(status.ready).toBe(false)
    expect(status.pending.join()).toContain('not bound')
  })

  it('reports rejection when Envoy failed THIS version', () => {
    const view = parseListenerView(dump('v1', [{
      name: NAME, error_state: { version_info: 'v2', details: 'address in use' },
    }]))
    expect(listenerGateStatus(view, EXPECTED).rejected).toEqual([NAME])
  })

  it('ignores a stale error from an earlier version that has since recovered', () => {
    const view = parseListenerView(dump('v2', [{
      ...bound(NAME, 15100),
      error_state: { version_info: 'v1', details: 'old failure' },
    }]))
    expect(listenerGateStatus(view, EXPECTED).ready).toBe(true)
  })
})

describe('waitForListeners', () => {
  const sleep = (): Promise<void> => Promise.resolve()

  it('returns immediately when nothing is expected (no pods to serve)', async () => {
    let calls = 0
    await waitForListeners({
      expected: { names: [], version: 'v2', ports: [15100] },
      dump: () => { calls++; return Promise.resolve('') },
      sleep, attempts: 3, pollMs: 1,
    })
    expect(calls).toBe(0)
  })

  it('polls until Envoy catches up', async () => {
    let calls = 0
    await waitForListeners({
      expected: EXPECTED,
      dump: () => {
        calls++
        return Promise.resolve(calls < 3 ? dump('v1', [bound(NAME, 15100)]) : dump('v2', [bound(NAME, 15100)]))
      },
      sleep, attempts: 10, pollMs: 1,
    })
    expect(calls).toBe(3)
  })

  it('fails FAST on a rejection instead of burning the timeout', async () => {
    let calls = 0
    const promise = waitForListeners({
      expected: EXPECTED,
      dump: () => {
        calls++
        return Promise.resolve(dump('v1', [{
          name: NAME,
          error_state: { version_info: 'v2', details: 'address already in use' },
        }]))
      },
      sleep, attempts: 50, pollMs: 1,
    })
    await expect(promise).rejects.toThrow(ListenerRejectedError)
    await promise.catch((err: Error) => { expect(err.message).toMatch(/already in use/) })
    expect(calls).toBe(1)
  })

  it('times out naming what it was still waiting for', async () => {
    const promise = waitForListeners({
      expected: EXPECTED,
      dump: () => Promise.resolve(dump('v1', [bound(NAME, 15100)])),
      sleep, attempts: 2, pollMs: 1,
    })
    await expect(promise).rejects.toThrow(ListenerTimeoutError)
    await promise.catch((err: Error) => {
      expect(err.message).toContain('lds version v1 != v2')
    })
  })

  it('treats an unreachable admin socket as "not up yet", not as a crash', async () => {
    // Envoy waits for netd to write the bootstrap, so the first passes
    // legitimately find no socket at all.
    const promise = waitForListeners({
      expected: EXPECTED,
      dump: () => Promise.reject(new Error('ENOENT')),
      sleep, attempts: 2, pollMs: 1,
    })
    await expect(promise).rejects.toThrow(ListenerTimeoutError)
  })
})

describe('adminGet', () => {
  /** A throwaway unix-socket HTTP server standing in for Envoy's admin. */
  async function serve(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<{ path: string; close: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'netd-admin-'))
    const socketPath = path.join(dir, 'admin.sock')
    const server = http.createServer(handler)
    await new Promise<void>((resolve) => { server.listen(socketPath, resolve) })
    return {
      path: socketPath,
      close: async () => {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
        await fs.rm(dir, { recursive: true, force: true })
      },
    }
  }

  it('returns the body from the admin unix socket', async () => {
    const server = await serve((req, res) => {
      res.end(JSON.stringify({ path: req.url }))
    })
    try {
      await expect(adminGet(server.path, CONFIG_DUMP_PATH))
        .resolves.toBe(JSON.stringify({ path: CONFIG_DUMP_PATH }))
    } finally {
      await server.close()
    }
  })

  it('accumulates a chunked body rather than returning the first chunk', async () => {
    // A real /config_dump is far past one chunk, and a truncated body
    // parses as "no listeners" — which would gate the DNAT open on a
    // half-read response.
    const server = await serve((_req, res) => {
      res.write('{"configs":')
      res.end('[]}')
    })
    try {
      await expect(adminGet(server.path, CONFIG_DUMP_PATH)).resolves.toBe('{"configs":[]}')
    } finally {
      await server.close()
    }
  })

  it('rejects when the socket does not exist', async () => {
    // The expected state before Envoy has started; waitForListeners turns
    // this into "not up yet" rather than a crash.
    await expect(adminGet(path.join(os.tmpdir(), 'netd-absent.sock'), CONFIG_DUMP_PATH))
      .rejects.toThrow()
  })

  it('destroys a hung request instead of waiting forever', async () => {
    const server = await serve(() => { /* never responds */ })
    try {
      await expect(adminGet(server.path, CONFIG_DUMP_PATH, 20))
        .rejects.toThrow(/timed out/)
    } finally {
      await server.close()
    }
  })
})
