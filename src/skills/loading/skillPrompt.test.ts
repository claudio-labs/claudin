/**
 * The prompt pipeline through its injected dependencies. It pins what the
 * loader's characterization suite cannot observe without running a real
 * shell: the permission grant the shell pass runs under, and the literal
 * insertion of the base directory. How argument text reaches the shell pass
 * is deliberately left unpinned here (see the spec's Security requirements).
 */
import { describe, expect, test } from 'bun:test'

import { buildSkillPrompt, type SkillPromptDeps } from 'src/skills/loading/skillPrompt.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

type Source = Parameters<typeof buildSkillPrompt>[0]
type AppState = ReturnType<ToolUseContext['getAppState']>
type ShellCall = { text: string; context: ToolUseContext; commandName: string; shell: string | undefined }

function source(overrides: Partial<Source> = {}): Source {
  return {
    skillName: 'demo',
    markdownContent: 'Body',
    baseDir: undefined,
    argumentNames: [],
    allowedTools: [],
    shell: undefined,
    loadedFrom: 'skills',
    ...overrides,
  }
}

function makeDeps(): { deps: SkillPromptDeps; shellCalls: ShellCall[] } {
  const shellCalls: ShellCall[] = []
  const deps: SkillPromptDeps = {
    sessionId: () => 'session-1',
    async runEmbeddedShell(text, context, commandName, shell) {
      shellCalls.push({ text, context, commandName, shell })
      return `ran:${text}`
    },
  }
  return { deps, shellCalls }
}

function contextWithAllowRules(alwaysAllowRules: Record<string, string[]>): ToolUseContext {
  const appState = { toolPermissionContext: { alwaysAllowRules } } as unknown as AppState
  return { getAppState: () => appState } as unknown as ToolUseContext
}

describe('buildSkillPrompt', () => {
  test("the shell pass runs on the text with its variables filled, as /<name>, in the skill's shell", async () => {
    const { deps, shellCalls } = makeDeps()
    const skill = source({
      baseDir: '/skills/demo',
      markdownContent: '!`cat ${CLAUDIN_SKILL_DIR}/notes.md` for ${CLAUDIN_SESSION_ID}',
      shell: 'powershell',
    })
    const text = await buildSkillPrompt(skill, '', contextWithAllowRules({}), deps)
    const filled = 'Base directory for this skill: /skills/demo\n\n!`cat /skills/demo/notes.md` for session-1'
    expect(shellCalls.map(call => [call.text, call.commandName, call.shell])).toEqual([[filled, '/demo', 'powershell']])
    expect(text).toBe(`ran:${filled}`)
  })

  test("during the shell pass the skill's allowed tools are the command source's always-allow rules", async () => {
    const { deps, shellCalls } = makeDeps()
    const context = contextWithAllowRules({ userSettings: ['Read'], command: ['Stale'] })
    await buildSkillPrompt(source({ allowedTools: ['Bash(npm:*)'] }), '', context, deps)
    const rules = shellCalls[0]!.context.getAppState().toolPermissionContext.alwaysAllowRules
    expect(rules).toEqual({ userSettings: ['Read'], command: ['Bash(npm:*)'] })
    expect(context.getAppState().toolPermissionContext.alwaysAllowRules).toEqual({ userSettings: ['Read'], command: ['Stale'] })
  })

  test('the base directory goes in literally, replacement patterns included', async () => {
    const { deps } = makeDeps()
    const baseDir = "/skills/a$&b$$c$'d$`e"
    const skill = source({ baseDir, markdownContent: 'run ${CLAUDIN_SKILL_DIR}/x.sh' })
    const text = await buildSkillPrompt(skill, '', contextWithAllowRules({}), deps)
    expect(text).toBe(`ran:Base directory for this skill: ${baseDir}\n\nrun ${baseDir}/x.sh`)
  })
})
