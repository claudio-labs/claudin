import { describe, expect, test } from 'bun:test'

import { readFileSync } from 'node:fs'

import type { ToolUseContext } from '../../Tool.js'
import { SkillTool } from '../../tools/SkillTool/SkillTool.js'
import { INTERRUPT_MESSAGE_FOR_TOOL_USE } from '../../utils/messages/constants.js'
import { saveGlobalConfig } from '../../utils/config.js'
import {
  getSchemaValidationErrorOverride,
  getSchemaValidationToolUseResult,
  withRepeatedFailureHint,
} from './toolExecution.js'

describe('getSchemaValidationErrorOverride', () => {
  test('returns actionable missing-skill error for SkillTool', () => {
    expect(getSchemaValidationErrorOverride(SkillTool, {})).toBe(
      'Missing skill name. Pass the slash command name as the skill parameter (e.g., skill: "commit" for /commit, skill: "review-pr" for /review-pr).',
    )
  })

  test('does not override unrelated tool schema failures', () => {
    expect(getSchemaValidationErrorOverride({ name: 'Read' } as never, {})).toBe(
      null,
    )
  })

  test('does not override SkillTool when skill is present', () => {
    expect(
      getSchemaValidationErrorOverride(SkillTool, { skill: 'commit' }),
    ).toBe(null)
  })

  test('uses the actionable override for structured toolUseResult too', () => {
    expect(getSchemaValidationToolUseResult(SkillTool, {} as never)).toBe(
      'InputValidationError: Missing skill name. Pass the slash command name as the skill parameter (e.g., skill: "commit" for /commit, skill: "review-pr" for /review-pr).',
    )
  })
})

// ---------------------------------------------------------------------------
// Repeated-failure hint — a model that keeps re-issuing the same failing call
// gets told to stop, appended to the error it is already receiving.
// ---------------------------------------------------------------------------

let seq = 0
const uid = () => `id-${seq++}`

// Minimal transcript shape — the detector only reads role/type/content, and
// importing the real Message type here buys nothing.
type TranscriptMessage = Record<string, unknown>

function humanTurn(): TranscriptMessage {
  return {
    type: 'user',
    uuid: uid(),
    isMeta: false,
    toolUseResult: undefined,
    message: { role: 'user', content: 'go' },
  }
}

/** N failed calls of `toolName` with identical input, as a transcript shows them. */
function failedCalls(
  toolName: string,
  input: unknown,
  n: number,
  content = 'boom',
): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (let i = 0; i < n; i++) {
    const id = uid()
    out.push({
      type: 'assistant',
      uuid: uid(),
      message: {
        role: 'assistant',
        id: uid(),
        content: [{ type: 'tool_use', id, name: toolName, input }],
      },
    })
    out.push({
      type: 'user',
      uuid: uid(),
      isMeta: false,
      toolUseResult: { stdout: content },
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: id, is_error: true, content },
        ],
      },
    })
  }
  return out
}

function ctxWith(messages: TranscriptMessage[]): ToolUseContext {
  return { messages } as unknown as ToolUseContext
}

/**
 * One SUCCESSFUL call, shaped the way a sub-agent's success actually reaches
 * the transcript: `toolUseResult` blanked (toolExecution.ts, `agentId &&
 * !preserveToolUseResults`), same as a result swapped for a persisted preview.
 */
function succeededCall(toolName: string, input: unknown): TranscriptMessage[] {
  const id = uid()
  return [
    {
      type: 'assistant',
      uuid: uid(),
      message: {
        role: 'assistant',
        id: uid(),
        content: [{ type: 'tool_use', id, name: toolName, input }],
      },
    },
    {
      type: 'user',
      uuid: uid(),
      isMeta: false,
      toolUseResult: undefined,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
      },
    },
  ]
}

