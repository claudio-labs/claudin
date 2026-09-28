/**
 * Characterization of `memdir.ts`: the MEMORY.md index caps, the directory
 * helpers, the private-memory prompt texts, the past-context search section and
 * `loadMemoryPrompt`.
 *
 * The prompts are pinned by the facts they must carry (paths, file names,
 * formats, limits, the rules the model is given), never by their sentences.
 * `feature()` reads false under `bun test`, so `loadMemoryPrompt` takes its
 * private-only path here; the team prompts it returns in a shipped build are
 * pinned in `memdir.teamPrompts.characterization.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, sep } from 'node:path'
import {
  areMemoryIndexesEmpty,
  buildMemoryLines,
  buildMemoryPrompt,
  buildMemoryStubLines,
  buildSearchingPastContextSection,
  countIndexEntries,
  DIR_EXISTS_GUIDANCE,
  DIRS_EXIST_GUIDANCE,
  ensureMemoryDirExists,
  ENTRYPOINT_NAME,
  hasExistingMemories,
  isLeanMemoryPromptEnabled,
  loadMemoryPrompt,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  truncateEntrypointContent,
} from 'src/memory/memdir/memdir.js'
import { MEMORY_FRONTMATTER_EXAMPLE, MEMORY_TYPES } from 'src/memory/memdir/memoryTypes.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { useMemdirWorld } from 'src/memory/memdir/__testutils__/memdirWorld.js'

const world = useMemdirWorld()

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
const TEAM_INDEX = readFileSync(join(FIXTURES, 'memory', 'team', 'MEMORY.md'), 'utf8')

const WARNING_PREFIX = '\n\n> WARNING: MEMORY.md is '

function bodyBeforeWarning(content: string): string {
  const at = content.indexOf(WARNING_PREFIX)
  return at === -1 ? content : content.slice(0, at)
}

function warningOf(content: string): string {
  const at = content.indexOf(WARNING_PREFIX)
  if (at === -1) throw new Error('no truncation warning')
  return content.slice(at + 2)
}

function lines(count: number, make: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => make(i)).join('\n')
}

/** A memory directory path under the world, with its trailing separator. */
function memoryDir(name = 'mem'): string {
  return join(world().root, name) + sep
}

/** The transcripts directory the search section names for the session. */
function transcriptsDir(): string {
  const w = world()
  return join(w.configDir, 'projects', w.project.replace(/[^a-zA-Z0-9]/g, '-'))
}

describe('the index file and its caps', () => {
  test('is MEMORY.md, capped at 200 lines and 25,000 bytes', () => {
    expect(ENTRYPOINT_NAME).toBe('MEMORY.md')
    expect(MAX_ENTRYPOINT_LINES).toBe(200)
    expect(MAX_ENTRYPOINT_BYTES).toBe(25_000)
  })
})

describe('countIndexEntries', () => {
  test('counts the top-level bullets of a real index, prose-led entries included', () => {
    expect(countIndexEntries(TEAM_INDEX)).toBe(5)
  })

  test.each([
    ['- one', 1],
    ['-\tone', 1],
    ['-   one', 1],
    ['-one', 0],
    [' - nested', 0],
    ['  - nested', 0],
    ['* star', 0],
    ['+ plus', 0],
    ['- ', 0],
    ['-', 0],
    ['# - heading', 0],
    ['- a\r\n- b', 2],
    ['', 0],
    ['# Memory\n\nNothing saved yet.', 0],
  ])('%p counts %p', (text, count) => {
    expect(countIndexEntries(text)).toBe(count)
  })

  test('the truncation warning is not an entry', () => {
    const truncated = truncateEntrypointContent(lines(260, i => `- [M${i}](m${i}.md) — hook`))
    expect(truncated.content).toContain('> WARNING:')
    expect(countIndexEntries(truncated.content)).toBe(200)
  })
})

