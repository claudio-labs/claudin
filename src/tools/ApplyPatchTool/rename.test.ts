import { expect, test } from 'bun:test'
import { getLegacyToolNames, permissionRuleValueFromString } from 'src/permissions/permissionRuleParser.js'
import { ApplyPatchTool } from 'src/tools/ApplyPatchTool/ApplyPatchTool.js'
import { toolMatchesName } from 'src/tools/Tool.js'

// The wire name was `apply_patch` until 2026-09-24. Everything written before
// that — a transcript's tool_use blocks, a settings rule, a hook matcher, a
// `--disallowedTools` flag — must still reach this tool under the new name.

test('the tool is called Patch and still answers to apply_patch', () => {
  expect(ApplyPatchTool.name).toBe('Patch')
  expect(toolMatchesName(ApplyPatchTool, 'apply_patch')).toBe(true)
})

test('a permission rule written against apply_patch applies to Patch', () => {
  expect(permissionRuleValueFromString('apply_patch')).toEqual({ toolName: 'Patch' })
})

test('a hook matcher for Patch also matches the legacy name', () => {
  expect(getLegacyToolNames('Patch')).toContain('apply_patch')
})
