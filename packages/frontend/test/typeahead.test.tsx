// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { Typeahead, type TypeaheadItem } from '#components/ui/Typeahead'

afterEach(cleanup)

const MODELS: TypeaheadItem[] = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5', detail: 'claude-opus-5-5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', detail: 'claude-sonnet-5' },
]

function field(props: Partial<Parameters<typeof Typeahead>[0]> = {}): { onSelect: ReturnType<typeof vi.fn> } {
  const onSelect = vi.fn()
  render(
    <Typeahead items={MODELS} query="" onQueryChange={() => {}} onSelect={onSelect} showList ariaLabel="Model" {...props} />,
  )
  return { onSelect }
}

const rows = (): string[] => within(screen.getByRole('list')).getAllByRole('button').map((b) => b.textContent ?? '')

describe('Typeahead', () => {
  it('finds an item by its label or its value, and shows both', () => {
    field({ query: 'sonnet' })
    expect(rows()).toEqual(['Sonnet 5claude-sonnet-5'])
    cleanup()
    field({ query: 'claude-opus' })
    expect(rows()).toEqual(['Opus 5.5claude-opus-5-5'])
  })

  // Enter is the form's submit unless a row is highlighted — so a field whose
  // typed text is a value (a branch) highlights nothing until asked, and one
  // whose text is a search (a model) highlights the first match as you type.
  it('picks the highlighted row on Enter, and leaves an unhighlighted Enter to the form', () => {
    const formKey = vi.fn()
    const onSelect = vi.fn()
    render(
      <div onKeyDown={(e) => { if (e.key === 'Enter') formKey() }}>
        <Typeahead items={MODELS} query="" onQueryChange={() => {}} onSelect={onSelect} showList ariaLabel="Model" />
      </div>,
    )
    const input = screen.getByLabelText('Model')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
    expect(formKey).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('claude-sonnet-5')
    expect(formKey).toHaveBeenCalledTimes(1) // taken, not bubbled
  })

  it('highlights the first match as the user types when asked to', () => {
    const { onSelect } = field({ autoHighlight: true })
    const input = screen.getByLabelText('Model')
    fireEvent.change(input, { target: { value: 'o' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('claude-opus-5-5')
  })

  it('offers typed text no item matches exactly as a free entry', () => {
    const { onSelect } = field({
      query: 'claude-next',
      freeEntry: (text) => ({ value: text, label: `Use "${text}"` }),
    })
    fireEvent.click(screen.getByText('Use "claude-next"'))
    expect(onSelect).toHaveBeenCalledWith('claude-next')
    cleanup()
    // Not when it already is an item.
    field({ query: 'claude-opus-5-5', freeEntry: (text) => ({ value: text, label: `Use "${text}"` }) })
    expect(screen.queryByText('Use "claude-opus-5-5"')).toBeNull()
  })

  it('renders the icon and tag slots', () => {
    field({
      icon: (p) => <span data-testid="glyph" data-size={p.size} />,
      tag: (item) => item.value === 'claude-opus-5-5' && <span>default</span>,
    })
    expect(screen.getAllByTestId('glyph')).toHaveLength(3) // input + two rows
    expect(within(screen.getByRole('list')).getAllByText('default')).toHaveLength(1)
  })
})
