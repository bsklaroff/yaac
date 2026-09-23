// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

// CodeMirror's contenteditable doesn't work under jsdom; the pane's save
// lifecycle is what is under test, so the editor is a textarea.
vi.mock('#components/ui/CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

import { AUTOSAVE_MS, POLL_MS, RETRY_MS, WorktreeFile } from '#components/WorktreeFile'
import { discardFileSavers, fileKey, fileSaver, flushFileSavers } from '#lib/files'
import { useUiStore } from '#store'

/**
 * The server, at `fetch`: one file whose version is a counter. A test can
 * hold the next PUT or GET open, fail PUTs, or change the file behind the
 * pane's back.
 */
interface Put { path: string; content: string; baseVersion: string | null }
let disk: { content: string; version: number } | null
let puts: Put[]
let failPuts: number
/** The whole worktree is gone: every request answers 404. */
let worktreeGone: boolean
let holdPut: ((release: () => void) => void) | null
let holdGet: ((release: () => void) => void) | null

function respond(status: number, body: unknown): Response {
  const res = {
    ok: status < 400,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    clone: () => res,
  }
  return res as unknown as Response
}

/** Read through a call, so a case that set `disk = null` can still look again. */
const onDisk = (): typeof disk => disk

async function held(hold: ((release: () => void) => void) | null): Promise<void> {
  if (!hold) return
  await new Promise<void>((resolve) => hold(resolve))
}

beforeEach(() => {
  vi.useFakeTimers()
  disk = { content: 'one\n', version: 1 }
  puts = []
  failPuts = 0
  worktreeGone = false
  holdPut = null
  holdGet = null
  // hono hands the client's fetch a relative URL string.
  globalThis.fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    if (init?.method === 'PUT') {
      const body = JSON.parse(init.body as string) as Put
      puts.push(body)
      if (worktreeGone) return respond(404, { error: { code: 'NOT_FOUND', message: 'worktree w1 not found' } })
      const hold = holdPut
      holdPut = null
      await held(hold)
      if (failPuts > 0) {
        failPuts--
        return respond(500, { error: { code: 'INTERNAL', message: 'boom' } })
      }
      const current = disk ? String(disk.version) : null
      if (body.baseVersion === null ? disk !== null : body.baseVersion !== current) {
        return respond(409, { error: { code: 'CONFLICT', message: 'conflict' }, version: current })
      }
      disk = { content: body.content, version: (disk?.version ?? 0) + 1 }
      return respond(200, { path: 'a.ts', version: String(disk.version), size: body.content.length })
    }
    const hold = holdGet
    holdGet = null
    const snapshot = disk && { ...disk }
    await held(hold)
    if (!snapshot) return respond(404, { error: { code: 'NOT_FOUND', message: 'no such file' } })
    const version = String(snapshot.version)
    const file = { path: 'a.ts', version, size: snapshot.content.length, binary: false }
    return respond(200, url.searchParams.get('known') === version ? file : { ...file, content: snapshot.content })
  }) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  discardFileSavers([fileKey('w1', 'a.ts')])
  vi.useRealTimers()
  useUiStore.setState({ dirtyFiles: {} })
})

const tick = (ms: number): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const editor = (): HTMLTextAreaElement => screen.getByLabelText<HTMLTextAreaElement>('editor')
const type = (text: string): void => { fireEvent.change(editor(), { target: { value: text } }) }
const ctrlS = (el: Element, over: Partial<KeyboardEventInit> = {}): boolean =>
  fireEvent.keyDown(el, { key: 's', code: 'KeyS', ctrlKey: true, ...over })

async function mount(): Promise<ReturnType<typeof render>> {
  const view = render(<WorktreeFile worktreeId="w1" path="a.ts" visible onClose={() => {}} />)
  await tick(0)
  return view
}

