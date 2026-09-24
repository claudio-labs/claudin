import { afterEach, expect, test } from 'bun:test'
import { BuildTool } from 'src/tools/BuildTool/BuildTool.js'
import { RunTestsTool } from 'src/tools/RunTestsTool/RunTestsTool.js'
import type { Tool } from 'src/tools/Tool.js'
import { isDeferredTool } from 'src/tools/ToolSearchTool/prompt.js'
import { TypecheckTool } from 'src/tools/TypecheckTool/TypecheckTool.js'
import { WaitForTool } from 'src/tools/WaitForTool/WaitForTool.js'

// Build, RunTests, Typecheck and WaitFor wait behind ToolSearch (~11.5k chars
// of schema off every request). Their searchHint is what a keyword search
// matches on, and CLAUDIN_EAGER_DEV_TOOLS=1 brings them back to the prefix.
// The built tools' progress renderers are narrower than `Tool`'s, so each is
// widened once here rather than at every call.
const DEV_TOOLS: ReadonlyArray<readonly [string, Tool]> = [
  ['Build', BuildTool as unknown as Tool],
  ['RunTests', RunTestsTool as unknown as Tool],
  ['Typecheck', TypecheckTool as unknown as Tool],
  ['WaitFor', WaitForTool as unknown as Tool],
]

const saved = process.env.CLAUDIN_EAGER_DEV_TOOLS
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDIN_EAGER_DEV_TOOLS
  else process.env.CLAUDIN_EAGER_DEV_TOOLS = saved
})

test.each(DEV_TOOLS)('%s is deferred and findable', (_name, tool) => {
  delete process.env.CLAUDIN_EAGER_DEV_TOOLS
  expect(isDeferredTool(tool)).toBe(true)
  expect(tool.searchHint?.length ?? 0).toBeGreaterThan(0)
})

test.each(DEV_TOOLS)('CLAUDIN_EAGER_DEV_TOOLS=1 sends %s eagerly again', (_name, tool) => {
  process.env.CLAUDIN_EAGER_DEV_TOOLS = '1'
  expect(isDeferredTool(tool)).toBe(false)
})
