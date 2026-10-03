/**
 * Characterization of the file rule patterns: how a `Read(...)` or
 * `Edit(...)` rule's text is anchored to a directory, and which paths it
 * then covers. Black box, through the `filePermissions` barrel.
 *
 * Every test gets its own temp workspace. The session's starting directory,
 * its current directory and the config home all point inside it, so no rule
 * ever resolves against the repository or the real `~/.claudin`. The
 * `~/` cases with real files run in a child process whose `HOME` is a temp
 * dir: see `homeAnchored.characterization.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getFileReadIgnorePatterns,
  matchingRuleForInput,
  normalizePatternsToPath,
} from 'src/permissions/filePermissions.js'
import type { PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import {
  getCwdState,
  getFlagSettingsPath,
  getOriginalCwd,
  setCwdState,
  setFlagSettingsPath,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

type Rules = Partial<Record<PermissionRuleSource, string[]>>
type Behavior = 'allow' | 'deny' | 'ask'
type Kind = 'read' | 'edit'

const LIST_FOR: Record<Behavior, 'alwaysAllowRules' | 'alwaysDenyRules' | 'alwaysAskRules'> = {
  allow: 'alwaysAllowRules',
  deny: 'alwaysDenyRules',
  ask: 'alwaysAskRules',
}

function contextOf(lists: Partial<Record<Behavior, Rules>>): ToolPermissionContext {
  const base = getEmptyToolPermissionContext()
  return {
    ...base,
    alwaysAllowRules: lists.allow ?? {},
    alwaysDenyRules: lists.deny ?? {},
    alwaysAskRules: lists.ask ?? {},
  }
}

/** The text of the rule that answers, tagged with its source, or null. */
function answer(path: string, rules: Rules, kind: Kind = 'read', behavior: Behavior = 'deny'): string | null {
  const ctx = contextOf({ [behavior]: rules })
  const hit = matchingRuleForInput(path, ctx, kind, behavior)
  return hit === null ? null : `${hit.source} ${hit.ruleValue.ruleContent}`
}

// ---- workspace -----------------------------------------------------------

const saved = {
  originalCwd: '',
  cwd: '',
  flagSettings: undefined as string | undefined,
  configDir: undefined as string | undefined,
}
let ws = ''
/** The session's starting directory (`getOriginalCwd`). */
let started = ''
/** Where the session is now (`getCwd`), deliberately a different directory. */
let current = ''
/** The config home (`CLAUDIN_CONFIG_DIR`). */
let configHome = ''

beforeAll(() => {
  saved.originalCwd = getOriginalCwd()
  saved.cwd = getCwdState()
  saved.flagSettings = getFlagSettingsPath()
  saved.configDir = process.env.CLAUDIN_CONFIG_DIR
})

afterAll(() => {
  setOriginalCwd(saved.originalCwd)
  setCwdState(saved.cwd)
  setFlagSettingsPath(saved.flagSettings)
  if (saved.configDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = saved.configDir
})

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'file-rules-')))
  started = join(ws, 'started')
  current = join(ws, 'current')
  configHome = join(ws, 'config-home')
  for (const dir of [started, current, configHome]) mkdirSync(dir)
  setOriginalCwd(started)
  setCwdState(current)
  setFlagSettingsPath(undefined)
  process.env.CLAUDIN_CONFIG_DIR = configHome
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

/** Creates `rel` under `dir` as a real file and returns its absolute path. */
function plant(dir: string, rel: string): string {
  const target = join(dir, rel)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, 'x')
  return target
}

// ---- anchoring -----------------------------------------------------------

