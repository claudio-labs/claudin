/**
 * The auto-mode path driven through its dependencies, so it runs under plain
 * `bun test` without the auto-mode build. The allowlist is the real one; the
 * classifier is a stand-in that records what it was asked.
 */
import { settleAutoModeAsk, type AutoModeDeps } from 'src/permissions/permissions/autoMode.js'
import { describe, expect, test } from 'bun:test'

import {
  isAutoModeAllowlistedReadOnlyToolUse,
  isAutoModeAllowlistedTool,
} from 'src/permissions/classifierDecision.js'
import type { PermissionAskDecision } from 'src/permissions/PermissionResult.js'
import { parseToolInput } from 'src/permissions/permissions/toolVerdict.js'
import {
  ASSISTANT_TURN,
  makeCtx,
  standIn,
  type StandInSpec,
  useDecisionWorld,
} from 'src/permissions/__testutils__/decisionWorld.js'

useDecisionWorld()

const ASK: PermissionAskDecision = { behavior: 'ask', message: 'the tool wants a yes' }

function recordingDeps(): { deps: AutoModeDeps; classified: string[] } {
  const classified: string[] = []
  const deps: AutoModeDeps = {
    classify: async (_messages, action) => {
      const block = action.content[0]
      classified.push(block && 'name' in block ? String(block.name) : '?')
      return { shouldBlock: false, reason: 'stand-in allows', model: 'stand-in-model' }
    },
    describeAction: (toolName, input) => ({
      role: 'assistant',
      content: [{ type: 'tool_use', name: toolName, input }],
    }),
    isSafeTool: isAutoModeAllowlistedTool,
    isSafeWhenReading: isAutoModeAllowlistedReadOnlyToolUse,
  }
  return { deps, classified }
}

async function settle(spec: StandInSpec, options: { acceptEditsMayAllow?: boolean; headless?: boolean } = {}) {
  const tool = standIn({ verdict: ASK, ...spec })
  const input = { file_path: '/x' }
  const { deps, classified } = recordingDeps()
  const decision = await settleAutoModeAsk(
    {
      tool,
      input,
      parsed: parseToolInput(tool, input),
      context: makeCtx({
        tools: [tool],
        permissions: { mode: 'auto', shouldAvoidPermissionPrompts: options.headless ?? false },
      }),
      assistantMessage: ASSISTANT_TURN,
      toolUseID: 'toolu_auto_unit',
      ask: ASK,
      acceptEditsMayAllow: options.acceptEditsMayAllow ?? true,
    },
    deps,
  )
  return { decision, classified, seenModes: tool.seenModes }
}

describe('the safe-tool allowlist only lets built-ins through (fix 2)', () => {
  const cases: Array<[string, StandInSpec, 'allowlist' | 'classifier']> = [
    ['the built-in Read', { name: 'Read' }, 'allowlist'],
    ['an MCP tool shown as Read', { name: 'Read', mcp: { serverName: 'files', toolName: 'Read' } }, 'classifier'],
    ['an MCP tool shown as TodoWrite', { name: 'TodoWrite', mcp: { serverName: 'todo', toolName: 'TodoWrite' } }, 'classifier'],
    [
      'an MCP tool shown as classify_result',
      { name: 'classify_result', mcp: { serverName: 'x', toolName: 'classify_result' } },
      'classifier',
    ],
    ['the built-in Git, reading', { name: 'Git', readOnly: true }, 'allowlist'],
    ['an MCP tool shown as Git, reading', { name: 'Git', readOnly: true, mcp: { serverName: 'vcs', toolName: 'Git' } }, 'classifier'],
  ]
  const labelled = cases.map(([what, spec, route]) => [`${what} goes to the ${route}`, spec, route] as const)
  test.each(labelled)('%s', async (_label, spec, route) => {
    const { decision, classified } = await settle(spec)
    const decidedBy = classified.length === 0 ? 'allowlist' : 'classifier'
    expect([decidedBy, decision.behavior]).toEqual([route, 'allow'])
  })

  test('the classifier is told the name the tool goes by', async () => {
    const { classified } = await settle({ name: 'Read', mcp: { serverName: 'files', toolName: 'Read' } })
    expect(classified).toEqual(['Read'])
  })
})

describe('the acceptEdits second look', () => {
  const editor: StandInSpec = {
    name: 'Edit',
    verdict: (_input, mode) => (mode === 'acceptEdits' ? { behavior: 'allow' } : ASK),
  }

  test('is taken only when the caller offers it', async () => {
    const offered = await settle(editor)
    const withheld = await settle(editor, { acceptEditsMayAllow: false })
    expect([offered.seenModes, offered.classified, withheld.seenModes, withheld.classified]).toEqual([
      ['acceptEdits'],
      [],
      [],
      ['Edit'],
    ])
  })

  test('is not taken for input the schema rejects', async () => {
    const tool = standIn({ ...editor, verdict: () => ({ behavior: 'allow' }) })
    const input = { file_path: 7 }
    const { deps, classified } = recordingDeps()
    await settleAutoModeAsk(
      {
        tool,
        input,
        parsed: parseToolInput(tool, input),
        context: makeCtx({ tools: [tool], permissions: { mode: 'auto' } }),
        assistantMessage: ASSISTANT_TURN,
        toolUseID: 'toolu_bad_input',
        ask: ASK,
        acceptEditsMayAllow: true,
      },
      deps,
    )
    expect([tool.seenModes, classified]).toEqual([[], ['Edit']])
  })
})

test('a tool that needs the user stays an ask even where no one can be asked, for the hooks to settle', async () => {
  const { decision, classified } = await settle({ name: 'AskUser', needsUser: true }, { headless: true })
  expect([decision, classified]).toEqual([ASK, []])
})
