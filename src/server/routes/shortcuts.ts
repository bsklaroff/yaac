import { Hono } from 'hono'
import { zv } from '@/server/routes/validator'
import { z } from 'zod'
import { clearShortcutOverrides, getShortcutOverrides, setShortcutOverride } from '@/lib/project/preferences'

/** A keyboard chord: a physical key `code` plus the four modifier states.
 *  Mirrors the frontend `Chord`; validation lives here so the server needn't
 *  import frontend code. */
const chordSchema = z.object({
  code: z.string().min(1),
  alt: z.boolean(),
  ctrl: z.boolean(),
  meta: z.boolean(),
  shift: z.boolean(),
})

export const shortcutsApp = new Hono()
  .get('/get', async (c) => c.json({ overrides: await getShortcutOverrides() }))
  .post(
    '/set',
    zv('json', z.object({ id: z.string().min(1), chord: chordSchema })),
    async (c) => {
      const { id, chord } = c.req.valid('json')
      await setShortcutOverride(id, chord)
      return c.json({ ok: true })
    },
  )
  .post('/reset', async (c) => {
    await clearShortcutOverrides()
    return c.json({ ok: true })
  })
