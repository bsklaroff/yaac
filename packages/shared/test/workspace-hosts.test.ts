import { describe, it, expect } from 'vitest'
import { namesWorkspace, parseWorkspaceHost, workspaceHostUrl, workspaceHostname } from '#workspace-hosts'

const ID = '4bfc59c6-1e83-4dd0-80f1-735294d5d2bb'

describe('workspaceHostname', () => {
  it('names the port under the workspace\'s own label', () => {
    expect(workspaceHostname(ID, 3000)).toBe('3000.4bfc59c6.localhost')
  })
})

describe('workspaceHostUrl', () => {
  it('reaches the name at the router\'s port, over http', () => {
    expect(workspaceHostUrl(ID, 5173, 8787)).toBe('http://5173.4bfc59c6.localhost:8787/')
  })
})

describe('parseWorkspaceHost', () => {
  it('reads back what workspaceHostname writes, with or without a port and in any case', () => {
    expect(parseWorkspaceHost(`${workspaceHostname(ID, 3000)}:8787`)).toEqual({ port: 3000, idPrefix: '4bfc59c6' })
    expect(parseWorkspaceHost('3000.4BFC59C6.LOCALHOST')).toEqual({ port: 3000, idPrefix: '4bfc59c6' })
    expect(parseWorkspaceHost('3000.4bfc59c6.localhost.')).toEqual({ port: 3000, idPrefix: '4bfc59c6' })
  })

  it('names nothing for the server\'s own hosts or a malformed name', () => {
    for (const host of [
      'localhost:8787', '127.0.0.1:8787', 'srv.example.ts.net', '3000.localhost',
      'web.4bfc59c6.localhost', '3000.4bfc59c.localhost', '0.4bfc59c6.localhost',
      '70000.4bfc59c6.localhost', '3000.4bfc59c6.localhost.evil.com', '',
    ]) expect(parseWorkspaceHost(host), host).toBeNull()
  })
})

describe('namesWorkspace', () => {
  it('matches a name for the given workspace, in any case, with or without a port', () => {
    expect(namesWorkspace('3000.4bfc59c6.localhost', ID)).toBe(true)
    expect(namesWorkspace('8787.4BFC59C6.localhost:8786', ID.toUpperCase())).toBe(true)
  })

  it('refuses another workspace, no workspace, a non-name and the trailing-dot form', () => {
    expect(namesWorkspace('3000.00000000.localhost', ID)).toBe(false)
    expect(namesWorkspace('3000.4bfc59c6.localhost', undefined)).toBe(false)
    expect(namesWorkspace('localhost:8787', ID)).toBe(false)
    expect(namesWorkspace('3000.4bfc59c6.localhost.', ID)).toBe(false)
    expect(namesWorkspace('3000.4bfc59c6.localhost.:8787', ID)).toBe(false)
  })
})
