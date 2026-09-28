/**
 * The extraction as the shipped build runs it.
 *
 * `scripts/build/build.ts` turns TEAMMEM and LOOP_ERROR_MEMORY_TRIGGER on, and
 * `bun test` folds every `feature()` to false, so the paths below never run
 * under the plain runner. This file therefore runs twice: under the plain
 * runner its one test re-runs the file in a child `bun test` with both flags
 * on, and in that child the characterization below runs against the flagged
 * code. A failure in the child fails the parent test, with the child's output.
 *
 * In the shipped build team memory follows auto memory, so every extraction
 * gets the combined prompt, and a repeated-error loop forces a fork.
 */
import { feature } from 'bun:bundle'
import { beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ForkedAgentParams,
  ForkedAgentResult,
} from 'src/agent/coordinator/forkedAgent.js'
import {
  executeExtractMemories,
  initExtractMemories,
} from 'src/memory/extract/extractMemories.js'
import {
  buildExtractAutoOnlyPrompt,
  buildExtractCombinedPrompt,
  buildLoopHint,
} from 'src/memory/extract/prompts.js'
import {
  announceSavedMemories,
  assistantCalls,
  assistantSays,
  checkoutRoot,
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
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  renderTeamCategoriesXml,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from 'src/memory/memdir/memoryTypes.js'
import type { Message, UserMessage } from 'src/shared/types/message.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'

// `feature()` has to sit directly in a ternary: any other form throws under `bun test`.
const SHIPPED_FLAGS = feature('TEAMMEM')
  ? feature('LOOP_ERROR_MEMORY_TRIGGER')
    ? true
    : false
  : false

if (!SHIPPED_FLAGS) {
  test('holds with the TEAMMEM and LOOP_ERROR_MEMORY_TRIGGER build flags on', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        'test',
        '--feature=TEAMMEM',
        '--feature=LOOP_ERROR_MEMORY_TRIGGER',
        import.meta.path,
      ],
      { cwd: checkoutRoot(), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
    )
    const [out, err, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const report = `${out}\n${err}`
    const passed = Number(/(\d+) pass/.exec(report)?.[1] ?? '0')
    const failed = Number(/(\d+) fail/.exec(report)?.[1] ?? '-1')
    if (exitCode !== 0 || failed !== 0 || passed === 0) {
      throw new Error(`the flagged run failed (exit ${exitCode}):\n${report.slice(-6_000)}`)
    }
    expect(report).not.toMatch(/\d+ skip/)
  }, 180_000)
} else {
  const scene = useScene()
  const fork = useForkDouble()

  beforeEach(() => {
    initExtractMemories()
  })

  const inMemory = (...parts: string[]) => join(scene().memoryDir, ...parts)

  const writes = (path: string): ToolUse => ({
    tool: FILE_WRITE_TOOL_NAME,
    input: { file_path: path, content: 'a remembered fact' },
  })

  const promptOf = (request: ForkedAgentParams | undefined): string => {
    expect(request?.promptMessages).toHaveLength(1)
    return (request?.promptMessages[0] as UserMessage).message.content as string
  }

  const manifestNow = async (): Promise<string> =>
    formatMemoryManifest(await scanMemoryFiles(scene().memoryDir, new AbortController().signal))

  /** `times` identical calls of one Bash command, each coming back as an error. */
  function failingRuns(command: string, times: number): Message[] {
    const turns: Message[] = []
    for (let run = 0; run < times; run++) {
      const id = nextToolUseId()
      turns.push(
        assistantCalls({ tool: BASH_TOOL_NAME, input: { command }, id }),
        toolAnswers(id, `${command}: exit code 1`, true),
      )
    }
    return turns
  }

  /** Same, for an Edit that keeps missing its target. */
  function failingEdits(path: string, times: number): Message[] {
    const turns: Message[] = []
    for (let run = 0; run < times; run++) {
      const id = nextToolUseId()
      turns.push(
        assistantCalls({
          tool: FILE_EDIT_TOOL_NAME,
          input: { file_path: path, old_string: 'missing', new_string: 'x' },
          id,
        }),
        toolAnswers(id, 'String to replace not found in file.', true),
      )
    }
    return turns
  }

  describe('the combined prompt', () => {
    const MANIFEST = '- [project] team/decisions/release_train.md (2026-04-01T00:00:00.000Z): Releases leave on Thursdays'
    const HINT = buildLoopHint('Bash', 3)

    test('carries the combined taxonomy, the team categories and the exclusions verbatim, not the private-only taxonomy', () => {
      const prompt = buildExtractCombinedPrompt(4, MANIFEST)
      expect(prompt).toContain(TYPES_SECTION_COMBINED.join('\n'))
      expect(prompt).toContain(renderTeamCategoriesXml().join('\n'))
      expect(prompt).toContain(WHAT_NOT_TO_SAVE_SECTION.join('\n'))
      expect(prompt).not.toContain(TYPES_SECTION_INDIVIDUAL.join('\n'))
    })

    test('forbids keys and credentials in shared team memory', () => {
      const prompt = buildExtractCombinedPrompt(4, '')
      expect(prompt).toMatch(/API keys?/)
      expect(prompt).toMatch(/credentials?/)
      expect(buildExtractAutoOnlyPrompt(4, '')).not.toMatch(/API keys?/)
    })

    test('describes the indexes: MEMORY.md, the link format, ~150 characters, cut after 200 lines', () => {
      const prompt = buildExtractCombinedPrompt(4, '')
      expect(prompt).toContain('`MEMORY.md`')
      expect(prompt).toContain('`- [Title](file.md) — one-line hook`')
      expect(prompt).toMatch(/\b150\b/)
      expect(prompt).toMatch(/\b200\b/)
    })

    test('shows the frontmatter example, and explains `paths:` as a rule under .claudin/rules/ does', () => {
      const prompt = buildExtractCombinedPrompt(4, '')
      expect(prompt).toContain(MEMORY_FRONTMATTER_EXAMPLE.join('\n'))
      expect(prompt).toContain('`paths:`')
      expect(prompt).toContain('`.claudin/rules/`')
    })

    test('opens as the auto-only prompt does: count, tools, manifest and hint come before they part', () => {
      const combined = buildExtractCombinedPrompt(9, MANIFEST, HINT)
      const autoOnly = buildExtractAutoOnlyPrompt(9, MANIFEST, HINT)
      let shared = 0
      while (shared < combined.length && combined[shared] === autoOnly[shared]) shared++
      const opening = combined.slice(0, shared)
      expect(opening).toContain('~9')
      expect(opening).toContain(MANIFEST)
      expect(opening).toContain(HINT)
      for (const name of [FILE_READ_TOOL_NAME, GREP_TOOL_NAME, GLOB_TOOL_NAME, BASH_TOOL_NAME, FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME]) {
        expect(opening).toContain(name)
      }
      expect(combined).not.toBe(autoOnly)
    })
  })

  describe('an extraction with team memory', () => {
    test('asks the fork with the combined prompt, the team files in its manifest', async () => {
      process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
      cpSync(join(import.meta.dir, '__fixtures__', 'rewrite', 'memory-dir'), scene().memoryDir, {
        recursive: true,
      })
      mkdirSync(inMemory('team', 'decisions'), { recursive: true })
      writeFileSync(
        inMemory('team', 'decisions', 'release_train.md'),
        '---\nname: release-train\ndescription: Releases leave on Thursdays\ntype: project\n---\n\nThursdays.\n',
      )
      // Distinct modification times: the manifest lists newest first, and ties have no stable order.
      const stamps: Array<[string[], string]> = [
        [['team', 'decisions', 'release_train.md'], '2026-04-01T00:00:00.000Z'],
        [['feedback_temp_dirs.md'], '2026-03-04T05:06:07.000Z'],
        [['user_role.md'], '2026-02-01T08:00:00.000Z'],
        [['notes', 'untyped.md'], '2026-01-01T00:00:00.000Z'],
      ]
      for (const [parts, iso] of stamps) utimesSync(inMemory(...parts), new Date(iso), new Date(iso))
      await executeExtractMemories(turnEnded([humanSays('a'), assistantSays('b')]))
      const prompt = promptOf(fork.requests[0])
      expect(prompt).toBe(buildExtractCombinedPrompt(2, await manifestNow()))
      expect(prompt).toContain('team/decisions/release_train.md')
    })

    test('the memory_saved message counts the team files among those it lists', async () => {
      process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
      announceSavedMemories(true)
      fork.answer(async () =>
        forkReturns([
          assistantCalls(
            writes(inMemory('feedback_tabs.md')),
            writes(inMemory('team', 'decisions', 'release_train.md')),
            writes(inMemory('team', 'MEMORY.md')),
          ),
          assistantCalls(writes(inMemory('team', 'conventions.md')), writes(inMemory('MEMORY.md'))),
        ]),
      )
      const appended: unknown[] = []
      await executeExtractMemories(turnEnded([humanSays('x')]), message => {
        appended.push(message)
      })
      expect(appended).toStrictEqual([
        {
          type: 'system',
          subtype: 'memory_saved',
          writtenPaths: [
            inMemory('feedback_tabs.md'),
            inMemory('team', 'decisions', 'release_train.md'),
            inMemory('team', 'conventions.md'),
          ],
          teamCount: 2,
          timestamp: expect.any(String),
          uuid: expect.any(String),
          isMeta: false,
        },
      ])
    })

    test('with no team file written, teamCount is 0 rather than missing', async () => {
      process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
      announceSavedMemories(true)
      fork.answer(async () => forkReturns([assistantCalls(writes(inMemory('user_role.md')))]))
      const appended: Array<Record<string, unknown>> = []
      await executeExtractMemories(turnEnded([humanSays('x')]), message => {
        appended.push(message as unknown as Record<string, unknown>)
      })
      expect(appended).toHaveLength(1)
      expect(appended[0]?.teamCount).toBe(0)
    })
  })

  describe('the repeated-error trigger', () => {
    test('three identical failing calls force a fork at once, with the loop hint for that tool and count', async () => {
      const messages = [humanSays('build it'), ...failingRuns('bun run build', 3)]
      await executeExtractMemories(turnEnded(messages))
      expect(fork.requests).toHaveLength(1)
      expect(promptOf(fork.requests[0])).toBe(
        buildExtractCombinedPrompt(7, await manifestNow(), buildLoopHint(BASH_TOOL_NAME, 3)),
      )
    })

    test('the same loop in the same human turn fires once; after that the cadence decides', async () => {
      const turn = [humanSays('build it'), ...failingRuns('bun run build', 3)]
      await executeExtractMemories(turnEnded(turn))
      const stillStuck = [...turn, ...failingRuns('bun run build', 1)]
      await executeExtractMemories(turnEnded(stillStuck))
      expect(fork.requests).toHaveLength(1)
    })

    test('a new human turn re-arms it for the same loop', async () => {
      const turn = [humanSays('build it'), ...failingRuns('bun run build', 3)]
      await executeExtractMemories(turnEnded(turn))
      const retried = [...turn, humanSays('try again'), ...failingRuns('bun run build', 3)]
      await executeExtractMemories(turnEnded(retried))
      expect(fork.requests).toHaveLength(2)
      expect(promptOf(fork.requests[1])).toContain(buildLoopHint(BASH_TOOL_NAME, 3))
    })

    test('a louder loop on another call in the same turn fires as well', async () => {
      const turn = [humanSays('build it'), ...failingRuns('bun run build', 3)]
      await executeExtractMemories(turnEnded(turn))
      const worse = [...turn, ...failingEdits(join(scene().projectDir, 'src', 'app.ts'), 4)]
      await executeExtractMemories(turnEnded(worse))
      expect(fork.requests).toHaveLength(2)
      expect(promptOf(fork.requests[1])).toContain(buildLoopHint(FILE_EDIT_TOOL_NAME, 4))
    })

    test('CLAUDIN_LOOP_MEMORY_TRIGGER=0 turns it off', async () => {
      process.env.CLAUDIN_LOOP_MEMORY_TRIGGER = '0'
      await executeExtractMemories(turnEnded([humanSays('build it'), ...failingRuns('bun run build', 3)]))
      expect(fork.requests).toHaveLength(0)
    })

    test('a loop fork restarts the cadence', async () => {
      process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '3'
      const transcript: Message[] = [humanSays('build it')]
      await executeExtractMemories(turnEnded([...transcript]))
      transcript.push(...failingRuns('bun run build', 3))
      await executeExtractMemories(turnEnded([...transcript]))
      expect(fork.requests).toHaveLength(1)
      for (let turn = 0; turn < 2; turn++) {
        transcript.push(...failingRuns('bun run build', 1))
        await executeExtractMemories(turnEnded([...transcript]))
      }
      expect(fork.requests).toHaveLength(1)
      transcript.push(assistantSays('giving up for now'))
      await executeExtractMemories(turnEnded([...transcript]))
      expect(fork.requests).toHaveLength(2)
      // A routine fork: no hint, and the five messages since the loop fork.
      expect(promptOf(fork.requests[1])).toBe(buildExtractCombinedPrompt(5, await manifestNow()))
    })

    test('a memory the main agent saved still wins over a loop', async () => {
      const messages = [
        humanSays('build it'),
        ...failingRuns('bun run build', 3),
        assistantCalls(writes(inMemory('feedback_build.md'))),
      ]
      await executeExtractMemories(turnEnded(messages))
      expect(fork.requests).toHaveLength(0)
    })

    test('a trailing fork carries no hint, and the loop fires on the next turn instead', async () => {
      process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1'
      const firstFork = Promise.withResolvers<ForkedAgentResult>()
      fork.answer(() => firstFork.promise)
      const first = [humanSays('build it')]
      const running = executeExtractMemories(turnEnded(first))
      await eventually(() => fork.requests.length === 1, 'the first fork')

      fork.answer(async () => forkReturns([]))
      const looping = [...first, ...failingRuns('bun run build', 3)]
      await executeExtractMemories(turnEnded(looping))
      firstFork.resolve(forkReturns([]))
      await running
      expect(fork.requests).toHaveLength(2)
      expect(promptOf(fork.requests[1])).toBe(buildExtractCombinedPrompt(6, await manifestNow()))

      process.env.CLAUDIN_EXTRACT_MEMORIES_EVERY = '1000'
      await executeExtractMemories(turnEnded([...looping, assistantSays('still failing')]))
      expect(fork.requests).toHaveLength(3)
      expect(promptOf(fork.requests[2])).toContain(buildLoopHint(BASH_TOOL_NAME, 3))
    })
  })
}
