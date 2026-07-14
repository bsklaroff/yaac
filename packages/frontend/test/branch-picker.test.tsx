// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { BranchPicker } from '#components/BranchPicker'

afterEach(cleanup)

const BRANCHES = ['main', 'dev', 'release/2.x', 'feature/login']

describe('BranchPicker', () => {
  it('filters the list by the query, case-insensitively', () => {
    render(<BranchPicker branches={BRANCHES} query="REL" onQueryChange={() => {}} onSelect={() => {}} showList />)
    const list = screen.getByRole('list')
    expect(within(list).queryByText('release/2.x')).toBeTruthy()
    expect(within(list).queryByText('main')).toBeNull()
    expect(within(list).queryByText('dev')).toBeNull()
  })

  it('caps the list at `limit`', () => {
    const many = Array.from({ length: 20 }, (_, i) => `b${i}`)
    render(<BranchPicker branches={many} query="" onQueryChange={() => {}} onSelect={() => {}} showList limit={5} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })

  it('tags the defaultBranch', () => {
    render(<BranchPicker branches={BRANCHES} defaultBranch="main" query="" onQueryChange={() => {}} onSelect={() => {}} showList />)
    const mainRow = within(screen.getByRole('list')).getByText('main').closest('li')
    expect(mainRow).toBeTruthy()
    expect(within(mainRow as HTMLElement).getByText('default')).toBeTruthy()
  })

  it('calls onQueryChange as the user types', () => {
    const onQueryChange = vi.fn()
    render(<BranchPicker branches={BRANCHES} query="" onQueryChange={onQueryChange} onSelect={() => {}} showList ariaLabel="Base branch" />)
    fireEvent.change(screen.getByLabelText('Base branch'), { target: { value: 'de' } })
    expect(onQueryChange).toHaveBeenCalledWith('de')
  })

  it('calls onSelect when a suggestion is clicked', () => {
    const onSelect = vi.fn()
    render(<BranchPicker branches={BRANCHES} query="" onQueryChange={() => {}} onSelect={onSelect} showList />)
    fireEvent.click(within(screen.getByRole('list')).getByText('dev'))
    expect(onSelect).toHaveBeenCalledWith('dev')
  })

  it('hides the list when showList is false', () => {
    render(<BranchPicker branches={BRANCHES} query="" onQueryChange={() => {}} onSelect={() => {}} showList={false} />)
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('renders the trailing and belowInput slots', () => {
    render(
      <BranchPicker
        branches={BRANCHES}
        query=""
        onQueryChange={() => {}}
        onSelect={() => {}}
        showList={false}
        trailing={<button type="button">pin</button>}
        belowInput={<div>oops</div>}
      />,
    )
    expect(screen.getByText('pin')).toBeTruthy()
    expect(screen.getByText('oops')).toBeTruthy()
  })
})
