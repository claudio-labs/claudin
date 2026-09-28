/**
 * Characterization of the background memory extraction
 * (src/memory/extract/extractMemories.ts), through its four exports.
 *
 * The forked agent is the one boundary: the double records what the unit
 * asks of it and answers from a script. The gates read real env vars and a
 * real settings file, the memory directory is a real temp directory, and the
 * manifest comes from real files in it.
 *
 * Every build flag reads false under `bun test`. What the shipped build adds
 * on top (team memory, the repeated-error trigger) is pinned in
 * extractMemories.shipFlags.characterization.test.ts.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, utimesSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'

import type {
  ForkedAgentParams,
  ForkedAgentResult,
} from 'src/agent/coordinator/forkedAgent.js'
import { createSystemMessage } from 'src/agent/messages/messages.js'
import {
  createAutoMemCanUseTool,
  drainPendingExtraction,
  executeExtractMemories,
  initExtractMemories,
} from 'src/memory/extract/extractMemories.js'
import { buildExtractAutoOnlyPrompt } from 'src/memory/extract/prompts.js'
import {
  announceSavedMemories,
  assistantCalls,
  assistantSays,
  eventually,
  forkReturns,
  humanSays,
  nextToolUseId,
  toolAnswers,
  turnEnded,
  useForkDouble,
  useScene,
  type ToolUse,
} from 'src/memory/extract/__testutils__/extractionHarness.js'
import { formatMemoryManifest, scanMemoryFiles } from 'src/memory/memdir/memoryScan.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import type { AssistantMessage, Message, UserMessage } from 'src/shared/types/message.js'
import { ApplyPatchTool } from 'src/tools/ApplyPatchTool/ApplyPatchTool.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GlobTool } from 'src/tools/GlobTool/GlobTool.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GrepTool } from 'src/tools/GrepTool/GrepTool.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { NotebookEditTool } from 'src/tools/NotebookEditTool/NotebookEditTool.js'
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import { WebFetchTool } from 'src/tools/WebFetchTool/WebFetchTool.js'

const scene = useScene()
const fork = useForkDouble()

beforeEach(() => {
  initExtractMemories()
})

const FIXTURE_MEMORIES = join(import.meta.dir, '__fixtures__', 'rewrite', 'memory-dir')

/** Makes every eligible end of turn fork, so a test sees each decision. */
function forkEveryTurn(): void {
  process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
}

function inMemory(...parts: string[]): string {
  return join(scene().memoryDir, ...parts)
}

function writes(path: string): ToolUse {
  return { tool: FILE_WRITE_TOOL_NAME, input: { file_path: path, content: 'a remembered fact' } }
}

function edits(path: string): ToolUse {
  return {
    tool: FILE_EDIT_TOOL_NAME,
    input: { file_path: path, old_string: 'before', new_string: 'after' },
  }
}

/** The single prompt message the unit handed a fork, as text. */
function promptOf(request: ForkedAgentParams | undefined): string {
  expect(request?.promptMessages).toHaveLength(1)
  const only = request?.promptMessages[0] as UserMessage
  expect(only.type).toBe('user')
  expect(typeof only.message.content).toBe('string')
  return only.message.content as string
}

/** The prompt a fork should get right now for `count` new messages. */
async function expectedPrompt(count: number): Promise<string> {
  const headers = await scanMemoryFiles(scene().memoryDir, new AbortController().signal)
  return buildExtractAutoOnlyPrompt(count, formatMemoryManifest(headers))
}

type Decide = ReturnType<typeof createAutoMemCanUseTool>

function ask(decide: Decide, tool: unknown, input: Record<string, unknown>) {
  return decide(
    tool as Tool,
    input,
    {} as ToolUseContext,
    assistantSays('asking') as AssistantMessage,
    nextToolUseId(),
  )
}