describe('where a rule pattern is anchored', () => {
  // `covers` is the directory the pattern resolves against; `misses` a
  // directory holding the same relative path that the rule must not reach.
  const cases: {
    name: string
    source: PermissionRuleSource
    rule: string
    covers: () => string
    misses: () => string
  }[] = [
    {
      name: 'a leading // is the filesystem root',
      source: 'session',
      rule: '<abs>',
      covers: () => join(ws, 'vault-parent'),
      misses: () => started,
    },
    {
      name: 'a leading / in a session rule is the starting directory, not the current one',
      source: 'session',
      rule: 'Read(/vault/**)',
      covers: () => started,
      misses: () => current,
    },
    {
      name: 'a leading / in a --allowedTools rule (cliArg) is the starting directory',
      source: 'cliArg',
      rule: 'Read(/vault/**)',
      covers: () => started,
      misses: () => current,
    },
    {
      name: 'a leading / in a command rule is the starting directory',
      source: 'command',
      rule: 'Read(/vault/**)',
      covers: () => started,
      misses: () => configHome,
    },
    {
      name: 'a leading / in project settings is the project (starting) directory',
      source: 'projectSettings',
      rule: 'Read(/vault/**)',
      covers: () => started,
      misses: () => current,
    },
    {
      name: 'a leading / in local settings is the project (starting) directory',
      source: 'localSettings',
      rule: 'Read(/vault/**)',
      covers: () => started,
      misses: () => configHome,
    },
    {
      name: 'a leading / in policy settings is the project (starting) directory',
      source: 'policySettings',
      rule: 'Read(/vault/**)',
      covers: () => started,
      misses: () => configHome,
    },
    {
      name: 'a leading / in user settings is the config home',
      source: 'userSettings',
      rule: 'Read(/vault/**)',
      covers: () => configHome,
      misses: () => started,
    },
    {
      name: 'a leading / in --settings rules, with no --settings file, is the starting directory',
      source: 'flagSettings',
      rule: 'Read(/vault/**)',
      covers: () => started,
      misses: () => current,
    },
    {
      name: 'a pattern with no anchor is relative to the current directory',
      source: 'session',
      rule: 'Read(vault/**)',
      covers: () => current,
      misses: () => started,
    },
    {
      name: 'a leading ./ is dropped, leaving an unanchored pattern',
      source: 'projectSettings',
      rule: 'Read(./vault/**)',
      covers: () => current,
      misses: () => started,
    },
  ]

  for (const c of cases) {
    test(c.name, () => {
      const rule =
        c.rule === '<abs>' ? `Read(/${join(ws, 'vault-parent', 'vault')}/**)` : c.rule
      const content = rule.slice('Read('.length, -1)
      const inside = plant(c.covers(), 'vault/key.txt')
      const elsewhere = plant(c.misses(), 'vault/key.txt')
      expect(answer(inside, { [c.source]: [rule] })).toBe(`${c.source} ${content}`)
      expect(answer(elsewhere, { [c.source]: [rule] })).toBeNull()
    })
  }

  test('a leading ~/ is the home directory', () => {
    // Matching is pure path text, so nothing under the real home is touched:
    // the directory name is random and never created. The child suite
    // repeats this with real files under a temp HOME.
    const unique = `no-such-dir-${Math.random().toString(36).slice(2)}`
    const rules = { projectSettings: [`Read(~/${unique}/**)`] }
    expect(answer(join(homedir(), unique, 'id_rsa'), rules)).toBe(
      `projectSettings ~/${unique}/**`,
    )
    expect(answer(plant(started, `${unique}/id_rsa`), rules)).toBeNull()
    expect(answer(`~/${unique}/id_rsa`, rules)).toBe(`projectSettings ~/${unique}/**`)
    const ctx = contextOf({ deny: { localSettings: [`Read(~/${unique}/**)`] } })
    expect([...getFileReadIgnorePatterns(ctx).entries()]).toEqual([
      [homedir(), [`/${unique}/**`]],
    ])
  })

  test('a leading / in --settings rules is the directory of the --settings file', () => {
    const flagsDir = join(ws, 'flags')
    mkdirSync(flagsDir)
    setFlagSettingsPath(join(flagsDir, 'extra.json'))
    const rules = { flagSettings: ['Read(/vault/**)'] }
    expect(answer(plant(flagsDir, 'vault/key.txt'), rules)).toBe('flagSettings /vault/**')
    expect(answer(plant(started, 'vault/key.txt'), rules)).toBeNull()
  })

  test('identical text in two sources: the later source keeps its anchor', () => {
    const rules = { userSettings: ['Read(/vault/**)'], session: ['Read(/vault/**)'] }
    expect(answer(plant(started, 'vault/a'), rules)).toBe('session /vault/**')
  })

  test('identical allow text in two sources: the earlier source is shadowed', () => {
    // Findings: shadowed duplicates. Kept for parity on allow rules only.
    const rules = { userSettings: ['Edit(/vault/**)'], projectSettings: ['Edit(/vault/**)'] }
    expect(answer(plant(configHome, 'vault/a'), rules, 'edit', 'allow')).toBeNull()
    expect(answer(plant(started, 'vault/a'), rules, 'edit', 'allow')).toBe(
      'projectSettings /vault/**',
    )
  })
})

