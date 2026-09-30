/**
 * A JSON-RPC 2.0 peer over a newline-delimited stream: the transport half of
 * the ACP client. It correlates ids, dispatches incoming calls, and reports
 * what a reconnecting peer must handle (orphan responses). A "peer" because
 * ACP is bidirectional: the agent also sends requests (permission asks).
 *
 * Closing rejects outgoing requests but cannot settle an incoming request
 * whose handler has not resolved; a handler that parks its answer (the
 * permission ask in `AcpConversation`) must settle it on teardown.
 */

import crypto from 'node:crypto'
import { serverLog } from '#log'

/** The duplex this peer speaks over (a streamd `ctrl` stream). */
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

/** Reserved JSON-RPC error codes yaac raises. */
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
 * Cap on one unterminated line, in UTF-16 code units (what a JS string can
 * measure). A backstop against a peer that never sends a newline; large
 * lines (a big file in a tool result) are legitimate.
 */
const MAX_LINE_UNITS = 32 * 1024 * 1024

export interface JsonRpcPeerHandlers {
  /**
   * An incoming request. Resolve with the result, or throw a
   * `JsonRpcCallError` to reply with a protocol error. The id is passed for
   * permission asks, which a human may answer after the connection has been
   * replaced (see `respondTo`).
   */
  onRequest?: (method: string, params: unknown, id: string | number) => Promise<unknown>
  onNotification?: (method: string, params: unknown) => void
  /**
   * A response for an id this peer never sent, possible only after a
   * reconnect: acpd forwards the agent's output to whichever client is
   * attached, so a reply to the previous connection's request reaches us.
   * The ACP client reads it as "the running turn ended". Replies produced
   * while nobody was attached exist only in the record.
   */
  onOrphanResponse?: (id: string | number, result: unknown, error?: JsonRpcError) => void
  onClose?: (reason: string) => void
}

export class JsonRpcPeer {
  private nextId = 1
  /**
   * Per-connection prefix for request ids. A reply to the previous
   * connection's request N can arrive here, and a plain counter would match
   * it to this connection's unrelated request N.
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

  /** Parse complete lines. A non-JSON line (e.g. a stray banner on the
   *  adapter's stdout) is logged and skipped. */
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

    // Validate the id so a malformed one is never echoed back or treated as
    // an orphan.
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
      // An id with our prefix was already resolved: a duplicate, dropped.
      // Only a foreign id is a real orphan ("the previous turn ended");
      // treating duplicates as orphans could end a turn still streaming.
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
      this.reply(id, await handler(method, params, id))
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

  /**
   * Answer a request the previous connection received and left open (the
   * reverse of `onOrphanResponse`). The agent's ids are not namespaced per
   * connection and acpd writes to the same stdin, so a permission ask can
   * still be answered after a relay drop instead of restarting the agent.
   * Best-effort: the agent may ignore an unrecognized reply.
   */
  respondTo(id: string | number, result: unknown): void {
    this.reply(id, result)
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