/** Plants the fixture memories with fixed modification times. */
function plantMemories(): void {
  cpSync(FIXTURE_MEMORIES, scene().memoryDir, { recursive: true })
  const stamps: Array<[string, string]> = [
    ['feedback_temp_dirs.md', '2026-03-04T05:06:07.000Z'],
    ['user_role.md', '2026-02-01T08:00:00.000Z'],
    [join('notes', 'untyped.md'), '2026-01-01T00:00:00.000Z'],
  ]
  for (const [file, iso] of stamps) utimesSync(inMemory(file), new Date(iso), new Date(iso))
}

describe('whether an end of turn forks', () => {
  test('an eligible main-thread turn forks once, counting only user and assistant messages', async () => {
    forkEveryTurn()
    const messages = [
      humanSays('rename the exporter'),
      createSystemMessage('context is getting long', 'info'),
      assistantSays('renamed it'),
      createSystemMessage('a background notice', 'warning'),
      humanSays('thanks'),
    ]
    await executeExtractMemories(turnEnded(messages))
    expect(fork.requests).toHaveLength(1)
    expect(promptOf(fork.requests[0])).toBe(await expectedPrompt(3))
  })

  test('a sub-agent turn never forks', async () => {
    forkEveryTurn()
    await executeExtractMemories(turnEnded([humanSays('x')], { agentId: 'agent-7' as never }))
    expect(fork.requests).toHaveLength(0)
  })

  test.each(['0', 'false', 'off'])('CLAUDIN_EXTRACT_MEMORIES=%p switches it off', async value => {
    forkEveryTurn()
    process.env.CLAUDIN_EXTRACT_MEMORIES = value
    await executeExtractMemories(turnEnded([humanSays('x')]))
    expect(fork.requests).toHaveLength(0)
  })

  test.each(['1', 'true', ''])('CLAUDIN_EXTRACT_MEMORIES=%p leaves it on', async value => {
    forkEveryTurn()
    process.env.CLAUDIN_EXTRACT_MEMORIES = value
    await executeExtractMemories(turnEnded([humanSays('x')]))
    expect(fork.requests).toHaveLength(1)
  })

  test('auto memory being off keeps it off: its env switch, bare mode, or the setting', async () => {
    forkEveryTurn()
    const context = turnEnded([humanSays('x')])

    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    await executeExtractMemories(context)
    delete process.env.CLAUDIN_DISABLE_AUTO_MEMORY

    process.env.CLAUDIN_SIMPLE = '1'
    await executeExtractMemories(context)
    delete process.env.CLAUDIN_SIMPLE

    writeFileSync(
      join(scene().configDir, 'settings.json'),
      JSON.stringify({ autoMemoryEnabled: false }),
    )
    resetSettingsCache()
    await executeExtractMemories(context)

    expect(fork.requests).toHaveLength(0)
  })

  test('CLAUDIN_DISABLE_AUTO_MEMORY=0 keeps it on even in bare mode', async () => {
    forkEveryTurn()
    process.env.CLAUDIN_SIMPLE = '1'
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '0'
    await executeExtractMemories(turnEnded([humanSays('x')]))
    expect(fork.requests).toHaveLength(1)
  })

  test('the switches are read at every call', async () => {
    forkEveryTurn()
    process.env.CLAUDIN_EXTRACT_MEMORIES = '0'
    await executeExtractMemories(turnEnded([humanSays('a')]))
    delete process.env.CLAUDIN_EXTRACT_MEMORIES
    await executeExtractMemories(turnEnded([humanSays('a'), humanSays('b')]))
    expect(fork.requests).toHaveLength(1)
  })

  test('a turn stopped by a gate does not count toward the cadence', async () => {
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '2'
    const messages = [humanSays('a')]
    await executeExtractMemories(turnEnded(messages, { agentId: 'agent-1' as never }))
    process.env.CLAUDIN_EXTRACT_MEMORIES = 'off'
    await executeExtractMemories(turnEnded(messages))
    delete process.env.CLAUDIN_EXTRACT_MEMORIES
    await executeExtractMemories(turnEnded(messages))
    expect(fork.requests).toHaveLength(0)
    await executeExtractMemories(turnEnded(messages))
    expect(fork.requests).toHaveLength(1)
  })
})

