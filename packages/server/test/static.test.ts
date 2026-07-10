import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { Hono } from 'hono'
import { contentTypeFor, registerStaticRoutes, SPA_CSP } from '#static'

describe('contentTypeFor', () => {
  it('maps known extensions', () => {
    expect(contentTypeFor('/x/index.html')).toContain('text/html')
    expect(contentTypeFor('/x/app.js')).toContain('text/javascript')
    expect(contentTypeFor('/x/app.css')).toContain('text/css')
    expect(contentTypeFor('/x/logo.svg')).toBe('image/svg+xml')
  })

  it('falls back to octet-stream for unknown extensions', () => {
    expect(contentTypeFor('/x/file.bin')).toBe('application/octet-stream')
  })
})

describe('registerStaticRoutes', () => {
  let dir: string
  let app: Hono

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-static-'))
    await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>yaac</title>')
    await fs.mkdir(path.join(dir, 'assets'))
    await fs.writeFile(path.join(dir, 'assets', 'app-abc.js'), 'console.log(1)')
    app = new Hono()
    registerStaticRoutes(app, dir)
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('serves index.html at / with CSP and no-cache', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('content-security-policy')).toBe(SPA_CSP)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('yaac')
  })

  it('serves hashed assets with an immutable long cache', async () => {
    const res = await app.request('/assets/app-abc.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(await res.text()).toBe('console.log(1)')
  })

  it('404s a missing asset', async () => {
    const res = await app.request('/assets/missing.js')
    expect(res.status).toBe(404)
  })
})
