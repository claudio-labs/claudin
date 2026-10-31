import { afterEach, describe, expect, test } from 'bun:test'

import type { Tool } from 'src/tools/Tool.js'
import { BuildTool } from 'src/tools/BuildTool/BuildTool.js'
import { EnterPlanModeTool } from 'src/tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { RunTestsTool } from 'src/tools/RunTestsTool/RunTestsTool.js'
import { TaskGetTool } from 'src/tools/TaskGetTool/TaskGetTool.js'
import { TaskListTool } from 'src/tools/TaskListTool/TaskListTool.js'
import { TaskStopTool } from 'src/tools/TaskStopTool/TaskStopTool.js'
import { TaskUpdateTool } from 'src/tools/TaskUpdateTool/TaskUpdateTool.js'
import { TypecheckTool } from 'src/tools/TypecheckTool/TypecheckTool.js'
import { WaitForTool } from 'src/tools/WaitForTool/WaitForTool.js'
import {
  deferredToolsHeader,
  formatDeferredToolLine,
  getPrompt,
  isDeferredTool,
} from 'src/tools/ToolSearchTool/prompt.js'

// CLAUDIN_DEFERRED_CALL_FORMS: a deferred tool whose whole input fits on a line
// is listed with that line, so the model calls it without a ToolSearch request
// first. Every A/B session on 10-30 opened with `ToolSearch
// select:EnterPlanMode,ExitPlanMode`, and TaskUpdate called directly from the
// approval text validated 5/5 on Opus 5.5: the API takes a tool_use for a
// deferred tool that was never loaded, and our zod checks the input.

const OLD_HEADER =
  'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:'

const saved = process.env.CLAUDIN_DEFERRED_CALL_FORMS
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDIN_DEFERRED_CALL_FORMS
  else process.env.CLAUDIN_DEFERRED_CALL_FORMS = saved
})

function fake(over: Partial<Tool> & { name: string }): Tool {
  return { shouldDefer: true, isMcp: false, ...over } as unknown as Tool
}

const WITH_FORMS: Tool[] = [
  EnterPlanModeTool,
  ExitPlanModeV2Tool,
  TaskListTool,
  TaskGetTool,
  TaskStopTool,
  TaskUpdateTool,
  RunTestsTool,
  TypecheckTool,
  BuildTool,
  WaitForTool,
] as unknown as Tool[]

describe('the built-in tools that carry a call form', () => {
  test.each(WITH_FORMS.map(t => [t.name, t] as const))('%s: deferred, named, and its form validates against its own schema', (_, tool) => {
    const form = (tool as { callForm?: string }).callForm
    expect(form).toBeDefined()
    expect(isDeferredTool(tool)).toBe(true)
    const match = /^(\w+)\((.*)\)$/.exec(form!)
    expect(match?.[1]).toBe(tool.name)
    const input = JSON.parse(
      match![2]!.replaceAll('<id>', '1').replaceAll('<status>', 'completed').replace(/<seconds, max (\d+)>/, '$1'),
    )
    expect(tool.inputSchema.safeParse(input).success).toBe(true)
  })

  test('WaitFor shows its cap, and the quoted number a schema-less call may send still passes', () => {
    const form = (WaitForTool as { callForm?: string }).callForm
    expect(form).toContain('<seconds, max 1800>')
    expect(WaitForTool.inputSchema.safeParse({ command: 'ls', description: 'd', timeout_s: '900' }).success).toBe(true)
    expect(WaitForTool.inputSchema.safeParse({ command: 'ls', description: 'd', timeout_s: '1801' }).success).toBe(false)
  })
})

describe('formatDeferredToolLine', () => {
  test('=0: the name alone, as before 10-30', () => {
    process.env.CLAUDIN_DEFERRED_CALL_FORMS = '0'
    expect(formatDeferredToolLine(EnterPlanModeTool as unknown as Tool)).toBe('EnterPlanMode')
  })

  test('on by default: a tool with a call form is listed with it', () => {
    delete process.env.CLAUDIN_DEFERRED_CALL_FORMS
    expect(formatDeferredToolLine(EnterPlanModeTool as unknown as Tool)).toBe('EnterPlanMode — call directly: EnterPlanMode({})')
  })

  test('on: a tool without one keeps its bare name', () => {
    process.env.CLAUDIN_DEFERRED_CALL_FORMS = '1'
    expect(formatDeferredToolLine(fake({ name: 'WebFetch' }))).toBe('WebFetch')
  })

  test('on: an MCP tool never gets one, whatever it declares', () => {
    process.env.CLAUDIN_DEFERRED_CALL_FORMS = '1'
    expect(formatDeferredToolLine(fake({ name: 'mcp__x__y', isMcp: true, callForm: 'mcp__x__y({})' } as never))).toBe('mcp__x__y')
  })
})

describe('deferredToolsHeader', () => {
  test('lines without a call form keep the header byte for byte, so an old transcript resumes on its cache', () => {
    expect(deferredToolsHeader(['WebFetch', 'TaskList'])).toBe(OLD_HEADER)
  })

  test('a line with a call form switches the header, whatever the flag says now', () => {
    process.env.CLAUDIN_DEFERRED_CALL_FORMS = '0'
    const header = deferredToolsHeader(['EnterPlanMode — call directly: EnterPlanMode({})', 'WebFetch'])
    expect(header).not.toBe(OLD_HEADER)
    expect(header).toContain('called directly')
    expect(header).toContain('select:<name>[,<name>...]')
    expect(header).not.toContain('will fail with InputValidationError')
  })
})

describe('the ToolSearch prompt', () => {
  test('=0: unchanged', () => {
    process.env.CLAUDIN_DEFERRED_CALL_FORMS = '0'
    const off = getPrompt()
    expect(off).toContain('there is no parameter schema, so the tool cannot be invoked.')
    expect(off).not.toContain('call form')
  })

  test('by default: names the exception', () => {
    delete process.env.CLAUDIN_DEFERRED_CALL_FORMS
    expect(getPrompt()).toContain('call form')
  })
})
