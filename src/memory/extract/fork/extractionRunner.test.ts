/**
 * The extraction runner driven through its dependencies: a scripted fork, a
 * manifest and settings the test sets, and a memory directory that exists
 * only as a path. No module is replaced.
 */
import { describe, expect, test } from 'bun:test'
import { join, resolve, sep } from 'node:path'

import type { ForkedAgentResult } from 'src/agent/coordinator/forkedAgent.js'
import {
  assistantCalls,
  assistantSays,
  eventually,
  forkReturns,
  humanSays,
  nextToolUseId,
  toolAnswers,
  turnEnded,
} from 'src/memory/extract/__testutils__/extractionHarness.js'
import {
  createExtractionRunner,
  type ExtractionRunner,
  type ExtractionSettings,
} from 'src/memory/extract/fork/extractionRunner.js'
import type { ExtractionForkRequest } from 'src/memory/extract/fork/forkRequest.js'
import { isInsideDirectory } from 'src/memory/extract/fork/permissions.js'
import { buildExtractAutoOnlyPrompt } from 'src/memory/extract/prompts.js'
import type { Message, UserMessage } from 'src/shared/types/message.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/constants.js'

const MEMORY = resolve(sep, 'virtual-project', 'memory') + sep
const inMemory = (...parts: string[]): string => join(MEMORY, ...parts)

type Rig = {
  readonly runner: ExtractionRunner
  readonly requests: ExtractionForkRequest[]
  readonly notices: unknown[]
  readonly settings: { -readonly [K in keyof ExtractionSettings]: ExtractionSettings[K] }
  answer(script: (request: ExtractionForkRequest) => Promise<ForkedAgentResult>): void
  manifest(read: () => Promise<string>): void
  end(messages: Message[]): Promise<void>
}

function rig(): Rig {
  const requests: ExtractionForkRequest[] = []
  const notices: unknown[] = []
  let script = async (_request: ExtractionForkRequest) => forkReturns([])
  let readManifest = async () => ''
  const settings = {
    extractionEnabled: () => true,
    autoMemoryEnabled: () => true,
    turnInterval: () => 1,
    loopTriggerEnabled: () => false,
    teamMemoryEnabled: () => false,
    announceSavedMemories: () => true,
  }
  const runner = createExtractionRunner({
    runFork: request => {
      requests.push(request)
      return script(request)
    },
    readManifest: () => readManifest(),
    settings: {
      extractionEnabled: () => settings.extractionEnabled(),
      autoMemoryEnabled: () => settings.autoMemoryEnabled(),
      turnInterval: () => settings.turnInterval(),
      loopTriggerEnabled: () => settings.loopTriggerEnabled(),
      teamMemoryEnabled: () => settings.teamMemoryEnabled(),
      announceSavedMemories: () => settings.announceSavedMemories(),
    },
    memory: {
      directory: () => MEMORY,
      contains: filePath => isInsideDirectory(filePath, MEMORY),
      containsTeamFile: filePath => isInsideDirectory(filePath, inMemory('team')),
    },
  })
  return {
    runner,
    requests,
    notices,
    settings,
    answer(next) {
      script = next
    },
    manifest(read) {
      readManifest = read
    },
    end(messages) {
      return runner.onTurnEnd(turnEnded(messages), notice => {
        notices.push(notice)
      })
    },
  }
}

function promptOf(request: ExtractionForkRequest | undefined): string {
  return (request?.promptMessages[0] as UserMessage).message.content as string
}

function writes(path: string, id?: string) {
  return { tool: FILE_WRITE_TOOL_NAME, input: { file_path: path, content: 'a fact' }, id }
}

