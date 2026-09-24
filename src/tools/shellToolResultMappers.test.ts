import { expect, test } from 'bun:test'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { PowerShellTool } from 'src/tools/PowerShellTool/PowerShellTool.js'

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