describe('the cadence', () => {
  test('by default one fork every 15 eligible turns, each counting the messages since the last', async () => {
    const transcript: Message[] = []
    const forksSoFar: number[] = []
    for (let turn = 1; turn <= 30; turn++) {
      transcript.push(humanSays(`turn ${turn}`))
      await executeExtractMemories(turnEnded([...transcript]))
      forksSoFar.push(fork.requests.length)
    }
    expect(forksSoFar.indexOf(1)).toBe(14)
    expect(forksSoFar.indexOf(2)).toBe(29)
    expect(promptOf(fork.requests[0])).toBe(await expectedPrompt(15))
    expect(promptOf(fork.requests[1])).toBe(await expectedPrompt(15))
  })

  test('CLAUDIN_EXTRACT_MEMORIES_EVERY retunes it, read at every turn', async () => {
    const transcript: Message[] = []
    const endTurn = async () => {
      transcript.push(humanSays(`turn ${transcript.length + 1}`))
      await executeExtractMemories(turnEnded([...transcript]))
    }
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '3'
    await endTurn()
    await endTurn()
    expect(fork.requests).toHaveLength(0)
    await endTurn()
    expect(fork.requests).toHaveLength(1)

    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '5'
    for (let i = 0; i < 4; i++) await endTurn()
    expect(fork.requests).toHaveLength(1)
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '2'
    await endTurn()
    expect(fork.requests).toHaveLength(2)
  })

  test('a turn in which the main agent saved a memory neither forks nor counts', async () => {
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '2'
    const first = [humanSays('one'), assistantSays('ok')]
    await executeExtractMemories(turnEnded(first))
    const second = [
      ...first,
      humanSays('remember that I indent with tabs'),
      assistantCalls(writes(inMemory('user_tabs.md'))),
      assistantSays('saved'),
    ]
    await executeExtractMemories(turnEnded(second))
    expect(fork.requests).toHaveLength(0)

    const third = [...second, humanSays('three'), assistantSays('done')]
    await executeExtractMemories(turnEnded(third))
    expect(fork.requests).toHaveLength(1)
    expect(promptOf(fork.requests[0])).toBe(await expectedPrompt(2))
  })
})

describe('what the fork is asked', () => {
  test('its identity and limits: extract_memories as query source and label, 5 turns, no transcript', async () => {
    forkEveryTurn()
    await executeExtractMemories(turnEnded([humanSays('x')]))
    const [request] = fork.requests
    expect(request?.querySource).toBe('extract_memories')
    expect(request?.forkLabel).toBe('extract_memories')
    expect(request?.maxTurns).toBe(5)
    expect(request?.skipTranscript).toBe(true)
  })

  test("the parent's cache-critical inputs as they are, and nothing that would change the request", async () => {
    forkEveryTurn()
    const context = turnEnded([humanSays('x'), assistantSays('y')], {
      options: { mainLoopModel: 'the-parent-model' } as never,
    })
    await executeExtractMemories(context)
    const [request] = fork.requests
    const handed = request?.cacheSafeParams
    // The fork replays the parent's prefix: the messages as the parent had them...
    expect(handed?.forkContextMessages).toEqual(context.messages)
    // ...and the four pieces of its request as they came, the model inside the tool-use context.
    for (const piece of ['systemPrompt', 'userContext', 'systemContext', 'toolUseContext'] as const) {
      expect(handed?.[piece]).toEqual(context[piece])
    }
    expect(Object.keys(handed ?? {})).toHaveLength(5)
    expect(request?.maxOutputTokens).toBeUndefined()
    expect(request?.overrides).toBeUndefined()
    expect(request?.onMessage).toBeUndefined()
    expect(request?.skipCacheWrite).toBeFalsy()
  })

  test('the auto-only prompt, with the new-message count and the manifest of the memory directory', async () => {
    forkEveryTurn()
    plantMemories()
    await executeExtractMemories(turnEnded([humanSays('x'), assistantSays('y')]))
    const manifest = [
      '- [feedback] feedback_temp_dirs.md (2026-03-04T05:06:07.000Z): Tests build their own scratch directories instead of mocking the filesystem',
      '- [user] user_role.md (2026-02-01T08:00:00.000Z): The user maintains the invoice exporter and reviews every change to its CSV',
      '- notes/untyped.md (2026-01-01T00:00:00.000Z)',
    ].join('\n')
    expect(promptOf(fork.requests[0])).toBe(buildExtractAutoOnlyPrompt(2, manifest))
  })

  test('the manifest is read at each fork, and is empty while the directory is missing', async () => {
    forkEveryTurn()
    const first = [humanSays('x')]
    await executeExtractMemories(turnEnded(first))
    expect(promptOf(fork.requests[0])).toBe(buildExtractAutoOnlyPrompt(1, ''))

    plantMemories()
    await executeExtractMemories(turnEnded([...first, assistantSays('y')]))
    const second = promptOf(fork.requests[1])
    expect(second).toBe(await expectedPrompt(1))
    expect(second).toContain('- [user] user_role.md (2026-02-01T08:00:00.000Z)')
  })

  test('its permission function is scoped to the auto-memory directory', async () => {
    forkEveryTurn()
    await executeExtractMemories(turnEnded([humanSays('x')]))
    const decide = fork.requests[0]!.canUseTool
    const inside = await ask(decide, FileWriteTool, { file_path: inMemory('a.md'), content: '' })
    const outside = await ask(decide, FileWriteTool, {
      file_path: join(scene().projectDir, 'a.md'),
      content: '',
    })
    expect([inside.behavior, outside.behavior]).toEqual(['allow', 'deny'])
  })
})

