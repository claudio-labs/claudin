import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { wrapStdoutWithMarkers } from 'src/outputFilter/Bash/markers.js'
import type { PipelineResult, PreExecPlan } from 'src/outputFilter/Bash/types.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import BashToolResultMessage from 'src/tools/BashTool/BashToolResultMessage.js'

function render(stdout: string): Promise<string> {
  return renderToString(
    <AppStateProvider>
      <BashToolResultMessage content={{ stdout, stderr: '' }} verbose={false} />
    </AppStateProvider>,
  ).then(stripAnsi)
}

const REWRITE_PLAN: PreExecPlan = {
  effectiveCommand: 'git status --porcelain --branch',
  filter: null,
  rewrite: { from: 'git status', to: 'git status --porcelain --branch' },
}
const FILTER_PLAN: PreExecPlan = {
  effectiveCommand: 'ls -la',
  filter: { name: 'ls', matchCommand: /^ls$/ },
  rewrite: null,
}
const PIPELINE_RESULT: PipelineResult = {
  body: '[d] .',
  applied: ['ls'],
  shortCircuited: false,
  reductionPct: 73,
  originalLines: 39,
  bodyLines: 39,
}

describe('BashToolResultMessage marker stripping', () => {
  test('unwraps a bash-output-rewritten wrapper for display', async () => {
    const wrapped = wrapStdoutWithMarkers('## main...origin/main', REWRITE_PLAN, null)
    const out = await render(wrapped)
    expect(out).toContain('## main...origin/main')
    // The raw XML wrapper must never reach the screen.
    expect(out).not.toContain('bash-output-rewritten')
  })

  test('unwraps a bash-output-filtered wrapper for display', async () => {
    const wrapped = wrapStdoutWithMarkers('[d] .', FILTER_PLAN, PIPELINE_RESULT)
    const out = await render(wrapped)
    expect(out).toContain('[d] .')
    expect(out).not.toContain('bash-output-filtered')
  })

  test('renders plain (unwrapped) stdout unchanged', async () => {
    const out = await render('hello world')
    expect(out).toContain('hello world')
  })
})
