import { afterEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'
import type { PermissionDecision, PermissionResult } from 'src/shared/types/permissions.js'
import {
  type EditThenDeps,
  foldThenPermission,
  formatThen,
  resolveThen,
  runThen,
  takeThenSkipNote,
  thenClassifierInput,
  thenSkipReason,
} from 'src/tools/shared/editThen/editThen.js'
import {
  EDIT_THEN_ENV,
  MAX_THEN_COMMANDS,
  thenCommands,
  thenFailed,
  thenSchemaFields,
} from 'src/tools/shared/editThen/editThenShape.js'

const priorFlag = process.env[EDIT_THEN_ENV]
afterEach(() => {
  if (priorFlag === undefined) delete process.env[EDIT_THEN_ENV]
  else process.env[EDIT_THEN_ENV] = priorFlag
})

type Mode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk' | 'plan'

function contextIn(mode: Mode, extra: { isBypassPermissionsModeAvailable?: boolean } = {}): ToolUseContext {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode, ...extra }
  return {
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => ({ toolPermissionContext, sessionHooks: new Map() }),
  } as unknown as ToolUseContext
}

const allow = (command: string): PermissionResult => ({
  behavior: 'allow',
  // What a delegated verdict carries: an input shaped for Bash, not for the edit.
  updatedInput: { command },
})
const ask: PermissionResult = { behavior: 'ask', message: 'Bash needs approval' }
const ruleAsk: PermissionResult = {
  behavior: 'ask',
  message: 'an ask rule matched',
  decisionReason: {
    type: 'rule',
    rule: { source: 'userSettings', ruleBehavior: 'ask', ruleValue: { toolName: 'Bash', ruleContent: 'npm publish:*' } },
  },
}
const safetyAsk: PermissionResult = {
  behavior: 'ask',
  message: 'touches .git/',
  decisionReason: { type: 'safetyCheck', reason: '.git', classifierApprovable: true },
}
const deny: PermissionResult = {
  behavior: 'deny',
  message: 'denied by rule',
  decisionReason: { type: 'other', reason: 'rule' },
}

/** Deps whose verdict per command comes from `verdicts`; everything else allows. */
function deps(
  verdicts: Record<string, PermissionResult> = {},
  opts: { hooks?: boolean; exits?: Record<string, number | null> } = {},
): EditThenDeps & { ran: string[] } {
  const ran: string[] = []
  return {
    ran,
    permissionFor: async command => verdicts[command] ?? allow(command),
    hooksConfigured: () => opts.hooks === true,
    runCommand: async command => {
      ran.push(command)
      const exitCode = opts.exits && command in opts.exits ? opts.exits[command]! : 0
      return { exitCode, output: `out of ${command}` }
    },
  }
}

describe('thenCommands', () => {
  test('trims, and reads null, [] and blank entries as none', () => {
    expect(thenCommands({ then: ['  bun test ', '', '   ', 'tsc'] })).toEqual(['bun test', 'tsc'])
    expect(thenCommands({ then: null })).toEqual([])
    expect(thenCommands({ then: [] })).toEqual([])
    expect(thenCommands({})).toEqual([])
  })
})

describe('thenSchemaFields', () => {
  test('off: no field, so the schema is what it was', () => {
    delete process.env[EDIT_THEN_ENV]
    expect(Object.keys(thenSchemaFields())).toEqual([])
  })

  test(`on: a nullable list of at most ${MAX_THEN_COMMANDS}`, () => {
    process.env[EDIT_THEN_ENV] = '1'
    const { then } = thenSchemaFields()
    expect(then.safeParse(['bun test']).success).toBe(true)
    expect(then.safeParse(null).success).toBe(true)
    expect(then.safeParse(undefined).success).toBe(true)
    expect(then.safeParse(['a', 'b', 'c', 'd']).success).toBe(false)
  })
})