describe('which messages are new', () => {
  test('after a fork, only the messages past the last one it was given', async () => {
    forkEveryTurn()
    const first = [humanSays('a'), assistantSays('b')]
    await executeExtractMemories(turnEnded(first))
    const second = [
      ...first,
      humanSays('c'),
      createSystemMessage('a notice', 'info'),
      assistantSays('d'),
      humanSays('e'),
    ]
    await executeExtractMemories(turnEnded(second))
    expect(promptOf(fork.requests[1])).toBe(await expectedPrompt(3))
  })

  test('when that message is gone, as after a compaction, every model-visible message counts again', async () => {
    forkEveryTurn()
    await executeExtractMemories(turnEnded([humanSays('a'), assistantSays('b')]))
    const compacted = [humanSays('summary of the earlier work'), assistantSays('continuing'), humanSays('next')]
    await executeExtractMemories(turnEnded(compacted))
    expect(promptOf(fork.requests[1])).toBe(await expectedPrompt(3))
  })

  test('a failed fork leaves them new, and still restarts the cadence', async () => {
    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '2'
    fork.answer(async () => {
      throw new Error('provider unavailable')
    })
    const first = [humanSays('a')]
    await executeExtractMemories(turnEnded(first))
    const second = [...first, assistantSays('b')]
    await executeExtractMemories(turnEnded(second))
    expect(fork.requests).toHaveLength(1)

    fork.answer(async () => forkReturns([]))
    const third = [...second, humanSays('c')]
    await executeExtractMemories(turnEnded(third))
    expect(fork.requests).toHaveLength(1)
    const fourth = [...third, assistantSays('d')]
    await executeExtractMemories(turnEnded(fourth))
    expect(fork.requests).toHaveLength(2)
    expect(promptOf(fork.requests[1])).toBe(await expectedPrompt(4))
  })

  test('a memory the main agent saved after the last fork skips this one and moves past it', async () => {
    forkEveryTurn()
    const first = [humanSays('a'), assistantSays('b')]
    await executeExtractMemories(turnEnded(first))
    const second = [
      ...first,
      humanSays('remember the release train'),
      assistantCalls({ tool: FILE_READ_TOOL_NAME, input: { file_path: inMemory('MEMORY.md') } }),
      assistantCalls(writes(inMemory('project_release.md'))),
      assistantSays('noted'),
    ]
    await executeExtractMemories(turnEnded(second))
    expect(fork.requests).toHaveLength(1)

    const third = [...second, humanSays('next task'), assistantSays('done')]
    await executeExtractMemories(turnEnded(third))
    expect(fork.requests).toHaveLength(2)
    expect(promptOf(fork.requests[1])).toBe(await expectedPrompt(2))
  })

  test('an Edit counts as saving a memory too; a write outside the memory directory does not', async () => {
    forkEveryTurn()
    const edited = [
      humanSays('fix that memory'),
      assistantCalls(edits(inMemory('nested', 'fact.md'))),
      assistantSays('fixed'),
    ]
    await executeExtractMemories(turnEnded(edited))
    expect(fork.requests).toHaveLength(0)

    const elsewhere = [
      ...edited,
      humanSays('now the code'),
      assistantCalls(writes(join(scene().projectDir, 'src', 'app.ts'))),
      assistantSays('written'),
    ]
    await executeExtractMemories(turnEnded(elsewhere))
    expect(fork.requests).toHaveLength(1)
    expect(promptOf(fork.requests[0])).toBe(await expectedPrompt(3))
  })

  test('a memory saved before the last fork does not hold back later ones', async () => {
    forkEveryTurn()
    const first = [humanSays('a'), assistantCalls(writes(inMemory('a.md'))), assistantSays('b')]
    await executeExtractMemories(turnEnded(first))
    expect(fork.requests).toHaveLength(0)
    await executeExtractMemories(turnEnded([...first, humanSays('c')]))
    expect(fork.requests).toHaveLength(1)
    expect(promptOf(fork.requests[0])).toBe(await expectedPrompt(1))
  })
})

