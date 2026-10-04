/**
 * Characterization of PermissionRequest, the component the REPL mounts for
 * the permission request at the head of its queue: which dialog each tool's
 * request is shown in, the interrupt key, what the user's answer reports
 * back, and the prompt counter every dialog bumps. Written before the
 * clean-base rewrite of permissions/promptFrame; the spec is
 * docs/tech/rewrite/permissions/promptFrame.md.
 *
 * The answers are driven through the dialog an unknown tool gets, since that
 * is the route every tool without a dialog of its own takes, MCP tools among
 * them. Every answer is checked for the calls it must not make as well as
 * the ones it makes: an allow nobody chose is the failure that matters here.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { z } from 'zod/v4'
import { createAssistantMessage } from 'src/agent/messages/factories.js'
import { usePermissionRequestLogging } from 'src/permissions/ui/hooks.js'
import { PermissionRequest, type ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import type { WorkerBadgeProps } from 'src/permissions/ui/WorkerBadge.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { Text } from 'src/terminal/ink.js'
import { AskUserQuestionTool } from 'src/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { EnterPlanModeTool } from 'src/tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { GitTool } from 'src/tools/GitTool/GitTool.js'
import { GlobTool } from 'src/tools/GlobTool/GlobTool.js'
import { GrepTool } from 'src/tools/GrepTool/GrepTool.js'
import { MonitorTool } from 'src/tools/MonitorTool/MonitorTool.js'
import { NotebookEditTool } from 'src/tools/NotebookEditTool/NotebookEditTool.js'
import { PowerShellTool } from 'src/tools/PowerShellTool/PowerShellTool.js'
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js'
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import { WaitForTool } from 'src/tools/WaitForTool/WaitForTool.js'
import { WebFetchTool } from 'src/tools/WebFetchTool/WebFetchTool.js'
import { isolatedWorld, KEYS, linesOf, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'

const world = isolatedWorld()
const { enter, esc, tab, down, ctrlC } = KEYS

// --- a request, and what it reports -----------------------------------------------

type Report =
  | ['allow', unknown, ...unknown[]]
  | ['reject', ...unknown[]]
  | ['abort']
  | ['done']
  | ['caller rejects']

/** A tool no dialog is made for, like any MCP tool. */
const deployTool = {
  name: 'mcp__infra__deploy',
  isMcp: true,
  inputSchema: z.object({ target: z.string() }),
  userFacingName: () => 'infra - deploy (MCP)',
  renderToolUseMessage: (input: { target: string }) => `target: ${input.target}`,
  isReadOnly: () => false,
} as unknown as Tool

function contextFor(): ToolUseContext {
  const held = { state: {} as ReturnType<ToolUseContext['getAppState']> }
  const context: Partial<ToolUseContext> = {
    abortController: new AbortController(),
    options: { tools: [], commands: [], mcpClients: [], isNonInteractiveSession: false, verbose: false, debug: false, mainLoopModel: 'test-model' } as never,
    setInProgressToolUseIDs: () => {},
    getAppState() {
      return held.state
    },
    setAppState(update) {
      held.state = update(held.state)
    },
    readFileState: new Map<string, never>() as never,
  }
  return context as ToolUseContext
}

function request(tool: Tool, input: Record<string, unknown>, reports: Report[], toolUseID = 'toolu_frame_1'): ToolUseConfirm {
  return {
    assistantMessage: createAssistantMessage({ content: 'working on it' }),
    tool,
    description: 'Ships the current build',
    input,
    toolUseContext: contextFor(),
    toolUseID,
    permissionResult: { behavior: 'ask', message: 'needs a yes' },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction: () => {},
    onAbort: () => reports.push(['abort']),
    onAllow: (...args: unknown[]) => reports.push(['allow', ...args] as Report),
    onReject: (...args: unknown[]) => reports.push(['reject', ...args]),
    recheckPermission: async () => {},
  } as unknown as ToolUseConfirm
}

function frameFor(confirm: ToolUseConfirm, reports: Report[], workerBadge?: WorkerBadgeProps) {
  return (
    <PermissionRequest
      toolUseConfirm={confirm}
      toolUseContext={confirm.toolUseContext}
      onDone={() => reports.push(['done'])}
      onReject={() => reports.push(['caller rejects'])}
      verbose={false}
      workerBadge={workerBadge}
    />
  )
}

async function ask(tool: Tool = deployTool, input: Record<string, unknown> = { target: 'production' }, workerBadge?: WorkerBadgeProps) {
  const reports: Report[] = []
  const confirm = request(tool, input, reports)
  const screen = await mount(frameFor(confirm, reports, workerBadge), { columns: 100, ready: frame => /\S/.test(frame) && !frame.includes('Loading') })
  return { screen, reports, confirm }
}

