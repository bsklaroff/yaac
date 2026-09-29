// @vitest-environment jsdom
import type { JSX } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'

afterEach(cleanup)

const URL = 'https://github.com/acme/widgets.git'

function renderDialog(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}): { onConfirm: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn()
  render(
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="Remove?"
      description="Gone forever."
      onConfirm={onConfirm}
      {...props}
    />,
  )
  return { onConfirm }
}

describe('ConfirmDialog', () => {
  it('confirms directly when no confirmText is set', () => {
    const { onConfirm } = renderDialog()
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Delete' })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('keeps confirm disabled until the exact confirmText is typed', () => {
    const { onConfirm } = renderDialog({ confirmText: URL })
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Delete' })
    const input = screen.getByRole('textbox')

    expect(confirm.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'https://github.com/acme/widgets' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: URL } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('confirms on Enter in the input only once matched', () => {
    const { onConfirm } = renderDialog({ confirmText: URL })
    const input = screen.getByRole('textbox')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: URL } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fails closed on an empty confirmText', () => {
    renderDialog({ confirmText: '' })
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Delete' })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    expect(confirm.disabled).toBe(true)
  })

  it('resets the typed text when the dialog reopens', () => {
    const onConfirm = vi.fn()
    const props = {
      onOpenChange: () => {},
      title: 'Remove?',
      description: 'Gone forever.',
      confirmText: URL,
      onConfirm,
    }
    const { rerender } = render(<ConfirmDialog open {...props} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: URL } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Delete' }).disabled).toBe(false)

    rerender(<ConfirmDialog open={false} {...props} />)
    rerender(<ConfirmDialog open {...props} />)
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Delete' }).disabled).toBe(true)
  })

  describe('focus on close', () => {
    const props = { onOpenChange: () => {}, title: 'Remove?', description: 'Gone forever.', onConfirm: () => {} }
    function Page({ open, withB = true }: { open: boolean; withB?: boolean }): JSX.Element {
      return (
        <>
          <button type="button">A</button>
          {withB && <button type="button">B</button>}
          <ConfirmDialog open={open} {...props} />
        </>
      )
    }
    const button = (name: string): HTMLElement => screen.getByRole('button', { name })
    const settled = async (): Promise<void> => {
      await waitFor(() => { expect(screen.queryByRole('alertdialog')).toBeNull() })
      await new Promise((r) => setTimeout(r, 0))
    }
    // Opening once from A leaves A in Base UI's fallback history.
    async function openFromA(rerender: (ui: JSX.Element) => void): Promise<void> {
      button('A').focus()
      rerender(<Page open />)
      await screen.findByRole('alertdialog')
      rerender(<Page open={false} />)
      await settled()
    }

    it('returns focus to the element that held it when the dialog opened', async () => {
      const { rerender } = render(<Page open={false} />)
      await openFromA(rerender)
      expect(document.activeElement).toBe(button('A'))
    })

    it('leaves focus alone when nothing held it, rather than refocusing an earlier opener', async () => {
      const { rerender } = render(<Page open={false} />)
      await openFromA(rerender)
      button('A').blur()
      rerender(<Page open />)
      await screen.findByRole('alertdialog')
      rerender(<Page open={false} />)
      await settled()
      expect(document.activeElement).toBe(document.body)
    })

    it('falls back to Base UI\'s choice when the opener has left the page', async () => {
      const { rerender } = render(<Page open={false} />)
      await openFromA(rerender)
      button('B').focus()
      rerender(<Page open />)
      await screen.findByRole('alertdialog')
      rerender(<Page open withB={false} />)
      rerender(<Page open={false} withB={false} />)
      await settled()
      expect(document.activeElement).toBe(button('A'))
    })
  })
})