describe('what is done with the answer', () => {
  /** A fork that saved two memories, touched two indexes, and did other things. */
  function busyFork(): Message[] {
    const readId = nextToolUseId()
    return [
      assistantCalls({ tool: FILE_READ_TOOL_NAME, input: { file_path: inMemory('MEMORY.md') }, id: readId }),
      toolAnswers(readId, '- [Old](old.md) — hook', false),
      assistantCalls(writes(inMemory('feedback_tabs.md')), edits(inMemory('MEMORY.md'))),
      assistantCalls(
        edits(inMemory('feedback_tabs.md')),
        { tool: FILE_WRITE_TOOL_NAME, input: { content: 'no path given' } },
        { tool: FILE_EDIT_TOOL_NAME, input: { file_path: 42 } },
      ),
      assistantCalls(writes(inMemory('team', 'MEMORY.md')), writes(inMemory('project_release.md'))),
      assistantCalls({ tool: BASH_TOOL_NAME, input: { command: `ls ${scene().memoryDir}` } }),
      assistantSays('saved two memories'),
    ]
  }

  test('with notifyMemorySaved on, one memory_saved message lists each saved file once, indexes left out', async () => {
    forkEveryTurn()
    announceSavedMemories(true)
    fork.answer(async () => forkReturns(busyFork()))
    const appended: unknown[] = []
    await executeExtractMemories(turnEnded([humanSays('x')]), message => {
      appended.push(message)
    })
    expect(appended).toStrictEqual([
      {
        type: 'system',
        subtype: 'memory_saved',
        writtenPaths: [inMemory('feedback_tabs.md'), inMemory('project_release.md')],
        timestamp: expect.any(String),
        uuid: expect.any(String),
        isMeta: false,
      },
    ])
  })

  test('silent unless notifyMemorySaved is true', async () => {
    forkEveryTurn()
    fork.answer(async () => forkReturns(busyFork()))
    const appended: unknown[] = []
    await executeExtractMemories(turnEnded([humanSays('x')]), message => {
      appended.push(message)
    })
    announceSavedMemories(false)
    await executeExtractMemories(turnEnded([humanSays('x'), humanSays('y')]), message => {
      appended.push(message)
    })
    expect(fork.requests).toHaveLength(2)
    expect(appended).toEqual([])
  })

  test('nothing to announce when the fork only touched indexes, or wrote nothing', async () => {
    forkEveryTurn()
    announceSavedMemories(true)
    const appended: unknown[] = []
    fork.answer(async () =>
      forkReturns([assistantCalls(edits(inMemory('MEMORY.md')), writes(inMemory('team', 'MEMORY.md')))]),
    )
    await executeExtractMemories(turnEnded([humanSays('x')]), message => {
      appended.push(message)
    })
    fork.answer(async () => forkReturns([assistantSays('nothing worth keeping')]))
    await executeExtractMemories(turnEnded([humanSays('x'), humanSays('y')]), message => {
      appended.push(message)
    })
    expect(fork.requests).toHaveLength(2)
    expect(appended).toEqual([])
  })

  test('without appendSystemMessage the call still completes', async () => {
    forkEveryTurn()
    announceSavedMemories(true)
    fork.answer(async () => forkReturns(busyFork()))
    await expect(executeExtractMemories(turnEnded([humanSays('x')]))).resolves.toBeUndefined()
    expect(fork.requests).toHaveLength(1)
  })

  test('a fork that throws is absorbed: the call resolves and nothing is announced', async () => {
    forkEveryTurn()
    announceSavedMemories(true)
    fork.answer(async () => {
      throw new Error('the model went away')
    })
    const appended: unknown[] = []
    await expect(
      executeExtractMemories(turnEnded([humanSays('x')]), message => {
        appended.push(message)
      }),
    ).resolves.toBeUndefined()
    expect(appended).toEqual([])
  })
})

