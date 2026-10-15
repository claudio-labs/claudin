// An `answer` outcome — a non-zero exit that is the reply itself (no upstream)
// — must survive the output schema and render as a success, like a stall.
import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { GitTool } from 'src/tools/GitTool/GitTool.js'
import { renderToolResultMessage } from 'src/tools/GitTool/UI.js'

const ANSWERED = {
  outcomes: [
    {
      command: 'git rev-parse --abbrev-ref @{u}',
      effectiveCommand: 'git rev-parse --abbrev-ref @{u}',
      exitCode: 128,
      output: "fatal: no upstream configured for branch 'feat/x'",
      interrupted: false,
      answer: '`feat/x` has no upstream: it was never pushed.',
    },
  ],
  notRun: [],
}

describe('an answer outcome', () => {
  test('keeps its answer through the output schema', () => {
    // On the parsed VALUE: `z.object` drops an undeclared key and still succeeds.
    const parsed = GitTool.outputSchema.safeParse(ANSWERED)
    expect(parsed.success && parsed.data.outcomes[0]?.answer).toBe(ANSWERED.outcomes[0]!.answer)
  })

  test('renders with ✓, not ✗', async () => {
    const text = stripAnsi(await renderToString(<>{renderToolResultMessage(ANSWERED, [])}</>))
    expect(text).toContain('✓ git rev-parse')
    expect(text).not.toContain('✗')
  })
})
