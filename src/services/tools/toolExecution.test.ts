import { describe, expect, test } from 'bun:test'

import { readFileSync } from 'node:fs'

import type { ToolUseContext } from 'src/Tool.js'
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js'
import { INTERRUPT_MESSAGE_FOR_TOOL_USE } from 'src/services/messages/constants.js'
import { saveGlobalConfig } from 'src/platform/config/config.js'
import {
  getSchemaValidationErrorOverride,
  getSchemaValidationToolUseResult,
  withRepeatedFailureHint,
} from 'src/services/tools/toolExecution.js'

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
    // …including the interrupt flag. Without it a cancelled call renders as
    // `Error calling tool (X): …`, which matches none of the
    // USER_CONTROL_SENTINELS, so the abort the user asked for both receives
    // the hint and counts toward a later streak. The inner site above threads
    // the same flag; this one was the odd one out.
    //
    // Pinned as `isAbortError(`, not `instanceof AbortError`: this is the
    // OUTERMOST catch, so it also sees the raw DOMException an AbortSignal
    // throws and the SDK's APIUserAbortError. The narrow check shipped first
    // and covered only our own class.
    //
    // The comment gap is matched line-wise (`\n`, horizontal space, `//`) and
    // the closing newline is mandatory rather than `\s*`-wrapped. The obvious
    // spelling — `(?:\s*//[^\n]*)*\s*` — puts `\s*` on both sides of a starred
    // group, so a run of `//` gives the engine exponentially many ways to
    // split the whitespace and it backtracks forever on a near-miss. CodeQL
    // flagged it. `[^\S\n]` cannot cross a line, so each iteration has exactly
    // one parse.
    expect(src).toMatch(
      /content: withRepeatedFailureHint\(\s*`<tool_use_error>\$\{detailedError\}[^`]*`,\s*tool\.name,\s*toolInput,\s*toolUseContext,(?:\n[^\S\n]*\/\/[^\n]*)*\n[^\S\n]*isAbortError\(error\),/,
    )
    // All three now pin every argument, not just the first. An audit found the
    // first two stopped at the content string, so a site passing the wrong
    // toolName or input — which silently keys the streak to nothing — would
    // have kept this green.
  })
})

// ---------------------------------------------------------------------------
// Wiring: the serial-edit nudge. It ships with SERIAL_EDIT_NUDGE off, so no
// runtime assertion can reach it — the helper returns the block unchanged under
// the test preload (which stubs every flag to false). A detached call site
// would therefore be invisible until someone flips the flag to run the bench
// and measures nothing. Pinned statically, like the hint sites above.
//
// Matched with plain substring checks rather than a regex: the neighbouring
// assertions needed hand-tuning to stop CodeQL flagging exponential
// backtracking, and there is nothing here a regex would buy.
// ---------------------------------------------------------------------------

describe('serial-edit nudge wiring', () => {
  const src = readFileSync(new URL('./toolExecution.ts', import.meta.url), 'utf8')

  test('the successful tool_result is routed through the nudge', () => {
    // addToolResult builds the content blocks for every non-error result; if
    // the wrapper is dropped the array goes back to `[toolResultBlock]`.
    expect(src).toContain('withSerialEditHint(')
    expect(src).toContain('toolResultBlock,')
  })

  test('the nudge is gated on the flag and the reminder killswitch', () => {
    expect(src).toContain("feature('SERIAL_EDIT_NUDGE')")
    expect(src).toContain('process.env.CLAUDIN_DISABLE_TOOL_REMINDERS')
  })

  test('the nudge exists at exactly one call site', () => {
    // Replaces two negative assertions that encoded the wrong indentation and
    // so could never match anything — an audit caught them as placebo.
    // Counting is the real guard: adding the nudge to any error path (where
    // withRepeatedFailureHint already lives — stacking two <system-reminder>s
    // on one failed result buries both) pushes this to 3.
    const occurrences = src.split('withSerialEditHint(').length - 1
    expect(occurrences).toBe(2) // 1 declaration + 1 call site
  })

  test('the current call is threaded in, not just the frozen transcript', () => {
    // toolUseContext.messages is frozen before the turn streams (query.ts), so
    // without this the detector never sees the call being answered and a
    // successful MULTI-file patch gets nudged for the single-file turns that
    // preceded it — the instrument scolding the behavior it asks for.
    expect(src).toContain('currentCall: { name: toolName, input: currentInput }')
  })
})

// ---------------------------------------------------------------------------
// Wiring: strict-schema placeholder stripping. The behavior itself is covered
// by src/services/tools/toolInputPlaceholders.test.ts; what no unit test can see is the
// call being detached here, which would put `pages: ""` back in front of
// validateInput on every Codex turn. Pinned statically for the same reason as
// the two blocks above.
// ---------------------------------------------------------------------------

describe('placeholder-input wiring', () => {
  const src = readFileSync(new URL('./toolExecution.ts', import.meta.url), 'utf8')

  // Source-text assertions, not behavior: `runToolUse` is a generator wired to
  // permissions, analytics and the message store, and standing all of that up
  // costs more than these pin. What they catch is the wiring being dropped or
  // ungated by a refactor; the semantics are covered behaviorally in
  // toolInputPlaceholders.test.ts and the gate in codexShim.test.ts.
  test('the strip runs, gated on the transport', () => {
    expect(src).toContain(
      'if (transportSendsStrictToolSchemas(toolUseContext.options.mainLoopModel)) {',
    )
    expect(src).toContain(
      'toolInput = stripPlaceholderOptionalFields(tool, toolInput)',
    )
  })

  test('the gate reads the request model, not the profile default', () => {
    // A session can run `/model`, a sub-agent override or the fallback model,
    // none of which touch the profile's primary model — asking the profile
    // strips on the wrong transport in both directions.
    expect(src).not.toContain('transportSendsStrictToolSchemas()')
  })
})