describe('turns that end while a fork is running', () => {
  test('are held: one trailing fork follows, with the latest context and its callback only', async () => {
    forkEveryTurn()
    announceSavedMemories(true)
    const firstFork = Promise.withResolvers<ForkedAgentResult>()
    fork.answer(() => firstFork.promise)
    const notices: string[] = []
    const first = [humanSays('a'), assistantSays('b')]
    const running = executeExtractMemories(turnEnded(first), () => {
      notices.push('first')
    })
    await eventually(() => fork.requests.length === 1, 'the first fork')

    fork.answer(async () => forkReturns([assistantCalls(writes(inMemory('late.md')))]))
    const second = [...first, humanSays('c'), assistantSays('d')]
    const third = [...second, humanSays('e'), assistantSays('f')]
    let heldReturned = false
    const held = Promise.all([
      executeExtractMemories(turnEnded(second), () => {
        notices.push('second')
      }),
      executeExtractMemories(turnEnded(third), () => {
        notices.push('third')
      }),
    ]).then(() => {
      heldReturned = true
    })
    await eventually(() => heldReturned, 'the held calls to return')
    expect(fork.requests).toHaveLength(1)

    firstFork.resolve(forkReturns([]))
    await running
    await held
    expect(fork.requests).toHaveLength(2)
    expect(fork.requests[1]?.cacheSafeParams.forkContextMessages).toEqual(third)
    expect(promptOf(fork.requests[1])).toBe(await expectedPrompt(4))
    expect(notices).toEqual(['third'])
  })

  test('the call that started the fork settles only once the trailing fork is done', async () => {
    forkEveryTurn()
    const gates = [
      Promise.withResolvers<ForkedAgentResult>(),
      Promise.withResolvers<ForkedAgentResult>(),
    ]
    fork.answer(() => gates[fork.requests.length - 1]!.promise)
    let settled = false
    const running = executeExtractMemories(turnEnded([humanSays('a')])).then(() => {
      settled = true
    })
    await eventually(() => fork.requests.length === 1, 'the first fork')
    await executeExtractMemories(turnEnded([humanSays('a'), humanSays('b')]))

    gates[0]!.resolve(forkReturns([]))
    await eventually(() => fork.requests.length === 2, 'the trailing fork')
    await Bun.sleep(10)
    expect(settled).toBe(false)
    gates[1]!.resolve(forkReturns([]))
    await running
    expect(settled).toBe(true)
  })

  test('the trailing fork ignores the cadence, and follows a failed fork too', async () => {
    forkEveryTurn()
    const firstFork = Promise.withResolvers<ForkedAgentResult>()
    fork.answer(() => firstFork.promise)
    const first = [humanSays('a')]
    const running = executeExtractMemories(turnEnded(first))
    await eventually(() => fork.requests.length === 1, 'the first fork')

    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1000'
    fork.answer(async () => forkReturns([]))
    await executeExtractMemories(turnEnded([...first, assistantSays('b')]))
    firstFork.reject(new Error('the model went away'))
    await running
    expect(fork.requests).toHaveLength(2)
    expect(promptOf(fork.requests[1])).toBe(await expectedPrompt(2))
  })

  test('the trailing fork is skipped like any other when the main agent saved a memory', async () => {
    forkEveryTurn()
    const firstFork = Promise.withResolvers<ForkedAgentResult>()
    fork.answer(() => firstFork.promise)
    const first = [humanSays('a')]
    const running = executeExtractMemories(turnEnded(first))
    await eventually(() => fork.requests.length === 1, 'the first fork')
    await executeExtractMemories(
      turnEnded([...first, assistantCalls(writes(inMemory('b.md'))), assistantSays('saved')]),
    )
    firstFork.resolve(forkReturns([]))
    await running
    expect(fork.requests).toHaveLength(1)
  })
})