describe('truncateEntrypointContent', () => {
  test('an index under both caps comes back trimmed, with its size and no flags', () => {
    const result = truncateEntrypointContent('\n\n  - [A](a.md) — x\n- [B](b.md) — é\n\n')
    expect(result).toEqual({
      content: '- [A](a.md) — x\n- [B](b.md) — é',
      lineCount: 2,
      byteCount: Buffer.byteLength('- [A](a.md) — x\n- [B](b.md) — é'),
      wasLineTruncated: false,
      wasByteTruncated: false,
    })
  })

  test('exactly 200 lines and exactly 25,000 bytes are still whole', () => {
    const atLineCap = lines(200, i => `- entry ${i}`)
    expect(truncateEntrypointContent(atLineCap).content).toBe(atLineCap)

    // 100 lines of 249 bytes and 99 newlines, plus one byte.
    const atByteCap = lines(100, () => 'b'.repeat(249)) + 'c'
    expect(Buffer.byteLength(atByteCap)).toBe(25_000)
    const result = truncateEntrypointContent(atByteCap)
    expect(result.wasByteTruncated).toBe(false)
    expect(result.content).toBe(atByteCap)
    expect(truncateEntrypointContent(atByteCap + 'd').wasByteTruncated).toBe(true)
  })

  test('over the line cap: the first 200 lines, then a warning naming the count and the limit', () => {
    const raw = lines(201, i => `- [Memory ${i}](m${i}.md) — hook`)
    const result = truncateEntrypointContent(raw)
    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(false)
    expect(result.lineCount).toBe(201)
    expect(result.byteCount).toBe(Buffer.byteLength(raw))
    expect(bodyBeforeWarning(result.content)).toBe(raw.split('\n').slice(0, 200).join('\n'))
    const warning = warningOf(result.content)
    expect(warning.startsWith('> WARNING: MEMORY.md is 201 lines (limit: 200)')).toBe(true)
    expect(warning).not.toContain('\n')
  })

  test('over the byte cap only: cut at the last newline before it, the sizes in the warning', () => {
    const line = 'x'.repeat(200)
    const raw = lines(150, () => line)
    const result = truncateEntrypointContent(raw)
    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(true)
    const body = bodyBeforeWarning(result.content)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(25_000)
    expect(body.split('\n').every(l => l === line)).toBe(true)
    expect(body.split('\n')).toHaveLength(124)
    const warning = warningOf(result.content)
    expect(warning).toContain(
      `MEMORY.md is ${formatFileSize(Buffer.byteLength(raw))} (limit: ${formatFileSize(25_000)})`,
    )
    expect(warning).toMatch(/too long/)
  })

  test('over both caps: line cut first, then byte cut, and both named', () => {
    const raw = lines(300, i => `${String(i).padStart(3, '0')} ${'z'.repeat(146)}`)
    const result = truncateEntrypointContent(raw)
    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(true)
    const body = bodyBeforeWarning(result.content)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(25_000)
    expect(body.startsWith('000 ')).toBe(true)
    expect(warningOf(result.content)).toContain(
      `MEMORY.md is 300 lines and ${formatFileSize(Buffer.byteLength(raw))}`,
    )
  })

  test('the byte flag reads the original size even when the line cut alone fits', () => {
    const raw = lines(260, () => 'y'.repeat(110))
    const result = truncateEntrypointContent(raw)
    const body = bodyBeforeWarning(result.content)
    expect(body.split('\n')).toHaveLength(200)
    expect(Buffer.byteLength(body)).toBeLessThan(25_000)
    expect(result.wasByteTruncated).toBe(true)
    expect(warningOf(result.content)).toContain(`260 lines and ${formatFileSize(Buffer.byteLength(raw))}`)
  })

  test('with no newline before the cap it cuts at exactly 25,000 bytes', () => {
    const result = truncateEntrypointContent('w'.repeat(30_000))
    expect(bodyBeforeWarning(result.content)).toBe('w'.repeat(25_000))
  })

  test('bytes are UTF-8 bytes, and a cut never splits a character', () => {
    const wide = lines(40, () => '記'.repeat(300))
    expect(wide.length).toBeLessThan(25_000)
    const byLine = truncateEntrypointContent(wide)
    expect(byLine.wasByteTruncated).toBe(true)
    expect(byLine.byteCount).toBe(Buffer.byteLength(wide))

    const oneLine = truncateEntrypointContent('é'.repeat(20_000))
    const body = bodyBeforeWarning(oneLine.content)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(25_000)
    expect(body).not.toContain('\uFFFD')
    expect(body).toBe('é'.repeat(12_500))

    // Two ASCII bytes first put byte 25,000 in the middle of a 3-byte character.
    const offset = truncateEntrypointContent('ab' + '記'.repeat(10_000))
    const offsetBody = bodyBeforeWarning(offset.content)
    expect(offsetBody).not.toContain('\uFFFD')
    expect(Buffer.byteLength(offsetBody)).toBe(24_998)
    expect(offsetBody).toBe('ab' + '記'.repeat(8_332))
  })

  test('the warning tells the model the index was cut and how to keep it short', () => {
    const warning = warningOf(truncateEntrypointContent(lines(205, i => `- ${i}`)).content)
    expect(warning).toMatch(/part/i)
    expect(warning).toMatch(/one line/)
    expect(warning).toMatch(/200 char/)
    expect(warning).toMatch(/topic files/)
  })
})

