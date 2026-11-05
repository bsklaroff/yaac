import { describe, it, expect, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { Whoami } from '@yaac/shared/types'
import { SettingsButton } from '#components/SettingsButton'
import { useUiStore } from '#lib/store'
import { TEST_USER_ID, mockFetch, renderWithClient, serverError, testQueryClient } from './harness'

/*
 * Settings → Users (docs/multi-user.md "Roles"): a tailnet install's users
 * and roles, which an admin changes and a member only reads.
 */

const whoami = (myRole: 'admin' | 'member'): Whoami => ({
  kind: 'tailnet', userId: TEST_USER_ID, login: 'me@x.com', name: 'Me',
  users: [
    { id: TEST_USER_ID, login: 'me@x.com', name: 'Me', role: myRole },
    { id: 'u-ada', login: 'ada@x.com', name: 'Ada', role: 'member' },
  ],
})

beforeEach(() => {
  useUiStore.setState({ settingsOpen: true, settingsSection: 'users' })
})

const rowOf = (name: string) => within(screen.getByText(name).closest<HTMLElement>('.rounded-md')!)

describe('Settings → Users', () => {
  it('lets an admin set roles, showing the server\'s refusal', async () => {
    const server = mockFetch({
      'GET /api/whoami': whoami('admin'),
      'PUT /api/users/u-ada/role': undefined,
      'PUT /api/users/u-me/role': serverError('CONFLICT', 'me@x.com is this install\'s last admin', 409),
    })
    renderWithClient(<SettingsButton />, testQueryClient(whoami('admin')))
    expect(screen.getByText(/Admins publish sites and choose who else is an admin/)).toBeTruthy()

    fireEvent.change(rowOf('Ada').getByRole('combobox', { name: 'Role of ada@x.com' }), { target: { value: 'admin' } })
    await waitFor(() => expect(server.called('PUT /api/users/u-ada/role')[0]?.body).toEqual({ role: 'admin' }))

    fireEvent.change(rowOf('Me (you)').getByRole('combobox'), { target: { value: 'member' } })
    expect(await screen.findByText(/last admin/)).toBeTruthy()
  })

  it('shows a member the roles without controls, and is absent on a local install', () => {
    mockFetch({ 'GET /api/whoami': whoami('member') })
    const view = renderWithClient(<SettingsButton />, testQueryClient(whoami('member')))
    expect(rowOf('Ada').getByText('Member')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    view.unmount()

    useUiStore.setState({ settingsSection: 'general' })
    mockFetch({})
    renderWithClient(<SettingsButton />)
    expect(screen.queryByRole('button', { name: 'Users' })).toBeNull()
  })
})