describe('thenFailed', () => {
  test('a command that ran and did not exit 0 is a failed check', () => {
    expect(thenFailed({ then: [{ command: 'x', ran: true, exitCode: 2, output: '' }] })).toBe(true)
    expect(thenFailed({ then: [{ command: 'x', ran: true, exitCode: null, output: '' }] })).toBe(true)
    expect(thenFailed({ then: [{ command: 'x', ran: true, exitCode: 0, output: '' }] })).toBe(false)
    expect(thenFailed({ then: [{ command: 'x', ran: false, exitCode: null, output: '' }] })).toBe(false)
    expect(thenFailed({ files: [] })).toBe(false)
    expect(thenFailed(null)).toBe(false)
  })
})

describe('thenSkipReason — where the commands may run', () => {
  test('any hook drops them, in every mode', async () => {
    for (const mode of ['bypassPermissions', 'auto', 'default'] as const) {
      expect(await thenSkipReason(['bun test'], contextIn(mode), deps({}, { hooks: true }))).toContain(
        'hook',
      )
    }
  })

  test('allowed commands run in every mode', async () => {
    for (const mode of ['default', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions'] as const) {
      expect(await thenSkipReason(['bun test'], contextIn(mode), deps())).toBeNull()
    }
  })

  test('a plain ask runs where no dialog opens — bypass and auto', async () => {
    const d = deps({ 'bun test': ask })
    expect(await thenSkipReason(['bun test'], contextIn('bypassPermissions'), d)).toBeNull()
    expect(await thenSkipReason(['bun test'], contextIn('auto'), d)).toBeNull()
    expect(
      await thenSkipReason(['bun test'], contextIn('plan', { isBypassPermissionsModeAvailable: true }), d),
    ).toBeNull()
  })

  test('a plain ask is dropped wherever it would open a dialog', async () => {
    const d = deps({ 'bun test': ask })
    for (const mode of ['default', 'acceptEdits', 'dontAsk', 'plan'] as const) {
      expect(await thenSkipReason(['bun test'], contextIn(mode), d)).toContain('permission prompt')
    }
  })

  test('an ask that prompts in any mode is dropped in bypass and auto too', async () => {
    for (const verdict of [ruleAsk, safetyAsk]) {
      const d = deps({ 'npm publish': verdict })
      for (const mode of ['bypassPermissions', 'auto'] as const) {
        expect(await thenSkipReason(['bun test', 'npm publish'], contextIn(mode), d)).toContain(
          '`npm publish`',
        )
      }
    }
  })

  test('a denied command is dropped and named', async () => {
    const reason = await thenSkipReason(['bun test', 'rm -rf x'], contextIn('bypassPermissions'), deps({ 'rm -rf x': deny }))
    expect(reason).toBe('`rm -rf x` is denied by a permission rule')
  })
})

describe('resolveThen', () => {
  test('an input without then passes through untouched', async () => {
    const input = { patchText: 'p' }
    expect(await resolveThen(input, contextIn('default'), deps())).toBe(input)
  })

  test('placeholders are dropped, not refused', async () => {
    for (const then of [null, [], ['']]) {
      const out = await resolveThen({ patchText: 'p', then }, contextIn('default'), deps())
      expect<object>(out).toEqual({ patchText: 'p' })
    }
  })

  test('commands that may run come back trimmed, with no note', async () => {
    const context = contextIn('bypassPermissions')
    const out = await resolveThen({ patchText: 'p', then: [' bun test '] }, context, deps({ 'bun test': ask }))
    expect(out).toEqual({ patchText: 'p', then: ['bun test'] })
    expect(takeThenSkipNote(context)).toBeUndefined()
  })

  test('commands that may not run are dropped, and call() gets the reason once', async () => {
    const context = contextIn('default')
    const out = await resolveThen({ patchText: 'p', then: ['bun test'] }, context, deps({ 'bun test': ask }))
    expect<object>(out).toEqual({ patchText: 'p' })
    expect(takeThenSkipNote(context)).toBe('`bun test` would need a permission prompt')
    expect(takeThenSkipNote(context)).toBeUndefined()
  })

  test('the next resolve clears a note a refused call left behind', async () => {
    const context = contextIn('default')
    await resolveThen({ patchText: 'p', then: ['bun test'] }, context, deps({ 'bun test': ask }))
    await resolveThen({ patchText: 'q' }, context, deps())
    expect(takeThenSkipNote(context)).toBeUndefined()
  })
})

describe('foldThenPermission', () => {
  const input = { patchText: 'p', then: ['bun test', 'tsc'] }
  const editAllow: PermissionDecision = { behavior: 'allow', updatedInput: { files: 'placeholder' } }
  const editAsk: PermissionDecision = { behavior: 'ask', message: 'edit outside the project' }
  const editDeny: PermissionDecision = {
    behavior: 'deny',
    message: 'edit denied',
    decisionReason: { type: 'other', reason: 'x' },
  }
  const context = contextIn('auto')

  test('without commands, the edit decides alone', async () => {
    expect(await foldThenPermission({ patchText: 'p' }, editAsk, context, deps())).toBe(editAsk)
  })

  test('the edit denied stays denied', async () => {
    expect(await foldThenPermission(input, editDeny, context, deps())).toBe(editDeny)
  })

  test('a denied command denies the call', async () => {
    const out = await foldThenPermission(input, editAllow, context, deps({ tsc: deny }))
    expect(out.behavior).toBe('deny')
    expect(out.behavior === 'deny' ? out.message : undefined).toBe('denied by rule')
  })

  test("the edit's own ask keeps its message and carries the edit's input", async () => {
    const out = await foldThenPermission(input, editAsk, context, deps())
    expect(out).toEqual({ ...editAsk, updatedInput: input })
  })

  test("a command that asks makes the call ask — with the edit's input, never Bash's", async () => {
    const out = await foldThenPermission(input, editAllow, context, deps({ tsc: ask }))
    expect(out.behavior).toBe('ask')
    expect(out.behavior === 'ask' ? out.message : undefined).toBe('Bash needs approval')
    expect(out.behavior !== 'deny' && out.updatedInput).toBe(input)
  })

  test("all allowed: allow, echoing the edit's input over Bash's { command }", async () => {
    const out = await foldThenPermission(input, editAllow, context, deps())
    expect(out.behavior).toBe('allow')
    expect(out.behavior === 'allow' && out.updatedInput).toBe(input)
  })
})

describe('thenClassifierInput', () => {
  test('the classifier judges the edit and every command', () => {
    expect(thenClassifierInput('a.ts: x', { then: ['bun test', 'tsc'] })).toBe(
      'a.ts: x\n\nthen, in order:\n$ bun test\n$ tsc',
    )
    expect(thenClassifierInput('a.ts: x', {})).toBe('a.ts: x')
  })
})

describe('runThen', () => {
  test('runs in order', async () => {
    const d = deps()
    const runs = await runThen(['a', 'b'], contextIn('auto'), d)
    expect(d.ran).toEqual(['a', 'b'])
    expect(runs.map(r => [r.command, r.ran, r.exitCode])).toEqual([
      ['a', true, 0],
      ['b', true, 0],
    ])
  })

  test('stops at the first that fails, or that has no exit status', async () => {
    for (const exit of [1, null]) {
      const d = deps({}, { exits: { a: exit } })
      const runs = await runThen(['a', 'b', 'c'], contextIn('auto'), d)
      expect(d.ran).toEqual(['a'])
      expect(runs.map(r => r.ran)).toEqual([true, false, false])
    }
  })
})

describe('formatThen', () => {
  test('nothing to say, nothing added', () => {
    expect(formatThen(undefined, undefined)).toBe('')
    expect(formatThen([], undefined)).toBe('')
  })

  test('each command with its output, the exit code when it failed, and what did not run', () => {
    const text = formatThen(
      [
        { command: 'bun test', ran: true, exitCode: 1, output: ' 1 fail\n' },
        { command: 'tsc', ran: false, exitCode: null, output: '' },
      ],
      undefined,
    )
    expect(text).toBe('\n\n$ bun test\n1 fail\nExit code 1\n\nNot run, an earlier command failed: $ tsc')
  })

  test('a green run with no output says so', () => {
    expect(formatThen([{ command: 'tsc', ran: true, exitCode: 0, output: '' }], undefined)).toBe(
      '\n\n$ tsc\n(no output)',
    )
  })

  test('the reason the commands were dropped', () => {
    expect(formatThen(undefined, '`bun test` would need a permission prompt')).toBe(
      '\n\n`then` did not run: `bun test` would need a permission prompt. Run the commands as their own Bash call.',
    )
  })
})

// The schemas and the prompts read the flag once, when they are built (at
// module load, or on the lazy schema's first use), so each arm loads its own
// instance of the module and builds what it reads with the variable set its way.
let loadSeq = 0
async function withThen<T, R>(specifier: string, on: boolean, build: (module: T) => R): Promise<R> {
  if (on) process.env[EDIT_THEN_ENV] = '1'
  else delete process.env[EDIT_THEN_ENV]
  try {
    return build((await import(`${specifier}?edit-then=${on}-${++loadSeq}`)) as T)
  } finally {
    if (priorFlag === undefined) delete process.env[EDIT_THEN_ENV]
    else process.env[EDIT_THEN_ENV] = priorFlag
  }
}

type Schema = { safeParse(input: unknown): { success: boolean } }
type SchemaModule = { inputSchema: () => Schema }
type PatchModule = { ApplyPatchTool: { inputSchema: Schema } }

describe('the edit tools carry `then` only with the flag', () => {
  const patch = { patchText: '*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch' }
  const edit = { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' }

  test('Patch: the strict schema refuses `then` off and takes it on', async () => {
    const spec = 'src/tools/ApplyPatchTool/ApplyPatchTool.js'
    const off = await withThen<PatchModule, Schema>(spec, false, m => m.ApplyPatchTool.inputSchema)
    const on = await withThen<PatchModule, Schema>(spec, true, m => m.ApplyPatchTool.inputSchema)
    expect(off.safeParse({ ...patch, then: ['bun test'] }).success).toBe(false)
    expect(on.safeParse({ ...patch, then: ['bun test'] }).success).toBe(true)
    expect(on.safeParse(patch).success).toBe(true)
  })

  test('Edit: the strict schema refuses `then` off and takes it on', async () => {
    const spec = 'src/tools/FileEditTool/types.js'
    const off = await withThen<SchemaModule, Schema>(spec, false, m => m.inputSchema())
    const on = await withThen<SchemaModule, Schema>(spec, true, m => m.inputSchema())
    expect(off.safeParse({ ...edit, then: ['bun test'] }).success).toBe(false)
    expect(on.safeParse({ ...edit, then: ['bun test'] }).success).toBe(true)
  })

  test('the prompts name `then` only with the flag', async () => {
    type PatchPrompt = { DESCRIPTION: string }
    const patchSpec = 'src/tools/ApplyPatchTool/prompt.js'
    const patchOff = await withThen<PatchPrompt, string>(patchSpec, false, m => m.DESCRIPTION)
    const patchOn = await withThen<PatchPrompt, string>(patchSpec, true, m => m.DESCRIPTION)
    expect(patchOff).not.toContain('`then`')
    expect(patchOn).toContain('put its test, typecheck or build command in `then`')
    expect(patchOn.startsWith(patchOff)).toBe(true)

    type EditPrompt = { buildEditToolDescription(lean: boolean): string }
    const editSpec = 'src/tools/FileEditTool/prompt.js'
    const editOff = await withThen<EditPrompt, string>(editSpec, false, m => m.buildEditToolDescription(false))
    const editOn = await withThen<EditPrompt, string>(editSpec, true, m => m.buildEditToolDescription(false))
    expect(editOff).not.toContain('`then`')
    expect(editOn).toContain('put its test, typecheck or build command in `then`')
  })
})