// ---- what a pattern covers ----------------------------------------------

describe('what an unanchored pattern covers below the current directory', () => {
  const cases: { rule: string; path: string; covered: boolean }[] = [
    { rule: '*.pem', path: 'id.pem', covered: true },
    { rule: '*.pem', path: 'deep/er/id.pem', covered: true },
    { rule: '*.pem', path: 'id.pem.bak', covered: false },
    { rule: '*.PEM', path: 'deep/id.pem', covered: true },
    { rule: 'id.p?m', path: 'id.pem', covered: true },
    { rule: 'id.[pq]em', path: 'id.qem', covered: true },
    { rule: 'id.[pq]em', path: 'id.rem', covered: false },
    { rule: 'src/*.ts', path: 'src/a.ts', covered: true },
    { rule: 'src/*.ts', path: 'src/inner/a.ts', covered: false },
    { rule: 'src/*.ts', path: 'pkg/src/a.ts', covered: false },
    { rule: 'src/**', path: 'src/inner/a.ts', covered: true },
    // A trailing /** widens the pattern to a directory of that name at any
    // depth (findings: kept for parity).
    { rule: 'src/**', path: 'pkg/src/a.ts', covered: true },
    { rule: '**', path: 'any/where/at/all.txt', covered: true },
    { rule: '**/build/*.js', path: 'a/b/build/x.js', covered: true },
    { rule: 'secrets/', path: 'secrets/key', covered: true },
  ]

  for (const c of cases) {
    test(`${c.rule} ${c.covered ? 'covers' : 'does not cover'} ${c.path}`, () => {
      const file = plant(current, c.path)
      expect(answer(file, { session: [`Read(${c.rule})`] })).toBe(
        c.covered ? `session ${c.rule}` : null,
      )
    })
  }

  test('anchored patterns also match without regard to case', () => {
    const file = plant(started, 'Vault/Key.TXT')
    expect(answer(file, { session: ['Read(/vault/key.txt)'] })).toBe('session /vault/key.txt')
  })

  test('a later ! pattern in the same anchor exempts a path', () => {
    const rules = { session: ['Read(*.pem)', 'Read(!public.pem)'] }
    expect(answer(plant(current, 'public.pem'), rules)).toBeNull()
    expect(answer(plant(current, 'private.pem'), rules)).toBe('session *.pem')
  })

  test('dir/** covers the directory itself and reports the rule as written', () => {
    const dir = join(started, 'vault')
    mkdirSync(dir)
    expect(answer(dir, { session: ['Read(/vault/**)'] })).toBe('session /vault/**')
    expect(answer(dir, { session: ['Read(//' + dir.slice(1) + '/**)'] })).toBe(
      `session /${dir}/**`,
    )
  })

  test('an absolute pattern needs no file on disk', () => {
    expect(answer('/etc/passwd', { session: ['Read(//etc/**)'] })).toBe('session //etc/**')
    expect(answer('/etcetera/passwd', { session: ['Read(//etc/**)'] })).toBeNull()
  })
})