describe('the directory guidance constants', () => {
  test('say the directory exists: write with the Write tool, no mkdir, no existence check', () => {
    for (const text of [DIR_EXISTS_GUIDANCE, DIRS_EXIST_GUIDANCE]) {
      expect(text).toMatch(/already exist/)
      expect(text).toContain('Write tool')
      expect(text).toContain('mkdir')
    }
    expect(DIRS_EXIST_GUIDANCE).toMatch(/both/i)
    expect(DIR_EXISTS_GUIDANCE).not.toMatch(/both/i)
  })
})

describe('ensureMemoryDirExists', () => {
  test('creates the directory with its parents, and again is harmless', async () => {
    const dir = join(world().root, 'a', 'b', 'memory') + sep
    await ensureMemoryDirExists(dir)
    expect(statSync(dir).isDirectory()).toBe(true)
    await ensureMemoryDirExists(dir)
    expect(statSync(dir).isDirectory()).toBe(true)
  })

  test('never rejects, even when the directory cannot be made', async () => {
    const w = world()
    const blocker = w.put(join(w.root, 'blocker'), 'a file, not a directory\n')
    await ensureMemoryDirExists(join(blocker, 'memory') + sep)
    expect(existsSync(join(blocker, 'memory'))).toBe(false)
  })
})

describe('hasExistingMemories', () => {
  test('false for a missing or empty directory, or one with only a blank index', () => {
    const w = world()
    expect(hasExistingMemories(memoryDir('missing'))).toBe(false)
    const dir = memoryDir()
    mkdirSync(dir)
    expect(hasExistingMemories(dir)).toBe(false)
    w.put(dir + 'MEMORY.md', ' \n\t\n')
    expect(hasExistingMemories(dir)).toBe(false)
  })

  test('true for an index with content, or for any other .md file beside it', () => {
    const w = world()
    const withIndex = memoryDir('with-index')
    w.put(withIndex + 'MEMORY.md', '- [A](a.md) — hook\n')
    expect(hasExistingMemories(withIndex)).toBe(true)

    const withTopic = memoryDir('with-topic')
    w.put(withTopic + 'MEMORY.md', '')
    w.put(withTopic + 'prefers-tabs.md', '---\nname: prefers-tabs\n---\n')
    expect(hasExistingMemories(withTopic)).toBe(true)
  })

  test('other files, directories named *.md and nested files do not count', () => {
    const w = world()
    const dir = memoryDir()
    w.put(dir + 'notes.txt', 'text\n')
    mkdirSync(dir + 'folder.md')
    w.put(join(dir, 'team', 'conventions.md'), '---\nname: c\n---\n')
    expect(hasExistingMemories(dir)).toBe(false)
  })
})

