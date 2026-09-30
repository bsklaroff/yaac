/**
 * Listening ports for the `ports` stream kind, read from the pod's
 * /proc/net/tcp{,6}. Only sockets bound to loopback or wildcard count, since
 * the `tcp` stream kind dials localhost.
 *
 * The agent controls these files, so parsing is bounded in size and rows and
 * every port is validated.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Read cap, in case a hostile mount replaces /proc/net. */
const MAX_PROC_BYTES = 2 * 1024 * 1024
/** Row cap per file; extra rows are ignored. */
const MAX_ROWS = 8192

/** /proc/net/tcp socket-state column value for LISTEN. */
const STATE_LISTEN = '0A'

/**
 * Whether a /proc/net hex local_address is reachable from an in-pod
 * localhost dial: IPv4/IPv6 loopback or wildcard. The kernel prints each
 * 32-bit word little-endian, so 127.0.0.1 is "0100007F" (any 127/8
 * address ends in "7F") and ::1 is 24 zeros + "01000000"; an
 * IPv4-mapped ::ffff:a.b.c.d carries "FFFF0000" in the third word with
 * the v4 word last.
 */
export function isLoopbackOrWildcardHex(addrHex) {
  const hex = String(addrHex).toUpperCase()
  if (!/^[0-9A-F]+$/.test(hex)) return false
  if (hex.length === 8) {
    return hex === '00000000' || hex.endsWith('7F')
  }
  if (hex.length === 32) {
    if (!/[^0]/.test(hex)) return true // :: wildcard
    if (hex === '00000000000000000000000001000000') return true // ::1
    if (hex.startsWith('0000000000000000FFFF0000')) {
      return isLoopbackOrWildcardHex(hex.slice(24)) // ::ffff:a.b.c.d
    }
    return false
  }
  return false
}

/**
 * Parse one /proc/net/tcp{,6} body into the LISTEN ports reachable from
 * an in-pod localhost dial. Tolerates torn/hostile input: malformed rows
 * are skipped, size/row caps bound the work.
 */
export function parseProcTcpPorts(text) {
  const ports = []
  const lines = String(text).slice(0, MAX_PROC_BYTES).split('\n')
  const rows = Math.min(lines.length, MAX_ROWS)
  // Row 0 is the header.
  for (let i = 1; i < rows; i++) {
    const cols = lines[i].trim().split(/\s+/)
    // sl local_address rem_address st ...
    if (cols.length < 4 || cols[3] !== STATE_LISTEN) continue
    const [addrHex, portHex] = cols[1].split(':')
    if (!addrHex || !portHex || !/^[0-9A-Fa-f]{1,4}$/.test(portHex)) continue
    const port = parseInt(portHex, 16)
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    if (!isLoopbackOrWildcardHex(addrHex)) continue
    ports.push(port)
  }
  return ports
}

/** Read a /proc file (which reports no size) up to `maxBytes`. */
function readBounded(file, maxBytes) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    let off = 0
    while (off < maxBytes) {
      const n = fs.readSync(fd, buf, off, maxBytes - off, null)
      if (n <= 0) break
      off += n
    }
    return buf.subarray(0, off).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The pod's current localhost-reachable LISTEN ports, deduped across
 * tcp/tcp6 and sorted ascending. A missing/unreadable file contributes
 * nothing (a v4-only netns has no tcp6).
 */
export function readListeningPorts(procNetDir = '/proc/net') {
  const seen = new Set()
  for (const name of ['tcp', 'tcp6']) {
    let text
    try {
      text = readBounded(path.join(procNetDir, name), MAX_PROC_BYTES)
    } catch {
      continue
    }
    for (const port of parseProcTcpPorts(text)) seen.add(port)
  }
  return [...seen].sort((a, b) => a - b)
}
