import { beforeAll, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from 'src/Tool.js'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
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
  const base = getEmptyToolPermissionContext()
  const toolPermissionContext: ToolPermissionContext = {
    ...base,
    ...(rules.allow ? { alwaysAllowRules: { cliArg: rules.allow } } : {}),
    ...(rules.deny ? { alwaysDenyRules: { cliArg: rules.deny } } : {}),
  }
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

test('a multi-line commit message still matches the Bash rule for its command', async () => {
  // The message is the reason this tool takes multi-line commands at all, and
  // `bashToolHasPermission` parses with tree-sitter: a body that reads like a
  // second command (`git push`, on its own line, inside the quotes) must not
  // change which rule applies, or an allowed commit would start asking.
  const result = await checkGitBatchPermission(
    {
      commands: [
        'git commit -m "fix: stop the retry loop\n\nIt used to git push twice.\nNow it does not."',
      ],
    },
    contextWith({ allow: ['Bash(git commit:*)'], deny: ['Bash(git push:*)'] }),
  )
  expect(result.behavior).toBe('allow')
})