describe('areMemoryIndexesEmpty', () => {
  const project = { type: 'Project' as const, content: '# Instructions\nUse the linter.' }

  test('true when no private or team index put anything in context', () => {
    expect(areMemoryIndexesEmpty([])).toBe(true)
    expect(areMemoryIndexesEmpty([project])).toBe(true)
    expect(
      areMemoryIndexesEmpty([
        project,
        { type: 'AutoMem', content: '' },
        { type: 'TeamMem', content: '\n \t ' },
      ]),
    ).toBe(true)
  })

  test('false as soon as either index has content', () => {
    expect(areMemoryIndexesEmpty([{ type: 'AutoMem', content: '- [A](a.md) — x' }])).toBe(false)
    expect(
      areMemoryIndexesEmpty([
        { type: 'AutoMem', content: '' },
        { type: 'TeamMem', content: '## Bugs\n- [B](bugs/b.md) — y' },
      ]),
    ).toBe(false)
  })

  test('other instruction kinds never count, whatever they hold', () => {
    for (const type of ['User', 'Project', 'Local', 'Managed'] as const) {
      expect(areMemoryIndexesEmpty([{ type, content: '- [X](x.md) — looks like an index' }])).toBe(true)
    }
  })
})

describe('buildMemoryLines (the full private-memory text)', () => {
  const dir = '/srv/work/app/.claudin/memory/'
  const text = () => buildMemoryLines('auto memory', dir).join('\n')

  test('opens with the display name and names the directory, which already exists', () => {
    const built = buildMemoryLines('agent memory', dir)
    expect(built[0]).toBe('# agent memory')
    expect(built.some(line => line.includes(`\`${dir}\``) && line.includes(DIR_EXISTS_GUIDANCE))).toBe(true)
  })

  test('shows the frontmatter example whole and explains [[name]] links', () => {
    const built = buildMemoryLines('auto memory', dir)
    const start = built.indexOf(MEMORY_FRONTMATTER_EXAMPLE[0]!)
    expect(start).toBeGreaterThan(0)
    expect(built.slice(start, start + MEMORY_FRONTMATTER_EXAMPLE.length)).toEqual([
      ...MEMORY_FRONTMATTER_EXAMPLE,
    ])
    expect(text()).toContain('`[[name]]`')
    expect(text()).toContain('`name:`')
  })

  test('names the four types', () => {
    for (const type of MEMORY_TYPES) expect(text()).toContain(`\`${type}\``)
    expect(text()).toMatch(/absolute/)
  })

  test('teaches the index: its name, the pointer line, no content in it, the 200-line cut', () => {
    const built = text()
    expect(built).toContain('`MEMORY.md`')
    expect(built).toContain('`- [Title](file.md) — hook`')
    expect(built).toMatch(/frontmatter/)
    expect(built).toContain(`${MAX_ENTRYPOINT_LINES}`)
    expect(built).toMatch(/truncated/)
  })

  test('explains paths: in the terms of a rule, relative to the project root, on Read', () => {
    const built = text()
    expect(built).toContain('`paths:`')
    expect(built).toContain('`.claudin/rules/`')
    expect(built).toMatch(/project root/)
    expect(built).toMatch(/Read/)
  })

  test('the saving rules: update before duplicating, skip the derivable, remember and forget', () => {
    const built = text()
    expect(built).toMatch(/duplicate/)
    expect(built).toMatch(/git history/)
    expect(built).toContain('CLAUDE.md')
    expect(built).toMatch(/non-obvious/)
    expect(built).toMatch(/remember/)
    expect(built).toMatch(/forget/)
  })

  test('frames recall as background inside system reminders, to verify before use', () => {
    const built = text()
    expect(built).toContain('`<system-reminder>`')
    expect(built).toMatch(/not[^.\n]{0,40}instructions/)
    expect(built).toMatch(/verify/)
  })

  test('keeps the current conversation out of memory: a Plan and tasks instead', () => {
    const built = text()
    expect(built).toMatch(/future conversations/)
    expect(built).toMatch(/Plan/)
    expect(built).toMatch(/tasks/)
  })

  test('extra guidelines come after the rules, one line each, before the search section', () => {
    const built = buildMemoryLines('auto memory', dir, ['EXTRA-ONE', 'EXTRA-TWO'])
    const one = built.indexOf('EXTRA-ONE')
    expect(one).toBeGreaterThan(built.findIndex(line => line.includes('<system-reminder>')))
    expect(built[one + 1]).toBe('EXTRA-TWO')
    expect(built.indexOf('## Searching past context')).toBeGreaterThan(one)
  })

  test('ends with the past-context search section for the same directory', () => {
    const built = buildMemoryLines('auto memory', dir)
    const section = buildSearchingPastContextSection(dir)
    expect(built.slice(-section.length)).toEqual(section)

    process.env.CLAUDIN_MEMORY_PAST_CONTEXT = '0'
    expect(buildMemoryLines('auto memory', dir).join('\n')).not.toContain('Searching past context')
  })
})