/** The dialog's headline: the line under the frame's top rule, or the first line when it has no frame. */
function headline(frame: string): string {
  const [first = '', second = ''] = linesOf(frame)
    .map(line => line.trim())
    .filter(line => line !== '')
  return /^─+$/.test(first) ? second : first
}

// --- the routing --------------------------------------------------------------------

describe('PermissionRequest: which dialog a request is shown in', () => {
  const file = (name: string) => join(world().project, name)
  type Route = { tool: Tool; input: () => Record<string, unknown>; headline: string }
  const routes: Route[] = [
    { tool: FileEditTool, input: () => ({ file_path: file('a.txt'), old_string: 'one', new_string: 'two' }), headline: 'Edit file' },
    { tool: FileWriteTool, input: () => ({ file_path: file('new.txt'), content: 'hello' }), headline: 'Create file' },
    { tool: BashTool, input: () => ({ command: 'make deploy' }), headline: 'Bash command' },
    { tool: PowerShellTool, input: () => ({ command: 'Get-ChildItem' }), headline: 'PowerShell command' },
    // The git tool is checked against Bash rules, so it has a dialog of its own rather than the tool-wide one.
    { tool: GitTool as unknown as Tool, input: () => ({ commands: ['git push'] }), headline: 'Git' },
    { tool: WebFetchTool, input: () => ({ url: 'https://example.com/notes', prompt: 'summarise' }), headline: 'Fetch' },
    { tool: NotebookEditTool, input: () => ({ notebook_path: file('n.ipynb'), new_source: 'x = 1', cell_id: 'c1' }), headline: 'Edit notebook' },
    { tool: ExitPlanModeV2Tool, input: () => ({ plan: 'step one' }), headline: 'Exit plan mode?' },
    { tool: EnterPlanModeTool, input: () => ({}), headline: 'Enter plan mode?' },
    { tool: SkillTool, input: () => ({ skill: 'release' }), headline: 'Use skill "release"?' },
    {
      tool: AskUserQuestionTool,
      input: () => ({ questions: [{ question: 'Which region?', header: 'Region', multiSelect: false, options: [{ label: 'eu', description: 'Europe' }, { label: 'us', description: 'America' }] }] }),
      headline: '☐ Region',
    },
    // Wait shares the dialog of the shell-delegating tools, which names itself after the tool.
    { tool: WaitForTool, input: () => ({ command: 'curl -s localhost:3000', until: 'ready' }), headline: 'Wait' },
    { tool: GlobTool, input: () => ({ pattern: '**/*.ts' }), headline: 'Read file' },
    { tool: GrepTool, input: () => ({ pattern: 'TODO' }), headline: 'Read file' },
    { tool: FileReadTool, input: () => ({ file_path: file('notes.md') }), headline: 'Read file' },
    // Without the monitor build flag, Monitor has no dialog of its own (the flagged run checks the other side).
    { tool: MonitorTool as Tool, input: () => ({ command: 'tail -f log', description: 'watch the log' }), headline: 'Tool use' },
    { tool: deployTool, input: () => ({ target: 'production' }), headline: 'Tool use' },
  ]
  for (const route of routes) {
    test(
      `${route.tool.name} → "${route.headline}"`,
      async () => {
        const { screen, reports } = await ask(route.tool, route.input())
        expect(headline(screen.text())).toBe(route.headline)
        expect(reports).toEqual([])
      },
      SLOW,
    )
  }

  test(
    'the worker badge reaches the dialog\'s title',
    async () => {
      const { screen } = await ask(deployTool, { target: 'production' }, { name: 'deployer', color: 'orange' })
      expect(headline(screen.text())).toBe('Tool use · @deployer')
    },
    SLOW,
  )
})

// --- the interrupt key ----------------------------------------------------------------

describe('PermissionRequest: Ctrl+C', () => {
  const cases: Array<[string, () => [Tool, Record<string, unknown>]]> = [
    ['in the dialog of a tool without one of its own', () => [deployTool, { target: 'production' }]],
    ['in the read dialog', () => [FileReadTool, { file_path: join(world().project, 'notes.md') }]],
  ]
  for (const [name, pick] of cases) {
    test(
      `${name}: the caller is done, the caller rejects, then the request is rejected with no note`,
      async () => {
        const [tool, input] = pick()
        const { screen, reports } = await ask(tool, input)
        await screen.press(ctrlC)
        await screen.until(() => reports.length >= 3, 'the interrupt')
        await Bun.sleep(150)
        expect(reports).toEqual([['done'], ['caller rejects'], ['reject']])
        expect(screen.state().attribution.escapeCount).toBe(0)
      },
      SLOW,
    )
  }
})

// --- the answers --------------------------------------------------------------------------

