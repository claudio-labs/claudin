/**
 * The fix decisions of the `permissions/fileRules` spec (F1-F5, F9), each
 * through the public exports, with real files in a temp workspace. The
 * characterization suites pin everything else, including the parity halves
 * of F1, F2 and F5.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  checkBatchWritePermission,
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  getFileReadIgnorePatterns,
  matchingRuleForInput,
} from 'src/permissions/filePermissions.js'
import type { PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

type Rules = Partial<Record<PermissionRuleSource, string[]>>
type Setup = { mode?: ToolPermissionContext['mode']; allow?: Rules; deny?: Rules; ask?: Rules }

function contextOf(setup: Setup = {}): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    mode: setup.mode ?? 'default',
    alwaysAllowRules: setup.allow ?? {},
    alwaysDenyRules: setup.deny ?? {},
    alwaysAskRules: setup.ask ?? {},
  }
}

type Checker = (tool: unknown, input: unknown, ctx: ToolPermissionContext) => PermissionDecision
const fileTool = { name: 'Edit', getPath: (input: { file_path: string }) => input.file_path }
const read = (path: string, ctx: ToolPermissionContext) =>
  (checkReadPermissionForTool as unknown as Checker)(fileTool, { file_path: path }, ctx)
const write = (path: string, ctx: ToolPermissionContext) =>
  (checkWritePermissionForTool as unknown as Checker)(fileTool, { file_path: path }, ctx)

function summary(decision: PermissionDecision): string {
  const reason = decision.decisionReason
  if (reason?.type === 'rule') return `${decision.behavior} rule ${reason.rule.source} ${reason.rule.ruleValue.ruleContent}`
  if (reason?.type === 'mode') return `${decision.behavior} mode ${reason.mode}`
  return `${decision.behavior} ${reason?.type ?? '-'}`
}

function messageOf(decision: PermissionDecision): string {
  return 'message' in decision ? decision.message : ''
}

const saved: Record<string, string | undefined> = {}
const globals = globalThis as { MACRO?: { VERSION?: string } }
let hadMacro = false
let suiteTmp = ''
let ws = ''
let project = ''
let current = ''
let outside = ''
let configHome = ''

beforeAll(() => {
  saved.originalCwd = getOriginalCwd()
  saved.cwd = getCwdState()
  saved.CLAUDIN_CONFIG_DIR = process.env.CLAUDIN_CONFIG_DIR
  saved.CLAUDIN_TMPDIR = process.env.CLAUDIN_TMPDIR
  hadMacro = globals.MACRO !== undefined
  globals.MACRO ??= { VERSION: 'fixes' }
  suiteTmp = realpathSync(mkdtempSync(join(tmpdir(), 'file-rules-fixes-suite-')))
  process.env.CLAUDIN_TMPDIR = suiteTmp
})

afterAll(() => {
  setOriginalCwd(saved.originalCwd ?? process.cwd())
  setCwdState(saved.cwd ?? process.cwd())
  for (const key of ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_TMPDIR']) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  if (!hadMacro) delete globals.MACRO
  rmSync(suiteTmp, { recursive: true, force: true })
})

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'file-rules-fixes-')))
  project = join(ws, 'project')
  current = join(project, 'pkg')
  outside = join(ws, 'outside')
  configHome = join(ws, 'home', '.claudin')
  for (const dir of [current, outside, configHome]) mkdirSync(dir, { recursive: true })
  setOriginalCwd(project)
  setCwdState(current)
  process.env.CLAUDIN_CONFIG_DIR = configHome
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

function plant(dir: string, rel: string): string {
  const target = join(dir, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, 'x')
  return target
}

describe('F1: a whole-anchor pattern covers everything under its anchor for deny and ask', () => {
  test('in the rule matcher, for /**, //** and ~/**', () => {
    const file = plant(project, 'src/a.ts')
    const underHome = join(homedir(), 'no-such-dir-f1', 'x')
    for (const behavior of ['deny', 'ask'] as const) {
      for (const [text, path] of [['/**', file], ['//**', file], ['~/**', underHome]] as const) {
        const ctx = contextOf({ [behavior]: { session: [`Read(${text})`] } })
        expect(matchingRuleForInput(path, ctx, 'read', behavior)?.ruleValue.ruleContent).toBe(text)
      }
    }
  })

  test('in the read and write checks', () => {
    const file = plant(project, 'src/a.ts')
    expect(summary(read(file, contextOf({ deny: { projectSettings: ['Read(/**)'] } })))).toBe('deny rule projectSettings /**')
    expect(summary(read(file, contextOf({ ask: { session: ['Read(//**)'] } })))).toBe('ask rule session //**')
    expect(summary(write(file, contextOf({ mode: 'acceptEdits', deny: { userSettings: ['Edit(//**)'] } })))).toBe(
      'deny rule userSettings //**',
    )
    expect(summary(write(file, contextOf({ mode: 'acceptEdits', ask: { session: ['Edit(/**)'] } })))).toBe(
      'ask rule session /**',
    )
  })

  test('allow keeps its pinned behaviour: the whole anchor grants nothing', () => {
    const file = plant(outside, 'a.ts')
    expect(summary(read(file, contextOf({ allow: { session: ['Read(//**)'] } })))).toBe('ask workingDir')
  })
})

describe('F2: the same deny or ask text in two sources keeps each anchor', () => {
  for (const behavior of ['deny', 'ask'] as const) {
    test(`${behavior}: user settings still covers the config home when the session repeats the rule`, () => {
      const rules = { userSettings: ['Read(/vault/**)'], session: ['Read(/vault/**)'] }
      const ctx = contextOf({ [behavior]: rules })
      const inConfig = plant(configHome, 'vault/key')
      const inProject = plant(project, 'vault/key')
      expect(matchingRuleForInput(inConfig, ctx, 'read', behavior)?.source).toBe('userSettings')
      expect(matchingRuleForInput(inProject, ctx, 'read', behavior)?.source).toBe('session')
      expect(summary(read(inConfig, ctx))).toBe(`${behavior} rule userSettings /vault/**`)
    })
  }

  test('edit deny in the write check', () => {
    const ctx = contextOf({ deny: { userSettings: ['Edit(/vault/**)'], projectSettings: ['Edit(/vault/**)'] } })
    expect(summary(write(plant(configHome, 'vault/key'), ctx))).toBe('deny rule userSettings /vault/**')
  })

  test('the search tools see both anchors', () => {
    const ctx = contextOf({ deny: { userSettings: ['Read(/vault/**)'], session: ['Read(/vault/**)'] } })
    expect([...getFileReadIgnorePatterns(ctx).entries()]).toEqual([
      [configHome, ['/vault/**']],
      [project, ['/vault/**']],
    ])
  })
})

describe('F3: the exact parent of an anchor answers instead of throwing', () => {
  const rows: { name: string; rule: string; path: () => string }[] = [
    { name: 'the current directory, with an unanchored rule', rule: 'Read(*.pem)', path: () => dirname(current) },
    { name: 'the starting directory, with a / rule', rule: 'Read(/vault/**)', path: () => dirname(project) },
    { name: 'home, with a ~/ rule', rule: 'Read(~/.ssh/**)', path: () => dirname(homedir()) },
  ]
  for (const row of rows) {
    test(row.name, () => {
      for (const behavior of ['allow', 'deny', 'ask'] as const) {
        const ctx = contextOf({ [behavior]: { session: [row.rule] } })
        expect(() => matchingRuleForInput(row.path(), ctx, 'read', behavior)).not.toThrow()
        expect(matchingRuleForInput(row.path(), ctx, 'read', behavior)).toBeNull()
      }
    })
  }

  test('the read check on the parent of the current directory decides', () => {
    const ctx = contextOf({ deny: { session: ['Read(*.pem)'] } })
    expect(summary(read(dirname(current), ctx))).toBe('allow mode default')
  })
})

describe('F4: the read check applies deny rules before the shapes that need a person', () => {
  test('a denied path with a Windows shape is denied, not asked', () => {
    const file = plant(project, 'secrets/GIT~1')
    const decision = read(file, contextOf({ deny: { session: ['Read(/secrets/**)'] } }))
    expect(summary(decision)).toBe('deny rule session /secrets/**')
  })

  test('a denied link to a UNC path is denied, not asked', () => {
    const link = join(project, 'locked', 'share-link')
    mkdirSync(dirname(link))
    symlinkSync('//fileserver/share/doc.txt', link)
    expect(summary(read(link, contextOf({ deny: { session: ['Read(/locked/**)'] } })))).toBe('deny rule session /locked/**')
  })

  test('without a deny rule, the shapes still ask', () => {
    expect(summary(read(plant(project, 'secrets/GIT~1'), contextOf()))).toBe('ask other')
  })
})

describe('F5: a batch write under bypassPermissions honours Edit deny rules', () => {
  test('a denied path denies the batch, naming only the denied paths', () => {
    const ok = plant(project, 'ok.ts')
    const lockedA = plant(project, 'locked/a.ts')
    const lockedB = plant(project, 'locked/b.ts')
    const ctx = contextOf({ mode: 'bypassPermissions', deny: { session: ['Edit(/locked/**)'] } })
    const decision = checkBatchWritePermission('ApplyPatch', [lockedA, ok, lockedB], ctx)
    expect(decision.behavior).toBe('deny')
    expect(decision.decisionReason).toEqual({ type: 'other', reason: 'batch deny' })
    expect(messageOf(decision).split('\n').slice(1)).toEqual([`  - ${lockedA}`, `  - ${lockedB}`])
  })

  test('a deny on a link target holds too', () => {
    const link = join(project, 'innocent.ts')
    symlinkSync(plant(outside, 'vault/key'), link)
    const ctx = contextOf({ mode: 'bypassPermissions', deny: { session: [`Edit(/${outside}/vault/**)`] } })
    expect(checkBatchWritePermission('Rename', [link], ctx).behavior).toBe('deny')
  })

  test('a Read deny does not block the batch write', () => {
    const ctx = contextOf({ mode: 'bypassPermissions', deny: { session: ['Read(/locked/**)'] } })
    expect(checkBatchWritePermission('Rename', [plant(project, 'locked/a.ts')], ctx).behavior).toBe('allow')
  })

  test('ask rules and protected paths stay allowed under bypass (pinned)', () => {
    const bypassAllow: PermissionDecision = {
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'mode', mode: 'bypassPermissions' },
    }
    const asked = plant(project, 'asked.ts')
    const ctx = contextOf({ mode: 'bypassPermissions', ask: { session: ['Edit(/asked.ts)'] } })
    expect(checkBatchWritePermission('ApplyPatch', [asked], ctx)).toEqual(bypassAllow)
    const gitConfig = plant(project, '.git/config')
    expect(checkBatchWritePermission('ApplyPatch', [gitConfig], contextOf({ mode: 'bypassPermissions' }))).toEqual(bypassAllow)
  })
})

describe('F9: write messages name the resolved path', () => {
  test('a relative input is named by its absolute path in the deny and the ask', () => {
    const resolved = plant(current, 'notes/b.txt')
    const denied = write('notes/b.txt', contextOf({ deny: { session: ['Edit(notes/**)'] } }))
    expect(denied.behavior).toBe('deny')
    expect(messageOf(denied)).toContain(resolved)
    const askedByRule = write('notes/b.txt', contextOf({ ask: { session: ['Edit(notes/**)'] } }))
    expect(summary(askedByRule)).toBe('ask rule session notes/**')
    expect(messageOf(askedByRule)).toContain(resolved)
    const askedPlain = write('notes/b.txt', contextOf())
    expect(summary(askedPlain)).toBe('ask -')
    expect(messageOf(askedPlain)).toContain(resolved)
  })

  test('a relative protected path is named by its absolute path', () => {
    const resolved = plant(current, '.git/config')
    expect(messageOf(write('.git/config', contextOf({ mode: 'acceptEdits' })))).toContain(resolved)
  })
})
