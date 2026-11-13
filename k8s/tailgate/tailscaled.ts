/**
 * tailscaled's local API, over the socket the two containers share.
 * tailgate runs as another uid than tailscaled, which therefore gives it
 * only the read-only calls, such as these two.
 */
import http from 'node:http'

export interface TailnetUser {
  login: string
  name: string
}

function get(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path, headers: { Host: 'local-tailscaled.sock' }, timeout: 5_000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('timeout', () => req.destroy(new Error(`tailscaled did not answer ${path}`)))
    req.on('error', reject)
  })
}

/**
 * Who holds a tailnet address: their login and display name, or null for
 * a tagged device, which acts for no user, and for an address the tailnet
 * does not know.
 */
export async function whois(socketPath: string, address: string, port: number): Promise<TailnetUser | null> {
  const addr = address.includes(':') ? `[${address}]:${String(port)}` : `${address}:${String(port)}`
  const res = await get(socketPath, `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`)
  if (res.status === 404) return null
  if (res.status !== 200) throw new Error(`tailscaled whois answered ${String(res.status)}: ${res.body.slice(0, 200)}`)
  const who = JSON.parse(res.body) as { Node?: { Tags?: string[] }; UserProfile?: { LoginName?: string; DisplayName?: string } }
  const login = who.UserProfile?.LoginName
  if ((who.Node?.Tags?.length ?? 0) > 0 || !login) return null
  return { login, name: who.UserProfile?.DisplayName ?? login }
}

/** The device's own tailnet addresses. */
export async function ownAddresses(socketPath: string): Promise<string[]> {
  const res = await get(socketPath, '/localapi/v0/status?peers=false')
  if (res.status !== 200) throw new Error(`tailscaled status answered ${String(res.status)}`)
  return (JSON.parse(res.body) as { TailscaleIPs?: string[] }).TailscaleIPs ?? []
}
