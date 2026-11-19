import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { YEmptyState } from '#ui'


const Dot = ({ size }: { size?: number }) => <svg data-testid="icon" width={size} />

describe('YEmptyState', () => {
  it('renders the title and the icon', () => {
    render(<YEmptyState icon={Dot} title="No sessions yet" />)
    expect(screen.getByText('No sessions yet')).toBeTruthy()
    expect(screen.getByTestId('icon')).toBeTruthy()
  })

  it('renders the description when given', () => {
    render(<YEmptyState icon={Dot} title="Empty" description="Start one with +" />)
    expect(screen.getByText('Start one with +')).toBeTruthy()
  })

  it('renders an action when given', () => {
    render(<YEmptyState icon={Dot} title="Empty" action={<button>New session</button>} />)
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy()
  })

  it('omits the icon badge in compact mode', () => {
    render(<YEmptyState icon={Dot} compact title="No sessions yet" />)
    expect(screen.getByText('No sessions yet')).toBeTruthy()
    expect(screen.queryByTestId('icon')).toBeNull()
  })
})
