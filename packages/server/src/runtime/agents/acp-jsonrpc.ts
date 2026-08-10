/**
 * A JSON-RPC 2.0 peer over a newline-delimited byte stream — the transport
 * half of the ACP client. Knows nothing about ACP itself: it correlates ids,
 * dispatches incoming calls, and surfaces the things a *reconnecting* peer has
 * to reason about (orphan responses, control lines from acpd).
 *
 * "Peer", not "client", because ACP is bidirectional: the agent calls back for
 * permission decisions and file access, so both directions carry requests.
 */

import crypto from 'node:crypto'
import { serverLog } from '#log'

/** The duplex this peer speaks over — satisfied by a streamd `ctrl` stream. */
export interface JsonRpcTransport {
  write(data: string): void
  onData(cb: (chunk: string) => void): void
  onClose(cb: (reason: string) => void): void
  close(): void
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/** JSON-RPC's own reserved codes, plus the one yaac raises itself. */
export const JSONRPC_METHOD_NOT_FOUND = -32601
export const JSONRPC_INTERNAL_ERROR = -32603

export class JsonRpcCallError extends Error {
  constructor(readonly rpc: JsonRpcError) {
    super(`${rpc.message} (code ${rpc.code})`)
    this.name = 'JsonRpcCallError'
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

/**
 * Cap on a single unterminated line, in UTF-16 code units rather than bytes
 * (it guards a JS string, so that is what it can measure — multibyte-heavy
 * content reaches it later than the number suggests). A backstop against a
 * peer that never sends a newline, not a protocol limit: an agent streaming a
 * large file into a tool result is legitimate.
 */
const MAX_LINE_UNITS = 32 * 1024 * 1024

export interface JsonRpcPeerHandlers {
  /** Incoming request from the far side. Resolve with the result, or throw a
   *  `JsonRpcCallError` to answer with a protocol error. */
  onRequest?: (method: string, params: unknown) => Promise<unknown>
  onNotification?: (method: string, params: unknown) => void
  /**
   * A response arrived for an id this peer never sent. Only possible after a
   * reconnect: acpd buffers whatever the agent produced while detached, so the
   * reply to a request the *previous* connection made is delivered to us. The
   * ACP client reads it as "the turn that was running has ended".
   */
  onOrphanResponse?: (id: string | number, result: unknown, error?: JsonRpcError) => void
  onClose?: (reason: string) => void
}

export class JsonRpcPeer {
  private nextId = 1
  /**
   * Namespaces this connection's request ids. acpd replays whatever the agent
   * produced while detached, so a reply to the PREVIOUS connection's request N
   * can arrive here — and a bare counter restarting at 1 would let it resolve
   * this connection's unrelated request N (a live turn reported as ended, say).
   * With a per-connection prefix an orphan is always recognisable as one.
   */
  private readonly idPrefix = crypto.randomUUID().slice(0, 8)
  private readonly pending = new Map<string, Pending>()
  private buffer = ''
  private closed = false

  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly handlers: JsonRpcPeerHandlers = {},
  ) {
    transport.onData((chunk) => this.feed(chunk))
    transport.onClose((reason) => this.onClosed(reason))
  }

  /** Parse whatever whole lines have arrived. Deliberately tolerant: a line
   *  that isn't JSON is logged and skipped rather than killing the stream —
   *  an adapter that prints a stray banner to stdout must not take the
   *  conversation down with it. */
  private feed(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE_UNITS) {
      this.onClosed('jsonrpc: line exceeded the size cap')
      this.transport.close()
      return
    }
    let nl = this.buffer.indexOf('\n')
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line !== '') this.dispatch(line)
      nl = this.buffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    let msg: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
      msg = parsed as Record<string, unknown>
    } catch {
      serverLog(`[server] acp: non-JSON line discarded: ${line.slice(0, 200)}`)
      return
    }

    // Validated rather than cast: a malformed id must not be echoed back
    // verbatim in a reply, nor reach the orphan path as something unmatchable.
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : undefined
    if (typeof msg.method === 'string') {
      if (id === undefined) {
        this.handlers.onNotification?.(msg.method, msg.params)
      } else {
        void this.serve(id, msg.method, msg.params)
      }
      return
    }
    if (id === undefined) return // neither a call nor a reply

    const entry = typeof id === 'string' ? this.pending.get(id) : undefined
    const error = msg.error as JsonRpcError | undefined
    if (!entry) {
      // Unmatched. Whose it is decides what it means, and the prefix says: an
      // id carrying OUR namespace is a request this connection already
      // resolved — a duplicate, to drop. Only a foreign id is a genuine
      // cross-connection orphan, which the caller reads as "the turn that was
      // running before the reconnect has ended". Conflating them lets a
      // duplicate (or a mangled id) end a turn that is still streaming.
      if (typeof id === 'string' && id.startsWith(`${this.idPrefix}-`)) {
        serverLog(`[server] acp: duplicate reply for ${id} discarded`)
        return
      }
      this.handlers.onOrphanResponse?.(id, msg.result, error)
      return
    }
    this.pending.delete(id as string)
    if (error) entry.reject(new JsonRpcCallError(error))
    else entry.resolve(msg.result)
  }

  private async serve(id: string | number, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.onRequest
    if (!handler) {
      this.reply(id, undefined, { code: JSONRPC_METHOD_NOT_FOUND, message: `no handler for ${method}` })
      return
    }
    try {
      this.reply(id, await handler(method, params))
    } catch (err) {
      this.reply(id, undefined, err instanceof JsonRpcCallError
        ? err.rpc
        : { code: JSONRPC_INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) })
    }
  }

  private reply(id: string | number, result: unknown, error?: JsonRpcError): void {
    if (this.closed) return
    this.transport.write(`${JSON.stringify(
      error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result: result ?? null },
    )}\n`)
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`acp: ${method} on a closed stream`))
    const id = `${this.idPrefix}-${this.nextId++}`
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.transport.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.transport.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  private onClosed(reason: string): void {
    if (this.closed) return
    this.closed = true
    const err = new Error(`acp stream closed: ${reason}`)
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
    this.handlers.onClose?.(reason)
  }

  close(): void {
    this.onClosed('closed locally')
    this.transport.close()
  }

  get isClosed(): boolean {
    return this.closed
  }
}