describe('paths a pattern never covers', () => {
  test('an unanchored pattern does not reach outside the current directory', () => {
    // The starting directory and the workspace both sit outside `current`.
    const rules = { session: ['Read(*.pem)'] }
    expect(answer(plant(started, 'id.pem'), rules)).toBeNull()
    expect(answer(plant(join(ws, 'side'), 'id.pem'), rules)).toBeNull()
  })

  test('the anchor directory itself is never covered', () => {
    expect(answer(started, { session: ['Read(/vault/**)'] })).toBeNull()
    expect(answer(current, { session: ['Read(**)'] })).toBeNull()
  })

  test('an anchored /** (the whole anchor) grants nothing as an allow rule', () => {
    // Findings: inert root-wide patterns. Pinned for allow rules only.
    const file = plant(started, 'src/a.ts')
    for (const source of ['session', 'projectSettings'] as const) {
      expect(answer(file, { [source]: ['Edit(/**)'] }, 'edit', 'allow')).toBeNull()
    }
    expect(answer(file, { session: ['Edit(//**)'] }, 'edit', 'allow')).toBeNull()
  })
})

// ---- the path argument ---------------------------------------------------

describe('the path being checked', () => {
  test('a relative path is resolved against the current directory', () => {
    plant(current, 'notes/a.pem')
    expect(answer('notes/a.pem', { session: ['Read(/notes/**)'] })).toBeNull()
    expect(answer('notes/a.pem', { session: ['Read(notes/**)'] })).toBe('session notes/**')
  })

  test('a path that does not exist is matched by its text', () => {
    expect(answer(join(current, 'ghost', 'x.pem'), { session: ['Read(*.pem)'] })).toBe(
      'session *.pem',
    )
  })
})

// ---- which rules are consulted ------------------------------------------

describe('which rules answer a query', () => {
  test('a read query consults Read rules only, an edit query Edit rules only', () => {
    const file = plant(current, 'a.txt')
    const table: { rule: string; kind: Kind; hit: boolean }[] = [
      { rule: 'Read(a.txt)', kind: 'read', hit: true },
      { rule: 'Read(a.txt)', kind: 'edit', hit: false },
      { rule: 'Edit(a.txt)', kind: 'edit', hit: true },
      { rule: 'Edit(a.txt)', kind: 'read', hit: false },
      { rule: 'Write(a.txt)', kind: 'edit', hit: false },
      { rule: 'Glob(a.txt)', kind: 'read', hit: false },
      { rule: 'Read', kind: 'read', hit: false },
      { rule: 'Edit', kind: 'edit', hit: false },
    ]
    for (const row of table) {
      expect({ ...row, got: answer(file, { session: [row.rule] }, row.kind) !== null }).toEqual({
        ...row,
        got: row.hit,
      })
    }
  })

  test('each behaviour consults only its own list', () => {
    const file = plant(current, 'a.txt')
    const ctx = contextOf({
      allow: { session: ['Read(a.*)'] },
      deny: { session: ['Read(*.txt)'] },
      ask: { session: ['Read(a.txt)'] },
    })
    const seen = (['allow', 'deny', 'ask'] as const).map(
      b => matchingRuleForInput(file, ctx, 'read', b)?.ruleValue.ruleContent ?? null,
    )
    expect(seen).toEqual(['a.*', '*.txt', 'a.txt'])
    expect(matchingRuleForInput(file, contextOf({ deny: { session: ['Read(a.txt)'] } }), 'read', 'allow')).toBeNull()
  })

  test('rules from every source are consulted', () => {
    const file = plant(current, 'a.txt')
    const sources: PermissionRuleSource[] = [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
      'cliArg',
      'command',
      'session',
    ]
    const found = sources.map(source => answer(file, { [source]: ['Edit(a.txt)'] }, 'edit', 'ask'))
    expect(found).toEqual(sources.map(source => `${source} a.txt`))
  })

  test('the answer is the whole rule: source, behaviour, tool and text', () => {
    const file = plant(current, 'a.txt')
    const ctx = contextOf({ ask: { localSettings: ['Edit(*.txt)'] } })
    expect(matchingRuleForInput(file, ctx, 'edit', 'ask')).toEqual({
      source: 'localSettings',
      ruleBehavior: 'ask',
      ruleValue: { toolName: 'Edit', ruleContent: '*.txt' },
    })
  })

  test('no rules at all answers null', () => {
    expect(matchingRuleForInput(plant(current, 'a'), getEmptyToolPermissionContext(), 'read', 'deny')).toBeNull()
  })
})

