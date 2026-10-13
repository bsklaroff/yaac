// @vitest-environment-options { "url": "https://srv.tail1234.ts.net/" }
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PhoneLinkField, phoneLink } from '#components/settings/PhoneLink'


describe('phoneLink', () => {
  it('links the iPhone app to an https origin, and to nothing else', () => {
    expect(phoneLink('https://srv.tail1234.ts.net')).toBe('yaac://connect?origin=https%3A%2F%2Fsrv.tail1234.ts.net')
    expect(phoneLink('http://127.0.0.1:8787')).toBeNull()
    expect(phoneLink('http://srv.tail1234.ts.net:19500')).toBeNull()
  })
})

describe('PhoneLinkField', () => {
  it('shows a QR code of this page\'s origin', () => {
    render(<PhoneLinkField />)
    const qr = screen.getByRole('img', { name: 'QR code for yaac://connect?origin=https%3A%2F%2Fsrv.tail1234.ts.net' })
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d/)
    expect(screen.getByText('Open on your phone')).toBeTruthy()
  })
})
