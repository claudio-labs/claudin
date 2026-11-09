import { beforeAll, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { ToolPermissionContext, ToolUseContext } from 'src/tools/Tool.js'
import { checkGitBatchPermission } from 'src/tools/GitTool/permissions.js'

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
  // with a field the schema does not have — the bug that made Patch dead
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

// The batch has no length cap of its own any more (2026-11-09): like Bash,
// past MAX_SUBCOMMANDS_FOR_SECURITY_CHECK the call asks instead of judging each
// element, and below it every element is judged as before.
test('past the subcommand cap a batch asks, with the reason Bash gives', async () => {
  const commands = Array.from({ length: 51 }, () => 'git status')
  const result = await checkGitBatchPermission(
    { commands },
    contextWith({ allow: ['Bash(git status:*)'] }),
  )
  expect(result.behavior).toBe('ask')
  expect(result.decisionReason).toEqual({
    type: 'other',
    reason: 'Batch has 51 commands, too many to safety-check individually',
  })
})

test('at the cap every element is still judged on its own', async () => {
  const commands = Array.from({ length: 50 }, () => 'git status')
  const allowed = await checkGitBatchPermission({ commands }, contextWith({ allow: ['Bash(git status:*)'] }))
  expect(allowed.behavior).toBe('allow')
  const denied = await checkGitBatchPermission(
    { commands: [...commands.slice(1), 'git push'] },
    contextWith({ allow: ['Bash(git status:*)'], deny: ['Bash(git push:*)'] }),
  )
  expect(denied.behavior).toBe('deny')
})