describe('withRepeatedFailureHint', () => {
  const input = { file_path: '/nope.ts' }

  test('the /config toggle suppresses it for every tool', () => {
    // This hint changes model-facing bytes for EVERY tool, not just the one
    // whose branch shipped it, so it must be switchable off like every other
    // default-on behavior in AGENTS.md's table.
    const ctx = ctxWith([humanTurn(), ...failedCalls('Read', input, 2)])
    expect(withRepeatedFailureHint('boom', 'Read', input, ctx)).not.toBe('boom')

    saveGlobalConfig(c => ({ ...c, repeatedFailureHintEnabled: false }))
    try {
      expect(withRepeatedFailureHint('boom', 'Read', input, ctx)).toBe('boom')
    } finally {
      saveGlobalConfig(c => ({ ...c, repeatedFailureHintEnabled: undefined }))
    }
    // undefined ⇒ on: the default is opt-OUT, not opt-in.
    expect(withRepeatedFailureHint('boom', 'Read', input, ctx)).not.toBe('boom')
  })

  test('stays silent while the streak is below the threshold', () => {
    // 1 prior failure + the one being built = 2 < 3.
    const ctx = ctxWith([humanTurn(), ...failedCalls('Read', input, 1)])
    expect(withRepeatedFailureHint('boom', 'Read', input, ctx)).toBe('boom')
  })

  test('appends the hint once the current failure is the 3rd identical one', () => {
    const ctx = ctxWith([humanTurn(), ...failedCalls('Read', input, 2)])
    const out = withRepeatedFailureHint('boom', 'Read', input, ctx)
    expect(out.startsWith('boom')).toBe(true)
    expect(out).toContain('failed 3 times in a row')
    expect(out).toContain('Read')
  })

  test('a different input does not inherit the streak', () => {
    const ctx = ctxWith([humanTurn(), ...failedCalls('Read', input, 5)])
    expect(
      withRepeatedFailureHint('boom', 'Read', { file_path: '/other.ts' }, ctx),
    ).toBe('boom')
  })

  test('interrupted calls never get the hint', () => {
    const ctx = ctxWith([humanTurn(), ...failedCalls('Read', input, 5)])
    expect(
      withRepeatedFailureHint(
        INTERRUPT_MESSAGE_FOR_TOOL_USE,
        'Read',
        input,
        ctx,
        true,
      ),
    ).toBe(INTERRUPT_MESSAGE_FOR_TOOL_USE)
  })

  test('user-control failures in the transcript do not build a streak', () => {
    const ctx = ctxWith([
      humanTurn(),
      ...failedCalls('Read', input, 5, INTERRUPT_MESSAGE_FOR_TOOL_USE),
    ])
    expect(withRepeatedFailureHint('boom', 'Read', input, ctx)).toBe('boom')
  })

  test('a context without a messages array yields no hint and does not throw', () => {
    // HONEST SCOPE: this pins the OUTCOME, not the `!Array.isArray(messages)`
    // early return that produces it. An audit showed the guard can be deleted
    // and this still passes, because countIdenticalFailures fails open — the
    // walk throws on undefined, the catch swallows it and returns 0, and no
    // hint is emitted either way. The guard's real value is avoiding a
    // logError on a path that is not an error, which is not observable here
    // without mocking the logger (see .claudin/rules/testing.md on why this
    // suite avoids mock.module). Named for what it verifies.
    expect(
      withRepeatedFailureHint('boom', 'Read', input, {} as ToolUseContext),
    ).toBe('boom')
  })

  test('a success in between breaks the streak, so "in a row" stays true', () => {
    const ctx = ctxWith([
      humanTurn(),
      ...failedCalls('Read', input, 2),
      ...succeededCall('Read', input),
    ])
    // Two failures, then the same call succeeded: the failure being built is
    // the 1st of a new run, and telling the model it failed "3 times in a row"
    // would contradict a success it can see in its own transcript.
    expect(withRepeatedFailureHint('boom', 'Read', input, ctx)).toBe('boom')
  })

  test('a blanked success turn does not reset the window', () => {
    const ctx = ctxWith([
      humanTurn(),
      ...failedCalls('Read', input, 1),
      ...succeededCall('Bash', { command: 'ls' }),
      ...failedCalls('Read', input, 1),
    ])
    // The Bash turn carries `toolUseResult: undefined` like every sub-agent
    // success; mistaking it for the human's turn drops the earlier Read failure
    // out of scope and the hint never fires inside agents.
    expect(withRepeatedFailureHint('boom', 'Read', input, ctx)).toContain(
      'failed 3 times in a row',
    )
  })
})

// ---------------------------------------------------------------------------
// Wiring: the hint has to reach the actual tool_result. Testing the helper in
// isolation cannot see it being DETACHED from a call site, and driving
// runToolUse end to end is not viable here — the PreToolUse hook pipeline
// stops any call built from a fake context (it yields type:'stop' before
// permissions are consulted), and a version of this suite that got past that
// passed alone but failed under the full run, because sibling files'
// mock.module calls reshape the pipeline's deps (.claudin/rules/testing.md).
// So the five call sites are pinned statically: unwrapping any one fails.
// ---------------------------------------------------------------------------

describe('repeated-failure hint wiring', () => {
  test('every errored tool_result site routes content through the hint', () => {
    const src = readFileSync(
      new URL('./toolExecution.ts', import.meta.url),
      'utf8',
    )
    // Schema-validation site.
    expect(src).toMatch(
      /content: withRepeatedFailureHint\(\s*`<tool_use_error>InputValidationError[^`]*`,\s*tool\.name,\s*input,\s*toolUseContext,/,
    )
    // validateInput rejection site — the one that carries FileEditTool's
    // "String to replace not found" and "File has not been read yet", i.e.
    // the repetition loop the hint most needs to interrupt.
    expect(src).toMatch(
      /content: withRepeatedFailureHint\(\s*`<tool_use_error>\$\{isValidCall\.message\}[^`]*`,\s*tool\.name,\s*input,\s*toolUseContext,/,
    )
    // Caught-exception site, with the interrupt flag threaded through.
    expect(src).toMatch(
      /content: withRepeatedFailureHint\(\s*content,\s*tool\.name,\s*input,\s*toolUseContext,\s*isInterrupt,/,
    )
    // Unknown-tool site — a hallucinated tool name retried with the same
    // input is the purest form of the loop this hint interrupts.
    expect(src).toMatch(
      /content: withRepeatedFailureHint\(\s*`<tool_use_error>Error: No such tool available[^`]*`,\s*toolName,\s*toolUse\.input,\s*toolUseContext,/,
    )
    // runToolUse's outer catch — the path a throwing tool takes (e.g. a
    // crashed MCP server). Wiring it is what makes AGENTS.md's "applies to
    // every tool" claim true. The two deliberate exclusions stay excluded:
    // permission denials (user control) and the pre-call cancel path
    // (withMemoryCorrectionHint's surface).
    expect(src).toMatch(
      /content: withRepeatedFailureHint\(\s*`<tool_use_error>\$\{detailedError\}[^`]*`,\s*tool\.name,\s*toolInput,\s*toolUseContext,/,
    )
    // All three now pin every argument, not just the first. An audit found the
    // first two stopped at the content string, so a site passing the wrong
    // toolName or input — which silently keys the streak to nothing — would
    // have kept this green.
  })
})
