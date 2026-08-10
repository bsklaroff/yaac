import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Hono } from 'hono'
import { registerStaticRoutes } from '#http'

/** What a browser computes for an inline <script> body it is offered a hash for. */
function sriHash(body: string): string {
  return `'sha256-${createHash('sha256').update(body).digest('base64')}'`
}

describe('registerStaticRoutes', () => {
  let dir: string
  let app: Hono

  // The shell is re-read per request, so tests rewrite index.html in place to
  // drive the CSP off different markup.
  const writeShell = (html: string): Promise<void> =>
    fs.writeFile(path.join(dir, 'index.html'), html)

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-static-'))
    await fs.mkdir(path.join(dir, 'assets'))
    await fs.writeFile(path.join(dir, 'assets', 'app-abc.js'), 'console.log(1)')
    await fs.writeFile(path.join(dir, 'assets', 'app-abc.css'), 'body{}')
    await fs.writeFile(path.join(dir, 'assets', 'logo-abc.svg'), '<svg/>')
    await fs.writeFile(path.join(dir, 'assets', 'inter-abc.woff2'), 'font')
    await fs.writeFile(path.join(dir, 'assets', 'blob-abc.bin'), 'raw')
    await fs.writeFile(path.join(dir, 'secret.txt'), 'outside the bundle')
    app = new Hono()
    registerStaticRoutes(app, dir)
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('serves the shell at / with no-cache and a CSP admitting its inline scripts by hash', async () => {
    await writeShell('<!doctype html><script>var a=1</script><script src="/x.js"></script><script>var b=2</script>')
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('var a=1')

    const csp = res.headers.get('content-security-policy') as string
    // Each inline body admitted by its own hash — computed from the html, so
    // the policy cannot drift from the markup. The external <script src> is
    // covered by 'self' and contributes no hash.
    expect(csp).toContain(`script-src 'self' ${sriHash('var a=1')} ${sriHash('var b=2')}; `)
    expect(csp).toContain("default-src 'self'; ")
    expect(csp).toContain("connect-src 'self' ws: wss:; ")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it("keeps script-src 'self'-only for a shell with no inline script", async () => {
    await writeShell('<!doctype html><title>yaac</title>')
    const res = await app.request('/')
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'; ")
    expect(res.headers.get('content-security-policy')).not.toContain('sha256-')
  })

  it('serves hashed assets with a long immutable cache and a type per extension', async () => {
    const cases: [string, string][] = [
      ['app-abc.js', 'text/javascript'],
      ['app-abc.css', 'text/css'],
      ['logo-abc.svg', 'image/svg+xml'],
      ['inter-abc.woff2', 'font/woff2'],
      // Nothing in the MIME table: served as opaque bytes rather than guessed.
      ['blob-abc.bin', 'application/octet-stream'],
    ]
    for (const [file, type] of cases) {
      const res = await app.request(`/assets/${file}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain(type)
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    }
    expect(await (await app.request('/assets/app-abc.js')).text()).toBe('console.log(1)')
  })

  it('404s a missing asset and a missing shell', async () => {
    expect((await app.request('/assets/missing.js')).status).toBe(404)
    await fs.rm(path.join(dir, 'index.html'))
    expect((await app.request('/')).status).toBe(404)
  })

  it('does not serve a file outside the assets dir', async () => {
    expect((await app.request('/assets/..%2Fsecret.txt')).status).toBe(404)
    expect((await app.request('/assets/subdir/../../secret.txt')).status).toBe(404)
  })
})
