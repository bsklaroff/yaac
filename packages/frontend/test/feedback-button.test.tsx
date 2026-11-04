import { describe, it, expect, beforeAll, onTestFinished } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { FeedbackButton } from '#components/FeedbackButton'
import { mockFetch, renderWithClient, serverSnapshot, testQueryClient } from './harness'

/** jsdom decodes no images, so the downscale's bitmap is faked; an image
 *  this small is sent unchanged. */
beforeAll(() => {
  globalThis.createImageBitmap ??= (() => Promise.resolve({ width: 8, height: 8, close: () => {} })) as
    unknown as typeof createImageBitmap
})

describe('FeedbackButton', () => {
  it('is absent on a server with no feedback endpoint', () => {
    renderWithClient(<FeedbackButton />, testQueryClient(undefined, serverSnapshot({ feedbackHost: null })))
    expect(screen.queryByRole('button', { name: 'Send feedback' })).toBeNull()
  })

  it('sends the words, a pasted screenshot and this client, then clears the form', async () => {
    const server = mockFetch({ 'POST /api/feedback': { host: 'feedback.example.test' } })
    // As the iPhone app's bridge describes itself.
    const shell = window as unknown as { yaacWindow?: unknown }
    shell.yaacWindow = { app: { kind: 'ios', version: '0.1.0', build: '2' } }
    onTestFinished(() => { delete shell.yaacWindow })
    renderWithClient(<FeedbackButton />, testQueryClient(undefined, serverSnapshot({ feedbackHost: 'feedback.example.test' })))
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    const box = await screen.findByPlaceholderText<HTMLTextAreaElement>(/what's working/i)
    // The form says where the report goes.
    expect(screen.getByText('feedback.example.test')).toBeTruthy()

    const png = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'shot.png', { type: 'image/png' })
    fireEvent.paste(box, { clipboardData: { types: ['Files'], files: [png], getData: () => '' } })
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(1))
    fireEvent.change(box, { target: { value: 'the sidebar flickers' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByText('Thanks — sent.')).toBeTruthy())
    // The unit tests run unbuilt, so the webapp has no build stamp.
    expect(server.called('POST /api/feedback')[0].body).toEqual({
      message: 'the sidebar flickers',
      images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
      client: { userAgent: navigator.userAgent, app: { kind: 'ios', version: '0.1.0', build: '2' } },
    })
    expect(box.value).toBe('')
    expect(document.querySelectorAll('img')).toHaveLength(0)
  })
})
