/**
 * Listening-port observation for the `ports` stream kind: parse the pod's
 * /proc/net/tcp{,6} for LISTEN sockets a loopback-origin dial could reach
 * (bound to loopback or wildcard — the relay's `tcp` kind dials
 * localhost, so a listener bound only to a private non-loopback IP is
 * unreachable and excluded).
 *
 * The files are agent-controlled state, so parsing is bounded: reads cap
 * at MAX_PROC_BYTES and rows at MAX_ROWS, and every port is re-validated
 * as an integer in [1, 65535].
 */

import fs from 'node:fs'
import path from 'node:path'

/** Read cap — a hostile mount over /proc/net must not balloon memory. */
const MAX_PROC_BYTES = 2 * 1024 * 1024
/** Row cap per file — beyond this, extra rows are ignored, not parsed. */
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

/** Bounded whole-file read — /proc files have no size, so read in a loop
 *  up to the cap instead of trusting fs.readFileSync's single allocation. */
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
