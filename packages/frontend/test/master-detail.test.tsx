import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

import { MasterDetail } from '#components/MasterDetail'

afterEach(cleanup)

describe('MasterDetail', () => {
  const panes = (detailOpen: boolean): HTMLElement => {
    const { container } = render(
      <MasterDetail
        detailOpen={detailOpen}
        onBack={() => {}}
        master={<p>the list</p>}
        detail={<p>the detail</p>}
      />,
    )
    return container.firstElementChild as HTMLElement
  }

  it('keeps both panes mounted and hides one of them only below the breakpoint', () => {
    // Desktop shows both panes, so hiding is `max-md:` only, on whichever
    // pane detailOpen hides.
    const closed = panes(false)
    const [masterClosed, detailClosed] = Array.from(closed.children) as HTMLElement[]
    expect(masterClosed.className).not.toContain('max-md:hidden')
    expect(detailClosed.className).toContain('max-md:hidden')

    cleanup()
    const open = panes(true)
    const [masterOpen, detailOpen] = Array.from(open.children) as HTMLElement[]
    expect(masterOpen.className).toContain('max-md:hidden')
    expect(detailOpen.className).not.toContain('max-md:hidden')
    // Both stay mounted, so going back doesn't refetch.
    expect(screen.getByText('the list')).toBeTruthy()
    expect(screen.getByText('the detail')).toBeTruthy()
  })

  it('offers a back control that is desktop-hidden and clears the selection', () => {
    const onBack = vi.fn()
    render(
      <MasterDetail
        detailOpen
        onBack={onBack}
        backLabel="Back to skills"
        master={<p>the list</p>}
        detail={<p>the detail</p>}
      />,
    )
    const back = screen.getByRole('button', { name: 'Back to skills' })
    // No back chevron on desktop, where both panes show.
    expect(back.className).toContain('md:hidden')
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
