import { describe, expect, test } from 'bun:test'
import { getMcpServerSignature } from 'src/mcp/config.js'

describe('getMcpServerSignature', () => {
  test('a stdio server is its command line, as before, when it sets no cwd', () => {
    expect(getMcpServerSignature({ command: 'npx', args: ['srv'] })).toBe('stdio:["npx","srv"]')
  })

  test('the same command in another directory is another server', () => {
    const here = getMcpServerSignature({ command: 'npx', args: ['srv'], cwd: '/a' })
    const there = getMcpServerSignature({ command: 'npx', args: ['srv'], cwd: '/b' })
    expect(here).toBe('stdio:["npx","srv"]@/a')
    expect(here).not.toBe(there)
  })

  test('a remote server is its url, and an sdk server has none', () => {
    expect(getMcpServerSignature({ type: 'http', url: 'https://srv/mcp' })).toBe('url:https://srv/mcp')
    expect(getMcpServerSignature({ type: 'sdk', name: 'x' })).toBeNull()
  })
})
