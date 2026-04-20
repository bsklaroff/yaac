import { Hono } from 'hono'
import { listAuth } from '@/lib/auth/list'

export const authApp = new Hono()
  .get('/list', async (c) => c.json(await listAuth()))
