// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ForwardedPortLinks, portLinkLabel } from '@/frontend/components/ForwardedPortLinks'

// Auto-cleanup only registers when vitest runs with globals; this suite
// doesn't, so unmount explicitly to keep renders isolated.
afterEach(cleanup)

describe('portLinkLabel', () => {
  it('shows just the port when host and container ports match', () => {
    expect(portLinkLabel({ containerPort: 3000, hostPort: 3000 })).toBe(':3000')
  })

  it('appends the container port when the host port differs', () => {
    expect(portLinkLabel({ containerPort: 8787, hostPort: 9787 })).toBe(':9787→8787')
  })
})

describe('ForwardedPortLinks', () => {
  it('renders a localhost link per forwarded port, opening in a new tab', () => {
    render(
      <ForwardedPortLinks
        ports={[
          { containerPort: 8787, hostPort: 9787 },
          { containerPort: 5432, hostPort: 5432 },
        ]}
        iconSize={11}
      />,
    )

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'http://localhost:9787',
      'http://localhost:5432',
    ])
    for (const a of links) expect(a.getAttribute('target')).toBe('_blank')
  })

  it('titles each link with the localhost URL and container port', () => {
    render(<ForwardedPortLinks ports={[{ containerPort: 8787, hostPort: 9787 }]} iconSize={11} />)

    const link = screen.getByRole('link')
    expect(link.getAttribute('title')).toBe('Open localhost:9787 (container port 8787)')
    expect(link.textContent).toBe(':9787→8787')
  })
})
