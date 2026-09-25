import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'

import { createUserMessage } from 'src/agent/messages/messages.ts'
import {
  applyToolResultReplacementsToMessages,
  getSessionSpillDir,
  processPreMappedToolResultBlock,
  processToolResultBlock,
  unlinkSessionSpillDir,
} from 'src/agent/tools/toolResultStorage.ts'
import { TOOL_RESULT_SUMMARY_TAG } from 'src/agent/tools/toolResultSummarizer.js'
import { resetGlobalConfigForTests, saveGlobalConfig } from 'src/platform/config/config.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'

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

// A tool can keep a result away from the summarizer (Tool.skipsResultSummarizer).
// toolExecution passes the answer to processPreMappedToolResultBlock — the path
// most built-in results take — and processToolResultBlock asks the tool itself.
describe('skipping the tool-result summarizer', () => {
  const savedKillSwitch = process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER

  beforeAll(() => {
    saveGlobalConfig(c => ({ ...c, toolResultSummarizerEnabled: true }))
  })
  beforeEach(() => {
    delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER
  })
  afterAll(() => {
    resetGlobalConfigForTests()
    if (savedKillSwitch === undefined) delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER
    else process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER = savedKillSwitch
  })

  // Past both head/tail triggers (8k chars AND 100 lines), under the 50k spill.
  const report = Array.from({ length: 300 }, (_, i) => `Line ${i}: ${'x'.repeat(40)}`).join('\n')
  const block = (): ToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: 'toolu_skip',
    content: [{ type: 'text', text: report }],
  })

  const tool = {
    name: AGENT_TOOL_NAME,
    maxResultSizeChars: 100_000,
    mapToolResultToToolResultBlockParam: (_: { keep: boolean }, id: string) => ({
      ...block(),
      tool_use_id: id,
    }),
    skipsResultSummarizer: (r: { keep: boolean }) => r.keep,
  }

  test('a tool without the hook has its report cut', async () => {
    const plain = { name: AGENT_TOOL_NAME, maxResultSizeChars: 100_000 }
    const out = await processPreMappedToolResultBlock(block(), plain, { keep: true })
    expect(typeof out.content).toBe('string')
    expect((out.content as string).startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  })

  test('the pre-mapped path asks the tool about the result it was mapped from', async () => {
    const kept = await processPreMappedToolResultBlock(block(), tool, { keep: true })
    const cut = await processPreMappedToolResultBlock(block(), tool, { keep: false })
    expect(kept.content).toEqual([{ type: 'text', text: report }])
    expect((cut.content as string).startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  })

  test('processToolResultBlock asks the tool per result', async () => {
    const kept = await processToolResultBlock(tool, { keep: true }, 'toolu_a')
    const cut = await processToolResultBlock(tool, { keep: false }, 'toolu_b')
    expect(kept.content).toEqual([{ type: 'text', text: report }])
    expect((cut.content as string).startsWith(TOOL_RESULT_SUMMARY_TAG)).toBe(true)
  })
})
