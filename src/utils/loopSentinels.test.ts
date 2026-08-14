import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getSessionId, regenerateSessionId, switchSession } from 'src/bootstrap/state.js'
import type { SessionId } from 'src/types/ids.js'
import {
  AUTONOMOUS_LOOP_DYNAMIC_SENTINEL,
  AUTONOMOUS_LOOP_SENTINEL,
  expandLoopSentinelPrompt,
  isLoopSentinelPrompt,
  type LoopMdPaths,
  MAINTENANCE_PROMPT,
  resetLoopSentinelState,
} from './loopSentinels.js'

let dir: string
let paths: LoopMdPaths

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'loop-sentinels-'))
  paths = {
    projectLoopMdPath: join(dir, 'project-loop.md'),
    userLoopMdPath: join(dir, 'user-loop.md'),
  }
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  resetLoopSentinelState()
  for (const p of [paths.projectLoopMdPath, paths.userLoopMdPath]) {
    try {
      unlinkSync(p)
    } catch {
      // already absent
    }
  }
})

describe('isLoopSentinelPrompt', () => {
  test('matches both sentinels, with surrounding whitespace', () => {
    expect(isLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL)).toBe(true)
    expect(isLoopSentinelPrompt(` ${AUTONOMOUS_LOOP_DYNAMIC_SENTINEL}\n`)).toBe(
      true,
    )
    expect(isLoopSentinelPrompt('/loop check CI')).toBe(false)
    expect(
      isLoopSentinelPrompt(`do this then ${AUTONOMOUS_LOOP_SENTINEL}`),
    ).toBe(false)
  })
})

describe('expandLoopSentinelPrompt', () => {
  test('non-sentinel prompts pass through unchanged', () => {
    expect(expandLoopSentinelPrompt('/loop check the deploy', paths)).toBe(
      '/loop check the deploy',
    )
    expect(expandLoopSentinelPrompt('remind me to stretch', paths)).toBe(
      'remind me to stretch',
    )
  })

  test('first fire expands to the full maintenance instructions', () => {
    const expanded = expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    expect(expanded).toContain('Scheduled loop tick.')
    expect(expanded).toContain(MAINTENANCE_PROMPT)
  })

  test('subsequent fires get the short reminder', () => {
    expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    const second = expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    expect(second).toContain(
      'continue the loop per the instructions earlier in this conversation',
    )
    expect(second).toContain('.claudin/loop.md')
    expect(second).not.toContain(MAINTENANCE_PROMPT)
  })

  test('dynamic sentinel includes ScheduleWakeup continuation on full expansion and reminder', () => {
    const first = expandLoopSentinelPrompt(
      AUTONOMOUS_LOOP_DYNAMIC_SENTINEL,
      paths,
    )
    expect(first).toContain(MAINTENANCE_PROMPT)
    expect(first).toContain('ScheduleWakeup')
    expect(first).toContain(AUTONOMOUS_LOOP_DYNAMIC_SENTINEL)

    const second = expandLoopSentinelPrompt(
      AUTONOMOUS_LOOP_DYNAMIC_SENTINEL,
      paths,
    )
    expect(second).toContain('ScheduleWakeup')
    expect(second).toContain('omit it to end the loop')
    expect(second).not.toContain(MAINTENANCE_PROMPT)
  })

  test('plain sentinel reminder does not push ScheduleWakeup (cron reschedules it)', () => {
    expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    const second = expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    expect(second).not.toContain('ScheduleWakeup')
  })

  test('the two sentinels track first-fire state independently', () => {
    expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    const dynamicFirst = expandLoopSentinelPrompt(
      AUTONOMOUS_LOOP_DYNAMIC_SENTINEL,
      paths,
    )
    expect(dynamicFirst).toContain(MAINTENANCE_PROMPT)
  })

  test('scopes track first-fire state independently (lead vs teammates)', () => {
    // Lead fires first (default scope) — full expansion.
    expect(expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)).toContain(
      MAINTENANCE_PROMPT,
    )
    // Teammate A's first fire must still be a full expansion — the lead's
    // fire happened in a different conversation.
    expect(
      expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths, 'agent-a@team'),
    ).toContain(MAINTENANCE_PROMPT)
    // Teammate B likewise.
    expect(
      expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths, 'agent-b@team'),
    ).toContain(MAINTENANCE_PROMPT)
    // Second fires within each scope downgrade to the reminder.
    expect(
      expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths, 'agent-a@team'),
    ).not.toContain(MAINTENANCE_PROMPT)
    expect(expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)).not.toContain(
      MAINTENANCE_PROMPT,
    )
  })

  test('switchSession (in-process /resume) restores full expansion', () => {
    const original = getSessionId()
    try {
      expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
      expect(
        expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths),
      ).not.toContain(MAINTENANCE_PROMPT)
      // The resumed conversation never carried the full instructions — the
      // onSessionSwitch listener must wipe first-fire state so the next
      // sentinel fire re-delivers them instead of the short reminder.
      switchSession('loop-sentinels-resume-test' as SessionId)
      expect(expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)).toContain(
        MAINTENANCE_PROMPT,
      )
    } finally {
      switchSession(original)
    }
  })

  test('regenerateSessionId (the /clear emit path) restores full expansion', () => {
    const original = getSessionId()
    try {
      expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
      expect(
        expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths),
      ).not.toContain(MAINTENANCE_PROMPT)
      regenerateSessionId()
      expect(expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)).toContain(
        MAINTENANCE_PROMPT,
      )
    } finally {
      switchSession(original)
    }
  })

  test('resetLoopSentinelState restores full expansion (the /clear path)', () => {
    expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    expect(expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)).not.toContain(
      MAINTENANCE_PROMPT,
    )
    resetLoopSentinelState()
    expect(expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)).toContain(
      MAINTENANCE_PROMPT,
    )
  })

  test('loop.md created between fires re-expands the full instructions', () => {
    expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    writeFileSync(paths.projectLoopMdPath, '- new loop instructions\n')
    const next = expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    expect(next).toContain('loop.md instructions changed since the last tick')
    expect(next).toContain(MAINTENANCE_PROMPT)
    // And the fire after that, with loop.md unchanged, is a reminder again.
    const after = expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    expect(after).not.toContain(MAINTENANCE_PROMPT)
  })

  test('loop.md mtime change between fires re-expands the full instructions', () => {
    writeFileSync(paths.projectLoopMdPath, '- v1\n')
    expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    // Same byte length, different mtime — fingerprint uses mtime+size.
    writeFileSync(paths.projectLoopMdPath, '- v2\n')
    utimesSync(paths.projectLoopMdPath, new Date(), new Date(Date.now() + 5000))
    const next = expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    expect(next).toContain('loop.md instructions changed since the last tick')
  })

  test('loop.md removed between fires re-expands (instructions changed)', () => {
    writeFileSync(paths.userLoopMdPath, '- user loop\n')
    expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    unlinkSync(paths.userLoopMdPath)
    const next = expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    expect(next).toContain(MAINTENANCE_PROMPT)
  })

  test('unchanged loop.md keeps the short reminder', () => {
    writeFileSync(paths.projectLoopMdPath, '- stable\n')
    expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    const next = expandLoopSentinelPrompt(AUTONOMOUS_LOOP_SENTINEL, paths)
    expect(next).not.toContain(MAINTENANCE_PROMPT)
    expect(next).toContain('Scheduled loop tick —')
  })
})