describe('drainPendingExtraction', () => {
  test('returns at once when nothing is in flight', async () => {
    const started = performance.now()
    await drainPendingExtraction()
    expect(performance.now() - started).toBeLessThan(500)
  })

  test('waits for the fork in flight and for the trailing fork behind it', async () => {
    forkEveryTurn()
    const gates = [
      Promise.withResolvers<ForkedAgentResult>(),
      Promise.withResolvers<ForkedAgentResult>(),
    ]
    fork.answer(() => gates[fork.requests.length - 1]!.promise)
    void executeExtractMemories(turnEnded([humanSays('a')]))
    await eventually(() => fork.requests.length === 1, 'the first fork')
    void executeExtractMemories(turnEnded([humanSays('a'), humanSays('b')]))

    let drained = false
    const draining = drainPendingExtraction().then(() => {
      drained = true
    })
    gates[0]!.resolve(forkReturns([]))
    await eventually(() => fork.requests.length === 2, 'the trailing fork')
    await Bun.sleep(10)
    expect(drained).toBe(false)
    gates[1]!.resolve(forkReturns([]))
    await draining
    expect(drained).toBe(true)
  })

  test('stops waiting after the timeout it is given', async () => {
    forkEveryTurn()
    fork.answer(() => new Promise<ForkedAgentResult>(() => {}))
    void executeExtractMemories(turnEnded([humanSays('a')]))
    await eventually(() => fork.requests.length === 1, 'the fork')
    const started = performance.now()
    await drainPendingExtraction(40)
    const waited = performance.now() - started
    expect(waited).toBeGreaterThanOrEqual(30)
    expect(waited).toBeLessThan(1_500)
  })
})

describe('initialization', () => {
  // Before the first initExtractMemories: extractMemories.firstUse.characterization.test.ts.

  test('initExtractMemories starts over: the cadence and the new-message mark are forgotten', async () => {
    forkEveryTurn()
    const first = [humanSays('a'), assistantSays('b')]
    await executeExtractMemories(turnEnded(first))
    expect(fork.requests).toHaveLength(1)

    process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '2'
    const second = [...first, humanSays('c')]
    await executeExtractMemories(turnEnded(second))
    initExtractMemories()
    const third = [...second, assistantSays('d')]
    await executeExtractMemories(turnEnded(third))
    expect(fork.requests).toHaveLength(1)

    const fourth = [...third, humanSays('e')]
    await executeExtractMemories(turnEnded(fourth))
    expect(fork.requests).toHaveLength(2)
    expect(promptOf(fork.requests[1])).toBe(await expectedPrompt(5))
  })
})

