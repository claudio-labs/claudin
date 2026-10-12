import { describe, expect, test } from 'bun:test'
import React from 'react'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
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

function render(output: ContainerToolOutput): Promise<string> {
  return renderToString(<AppStateProvider>{renderToolResultMessage(output, [])}</AppStateProvider>)
}

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
})