describe('buildMemoryStubLines (the text for an empty directory)', () => {
  const dir = '/srv/work/app/.claudin/memory/'

  test('says the memory is empty, and how the first memory and its index line are written', () => {
    const built = buildMemoryStubLines('auto memory', dir)
    expect(built[0]).toBe('# auto memory')
    const text = built.join('\n')
    expect(built.some(line => line.includes(`\`${dir}\``) && line.includes(DIR_EXISTS_GUIDANCE))).toBe(true)
    expect(text).toMatch(/empty/)
    expect(text).toMatch(/remember/)
    expect(text).toContain('`.md`')
    for (const key of ['`name`', '`description`', '`type`']) expect(text).toContain(key)
    for (const type of MEMORY_TYPES) expect(text).toContain(`\`${type}\``)
    expect(text).not.toContain('metadata')
    expect(text).toContain('`MEMORY.md`')
    expect(text).toContain('`- [Title](file.md) — hook`')
    expect(text).toMatch(/frontmatter/)
  })

  test('is much shorter than the full text and carries the same search section', () => {
    const stub = buildMemoryStubLines('auto memory', dir)
    const full = buildMemoryLines('auto memory', dir)
    expect(stub.join('\n').length * 2).toBeLessThan(full.join('\n').length)
    expect(stub.join('\n')).not.toContain('```markdown')
    const section = buildSearchingPastContextSection(dir)
    expect(stub.slice(-section.length)).toEqual(section)
  })

  test('carries extra guidelines before the search section', () => {
    const stub = buildMemoryStubLines('auto memory', dir, ['STUB-EXTRA'])
    const at = stub.indexOf('STUB-EXTRA')
    expect(at).toBeGreaterThan(0)
    expect(stub.indexOf('## Searching past context')).toBeGreaterThan(at)
  })
})

describe('buildMemoryPrompt (the full text plus the index, for agent memory)', () => {
  test('is the full text, then a MEMORY.md section with the trimmed index', () => {
    const w = world()
    const dir = memoryDir()
    w.put(dir + 'MEMORY.md', `\n${TEAM_INDEX}\n\n`)
    const prompt = buildMemoryPrompt({ displayName: 'agent memory', memoryDir: dir, extraGuidelines: ['EXTRA'] })
    expect(prompt).toBe(
      [...buildMemoryLines('agent memory', dir, ['EXTRA']), '## MEMORY.md', '', TEAM_INDEX.trim()].join('\n'),
    )
  })

  test('an index over the caps arrives truncated, with the warning', () => {
    const w = world()
    const dir = memoryDir()
    const raw = lines(230, i => `- [Memory ${i}](m${i}.md) — hook`)
    w.put(dir + 'MEMORY.md', raw)
    const prompt = buildMemoryPrompt({ displayName: 'agent memory', memoryDir: dir })
    expect(prompt.endsWith(truncateEntrypointContent(raw).content)).toBe(true)
    expect(prompt).toContain('> WARNING: MEMORY.md is 230 lines')
  })

  test('a missing or blank index gets the empty-index note instead, and nothing is created', () => {
    const w = world()
    const missing = memoryDir('not-there')
    const prompt = buildMemoryPrompt({ displayName: 'agent memory', memoryDir: missing })
    const head = buildMemoryLines('agent memory', missing).join('\n')
    expect(prompt.startsWith(`${head}\n## MEMORY.md\n\n`)).toBe(true)
    const note = prompt.slice(`${head}\n## MEMORY.md\n\n`.length)
    expect(note).toContain('MEMORY.md')
    expect(note).toMatch(/empty/)
    expect(note).not.toContain('\n')
    expect(existsSync(missing)).toBe(false)

    const blank = memoryDir('blank')
    w.put(blank + 'MEMORY.md', '  \n\n')
    const blankPrompt = buildMemoryPrompt({ displayName: 'agent memory', memoryDir: blank })
    expect(blankPrompt.endsWith(note)).toBe(true)
  })
})