describe('createAutoMemCanUseTool', () => {
  const decideFor = (tool: unknown, input: Record<string, unknown>) =>
    ask(createAutoMemCanUseTool(scene().memoryDir), tool, input)

  test('Read, Grep and Glob are allowed anywhere, with the input handed back', async () => {
    const cases: Array<[unknown, Record<string, unknown>]> = [
      [FileReadTool, { file_path: '/etc/hosts' }],
      [GrepTool, { pattern: 'token', path: '/' }],
      [GlobTool, { pattern: '**/*.md', path: scene().projectDir }],
    ]
    for (const [tool, input] of cases) {
      expect(await decideFor(tool, input)).toStrictEqual({ behavior: 'allow', updatedInput: input })
    }
  })

  test.each([
    'ls -la',
    'cat notes.md',
    'grep -rn TODO .',
    'find . -name "*.md"',
    'head -5 MEMORY.md',
    'wc -l MEMORY.md',
  ])('Bash that only reads is allowed: %s', async command => {
    const input = { command }
    expect(await decideFor(BashTool, input)).toStrictEqual({ behavior: 'allow', updatedInput: input })
  })

  test.each([
    'rm notes.md',
    'echo hi > notes.md',
    'touch notes.md',
    'mv a.md b.md',
    'find . -delete',
    'sed -i s/a/b/ notes.md',
    'curl https://example.com',
  ])('Bash that could change anything is denied: %s', async command => {
    expect(await decideFor(BashTool, { command })).toMatchObject({
      behavior: 'deny',
      message: expect.stringMatching(/read-only/),
    })
  })

  test('Bash input its own schema rejects is denied', async () => {
    expect(await decideFor(BashTool, { cmd: 'ls' })).toMatchObject({ behavior: 'deny' })
    expect(await decideFor(BashTool, { command: 42 })).toMatchObject({ behavior: 'deny' })
  })

  test('Edit and Write are allowed anywhere inside the memory directory', async () => {
    const memory = scene().memoryDir
    const cases: Array<[unknown, Record<string, unknown>]> = [
      [FileWriteTool, { file_path: join(memory, 'a.md'), content: 'x' }],
      [FileEditTool, { file_path: join(memory, 'team', 'decisions', 'b.md'), old_string: 'x', new_string: 'y' }],
      [FileWriteTool, { file_path: `${memory}sub${sep}..${sep}c.md`, content: 'x' }],
    ]
    for (const [tool, input] of cases) {
      expect(await decideFor(tool, input)).toStrictEqual({ behavior: 'allow', updatedInput: input })
    }
  })

  const outsidePaths: Array<[string, (memory: string, project: string) => unknown]> = [
    ['in the project', (_memory, project) => join(project, 'notes.md')],
    ['in a sibling whose name extends the directory', memory => `${memory.slice(0, -1)}-shadow${sep}a.md`],
    ['climbing out with ..', memory => `${memory}..${sep}escaped.md`],
    ['relative', () => 'memory/a.md'],
    ['not a string', () => 7],
  ]

  test.each(outsidePaths)('Edit and Write are denied %s', async (_label, pathFor) => {
    const target = pathFor(scene().memoryDir, scene().projectDir)
    for (const tool of [FileWriteTool, FileEditTool]) {
      expect(await decideFor(tool, { file_path: target, content: 'x' })).toMatchObject({ behavior: 'deny' })
    }
  })

  test('Edit and Write without a file_path are denied', async () => {
    expect(await decideFor(FileWriteTool, { content: 'x' })).toMatchObject({ behavior: 'deny' })
  })

  test('every other tool is denied, even aimed at the memory directory, and told what is allowed where', async () => {
    const others = [NotebookEditTool, ApplyPatchTool, WebFetchTool, { name: 'mcp__docs__search' }]
    for (const tool of others) {
      const decision = await decideFor(tool, { file_path: inMemory('a.md'), notebook_path: inMemory('a.ipynb') })
      expect(decision.behavior).toBe('deny')
      const message = (decision as { message: string }).message
      for (const named of [
        FILE_READ_TOOL_NAME,
        GREP_TOOL_NAME,
        GLOB_TOOL_NAME,
        BASH_TOOL_NAME,
        FILE_EDIT_TOOL_NAME,
        FILE_WRITE_TOOL_NAME,
        scene().memoryDir,
      ]) {
        expect(message).toContain(named)
      }
    }
  })

  test('a denial gives its reason as the message and as an "other" decision reason', async () => {
    const decision = await decideFor(WebFetchTool, { url: 'https://example.com' })
    const message = (decision as { message: string }).message
    expect(decision).toStrictEqual({
      behavior: 'deny',
      message,
      decisionReason: { type: 'other', reason: message },
    })
  })
})
