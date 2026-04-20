import type { Hono } from 'hono'
import type { DaemonAppDeps } from '@/lib/daemon/server'

export function registerHealthRoutes(app: Hono, deps: DaemonAppDeps): void {
  app.get('/health', (c) => c.json({ ok: true, version: deps.version }))
}
