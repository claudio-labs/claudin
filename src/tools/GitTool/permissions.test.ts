import { beforeAll, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { ToolUseContext } from '../../Tool.js'
import { checkGitBatchPermission } from './permissions.js'

beforeAll(() => {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }
})

function contextWith(rules: {
  allow?: string[]
  deny?: string[]
}): ToolUseContext {
  const toolPermissionContext = getEmptyToolPermissionContext()
  if (rules.allow) toolPermissionContext.alwaysAllowRules = { cliArg: rules.allow }
  if (rules.deny) toolPermissionContext.alwaysDenyRules = { cliArg: rules.deny }
  return {
    abortController: new AbortController(),
    options: { isNonInteractiveSession: false },
    getAppState() {
      return { toolPermissionContext }
    },
  } as never
}

test('an existing Bash deny rule blocks the Git tool', async () => {
  // The whole point of delegating: a user who denied `git push` in Bash does
  // not have to learn a second rule namespace.
  const result = await checkGitBatchPermission(
    { commands: ['git push --force origin main'] },
    contextWith({ deny: ['Bash(git push:*)'] }),
  )
  expect(result.behavior).toBe('deny')
})

test('a deny anywhere in the batch refuses the whole call', async () => {
  // Not just the first element — otherwise the allowed commands would run and
  // the denied one would surface after the side effects had landed.
  const result = await checkGitBatchPermission(
    { commands: ['git status', 'git diff', 'git push'] },
    contextWith({ allow: ['Bash(git status:*)', 'Bash(git diff:*)'], deny: ['Bash(git push:*)'] }),
  )
  expect(result.behavior).toBe('deny')
})

test('on allow it echoes the Git input, never the synthesized Bash one', async () => {
  // bashToolHasPermission returns `updatedInput: { command }` and the harness
  // applies updatedInput verbatim. Passing it through would replace `commands`
  // with a field the schema does not have — the bug that made apply_patch dead
  // on arrival in auto/bypass mode.
  const input = { commands: ['git status'] }
  const result = await checkGitBatchPermission(
    input,
    contextWith({ allow: ['Bash(git status:*)'] }),
  )
  expect(result.behavior).toBe('allow')
  if (result.behavior === 'allow') {
    expect(result.updatedInput).toBe(input)
    expect(result.updatedInput).not.toHaveProperty('command')
  }
})
