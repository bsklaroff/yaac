import { useState, type JSX } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, render, waitFor } from '@testing-library/react'

// CodeMirror doesn't run under jsdom; each editor gets a textarea.
vi.mock('#components/CodeEditor', () => ({
  CodeEditor: ({ value, onChange, readOnly }: { value: string; onChange: (v: string) => void; readOnly?: boolean }) => (
    <textarea aria-label="editor" value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} />
  ),
}))

import { FileEditor } from '#components/settings/FileEditor'

afterEach(cleanup)

const editors = (): HTMLTextAreaElement[] => screen.getAllByLabelText<HTMLTextAreaElement>('editor')

describe('FileEditor', () => {
  it('expands into a titled overlay over the same text, with its footer, and keeps an edit made there', async () => {
    function Holder(): JSX.Element {
      const [text, setText] = useState('FROM a')
      return <FileEditor title="node · Dockerfile" language="dockerfile" value={text} onChange={setText} footer={<span>footer</span>} />
    }
    render(<Holder />)
    expect(screen.queryByText('node · Dockerfile')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Expand editor' }))
    await screen.findByText('node · Dockerfile')
    expect(editors().map((e) => e.value)).toEqual(['FROM a', 'FROM a'])
    expect(screen.getAllByText('footer')).toHaveLength(2)
    fireEvent.change(editors()[1], { target: { value: 'FROM b' } })
    expect(editors()[0].value).toBe('FROM b')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse editor' }))
    await waitFor(() => expect(editors().map((e) => e.value)).toEqual(['FROM b']))
  })

  it('is read-only in both places without a change handler', async () => {
    render(<FileEditor title="rev 1" language="dockerfile" value="FROM a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand editor' }))
    await screen.findByText('rev 1')
    expect(editors().map((e) => e.readOnly)).toEqual([true, true])
  })
})
