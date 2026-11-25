import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { STOCK_IMAGE_ID, type ImageSummary, type ProjectSummary } from '@yaac/shared/types'

// CodeMirror doesn't run under jsdom; each file editor gets a textarea.
vi.mock('#components/CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

import { ProjectSettings } from '#components/settings/ProjectSettings'
import { UserImagePane } from '#components/settings/Images'
import { SettingsDialog } from '#components/SettingsButton'
import { useUiStore } from '#lib/store'
import {
  imageBuild, imageRevision, imageSummary, mockFetch, projectRepo, renderWithClient, serverSnapshot, testQueryClient,
  TEST_USER_ID, type FetchCall, type FetchMock,
} from './harness'

afterEach(() => {
  cleanup()
  useUiStore.setState({ settingsProjectId: null, settingsOpen: false, settingsSection: 'general' })
  useUiStore.getState().openBuild(null)
})

const PROJECT: ProjectSummary = {
  id: 'id-alpha', name: 'alpha', addedAt: '', owner: TEST_USER_ID, workspaceCount: 0, stoppedCount: 0, deaths: 0,
  deathsSeenBy: {}, createDefaults: {}, repos: [projectRepo()], scratchDirs: { dirs: [], sizeGiB: 32, ignoredTracked: [] },
  portForwards: [], cacheVolumes: {}, npmCache: true,
}

const STOCK = imageSummary({ id: STOCK_IMAGE_ID, name: 'yaac', isDefault: true })
const NODE = imageSummary({ latestBuildId: 'build-1' })

/** Show alpha's Images page over `routes`, which list `images`. */
function renderImages(routes: Record<string, unknown>, images: ImageSummary[] = [STOCK, NODE], project = PROJECT): FetchMock {
  useUiStore.setState({ activeProjectId: 'id-alpha' })
  const server = mockFetch({ 'GET /api/image/project/id-alpha': () => images, ...routes })
  renderWithClient(<ProjectSettings page="images" />, testQueryClient(undefined, serverSnapshot({ projects: [project] })))
  return server
}

const editors = (): HTMLTextAreaElement[] => screen.getAllByLabelText<HTMLTextAreaElement>('editor')

describe('Images settings', () => {
  it('lists the stock image first, read-only, and makes a new image from a name and a Dockerfile', async () => {
    const images = [STOCK, NODE, imageSummary({ id: 'img-2', name: 'rust', state: 'failed' })]
    const server = renderImages({
      'POST /api/image/project/id-alpha': () => {
        const made = imageSummary({ id: 'img-9', name: 'py', state: 'never-built' })
        images.push(made)
        return made
      },
      'GET /api/image/img-9': { image: imageSummary({ id: 'img-9', name: 'py' }), revision: imageRevision({ id: 'rev-9', imageId: 'img-9' }) },
    }, images)

    await screen.findByRole('button', { name: 'Open image node' })
    const rows = screen.getAllByRole('button', { name: /^Open image/ }).map((b) => b.textContent)
    expect(rows).toEqual(['yaacstockdefault', 'nodeready', 'rustbuild failed'])

    fireEvent.click(screen.getByRole('button', { name: 'Open image yaac' }))
    expect(screen.getByText(/It is read-only/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete image' })).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    // The project-wide settings are on the list, not in an image.
    expect(screen.queryByRole('checkbox', { name: 'npm cache' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to images' }))
    expect(screen.getByRole('checkbox', { name: 'npm cache' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'New image' }))
    const create = screen.getByRole<HTMLButtonElement>('button', { name: 'Create image' })
    fireEvent.change(screen.getByLabelText('Image name'), { target: { value: 'yaac' } })
    expect(screen.getByText('“yaac” is the stock image')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Image name'), { target: { value: 'Py' } })
    expect(create.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Image name'), { target: { value: 'py' } })
    expect(editors()[0].value).toBe('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n')
    fireEvent.change(editors()[0], { target: { value: 'FROM python:3\n' } })
    fireEvent.click(create)

    await screen.findByRole('heading', { name: 'py' })
    expect(server.called('POST /api/image/project/id-alpha').map((c) => c.body)).toEqual([
      { name: 'py', dockerfile: 'FROM python:3\n', files: {} },
    ])
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Dockerfile', 'Revisions', 'Builds'])
  })

  it('edits the Dockerfile and support files, saves them as one revision, and shows the build and its warnings', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('bin/blob.bin')
    const server = renderImages({
      'GET /api/image/img-1': { image: NODE, revision: imageRevision({ files: { 'old.txt': { sha256: 'h-old', size: 3 } } }) },
      'GET /api/image/img-1/revisions/rev-1/file': { binary: false, content: 'old' },
      'GET /api/image/builds/build-1': imageBuild({ status: 'failed', warnings: [{ message: 'JSONArgsRecommended', line: 2 }] }),
      'POST /api/image/img-1/files': ({ body }: FetchCall) => {
        const { content } = body as { content?: string }
        return content !== undefined ? { sha256: `h-${content}`, size: content.length } : { sha256: 'h-bin', size: 3 }
      },
      'PUT /api/image/img-1': { revision: imageRevision({ id: 'rev-2', number: 2 }), changed: true },
    })
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Open image node' }))
      await waitFor(() => expect(editors()[0].value).toBe('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'))
      const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' })
      expect(save.disabled).toBe(true)

      // The newest build of the current revision, its warning beside its line.
      const warnings = await screen.findByRole('list', { name: 'Check warnings' })
      expect(within(warnings).getByText('Line 2: JSONArgsRecommended')).toBeTruthy()
      expect(within(warnings).getByText('FROM ${BASE_IMAGE}')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Open build' }))
      expect(useUiStore.getState().buildPageId).toBe('build-1')

      fireEvent.change(editors()[0], { target: { value: 'FROM node:22\n' } })
      // An upload sends the bytes now and keeps their hash.
      fireEvent.change(screen.getByLabelText('Upload files'), { target: { files: [new File([new Uint8Array([1, 2, 3])], 'blob.bin')] } })
      await screen.findByText('blob.bin')
      expect(server.called('POST /api/image/img-1/files').map((c) => c.body)).toEqual([{ contentBase64: 'AQID' }])
      fireEvent.click(screen.getByRole('button', { name: 'Rename blob.bin' }))
      expect(screen.getByText('bin/blob.bin')).toBeTruthy()
      // A stored file opens at its saved text; typed text goes up at save.
      fireEvent.click(screen.getByRole('button', { name: 'old.txt' }))
      await waitFor(() => expect(editors()).toHaveLength(2))
      expect(editors()[1].value).toBe('old')
      fireEvent.change(editors()[1], { target: { value: 'new' } })
      fireEvent.change(screen.getByPlaceholderText(/new file path/), { target: { value: 'a.txt' } })
      fireEvent.click(screen.getByRole('button', { name: 'New file' }))
      fireEvent.change(editors()[1], { target: { value: 'hi' } })
      fireEvent.change(screen.getByLabelText('Revision note'), { target: { value: 'bump node' } })
      fireEvent.click(save)

      await waitFor(() => expect(server.called('PUT /api/image/img-1').map((c) => c.body)).toEqual([{
        dockerfile: 'FROM node:22\n',
        files: {
          'a.txt': { sha256: 'h-hi', size: 2 },
          'bin/blob.bin': { sha256: 'h-bin', size: 3 },
          'old.txt': { sha256: 'h-new', size: 3 },
        },
        note: 'bump node',
      }]))
    } finally {
      promptSpy.mockRestore()
    }
  })

  it('diffs, restores and views revisions, makes the image the default, and deletes it', async () => {
    const revisions = [
      imageRevision({ id: 'rev-3', number: 3, dockerfile: 'FROM node:22\nRUN make\n', note: 'add make', buildStatus: 'succeeded' }),
      imageRevision({ id: 'rev-2', number: 2, dockerfile: 'FROM node:22\n', files: { 'a.txt': { sha256: 'h1', size: 1 } } }),
      imageRevision({ id: 'rev-1', number: 1, dockerfile: 'FROM node:20\n', missingFiles: ['big.tar'] }),
    ]
    const images = [STOCK, imageSummary({ currentRevision: { id: 'rev-3', number: 3, createdAt: '' } })]
    const server = renderImages({
      'GET /api/image/img-1': { image: images[1], revision: revisions[0] },
      'GET /api/image/img-1/revisions': revisions,
      'POST /api/image/img-1/revisions/rev-1/restore': { revision: imageRevision({ id: 'rev-4', number: 4 }), droppedFiles: ['big.tar'] },
      'PUT /api/image/project/id-alpha/default': undefined,
      'DELETE /api/image/img-1': () => {
        images.pop()
        return undefined
      },
    }, images)
    fireEvent.click(await screen.findByRole('button', { name: 'Open image node' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Revisions' }))
    await screen.findByText('add make')

    const row = (n: number): HTMLElement => screen.getByText(`#${n}`).parentElement!.parentElement!
    expect(within(row(3)).getByText('current')).toBeTruthy()
    expect(within(row(3)).getByText('succeeded')).toBeTruthy()
    expect(within(row(3)).queryByRole('button', { name: 'Restore' })).toBeNull()
    expect(within(row(1)).queryByRole('button', { name: 'Diff previous' })).toBeNull()

    fireEvent.click(within(row(3)).getByRole('button', { name: 'Diff previous' }))
    const toPrevious = screen.getByLabelText('Diff of revision 2 to 3')
    expect(toPrevious.textContent).toContain('+RUN make')
    expect(toPrevious.textContent).toContain('− a.txt')
    fireEvent.click(within(row(1)).getByRole('button', { name: 'Diff current' }))
    expect(screen.queryByLabelText('Diff of revision 2 to 3')).toBeNull()
    expect(screen.getByLabelText('Diff of revision 1 to 3').textContent).toContain('−FROM node:20')
    fireEvent.click(within(row(2)).getByRole('button', { name: 'View' }))
    expect(editors().map((e) => e.value)).toEqual(['FROM node:22\n'])

    fireEvent.click(within(row(1)).getByRole('button', { name: 'Restore' }))
    expect(await screen.findByText('Restored as revision 4.')).toBeTruthy()
    expect(screen.getByText(/were left out: big.tar/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Set as project default' }))
    await waitFor(() => expect(server.called('PUT /api/image/project/id-alpha/default').map((c) => c.body)).toEqual([{ imageId: 'img-1' }]))

    fireEvent.click(screen.getByRole('button', { name: 'Delete image' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open image node' })).toBeNull())
    expect(server.called('DELETE /api/image/img-1')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Open image yaac' })).toBeTruthy()
  })

  it('lists builds newest first, each opening its page, and builds now with or without the cache', async () => {
    const server = renderImages({
      'GET /api/image/img-1': { image: NODE, revision: imageRevision() },
      'GET /api/image/builds': [
        imageBuild({
          id: 'b2', status: 'succeeded', revisionNumber: 2, reason: 'manual', noCache: true,
          startedAt: '2026-11-20T00:00:00Z', finishedAt: '2026-11-20T00:00:42Z',
        }),
        imageBuild({ id: 'b1', status: 'failed' }),
      ],
      'POST /api/image/img-1/builds': [],
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Open image node' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Builds' }))
    const newest = await screen.findByRole('button', { name: 'Open build of revision 2' })
    expect(newest.textContent).toContain('manual, without cache')
    expect(newest.textContent).toContain('42s')
    expect(server.called('GET /api/image/builds')[0].query.get('imageId')).toBe('img-1')
    fireEvent.click(newest)
    expect(useUiStore.getState().buildPageId).toBe('b2')

    fireEvent.click(screen.getByRole('button', { name: 'Build now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild without cache' }))
    await waitFor(() => expect(server.called('POST /api/image/img-1/builds').map((c) => c.body)).toEqual([
      { projectId: 'id-alpha' }, { noCache: true, projectId: 'id-alpha' },
    ]))
  })

  it('opens a build\'s page over the settings dialog', async () => {
    useUiStore.setState({ activeProjectId: 'id-alpha', settingsOpen: true, settingsSection: 'project-images' })
    mockFetch({
      'GET /api/image/project/id-alpha': [STOCK, NODE],
      'GET /api/image/img-1': { image: NODE, revision: imageRevision() },
      'GET /api/image/builds': [imageBuild({ status: 'succeeded' })],
      'GET /api/image/builds/build-1': imageBuild({ status: 'succeeded' }),
      'GET /api/image/builds/build-1/log': { text: '#1 [1/1] FROM x\n', offset: 16, done: true },
    })
    renderWithClient(<SettingsDialog />, testQueryClient(undefined, serverSnapshot({ projects: [PROJECT] })))
    fireEvent.click(await screen.findByRole('button', { name: 'Open image node' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Builds' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open build of revision 1' }))
    expect(await screen.findByRole('heading', { name: 'node · revision 1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close build' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'node · revision 1' })).toBeNull())
    expect(screen.getByRole('tab', { name: 'Builds' })).toBeTruthy()
  })

  it('sets the build cache age, and puts it back to the default', async () => {
    const server = renderImages({ 'PUT /api/image/project/id-alpha/cache-days': undefined }, [STOCK], { ...PROJECT, imageCacheDays: 14 })
    const days = await screen.findByLabelText<HTMLInputElement>('Build cache age in days')
    expect(days.value).toBe('14')
    fireEvent.change(days, { target: { value: '7' } })
    fireEvent.submit(days.closest('form')!)
    fireEvent.click(screen.getByRole('button', { name: 'Default' }))
    await waitFor(() => expect(server.called('PUT /api/image/project/id-alpha/cache-days').map((c) => c.body)).toEqual([
      { days: 7 }, { days: null },
    ]))
  })
})

describe('UserImagePane', () => {
  it('opens on a layered template until its first save makes the image, then shows its tabs', async () => {
    let image: ImageSummary | null = null
    const server = mockFetch({
      'GET /api/image/user': () => ({ image }),
      'PUT /api/image/user': () => {
        image = imageSummary({ id: 'img-u', scope: 'user', name: 'user' })
        return { revision: imageRevision({ imageId: 'img-u' }), changed: true }
      },
      'GET /api/image/img-u': () => ({ image, revision: imageRevision({ imageId: 'img-u', dockerfile: 'FROM ${BASE_IMAGE}\nRUN x\n' }) }),
    })
    useUiStore.setState({ activeProjectId: 'id-alpha' })
    renderWithClient(<UserImagePane />, testQueryClient(undefined, serverSnapshot({ projects: [PROJECT] })))

    await waitFor(() => expect(editors()[0].value).toBe('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'))
    expect(screen.getByText('Save the Dockerfile once to add files.')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
    fireEvent.change(editors()[0], { target: { value: 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN x\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('tab', { name: 'Revisions' })
    expect(server.called('PUT /api/image/user').map((c) => c.body)).toEqual([
      { dockerfile: 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN x\n', files: {} },
    ])
    await waitFor(() => expect(editors()[0].value).toBe('FROM ${BASE_IMAGE}\nRUN x\n'))
    expect(screen.getByRole('button', { name: 'Upload files' })).toBeTruthy()
  })
})
