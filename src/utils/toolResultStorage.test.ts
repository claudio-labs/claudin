import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUserMessage } from './messages.ts'
import {
  applyToolResultReplacementsToMessages,
  getSessionSpillDir,
  unlinkSessionSpillDir,
} from './toolResultStorage.ts'

test('applyToolResultReplacementsToMessages replaces matching tool results and preserves unrelated messages', () => {
  const unrelated = createUserMessage({ content: 'keep me' })
  const oversizedResult = createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'very large tool output',
        is_error: false,
      },
    ],
    toolUseResult: {
      stdout: 'very large tool output',
      stderr: '',
    },
  })
  const messages = [unrelated, oversizedResult]
  const replacement =
    '<persisted-output>\nOutput too large. Preview\n</persisted-output>'

  const next = applyToolResultReplacementsToMessages(
    messages,
    new Map([['tool-1', replacement]]),
  )

  expect(next).not.toBe(messages)
  expect(next[0]).toBe(unrelated)
  expect(next[1]).not.toBe(oversizedResult)
  const replaced = next[1] as typeof oversizedResult
  expect(
    (replaced.message.content as Array<{ content: string }>)[0]!.content,
  ).toBe(replacement)
  expect(replaced.toolUseResult).toBeUndefined()
})

test('applyToolResultReplacementsToMessages is idempotent when messages are already hydrated', () => {
  const hydrated = createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: '<persisted-output>\nPreview\n</persisted-output>',
        is_error: false,
      },
    ],
  })
  const messages = [hydrated]

  const next = applyToolResultReplacementsToMessages(
    messages,
    new Map([['tool-1', '<persisted-output>\nPreview\n</persisted-output>']]),
  )

  expect(next).toBe(messages)
})

describe('unlinkSessionSpillDir', () => {
  // Isolate filesystem side effects in a hermetic config dir so the test
  // never touches ~/.claudin. CLAUDIN_CONFIG_DIR flows through
  // getClaudinConfigHomeDir → getProjectsDir → getProjectDir.
  const prevConfigDir = process.env.CLAUDIN_CONFIG_DIR
  const testConfigDir = join(
    tmpdir(),
    `claudin-test-spill-${process.pid}-${Date.now()}`,
  )

  beforeAll(() => {
    process.env.CLAUDIN_CONFIG_DIR = testConfigDir
    mkdirSync(testConfigDir, { recursive: true })
  })

  // Track every dir we create so afterAll can remove them even when a leaked
  // getProjectDir stub redirects getSessionSpillDir away from testConfigDir.
  const createdDirs: string[] = []

  afterAll(() => {
    if (prevConfigDir === undefined) {
      delete process.env.CLAUDIN_CONFIG_DIR
    } else {
      process.env.CLAUDIN_CONFIG_DIR = prevConfigDir
    }
    for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
    rmSync(testConfigDir, { recursive: true, force: true })
  })

  // Build the spill dir through the same getSessionSpillDir() the code under
  // test uses, so this test always targets the exact directory
  // unlinkSessionSpillDir will delete — never an independently-derived path
  // that a sibling's leaked getProjectDir mock could send elsewhere.
  function makeSessionSpillDir(sessionId: string, fileCount: number): string {
    const spillDir = getSessionSpillDir(sessionId)
    mkdirSync(spillDir, { recursive: true })
    createdDirs.push(spillDir)
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(spillDir, `tool_${i}.txt`), 'X'.repeat(1_000))
    }
    return spillDir
  }

  test('removes the tool-results directory for the given session', async () => {
    const sessionId = `sess-remove-${Date.now()}`
    const dir = makeSessionSpillDir(sessionId, 5)
    expect(existsSync(dir)).toBe(true)

    await unlinkSessionSpillDir(sessionId)

    expect(existsSync(dir)).toBe(false)
  })

  test('leaves unrelated sessions untouched', async () => {
    const victim = `sess-victim-${Date.now()}`
    const survivor = `sess-survivor-${Date.now()}`
    const victimDir = makeSessionSpillDir(victim, 3)
    const survivorDir = makeSessionSpillDir(survivor, 3)

    await unlinkSessionSpillDir(victim)

    expect(existsSync(victimDir)).toBe(false)
    expect(existsSync(survivorDir)).toBe(true)
    expect(existsSync(join(survivorDir, 'tool_0.txt'))).toBe(true)
  })

  test('is a no-op when the session directory does not exist', async () => {
    // Force: true swallows ENOENT — this just verifies we don't throw.
    await expect(
      unlinkSessionSpillDir(`sess-nonexistent-${Date.now()}`),
    ).resolves.toBeUndefined()
  })

  test('is a no-op when sessionId is empty', async () => {
    // Guard: empty string must never escalate to "rm -rf projectDir/" via
    // join() treating it as a path segment. The early return protects this.
    const sentinel = `sess-sentinel-${Date.now()}`
    const sentinelDir = makeSessionSpillDir(sentinel, 2)

    await unlinkSessionSpillDir('')

    // Nothing near the projectDir root was touched
    expect(existsSync(sentinelDir)).toBe(true)
  })
})
