import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import React from 'react'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { renderToAnsiString, renderToString } from 'src/terminal/render/staticRender.js'
import { renderToolResultMessage } from 'src/tools/ContainerTool/UI.js'
import type { ContainerToolOutput } from 'src/tools/ContainerTool/types.js'

function result(overrides: Partial<ContainerToolOutput>): ContainerToolOutput {
  return {
    op: 'logs',
    command: 'docker compose logs api',
    exitCode: 0,
    output: '',
    diagnosis: null,
    durationMs: 10,
    ...overrides,
  }
}

function node(output: ContainerToolOutput): React.ReactNode {
  return <AppStateProvider>{renderToolResultMessage(output, [], { theme: 'dark', verbose: false })}</AppStateProvider>
}

function render(output: ContainerToolOutput): Promise<string> {
  return renderToString(node(output))
}

// dark's `error` is rgb(255,107,128).
const DARK_ERROR_SGR = '38;2;255;107;128'

describe('ContainerTool result', () => {
  test('a successful op leads with its verdict', async () => {
    const out = await render(result({ op: 'logs', output: 'INFO ready' }))
    expect(out).toContain('✓ logs')
  })

  test('an op whose body is not a log keeps it hidden', async () => {
    const out = await render(result({ op: 'inspect', output: '[{"Id": "abc123"}]' }))
    expect(out).toContain('✓ inspect')
    expect(out).not.toContain('abc123')
  })

  test('a failure shows the diagnosis and caps its evidence', async () => {
    const evidence = Array.from({ length: 8 }, (_, i) => `ERROR line ${i + 1}`).join('\n')
    const out = await render(
      result({
        op: 'exec',
        exitCode: 1,
        output: evidence,
        diagnosis: { kind: 'exit-error', summary: 'the command exited 1', evidence },
      }),
    )
    expect(out).toContain('✗ exec failed (exit 1)')
    expect(out).toContain('⎿ the command exited 1')
    expect(out).toContain('ERROR line 6')
    expect(out).not.toContain('ERROR line 7')
    expect(out).toContain('… 2 more lines')
  })

  test('a failure does not repeat its body under the evidence', async () => {
    const out = await render(
      result({
        op: 'exec',
        exitCode: 1,
        output: 'full body nobody asked for',
        diagnosis: { kind: 'exit-error', summary: 'the command exited 1', evidence: 'ERROR the one line' },
      }),
    )
    expect(out).toContain('ERROR the one line')
    expect(out).not.toContain('full body nobody asked for')
  })
})

describe('ContainerTool log bodies', () => {
  const savedLevel = chalk.level
  beforeAll(() => {
    chalk.level = 3
  })
  afterAll(() => {
    chalk.level = savedLevel
  })

  test.each(['logs', 'exec', 'run'] as const)('%s shows its body below the verdict', async op => {
    const out = await render(result({ op, output: 'api-1  | INFO ready' }))
    expect(out).toContain(`✓ ${op}`)
    expect(out).toContain('api-1  | INFO ready')
    expect(out.indexOf(`✓ ${op}`)).toBeLessThan(out.indexOf('INFO ready'))
  })

  test('a followed log shows only its verdict, not the task notice', async () => {
    const out = await render(
      result({
        op: 'logs',
        backgroundTaskId: 'b1',
        output: 'Started in the background as task b1. Output streams to /tmp/b1.output.',
      }),
    )
    expect(out).toContain('✓ running in the background (b1)')
    expect(out).not.toContain('Output streams to')
  })

  test('the body collapses like a Bash result', async () => {
    const output = Array.from({ length: 10 }, (_, i) => `INFO line ${i + 1}`).join('\n')
    const out = await render(result({ op: 'logs', output }))
    expect(out).toContain('INFO line 1')
    expect(out).not.toContain('INFO line 10')
    expect(out).toContain('ctrl+o to expand')
  })

  test('levels in the body take the theme color', async () => {
    const out = await renderToAnsiString(node(result({ op: 'logs', output: 'ERROR boom' })))
    const at = out.indexOf('ERROR')
    expect(out.slice(Math.max(0, at - 30), at)).toContain(DARK_ERROR_SGR)
  })

  test('levels in failure evidence take the theme color', async () => {
    const out = await renderToAnsiString(
      node(
        result({
          op: 'logs',
          exitCode: 1,
          output: 'ERROR boom',
          diagnosis: { kind: 'exit-error', summary: 'exited 1', evidence: 'ERROR boom' },
        }),
      ),
    )
    const at = out.indexOf('ERROR')
    expect(out.slice(Math.max(0, at - 30), at)).toContain(DARK_ERROR_SGR)
  })
})