describe('WorktreeFile', () => {
  it('reloads a clean buffer in place when the file changes on disk', async () => {
    await mount()
    expect(editor().value).toBe('one\n')
    disk = { content: 'two\n', version: 2 }
    await tick(POLL_MS)
    expect(editor().value).toBe('two\n')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps a dirty buffer when the file changes on disk, and offers Reload or Overwrite', async () => {
    await mount()
    await tick(POLL_MS - 500)
    disk = { content: 'theirs\n', version: 2 }
    type('mine\n')
    await tick(500)
    expect(screen.getByRole('alert').textContent).toContain('Changed on disk')
    expect(editor().value).toBe('mine\n')
    expect(screen.getByText('Paused: conflict')).toBeTruthy()
    // Paused: the autosave that was pending never runs.
    await tick(AUTOSAVE_MS * 5)
    expect(puts).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await tick(0)
    expect(editor().value).toBe('theirs\n')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('autosaves once, a second after the last of a burst of edits', async () => {
    await mount()
    type('o')
    await tick(AUTOSAVE_MS - 100)
    type('on')
    await tick(AUTOSAVE_MS - 100)
    type('one!')
    await tick(AUTOSAVE_MS - 1)
    expect(puts).toEqual([])
    await tick(1)
    expect(puts).toEqual([{ path: 'a.ts', content: 'one!', baseVersion: '1' }])
    expect(disk?.content).toBe('one!')
    expect(screen.getByText('Saved')).toBeTruthy()
    expect(useUiStore.getState().dirtyFiles).toEqual({})
  })

  it('marks the file dirty in the store until the save lands', async () => {
    await mount()
    type('changed')
    expect(useUiStore.getState().dirtyFiles).toEqual({ [fileKey('w1', 'a.ts')]: true })
    await tick(AUTOSAVE_MS)
    expect(useUiStore.getState().dirtyFiles).toEqual({})
  })

  it('saves at once on Ctrl+S, from the editor or the focused Save button', async () => {
    await mount()
    type('first')
    expect(ctrlS(editor())).toBe(false) // default prevented: no "Save page"
    await tick(0)
    expect(puts.map((p) => p.content)).toEqual(['first'])
    type('second')
    const save = screen.getByRole('button', { name: 'Save' })
    save.focus()
    expect(ctrlS(save)).toBe(false)
    await tick(0)
    expect(puts.map((p) => p.content)).toEqual(['first', 'second'])
  })

  it('leaves Ctrl+S alone with Shift or Alt held', async () => {
    await mount()
    type('x')
    expect(ctrlS(editor(), { shiftKey: true })).toBe(true)
    expect(ctrlS(editor(), { altKey: true })).toBe(true)
    await tick(0)
    expect(puts).toEqual([])
  })

  it('saves at once when the pane is hidden', async () => {
    const view = await mount()
    type('hidden')
    view.rerender(<WorktreeFile worktreeId="w1" path="a.ts" visible={false} onClose={() => {}} />)
    await tick(0)
    expect(puts.map((p) => p.content)).toEqual(['hidden'])
  })

  it('coalesces edits made during a save into one follow-up against the version it returned', async () => {
    await mount()
    let release = (): void => {}
    holdPut = (r) => { release = r }
    type('a')
    ctrlS(editor())
    await tick(0)
    type('ab')
    type('abc')
    await tick(AUTOSAVE_MS * 3)
    expect(puts).toHaveLength(1)
    release()
    await tick(0)
    expect(puts).toEqual([
      { path: 'a.ts', content: 'a', baseVersion: '1' },
      { path: 'a.ts', content: 'abc', baseVersion: '2' },
    ])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a poll issued before its own save landed', async () => {
    await mount()
    let release = (): void => {}
    holdGet = (r) => { release = r }
    await tick(POLL_MS) // a poll goes out, reads version 1, and is held
    type('mine')
    ctrlS(editor())
    await tick(0)
    expect(disk?.version).toBe(2)
    release() // it answers version 1 — older than the pane's own save
    await tick(0)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(editor().value).toBe('mine')
  })

  it('pauses on a refused save until Overwrite saves against the version on disk', async () => {
    await mount()
    disk = { content: 'theirs', version: 5 }
    type('mine')
    await tick(AUTOSAVE_MS)
    expect(puts).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('Changed on disk')
    type('mine, more')
    await tick(AUTOSAVE_MS * 5)
    expect(puts).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }))
    await tick(0)
    expect(puts[1]).toEqual({ path: 'a.ts', content: 'mine, more', baseVersion: '5' })
    expect(disk?.content).toBe('mine, more')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('never recreates a deleted file on its own, only on Save to recreate', async () => {
    await mount()
    disk = null
    type('keep me')
    await tick(AUTOSAVE_MS)
    expect(screen.getByText('Deleted on disk')).toBeTruthy()
    await tick(RETRY_MS[2] * 3)
    expect(puts).toEqual([{ path: 'a.ts', content: 'keep me', baseVersion: '1' }])
    expect(disk).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save to recreate' }))
    await tick(0)
    expect(puts[1]).toEqual({ path: 'a.ts', content: 'keep me', baseVersion: null })
    expect(onDisk()?.content).toBe('keep me')
  })

  it('retries a failing save after 2, 5 and then 10 seconds', async () => {
    await mount()
    failPuts = 3
    type('x')
    await tick(AUTOSAVE_MS)
    expect(puts).toHaveLength(1)
    expect(screen.getByText('Save failed, retrying')).toBeTruthy()
    await tick(RETRY_MS[0] - 1)
    expect(puts).toHaveLength(1)
    await tick(1)
    expect(puts).toHaveLength(2)
    await tick(RETRY_MS[1])
    expect(puts).toHaveLength(3)
    await tick(RETRY_MS[2])
    expect(puts).toHaveLength(4)
    expect(disk?.content).toBe('x')
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('saves what it holds when its pane goes without a close — its worktree stopped', async () => {
    const view = await mount()
    type('unsaved')
    view.unmount()
    await tick(0)
    expect(puts.map((p) => p.content)).toEqual(['unsaved'])
    expect(onDisk()?.content).toBe('unsaved')
    expect(useUiStore.getState().dirtyFiles).toEqual({})
    expect(fileSaver(fileKey('w1', 'a.ts'))).toBeUndefined()
  })

  it('keeps a conflicted buffer past an unmount, for the next pane of that file', async () => {
    const view = await mount()
    disk = { content: 'theirs', version: 5 }
    type('mine')
    await tick(AUTOSAVE_MS)
    view.unmount()
    await tick(RETRY_MS[2])
    // Still guarded: the page will not unload it silently.
    expect(useUiStore.getState().dirtyFiles).toEqual({ [fileKey('w1', 'a.ts')]: true })
    await mount()
    expect(editor().value).toBe('mine')
    expect(screen.getByRole('alert').textContent).toContain('Changed on disk')
  })

  it('forgets an unmounted buffer whose worktree is gone, instead of retrying forever', async () => {
    const view = await mount()
    type('orphaned')
    worktreeGone = true
    view.unmount()
    await tick(0)
    await tick(RETRY_MS[2] * 3)
    expect(puts).toHaveLength(1)
    expect(useUiStore.getState().dirtyFiles).toEqual({})
    expect(fileSaver(fileKey('w1', 'a.ts'))).toBeUndefined()
  })

  it('stops saving a mounted buffer whose worktree is gone, says so, and forgets it on unmount', async () => {
    const view = await mount()
    worktreeGone = true
    type('orphaned')
    await tick(AUTOSAVE_MS)
    await tick(RETRY_MS[2] * 3)
    expect(puts).toHaveLength(1)
    expect(screen.getByText(/This worktree is gone/)).toBeTruthy()
    view.unmount()
    await tick(0)
    expect(useUiStore.getState().dirtyFiles).toEqual({})
    expect(fileSaver(fileKey('w1', 'a.ts'))).toBeUndefined()
  })

  it('drops a buffer closed on purpose without saving it', async () => {
    const view = await mount()
    type('thrown away')
    discardFileSavers([fileKey('w1', 'a.ts')])
    view.unmount()
    await tick(AUTOSAVE_MS * 3)
    expect(puts).toEqual([])
    expect(useUiStore.getState().dirtyFiles).toEqual({})
  })

  it('lands its text for a close, and reports a paused conflict as unable to', async () => {
    await mount()
    type('closing')
    expect(await act(() => flushFileSavers([fileKey('w1', 'a.ts')]))).toBe(true)
    expect(disk?.content).toBe('closing')
    disk = { content: 'theirs', version: 9 }
    type('again')
    expect(await act(() => flushFileSavers([fileKey('w1', 'a.ts')]))).toBe(false)
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
