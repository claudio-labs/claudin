import { describe, expect, test } from 'bun:test'
import { isPreapprovedHost } from 'src/tools/WebFetchTool/preapproved.js'

describe('isPreapprovedHost — claudiolabs.ai', () => {
  test('the docs host is preapproved on apex and www', () => {
    expect(isPreapprovedHost('claudiolabs.ai', '/llms.txt')).toBe(true)
    expect(isPreapprovedHost('www.claudiolabs.ai', '/docs/agents.md')).toBe(
      true,
    )
  })

  test('lookalike hosts are not', () => {
    expect(isPreapprovedHost('evilclaudiolabs.ai', '/llms.txt')).toBe(false)
    expect(isPreapprovedHost('claudiolabs.ai.evil.com', '/llms.txt')).toBe(
      false,
    )
    expect(isPreapprovedHost('docs.claudiolabs.ai', '/llms.txt')).toBe(false)
  })
})
