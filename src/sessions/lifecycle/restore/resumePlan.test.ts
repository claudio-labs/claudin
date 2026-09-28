import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'

import { planResume } from 'src/sessions/lifecycle/restore/resumePlan.js'
import { asSessionId } from 'src/shared/types/ids.js'

describe('planResume', () => {
  const loaded = randomUUID()

  test('a fork takes nothing over, whatever session id it is given', () => {
    const plan = planResume(
      { sessionId: loaded },
      { forkSession: true, sessionIdOverride: randomUUID(), transcriptPath: '/p/a.jsonl' },
    )

    expect(plan).toEqual({ kind: 'fork' })
  })

  test("the override names the session taken over, ahead of the transcript's own id", () => {
    const chosen = randomUUID()

    const plan = planResume({ sessionId: loaded }, { forkSession: false, sessionIdOverride: chosen })

    expect(plan).toEqual({ kind: 'takeOver', sessionId: asSessionId(chosen), projectDir: null })
  })

  test('a transcript path makes its directory the project directory', () => {
    const plan = planResume(
      { sessionId: loaded },
      { forkSession: false, transcriptPath: '/elsewhere/project/abc.jsonl' },
    )

    expect(plan).toEqual({
      kind: 'takeOver',
      sessionId: asSessionId(loaded),
      projectDir: '/elsewhere/project',
    })
  })

  test('with no session id anywhere the current session stays', () => {
    expect(planResume({ sessionId: undefined }, { forkSession: false })).toEqual({ kind: 'stay' })
  })
})
