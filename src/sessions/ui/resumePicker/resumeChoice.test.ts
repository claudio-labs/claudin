import { describe, expect, test } from 'bun:test'
import { resumeSteps } from 'src/sessions/ui/resumePicker/resumeChoice.js'

describe('resumeSteps', () => {
  const TAKE_OVER = [
    'take the session id',
    'rename the recording',
    'reset the session file pointer',
    'restore the cost so far',
    'enter the worktree',
    'adopt the transcript',
  ]

  test('a resume runs every step, the mode first and the transcript last', () => {
    const names = resumeSteps(false).map(step => step.name)
    expect(names[0]).toBe('match the session mode')
    expect(names.at(-1)).toBe('adopt the transcript')
    for (const name of TAKE_OVER) expect(names).toContain(name)
    // The agent comes back before its mode is recorded, and the metadata before the worktree.
    expect(names.indexOf('restore the agent')).toBeLessThan(names.indexOf('record the session mode'))
    expect(names.indexOf('restore the metadata')).toBeLessThan(names.indexOf('enter the worktree'))
  })

  test('a fork skips every step that would take the session over', () => {
    const names = resumeSteps(true).map(step => step.name)
    expect(names).toEqual([
      'match the session mode',
      'restore the agent',
      'record the session mode',
      'restore the agent context',
      'update the session name',
      'restore the metadata',
    ])
  })
})
