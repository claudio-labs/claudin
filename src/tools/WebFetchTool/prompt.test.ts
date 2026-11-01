import { describe, expect, test } from 'bun:test'

import { DESCRIPTION } from 'src/tools/WebFetchTool/prompt.js'

describe('WebFetch full description', () => {
  // gh runs through the Git tool, and Bash steers it there too.
  test('sends GitHub URLs to gh through the Git tool', () => {
    expect(DESCRIPTION).toContain('prefer the gh CLI through the Git tool')
    expect(DESCRIPTION).not.toContain('via Bash')
  })
})
