import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/**
 * Tailnet address discovery for shared-session links. The daemon binds a
 * second listener on the machine's tailscale address (opt-in via the
 * tailnet-sharing preference) so teammates on the tailnet can open share
 * links; loopback stays the primary bind for the CLI and local webapp.
 */

export interface TailnetInfo {
  /** The IPv4 address to bind (e.g. 100.x.y.z). */
  ip: string
  /** MagicDNS name (e.g. mymac.tail1234.ts.net), when discoverable. */
  dnsName?: string
}

/** True for addresses in tailscale's CGNAT range, 100.64.0.0/10. */
export function isTailnetIPv4(addr: string): boolean {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(addr)
  if (!m) return false
  const second = Number(m[1])
  return second >= 64 && second <= 127
}

type InterfaceMap = Record<string, Array<{ family: string; address: string; internal: boolean }> | undefined>

/** Find the machine's tailnet IPv4 from its network interfaces — i.e. an
 *  address tailscale has actually assigned (the daemon can bind it). */
export function findTailnetIPv4(interfaces: InterfaceMap = os.networkInterfaces() as InterfaceMap): string | null {
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && isTailnetIPv4(a.address)) return a.address
    }
  }
  return null
}

/** Best-effort MagicDNS name via the tailscale CLI; null when unavailable. */
export async function getTailnetDnsName(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('tailscale', ['status', '--json'], { timeout: 3000 })
    const parsed: unknown = JSON.parse(stdout)
    const dns = (parsed as { Self?: { DNSName?: unknown } } | null)?.Self?.DNSName
    if (typeof dns === 'string' && dns.length > 0) return dns.replace(/\.$/, '')
    return null
  } catch {
    return null
  }
}

/**
 * Resolve the address share links should use. `YAAC_SHARE_ADDR` overrides
 * detection (useful for plain-LAN/VPN setups without tailscale). Returns
 * null when tailscale isn't up and no override is set.
 */
export async function detectTailnet(): Promise<TailnetInfo | null> {
  const override = process.env.YAAC_SHARE_ADDR
  if (override) return { ip: override }
  const ip = findTailnetIPv4()
  if (!ip) return null
  const dnsName = await getTailnetDnsName()
  return dnsName ? { ip, dnsName } : { ip }
}