describe('buildSearchingPastContextSection', () => {
  const dir = '/srv/work/app/.claudin/memory/'

  test('the full section: memory topic files first, then the transcripts as a last resort', () => {
    const section = buildSearchingPastContextSection(dir)
    expect(section[0]).toBe('## Searching past context')
    expect(section.at(-1)).toBe('')
    const text = section.join('\n')
    const memorySearch = `${GREP_TOOL_NAME} with pattern="<search term>" path="${dir}" glob="*.md"`
    const transcriptSearch = `${GREP_TOOL_NAME} with pattern="<search term>" path="${transcriptsDir()}/" glob="*.jsonl"`
    expect(section).toContain(memorySearch)
    expect(section).toContain(transcriptSearch)
    expect(section.indexOf(memorySearch)).toBeLessThan(section.indexOf(transcriptSearch))
    for (const command of [memorySearch, transcriptSearch]) {
      const at = section.indexOf(command)
      expect(section[at - 1]).toBe('```')
      expect(section[at + 1]).toBe('```')
    }
    expect(text).toMatch(/last resort/)
    expect(text).toMatch(/narrow/)
  })

  test('the lean form is one line with both searches, in the same order', () => {
    const lean = buildSearchingPastContextSection(dir, true)
    expect(lean).toHaveLength(1)
    const [line] = lean as [string]
    const memorySearch = `${GREP_TOOL_NAME} with pattern="<search term>" path="${dir}" glob="*.md"`
    const transcriptSearch = `${GREP_TOOL_NAME} with pattern="<search term>" path="${transcriptsDir()}/" glob="*.jsonl"`
    expect(line.indexOf(memorySearch)).toBeGreaterThan(-1)
    expect(line.indexOf(transcriptSearch)).toBeGreaterThan(line.indexOf(memorySearch))
    expect(line).toMatch(/last resort/)
    expect(line).toMatch(/narrow/)
  })

  test('the transcripts are the ones of the session original cwd', () => {
    const w = world()
    const elsewhere = w.mkdir('launched-here')
    w.enter(elsewhere)
    const expected = join(w.configDir, 'projects', elsewhere.replace(/[^a-zA-Z0-9]/g, '-'))
    expect(buildSearchingPastContextSection(dir).join('\n')).toContain(`path="${expected}/" glob="*.jsonl"`)
  })

  test('with embedded search tools it gives shell grep commands instead', () => {
    process.env.EMBEDDED_SEARCH_TOOLS = '1'
    const section = buildSearchingPastContextSection(dir)
    expect(section).toContain(`grep -rn "<search term>" ${dir} --include="*.md"`)
    expect(section).toContain(`grep -rn "<search term>" ${transcriptsDir()}/ --include="*.jsonl"`)
    expect(section.join('\n')).not.toContain(GREP_TOOL_NAME + ' with')

    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    expect(buildSearchingPastContextSection(dir).join('\n')).toContain(`${GREP_TOOL_NAME} with`)
  })

  test.each(['0', 'false', 'no', 'off'])('CLAUDIN_MEMORY_PAST_CONTEXT=%p drops it in both forms', value => {
    process.env.CLAUDIN_MEMORY_PAST_CONTEXT = value
    expect(buildSearchingPastContextSection(dir)).toEqual([])
    expect(buildSearchingPastContextSection(dir, true)).toEqual([])
  })

  test.each(['1', 'yes', '', 'sometimes'])('CLAUDIN_MEMORY_PAST_CONTEXT=%p keeps it', value => {
    process.env.CLAUDIN_MEMORY_PAST_CONTEXT = value
    expect(buildSearchingPastContextSection(dir)[0]).toBe('## Searching past context')
  })
})