describe('PermissionRequest: what each answer reports', () => {
  const INPUT = { target: 'production' }
  const ALWAYS = [{ type: 'addRules', rules: [{ toolName: 'mcp__infra__deploy' }], behavior: 'allow', destination: 'localSettings' }]
  type Row = { name: string; keys: string[]; reports: Report[]; escapes?: number }
  const rows: Row[] = [
    { name: 'Enter: allow once, nothing remembered', keys: [enter], reports: [['allow', INPUT, [], undefined], ['done']] },
    { name: '1: allow once', keys: ['1'], reports: [['allow', INPUT, [], undefined], ['done']] },
    { name: 'a note on yes: allow once, with the note', keys: [tab, 'a', 'f', 't', 'e', 'r', ' ', '5', 'p', 'm', enter], reports: [['allow', INPUT, [], 'after 5pm'], ['done']] },
    { name: '2: allow always, with a local-settings rule for the whole tool', keys: ['2'], reports: [['allow', INPUT, ALWAYS], ['done']] },
    { name: 'Down then Enter: allow always', keys: [down, enter], reports: [['allow', INPUT, ALWAYS], ['done']] },
    { name: '3: deny with no note', keys: ['3'], reports: [['reject', undefined], ['caller rejects'], ['done']] },
    { name: 'a note on no: deny with the note', keys: [down, down, tab, 'u', 's', 'e', ' ', 's', 't', 'a', 'g', 'i', 'n', 'g', enter], reports: [['reject', 'use staging'], ['caller rejects'], ['done']] },
    { name: 'an empty note on no: deny with no note', keys: [down, down, tab, enter], reports: [['reject', undefined], ['caller rejects'], ['done']] },
    { name: 'Esc: deny with nothing at all, counted as an escape', keys: [esc], reports: [['reject'], ['caller rejects'], ['done']], escapes: 1 },
    { name: 'Esc with a yes note written: still a deny', keys: [tab, 'o', 'k', esc], reports: [['reject'], ['caller rejects'], ['done']], escapes: 1 },
    { name: 'y and n answer nothing', keys: ['y', 'n'], reports: [] },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const { screen, reports } = await ask()
        await screen.press(...row.keys)
        await Bun.sleep(100)
        expect(reports).toEqual(row.reports)
        expect(screen.state().attribution.escapeCount).toBe(row.escapes ?? 0)
      },
      SLOW,
    )
  }

  test(
    'when managed policy keeps rules to itself there is no allow-always, and 2 is the deny',
    async () => {
      const managed = join(world().home, 'managed')
      mkdirSync(managed, { recursive: true })
      writeFileSync(join(managed, 'managed-settings.json'), JSON.stringify({ allowManagedPermissionRulesOnly: true }))
      resetSettingsCache()
      const { screen, reports } = await ask()
      expect(screen.text()).not.toContain("don't ask again")
      await screen.press('2')
      await Bun.sleep(100)
      expect(reports).toEqual([['reject', undefined], ['caller rejects'], ['done']])
    },
    SLOW,
  )
})

// --- the prompt counter -----------------------------------------------------------------------

describe('PermissionRequest: the permission-prompt counter', () => {
  test(
    'a dialog counts one prompt; a new request object for the same tool use does not count again; a new tool use does',
    async () => {
      const reports: Report[] = []
      const first = request(deployTool, { target: 'production' }, reports, 'toolu_count_a')
      const screen = await mount(frameFor(first, reports), { columns: 100 })
      await screen.until(() => screen.state().attribution.permissionPromptCount === 1, 'the first count')
      await screen.replace(frameFor({ ...first, description: 'a fresh object' } as ToolUseConfirm, reports))
      expect(screen.state().attribution.permissionPromptCount).toBe(1)
      await screen.replace(frameFor(request(deployTool, { target: 'staging' }, reports, 'toolu_count_b'), reports))
      await screen.until(() => screen.state().attribution.permissionPromptCount === 2, 'the second count')
      expect(reports).toEqual([])
    },
    SLOW,
  )

  test(
    'the hook on its own: once per tool use id, whatever else changes',
    async () => {
      const reports: Report[] = []
      function Probe({ confirm, language }: { confirm: ToolUseConfirm; language: string }): React.ReactNode {
        usePermissionRequestLogging(confirm, { completion_type: 'tool_use_single', language_name: language })
        return <Text>{`probing ${confirm.toolUseID}`}</Text>
      }
      const one = request(deployTool, {}, reports, 'toolu_hook_1')
      const screen = await mount(<Probe confirm={one} language="none" />)
      expect(screen.state().attribution.permissionPromptCount).toBe(1)
      await screen.replace(<Probe confirm={{ ...one } as ToolUseConfirm} language="typescript" />)
      expect(screen.state().attribution.permissionPromptCount).toBe(1)
      await screen.replace(<Probe confirm={request(deployTool, {}, reports, 'toolu_hook_2')} language="none" />)
      await screen.until(() => screen.state().attribution.permissionPromptCount === 2, 'the second count')
      await screen.replace(<Probe confirm={one} language="none" />)
      await screen.until(() => screen.state().attribution.permissionPromptCount === 3, 'a return to the first id')
    },
    SLOW,
  )
})
