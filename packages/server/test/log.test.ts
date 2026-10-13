import { describe, it, expect } from 'vitest'
import { errorText } from '#log'

describe('errorText', () => {
  it('appends each cause, and stops on a chain that loops', () => {
    const db = new Error('invalid input syntax for type uuid: "demo"')
    const query = new Error('Failed query: select 1', { cause: db })
    expect(errorText(query)).toBe(
      'Error: Failed query: select 1\n  caused by: Error: invalid input syntax for type uuid: "demo"',
    )
    expect(errorText('plain')).toBe('plain')

    const a = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b
    expect(errorText(a).split('\n')).toHaveLength(6)
  })
})