// ---- read-deny patterns for search tools ---------------------------------

describe('getFileReadIgnorePatterns', () => {
  test('groups Read deny patterns by the directory they are anchored to', () => {
    const ctx = contextOf({
      deny: {
        userSettings: ['Read(/u-secret/**)', 'Read(*.key)'],
        projectSettings: ['Read(/p-secret/**)', 'Read(./.env)'],
        session: ['Read(//var/vault/**)', 'Read(/s-secret)'],
      },
      allow: { session: ['Read(*.allowed)'] },
      ask: { session: ['Read(*.asked)'] },
    })
    expect([...getFileReadIgnorePatterns(ctx).entries()]).toEqual([
      [configHome, ['/u-secret/**']],
      [null, ['*.key', '.env']],
      [started, ['/p-secret/**', '/s-secret']],
      ['/', ['/var/vault/**']],
    ])
  })

  test('ignores Edit deny rules and collapses repeated text within an anchor', () => {
    const ctx = contextOf({
      deny: {
        projectSettings: ['Edit(*.pem)', 'Read(*.pem)'],
        session: ['Read(*.pem)', 'Edit(/x/**)'],
      },
    })
    expect([...getFileReadIgnorePatterns(ctx).entries()]).toEqual([[null, ['*.pem']]])
  })

  test('is empty with no Read deny rules', () => {
    expect(getFileReadIgnorePatterns(getEmptyToolPermissionContext()).size).toBe(0)
  })
})

describe('normalizePatternsToPath', () => {
  const cases: {
    name: string
    byRoot: [string | null, string[]][]
    root: string
    expected: string[]
  }[] = [
    {
      name: 'unanchored patterns pass through as they are',
      byRoot: [[null, ['*.env', 'secrets/**']]],
      root: '/repo',
      expected: ['*.env', 'secrets/**'],
    },
    {
      name: 'a pattern anchored at the search root keeps its text',
      byRoot: [['/repo', ['/src/a.ts']]],
      root: '/repo',
      expected: ['/src/a.ts'],
    },
    {
      name: 'a pattern anchored below the search root is prefixed with the way down',
      byRoot: [['/repo/pkg', ['/src/a.ts', '/lib/**']]],
      root: '/repo',
      expected: ['/pkg/src/a.ts', '/pkg/lib/**'],
    },
    {
      name: 'a pattern anchored above the search root that reaches into it is cut down to it',
      byRoot: [['/', ['/repo/src/**']]],
      root: '/repo',
      expected: ['/src/**'],
    },
    {
      name: 'a pattern anchored above the search root that stays outside it is dropped',
      byRoot: [['/', ['/other/**', '/repository/x']]],
      root: '/repo',
      expected: [],
    },
    {
      name: 'a pattern anchored beside the search root is dropped',
      byRoot: [['/elsewhere', ['/src/a.ts']]],
      root: '/repo',
      expected: [],
    },
    {
      name: 'unanchored patterns come first, and duplicates collapse',
      byRoot: [
        ['/repo', ['/src/a.ts', '/b']],
        [null, ['/src/a.ts', '*.pem']],
        ['/repo/pkg', ['/b']],
      ],
      root: '/repo',
      expected: ['/src/a.ts', '*.pem', '/b', '/pkg/b'],
    },
    {
      name: 'an empty map gives no patterns',
      byRoot: [],
      root: '/repo',
      expected: [],
    },
  ]

  for (const c of cases) {
    test(c.name, () => {
      expect(normalizePatternsToPath(new Map(c.byRoot), c.root)).toEqual(c.expected)
    })
  }

  test('round trip: the Read deny rules a search under the project must hide', () => {
    const ctx = contextOf({
      deny: {
        projectSettings: ['Read(/build/**)', 'Read(*.pem)'],
        session: [`Read(/${join(started, 'pkg')}/dist/**)`, 'Read(//opt/elsewhere/**)'],
      },
    })
    expect(normalizePatternsToPath(getFileReadIgnorePatterns(ctx), started)).toEqual([
      '*.pem',
      '/build/**',
      '/pkg/dist/**',
    ])
  })
})