describe('the saved-memory notice', () => {
  test('lists the saves that went through, not the calls that were refused or aimed elsewhere', async () => {
    const { answer, end, notices } = rig()
    const [kept, refused, outside] = [nextToolUseId(), nextToolUseId(), nextToolUseId()]
    answer(async () =>
      forkReturns([
        assistantCalls(
          writes(inMemory('kept.md'), kept),
          writes(inMemory('refused.md'), refused),
          writes(resolve(sep, 'virtual-project', 'src', 'notes.md'), outside),
        ),
        toolAnswers(kept, 'File written', false),
        toolAnswers(refused, 'Permission denied: a memory fork may only write inside the memory directory', true),
        toolAnswers(outside, 'File written', false),
      ]),
    )
    await end([humanSays('remember that releases leave on Thursdays')])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ subtype: 'memory_saved', writtenPaths: [inMemory('kept.md')] })
  })

  test('is not sent when every save was refused', async () => {
    const { answer, end, notices, requests } = rig()
    const refused = nextToolUseId()
    answer(async () =>
      forkReturns([assistantCalls(writes(inMemory('a.md'), refused)), toolAnswers(refused, 'denied', true)]),
    )
    await end([humanSays('x')])
    expect(requests).toHaveLength(1)
    expect(notices).toEqual([])
  })
})

describe('after a compaction', () => {
  test("the main agent's save among the messages left still stops the fork, and the mark moves past it", async () => {
    const { end, requests } = rig()
    await end([humanSays('a'), assistantSays('b')])
    expect(requests).toHaveLength(1)

    const compacted = [
      humanSays('summary of the work so far'),
      assistantCalls(writes(inMemory('project_release.md'))),
      assistantSays('saved it'),
    ]
    await end(compacted)
    expect(requests).toHaveLength(1)

    await end([...compacted, humanSays('next task')])
    expect(requests).toHaveLength(2)
    expect(promptOf(requests[1])).toBe(buildExtractAutoOnlyPrompt(1, ''))
  })
})

describe('a failure before the fork', () => {
  test('a manifest that cannot be read is absorbed: nothing forks, and the messages stay new', async () => {
    const { end, manifest, requests } = rig()
    manifest(async () => {
      throw new Error('the memory directory went away')
    })
    const first = [humanSays('a'), assistantSays('b')]
    await expect(end(first)).resolves.toBeUndefined()
    expect(requests).toHaveLength(0)

    manifest(async () => '')
    await end([...first, humanSays('c')])
    expect(requests).toHaveLength(1)
    expect(promptOf(requests[0])).toBe(buildExtractAutoOnlyPrompt(3, ''))
  })
})

describe('turns kept while a fork runs', () => {
  test('are checked against the switches again before their fork, so one switched off meanwhile gets none', async () => {
    const { answer, end, requests, settings } = rig()
    const first = Promise.withResolvers<ForkedAgentResult>()
    answer(() => first.promise)
    const running = end([humanSays('a')])
    await eventually(() => requests.length === 1, 'the first fork')
    await end([humanSays('a'), humanSays('b')])

    settings.extractionEnabled = () => false
    first.resolve(forkReturns([]))
    await running
    expect(requests).toHaveLength(1)
  })

  test('each fork that follows can be followed in turn, and the first call waits for all of them', async () => {
    const { answer, end, requests } = rig()
    const gates = [
      Promise.withResolvers<ForkedAgentResult>(),
      Promise.withResolvers<ForkedAgentResult>(),
      Promise.withResolvers<ForkedAgentResult>(),
    ]
    answer(() => gates[requests.length - 1]!.promise)
    let settled = false
    const turns = [humanSays('a'), humanSays('b'), humanSays('c')]
    const running = end(turns.slice(0, 1)).then(() => {
      settled = true
    })
    await eventually(() => requests.length === 1, 'the first fork')
    await end(turns.slice(0, 2))

    gates[0]!.resolve(forkReturns([]))
    await eventually(() => requests.length === 2, 'the fork for the kept turn')
    await end(turns.slice(0, 3))

    gates[1]!.resolve(forkReturns([]))
    await eventually(() => requests.length === 3, 'the fork for the turn kept during it')
    expect(requests[2]?.cacheSafeParams.forkContextMessages).toEqual(turns)
    expect(settled).toBe(false)

    gates[2]!.resolve(forkReturns([]))
    await running
    expect(settled).toBe(true)
  })
})
