import { afterEach, describe, expect, test } from 'bun:test'
import type { Command, PromptCommand } from 'src/shared/types/command.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import {
  launchSkillInBackground,
  shouldRunSkillInBackground,
  type BackgroundSkillDeps,
} from 'src/tools/SkillTool/backgroundSkill.js'

function forked(overrides: Partial<PromptCommand> = {}): Command & PromptCommand {
  return {
    type: 'prompt',
    name: 'nightly',
    description: 'nightly report',
    progressMessage: 'running',
    contentLength: 0,
    source: 'projectSettings',
    context: 'fork',
    background: true,
    async getPromptForCommand(args: string) {
      return [{ type: 'text', text: `Write the nightly report ${args}` }]
    },
    ...overrides,
  } as Command & PromptCommand
}

describe('shouldRunSkillInBackground', () => {
  const gates = { ownsBackgroundAgents: true, backgroundHidden: false }

  test('a forked skill marked background, called from the main thread with background agents on', () => {
    expect(shouldRunSkillInBackground(forked(), gates)).toBe(true)
  })

  test('in the foreground otherwise: not marked, a caller that owns no background agents, or background agents unavailable', () => {
    expect(shouldRunSkillInBackground(forked({ background: false }), gates)).toBe(false)
    expect(shouldRunSkillInBackground(forked({ background: undefined }), gates)).toBe(false)
    expect(shouldRunSkillInBackground(forked(), { ...gates, ownsBackgroundAgents: false })).toBe(false)
    expect(shouldRunSkillInBackground(forked(), { ...gates, backgroundHidden: true })).toBe(false)
  })
})

describe('launchSkillInBackground', () => {
  const calls: Record<string, unknown[]> = {}
  afterEach(() => {
    for (const key of Object.keys(calls)) delete calls[key]
  })

  function deps(): BackgroundSkillDeps {
    const abortController = new AbortController()
    return {
      register: (input => {
        calls.register = [input]
        return { agentId: 'skill-agent-1', abortController }
      }) as BackgroundSkillDeps['register'],
      runLifecycle: (async input => {
        calls.lifecycle = [input]
        const stream = input.makeStream(undefined)
        calls.stream = [stream]
      }) as BackgroundSkillDeps['runLifecycle'],
      stream: (input => {
        calls.streamInput = [input]
        return (async function* () {})()
      }) as BackgroundSkillDeps['stream'],
    }
  }

  test('registers a background agent for the fork and runs it there, returning at once', async () => {
    const setAppStateForTasks = () => {}
    const canUseTool = (async () => ({})) as never
    const context = {
      agentId: undefined,
      toolUseId: 'toolu_bg_1',
      setAppState: () => {},
      setAppStateForTasks,
      getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
      options: {
        tools: [],
        mainLoopModel: 'claude-opus-5-5',
        agentDefinitions: { activeAgents: [GENERAL_PURPOSE_AGENT] },
      },
    } as unknown as ToolUseContext

    const command = forked({ effort: 'low', model: 'sonnet', allowedTools: ['Bash(make:*)'] })
    const { agentId } = await launchSkillInBackground(command, 'nightly', 'for today', context, canUseTool, deps())
    expect(agentId).toBe('skill-agent-1')

    const [registered] = calls.register as [Record<string, unknown>]
    expect(registered).toMatchObject({
      description: '/nightly',
      prompt: 'Write the nightly report for today',
      toolUseId: 'toolu_bg_1',
      setAppState: setAppStateForTasks,
    })
    expect((registered.selectedAgent as { effort?: string }).effort).toBe('low')

    const [lifecycle] = calls.lifecycle as [Record<string, unknown>]
    expect(lifecycle).toMatchObject({
      taskId: 'skill-agent-1',
      agentIdForCleanup: 'skill-agent-1',
      description: '/nightly',
      metadata: { isAsync: true, prompt: 'Write the nightly report for today' },
    })
    expect(lifecycle.rootSetAppState).toBe(setAppStateForTasks)
    const [streamed] = calls.streamInput as [Record<string, unknown>]
    expect(streamed).toMatchObject({ isAsync: true, querySource: 'agent:custom', description: '/nightly', model: 'sonnet' })
    expect(streamed.canUseTool).toBe(canUseTool)
    expect((streamed.override as { agentId: string }).agentId).toBe('skill-agent-1')
    expect(JSON.stringify(streamed.promptMessages)).toContain('Write the nightly report for today')
    // The fork runs with the tools the skill grants, through the prepared getAppState.
    const forkContext = streamed.toolUseContext as ToolUseContext
    expect(forkContext).toBe(lifecycle.toolUseContext as ToolUseContext)
    expect(forkContext.getAppState().toolPermissionContext.alwaysAllowRules.command).toContain('Bash(make:*)')
  })
})
