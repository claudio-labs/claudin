import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { PowerShellTool } from 'src/tools/PowerShellTool/PowerShellTool.js'

const spillDir = mkdtempSync(join(tmpdir(), 'shell-spill-'))
afterAll(() => rmSync(spillDir, { recursive: true, force: true }))

/** A saved run's file, and the page a result built from it shows. */
function spill(name: string, text: string): string {
  const path = join(spillDir, name)
  writeFileSync(path, text)
  return path
}
const pageOf = (content: string) => content.slice(content.indexOf('\n\n') + 2, content.indexOf('\n</persisted-output>'))
const shownOf = (content: string) =>
  Number(/^Lines 1-(\d+) are below; Read the file with offset=\d+ and limit=\d+ for the next page\.$/m.exec(content)![1])

// The page of a run that spilled is cut from the saved file itself: stdout has
// been through the output filter, the blank-line strip and a byte cap that
// can end mid-line, and any of them would shift the pointer's line numbers.
test('a shell run that spilled is paged from its saved file, whatever its stdout went through', () => {
  const raw = `\n\n${Array.from({ length: 3_000 }, (_, i) => `out ${i + 1} ${'q'.repeat(30)}`).join('\n')}\n`
  const path = spill('filtered.txt', raw)
  const result = BashTool.mapToolResultToToolResultBlockParam(
    {
      // What the filter left of it: a head, a cut, a tail.
      stdout: 'out 1\n…2990 lines omitted…\nout 3000',
      stderr: '',
      interrupted: false,
      persistedOutputPath: path,
      persistedOutputSize: raw.length,
    },
    'tool-paged',
  )
  const content = String(result.content)
  expect(content.length).toBeLessThanOrEqual(30_000)
  const shown = shownOf(content)
  expect(shown).toBeGreaterThan(100)
  // Lines 1-2 of the file are the blank ones trimShellStdout would drop.
  expect(pageOf(content)).toBe(raw.split('\n').slice(0, shown).join('\n'))
  expect(content).not.toContain('lines omitted')
})

test('a line the head cut short is not counted as shown', () => {
  // Lines of mixed width, so the head ends inside one.
  const raw = Array.from({ length: 4_000 }, (_, i) => `l${i + 1} ${'✓'.repeat(i % 7)}${'w'.repeat(23)}`).join('\n')
  const path = spill('multibyte.txt', raw)
  const content = String(
    BashTool.mapToolResultToToolResultBlockParam({ stdout: '', stderr: '', interrupted: false, persistedOutputPath: path, persistedOutputSize: raw.length }, 't').content,
  )
  const shown = shownOf(content)
  expect(pageOf(content)).toBe(raw.split('\n').slice(0, shown).join('\n'))
})

test('the page leaves room for the lines after it: the whole result stays under 30k', () => {
  const raw = `${Array.from({ length: 3_000 }, (_, i) => `row ${i + 1} ${'z'.repeat(30)}`).join('\n')}\n`
  const path = spill('notes.txt', raw)
  const content = String(
    BashTool.mapToolResultToToolResultBlockParam(
      {
        stdout: '',
        stderr: `${'stderr line\n'.repeat(200)}`,
        interrupted: false,
        persistedOutputPath: path,
        persistedOutputSize: raw.length,
        backgroundTaskId: 'bg1',
        readNote: `(${'note '.repeat(300)})`,
      },
      't',
    ).content,
  )
  expect(content.length).toBeLessThanOrEqual(30_000)
  expect(content).toContain('note note')
})

test('BashTool result mapper tolerates null stderr', () => {
  const result = BashTool.mapToolResultToToolResultBlockParam(
    {
      stdout: 'ok',
      stderr: null as unknown as string,
      interrupted: false,
    },
    'tool-1',
  )

  expect(result).toMatchObject({
    type: 'tool_result',
    tool_use_id: 'tool-1',
    content: 'ok',
  })
})

test('BashTool result mapper tolerates null stdout', () => {
  const result = BashTool.mapToolResultToToolResultBlockParam(
    {
      stdout: null as unknown as string,
      stderr: 'problem',
      interrupted: false,
    },
    'tool-2',
  )

  expect(result).toMatchObject({
    type: 'tool_result',
    tool_use_id: 'tool-2',
    content: 'problem',
  })
})

// The note a file read carries (BashTool's fitOverBudgetRead, creditShownFiles):
// the model's, after stdout and before stderr and the background note.
test('BashTool result mapper puts a read note right after stdout', () => {
  const result = BashTool.mapToolResultToToolResultBlockParam(
    {
      stdout: '<bash-output-read>a\nb\n</bash-output-read>\n',
      stderr: '',
      interrupted: false,
      readNote: 'Not shown — …\n(2 files printed whole — …)',
    },
    'tool-5',
  )
  expect(result.content).toBe(
    '<bash-output-read>a\nb\n</bash-output-read>\nNot shown — …\n(2 files printed whole — …)',
  )
})

// Every shell run with both flags off: no note, and the block as it always was.
test('BashTool result mapper without a read note is unchanged', () => {
  const data = { stdout: '\n\nok\n', stderr: 'warning: x', interrupted: false }
  expect(BashTool.mapToolResultToToolResultBlockParam(data, 'tool-6')).toEqual({
    tool_use_id: 'tool-6',
    type: 'tool_result',
    content: 'ok\nwarning: x',
    is_error: false,
  })
  expect(
    BashTool.mapToolResultToToolResultBlockParam({ ...data, readNote: undefined }, 'tool-6'),
  ).toEqual(BashTool.mapToolResultToToolResultBlockParam(data, 'tool-6'))
})

test('PowerShellTool result mapper tolerates null stderr', () => {
  const result = PowerShellTool.mapToolResultToToolResultBlockParam(
    {
      stdout: 'ok',
      stderr: null as unknown as string,
      interrupted: false,
    },
    'tool-3',
  )

  expect(result).toMatchObject({
    type: 'tool_result',
    tool_use_id: 'tool-3',
    content: 'ok',
  })
})

test('PowerShellTool result mapper tolerates null stdout', () => {
  const result = PowerShellTool.mapToolResultToToolResultBlockParam(
    {
      stdout: null as unknown as string,
      stderr: 'problem',
      interrupted: false,
    },
    'tool-4',
  )

  expect(result).toMatchObject({
    type: 'tool_result',
    tool_use_id: 'tool-4',
    content: 'problem',
  })
})
