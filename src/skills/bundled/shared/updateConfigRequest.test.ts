import { describe, expect, test } from 'bun:test'

import { parseUpdateConfigRequest } from 'src/skills/bundled/shared/updateConfigRequest.js'

describe('parseUpdateConfigRequest', () => {
  test('anything but the prefix asks for the full guidance, with the text as the request', () => {
    expect(parseUpdateConfigRequest('')).toEqual({ mode: 'full', request: undefined })
    expect(parseUpdateConfigRequest('  allow npm test \n')).toEqual({
      mode: 'full',
      request: 'allow npm test',
    })
  })

  test('a blank request is no request', () => {
    expect(parseUpdateConfigRequest(' \t\n ')).toEqual({ mode: 'full', request: undefined })
  })

  test('[hooks-only] asks for the hooks reference, with the rest of the line as the task', () => {
    expect(parseUpdateConfigRequest('[hooks-only]')).toEqual({ mode: 'hooks-only', task: undefined })
    expect(parseUpdateConfigRequest('[hooks-only]  \t ')).toEqual({ mode: 'hooks-only', task: undefined })
    expect(parseUpdateConfigRequest('[hooks-only] PostToolUse format hook  ')).toEqual({
      mode: 'hooks-only',
      task: 'PostToolUse format hook',
    })
  })

  test('the prefix counts only as the exact text at the very start', () => {
    expect(parseUpdateConfigRequest(' [hooks-only] x')).toEqual({ mode: 'full', request: '[hooks-only] x' })
    expect(parseUpdateConfigRequest('[HOOKS-ONLY] x')).toEqual({ mode: 'full', request: '[HOOKS-ONLY] x' })
  })
})