describe('isLeanMemoryPromptEnabled', () => {
  test('on unless CLAUDIN_LEAN_MEMORY_PROMPT is an off value', () => {
    expect(isLeanMemoryPromptEnabled()).toBe(true)
    for (const off of ['0', 'false', 'no', 'off']) {
      process.env.CLAUDIN_LEAN_MEMORY_PROMPT = off
      expect(isLeanMemoryPromptEnabled()).toBe(false)
    }
    for (const on of ['1', 'true', '', 'v2']) {
      process.env.CLAUDIN_LEAN_MEMORY_PROMPT = on
      expect(isLeanMemoryPromptEnabled()).toBe(true)
    }
  })
})

describe('loadMemoryPrompt (private memory only: no team feature under test)', () => {
  test('null when auto memory is off, and nothing is created', async () => {
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    expect(await loadMemoryPrompt()).toBeNull()
    expect(await loadMemoryPrompt(true)).toBeNull()
    expect(existsSync(join(world().configDir, 'projects'))).toBe(false)
  })

  test('an empty directory gets the compact text, and the directory now exists', async () => {
    const dir = getAutoMemPath()
    expect(existsSync(dir)).toBe(false)
    const prompt = await loadMemoryPrompt()
    expect(prompt).toBe(buildMemoryStubLines('auto memory', dir).join('\n'))
    expect(statSync(dir).isDirectory()).toBe(true)
  })

  test('a directory holding memories gets the full text', async () => {
    const dir = getAutoMemPath()
    cpSync(join(FIXTURES, 'memory'), dir, { recursive: true })
    expect(await loadMemoryPrompt()).toBe(buildMemoryLines('auto memory', dir).join('\n'))
  })

  test('an index with content alone is enough for the full text; a blank one is not', async () => {
    const w = world()
    const dir = getAutoMemPath()
    w.put(dir + 'MEMORY.md', '  \n')
    expect(await loadMemoryPrompt()).toBe(buildMemoryStubLines('auto memory', dir).join('\n'))
    writeFileSync(dir + 'MEMORY.md', '- [A](a.md) — hook\n')
    expect(await loadMemoryPrompt()).toBe(buildMemoryLines('auto memory', dir).join('\n'))
  })

  test('the lean switch does not change the private-only text', async () => {
    const dir = getAutoMemPath()
    cpSync(join(FIXTURES, 'memory'), dir, { recursive: true })
    expect(await loadMemoryPrompt(true)).toBe(await loadMemoryPrompt(false))
  })

  test('CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES is passed on as one extra guideline', async () => {
    const dir = getAutoMemPath()
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES = 'Save nothing about customers.'
    expect(await loadMemoryPrompt()).toBe(
      buildMemoryStubLines('auto memory', dir, ['Save nothing about customers.']).join('\n'),
    )
  })

  test('a blank CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES is ignored', async () => {
    const dir = getAutoMemPath()
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES = ' \n\t'
    expect(await loadMemoryPrompt()).toBe(buildMemoryStubLines('auto memory', dir).join('\n'))
  })

  test('in a repository the text names the project-local directory', async () => {
    const w = world()
    const repo = w.repo(join(w.root, 'repo'))
    w.enter(repo)
    const prompt = await loadMemoryPrompt()
    expect(prompt).toContain(`\`${join(repo, '.claudin', 'memory')}${sep}\``)
  })
})
