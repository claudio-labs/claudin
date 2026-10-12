import { describe, expect, test } from 'bun:test'
import { getSettingsFilePathForSource } from 'src/platform/settings/settings.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { ONE_SHOT_BUILTIN_AGENT_TYPES } from 'src/tools/AgentTool/constants.js'
import {
  getStatusLinePaths,
  STATUSLINE_INPUT_FIELDS,
  STATUSLINE_SETUP_AGENT,
  STATUSLINE_SETUP_AGENT_TYPE,
} from 'src/tools/AgentTool/built-in/statuslineSetupAgent.js'

type SystemPromptArg = Parameters<typeof STATUSLINE_SETUP_AGENT.getSystemPrompt>[0]
const prompt = () => STATUSLINE_SETUP_AGENT.getSystemPrompt({} as SystemPromptArg)

describe('STATUSLINE_SETUP_AGENT', () => {
  test('is the statusline-setup agent, built in', () => {
    expect(STATUSLINE_SETUP_AGENT_TYPE).toBe('statusline-setup')
    expect(STATUSLINE_SETUP_AGENT.agentType).toBe(STATUSLINE_SETUP_AGENT_TYPE)
    expect(STATUSLINE_SETUP_AGENT.source).toBe('built-in')
    expect(STATUSLINE_SETUP_AGENT.baseDir).toBe('built-in')
  })

  test('reads, edits and writes files, and nothing else', () => {
    expect(STATUSLINE_SETUP_AGENT.tools).toEqual([FILE_READ_TOOL_NAME, FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME])
    expect(STATUSLINE_SETUP_AGENT.tools).not.toContain(BASH_TOOL_NAME)
  })

  test('runs on sonnet', () => {
    expect(STATUSLINE_SETUP_AGENT.model).toBe('sonnet')
  })

  test('keeps the permission dialog: its edits are how the user sees the change', () => {
    expect(STATUSLINE_SETUP_AGENT.permissionMode).toBeUndefined()
  })

  test('is one-shot, so a spawn is never auto-backgrounded away from its dialog', () => {
    expect(ONE_SHOT_BUILTIN_AGENT_TYPES.has(STATUSLINE_SETUP_AGENT_TYPE)).toBe(true)
  })

  test('skips the repo context it never uses', () => {
    expect(STATUSLINE_SETUP_AGENT.omitClaudeMd).toBe(true)
    expect(STATUSLINE_SETUP_AGENT.omitGitStatus).toBe(true)
    expect(STATUSLINE_SETUP_AGENT.omitGitInstructions).toBe(true)
  })
})

describe('the statusline-setup system prompt', () => {
  test('documents every field the status line command receives', () => {
    const text = prompt()
    for (const field of Object.keys(STATUSLINE_INPUT_FIELDS)) {
      expect(text).toContain(`"${field}"`)
    }
  })

  test('documents no field Claudin does not send', () => {
    const text = prompt()
    // Claude Code's prompt lists `agent.type`; Claudin's payload has only `agent.name`.
    expect(text).not.toMatch(/"agent": \{[^}]*"type"/)
    expect(text).not.toContain('"permission_mode"')
    expect(text).not.toContain('"agent_id"')
  })

  test('names the resolved settings and script paths, not a guessed config home', () => {
    const text = prompt()
    const { settingsPath, scriptPath, projectSettingsPath } = getStatusLinePaths()
    expect(settingsPath).toBe(getSettingsFilePathForSource('userSettings')!)
    expect(text).toContain(settingsPath)
    expect(text).toContain(`bash ${scriptPath}`)
    expect(text).toContain(projectSettingsPath)
    expect(text).not.toContain('.claudio')
    expect(text).not.toContain('~/.claude/')
  })

  test('without a PS1 it sets up the default line instead of asking', () => {
    const text = prompt()
    expect(text).toContain('do not stop to ask')
    expect(text).toContain("jq -r '.model.display_name'")
    expect(text).toContain('git --no-optional-locks')
    expect(text).toContain('.context_window.used_percentage')
  })

  test('says how to remove the status line', () => {
    expect(prompt()).toContain('delete the "statusLine" key')
  })
})
