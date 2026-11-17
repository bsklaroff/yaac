import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { describe, it, expect } from 'vitest'
import { listenForRedirect } from '#oauth-callback'

/**
 * The loopback listener, driven by plain fetches standing in for the
 * browser coming back from a vendor's authorize page.
 */

/** A port free right now. */
async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

const authorizeUrl = (redirect: string, state = 's1'): string =>
  `https://vendor.example/authorize?${new URLSearchParams({ redirect_uri: redirect, state })}`

describe('listenForRedirect', () => {
  it('catches the code on the redirect path for its state, on either loopback name, and answers the browser', async () => {
    const port = await freePort()
    const listener = await listenForRedirect(authorizeUrl(`http://localhost:${port}/callback`))
    // Another path, and a tab left from an earlier attempt, leave it waiting.
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404)
    const stale = await fetch(`http://127.0.0.1:${port}/callback?code=old&state=s0`)
    expect(stale.status).toBe(400)
    expect(await stale.text()).toContain('out of date')

    const res = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=s1`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Signed in')
    await expect(listener.result).resolves.toEqual({ code: 'the-code', state: 's1' })
    // It stops listening once it has the code.
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow()
  })

  it('reports a redirect with no code, and a wait that runs out', async () => {
    const port = await freePort()
    const denied = await listenForRedirect(authorizeUrl(`http://127.0.0.1:${port}/auth/callback`))
    const res = await fetch(`http://127.0.0.1:${port}/auth/callback?error=access_denied&state=s1`)
    expect(await res.text()).toContain('access_denied')
    await expect(denied.result).rejects.toThrow('The sign-in did not complete: access_denied')

    const late = await listenForRedirect(authorizeUrl(`http://127.0.0.1:${await freePort()}/cb`), 50)
    await expect(late.result).rejects.toThrow('in time')
  })

  it('refuses a redirect off loopback, and a port already taken', async () => {
    await expect(listenForRedirect(authorizeUrl('https://platform.claude.com/oauth/code/callback')))
      .rejects.toThrow('loopback')
    await expect(listenForRedirect(authorizeUrl('http://evil.example:8080/cb'))).rejects.toThrow('loopback')

    const port = await freePort()
    const first = await listenForRedirect(authorizeUrl(`http://127.0.0.1:${port}/cb`))
    await expect(listenForRedirect(authorizeUrl(`http://127.0.0.1:${port}/cb`))).rejects.toThrow(`Port ${port} is in use`)
    first.close()
  })
})
