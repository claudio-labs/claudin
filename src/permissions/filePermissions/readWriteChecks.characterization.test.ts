/**
 * Characterization of the file read and write permission checks, and of the
 * batch variants built on them. Black box: the barrel's exports, plus
 * `checkBatchReadPermission`, which callers import from the module itself.
 *
 * Every test gets a fresh temp workspace with real files. The session's
 * starting directory (its working directory), its current directory and the
 * config home all point inside it. The config home is named `.claudin`, as
 * the real one is, so the protected-directory rules apply to it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { getPlansDirectory } from 'src/agent/plans/plans.js'
import {
  checkBatchWritePermission,
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  generateSuggestions,
} from 'src/permissions/filePermissions.js'
import { checkBatchReadPermission } from 'src/permissions/filePermissions/readWriteChecks.js'
import type { PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

type Rules = Partial<Record<PermissionRuleSource, string[]>>
type Mode = ToolPermissionContext['mode']
type Setup = { mode?: Mode; extraDirs?: string[]; allow?: Rules; deny?: Rules; ask?: Rules }

function contextOf(setup: Setup = {}): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    mode: setup.mode ?? 'default',
    additionalWorkingDirectories: new Map(
      (setup.extraDirs ?? []).map(dir => [dir, { path: dir, source: 'session' as const }]),
    ),
    alwaysAllowRules: setup.allow ?? {},
    alwaysDenyRules: setup.deny ?? {},
    alwaysAskRules: setup.ask ?? {},
  }
}

// The checks take a Tool; only `name` and `getPath` are ever looked at.
type FileInput = { file_path: string }
type Checker = (tool: unknown, input: unknown, ctx: ToolPermissionContext, paths?: readonly string[]) => PermissionDecision
const fileTool = { name: 'Edit', getPath: (input: FileInput) => input.file_path }

function readCheck(path: string, ctx: ToolPermissionContext): PermissionDecision {
  return (checkReadPermissionForTool as unknown as Checker)(fileTool, { file_path: path }, ctx)
}
function writeCheck(path: string, ctx: ToolPermissionContext, paths?: readonly string[]): PermissionDecision {
  return (checkWritePermissionForTool as unknown as Checker)(fileTool, { file_path: path }, ctx, paths)
}

/**
 * One line per decision: behaviour, reason kind, and the detail that matters
 * (the rule text, the mode, or whether a classifier may approve).
 */
function summary(decision: PermissionDecision): string {
  const reason = decision.decisionReason
  const parts: string[] = [decision.behavior, reason?.type ?? '-']
  if (reason?.type === 'rule') {
    const { toolName, ruleContent } = reason.rule.ruleValue
    parts.push(`${toolName}(${ruleContent})`)
  } else if (reason?.type === 'mode') {
    parts.push(reason.mode)
  } else if (reason?.type === 'safetyCheck') {
    parts.push(reason.classifierApprovable ? 'approvable' : 'manual')
  }
  return parts.join(' ')
}

function suggestionsOf(decision: PermissionDecision): unknown {
  return 'suggestions' in decision ? decision.suggestions : undefined
}

function messageOf(decision: PermissionDecision): string {
  return 'message' in decision && typeof decision.message === 'string' ? decision.message : ''
}

// ---- workspace -----------------------------------------------------------

const saved: Record<string, string | undefined> = {}
const globals = globalThis as { MACRO?: { VERSION?: string } }
let hadMacro = false
let suiteTmp = ''
let ws = ''
/** The session's starting directory: its working directory. */
let project = ''
/** Where the session is now: a subdirectory, so relative paths land in the project. */
let current = ''
/** A directory outside every working directory. */
let outside = ''
/** The config home, named `.claudin` as the real one is. */
let configHome = ''

beforeAll(() => {
  saved.originalCwd = getOriginalCwd()
  saved.cwd = getCwdState()
  saved.CLAUDIN_CONFIG_DIR = process.env.CLAUDIN_CONFIG_DIR
  saved.CLAUDIN_TMPDIR = process.env.CLAUDIN_TMPDIR
  // The read check reaches the bundled-skills root, which embeds the
  // build-time version.
  hadMacro = globals.MACRO !== undefined
  globals.MACRO ??= { VERSION: 'characterization' }
  suiteTmp = realpathSync(mkdtempSync(join(tmpdir(), 'rw-checks-suite-')))
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
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'rw-checks-')))
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

/** `Read(//abs/dir/**)`-style rule text for an absolute directory. */
function under(tool: 'Read' | 'Edit', dir: string): string {
  return `${tool}(/${dir}/**)`
}

// ---- read ----------------------------------------------------------------

describe('checkReadPermissionForTool', () => {
  test('a tool that exposes no path is asked about by name', () => {
    const decision = (checkReadPermissionForTool as unknown as Checker)(
      { name: 'PathlessProbe' },
      { file_path: '/x' },
      contextOf({ mode: 'bypassPermissions', allow: { session: ['Read(**)'] } }),
    )
    expect(summary(decision)).toBe('ask -')
    expect(messageOf(decision)).toContain('PathlessProbe')
    expect(suggestionsOf(decision)).toBeUndefined()
  })

  type Row = { name: string; file: 'project' | 'outside' | 'config'; setup: () => Setup; expected: string }
  const rows: Row[] = [
    {
      name: 'a Read deny beats a Read allow',
      file: 'outside',
      setup: () => ({ allow: { session: ['Read(**)', under('Read', outside)] }, deny: { userSettings: [under('Read', outside)] } }),
      expected: 'deny rule Read(<outside>)',
    },
    {
      name: 'a Read deny beats the working directory',
      file: 'project',
      setup: () => ({ deny: { projectSettings: ['Read(/src/**)'] } }),
      expected: 'deny rule Read(/src/**)',
    },
    {
      name: 'a Read deny beats an Edit allow',
      file: 'outside',
      setup: () => ({ allow: { session: [under('Edit', outside)] }, deny: { session: [under('Read', outside)] } }),
      expected: 'deny rule Read(<outside>)',
    },
    {
      name: 'a Read deny beats acceptEdits',
      file: 'project',
      setup: () => ({ mode: 'acceptEdits', deny: { localSettings: ['Read(/src/**)'] } }),
      expected: 'deny rule Read(/src/**)',
    },
    {
      name: 'a Read deny beats a Read ask',
      file: 'project',
      setup: () => ({ ask: { session: ['Read(/src/**)'] }, deny: { session: ['Read(/src/app.ts)'] } }),
      expected: 'deny rule Read(/src/app.ts)',
    },
    {
      name: 'a Read ask beats the working directory',
      file: 'project',
      setup: () => ({ ask: { session: ['Read(/src/**)'] } }),
      expected: 'ask rule Read(/src/**)',
    },
    {
      name: 'a Read ask beats an Edit allow',
      file: 'outside',
      setup: () => ({ allow: { session: [under('Edit', outside)] }, ask: { session: [under('Read', outside)] } }),
      expected: 'ask rule Read(<outside>)',
    },
    {
      name: 'a Read ask beats a Read allow',
      file: 'outside',
      setup: () => ({ allow: { session: [under('Read', outside)] }, ask: { cliArg: [`Read(/${outside}/notes.ts)`] } }),
      expected: 'ask rule Read(<outside-file>)',
    },
    {
      name: 'an Edit deny does not stop a read',
      file: 'project',
      setup: () => ({ deny: { session: ['Edit(/src/**)'] } }),
      expected: 'allow mode default',
    },
    {
      name: 'an Edit ask does not make a read ask',
      file: 'outside',
      setup: () => ({ ask: { session: [under('Edit', outside)] }, allow: { session: [under('Read', outside)] } }),
      expected: 'allow rule Read(<outside>)',
    },
    {
      name: 'an Edit allow grants the read, citing the Edit rule',
      file: 'outside',
      setup: () => ({ allow: { session: [under('Edit', outside)] } }),
      expected: 'allow rule Edit(<outside>)',
    },
    {
      name: 'acceptEdits in the working directory grants the read through the write check',
      file: 'project',
      setup: () => ({ mode: 'acceptEdits' }),
      expected: 'allow mode acceptEdits',
    },
    {
      name: 'the working directory grants the read in default mode',
      file: 'project',
      setup: () => ({}),
      expected: 'allow mode default',
    },
    {
      name: 'the working directory reason names default mode whatever the mode is',
      file: 'project',
      setup: () => ({ mode: 'plan' }),
      expected: 'allow mode default',
    },
    {
      name: 'an additional working directory grants the read',
      file: 'outside',
      setup: () => ({ extraDirs: [outside] }),
      expected: 'allow mode default',
    },
    {
      name: 'a Read allow grants a read outside the working directories',
      file: 'outside',
      setup: () => ({ allow: { flagSettings: [under('Read', outside)] } }),
      expected: 'allow rule Read(<outside>)',
    },
    {
      name: 'bypassPermissions is not applied here: outside still asks',
      file: 'outside',
      setup: () => ({ mode: 'bypassPermissions' }),
      expected: 'ask workingDir',
    },
    {
      name: 'outside every working directory and rule, the read asks',
      file: 'outside',
      setup: () => ({ allow: { session: ['Read(/elsewhere/**)'] } }),
      expected: 'ask workingDir',
    },
    {
      name: 'a harness-owned file (the config home task list) is readable',
      file: 'config',
      setup: () => ({}),
      expected: 'allow other',
    },
    {
      name: 'a Read deny beats a harness-owned file',
      file: 'config',
      setup: () => ({ deny: { session: [under('Read', configHome)] } }),
      expected: 'deny rule Read(<config>)',
    },
  ]

  for (const row of rows) {
    test(row.name, () => {
      const file =
        row.file === 'project'
          ? plant(project, 'src/app.ts')
          : row.file === 'outside'
            ? plant(outside, 'notes.ts')
            : plant(configHome, 'tasks/list.json')
      const expected = row.expected
        .replace('<outside-file>', `/${outside}/notes.ts`)
        .replace('<outside>', `/${outside}/**`)
        .replace('<config>', `/${configHome}/**`)
      expect(summary(readCheck(file, contextOf(row.setup())))).toBe(expected)
    })
  }

  test('an allow hands back the input it was given', () => {
    const file = plant(project, 'src/app.ts')
    const input = { file_path: file, extra: 1 }
    for (const ctx of [contextOf(), contextOf({ mode: 'acceptEdits' })]) {
      const decision = (checkReadPermissionForTool as unknown as Checker)(fileTool, input, ctx)
      expect(decision.behavior === 'allow' && decision.updatedInput).toBe(input)
    }
    const outsideFile = plant(outside, 'a.txt')
    const viaRule = (checkReadPermissionForTool as unknown as Checker)(
      fileTool,
      { file_path: outsideFile },
      contextOf({ allow: { session: [under('Read', outside)] } }),
    )
    expect(viaRule.behavior === 'allow' && viaRule.updatedInput).toEqual({ file_path: outsideFile })
  })

  test('a relative path is resolved against the current directory', () => {
    const file = plant(current, 'notes/a.txt')
    const denied = readCheck('notes/a.txt', contextOf({ deny: { session: [under('Read', join(current, 'notes'))] } }))
    expect(summary(denied)).toBe(`deny rule Read(/${join(current, 'notes')}/**)`)
    expect(messageOf(denied)).toContain(file)
  })

  test('the deny and ask messages name the path and the operation', () => {
    const file = plant(outside, 'a.txt')
    const denied = messageOf(readCheck(file, contextOf({ deny: { session: [under('Read', outside)] } })))
    expect(denied).toContain(file)
    expect(denied).toMatch(/\bread\b/)
    expect(denied).toMatch(/denied/)
    for (const ctx of [contextOf(), contextOf({ ask: { session: [under('Read', outside)] } })]) {
      const asked = messageOf(readCheck(file, ctx))
      expect(asked).toContain(file)
      expect(asked).toMatch(/\bread\b/)
    }
  })

  test('outside the working directories, the ask suggests a session Read rule for the directory', () => {
    const file = plant(outside, 'deep/a.txt')
    expect(suggestionsOf(readCheck(file, contextOf()))).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Read', ruleContent: `/${join(outside, 'deep')}/**` }],
        behavior: 'allow',
        destination: 'session',
      },
    ])
    // A directory is its own suggestion.
    expect(suggestionsOf(readCheck(join(outside, 'deep'), contextOf()))).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Read', ruleContent: `/${join(outside, 'deep')}/**` }],
        behavior: 'allow',
        destination: 'session',
      },
    ])
  })

  test('a rule-backed ask carries no suggestions', () => {
    const file = plant(outside, 'a.txt')
    expect(suggestionsOf(readCheck(file, contextOf({ ask: { session: [under('Read', outside)] } })))).toBeUndefined()
  })

  describe('symbolic links', () => {
    test('a Read deny on the target catches a link inside the project', () => {
      const secret = plant(outside, 'vault/key')
      const link = join(project, 'key-link')
      symlinkSync(secret, link)
      const decision = readCheck(link, contextOf({ deny: { session: [under('Read', join(outside, 'vault'))] } }))
      expect(summary(decision)).toBe(`deny rule Read(/${join(outside, 'vault')}/**)`)
      expect(messageOf(decision)).toContain(link)
    })

    test('a Read deny on a hop in the middle of a chain catches it', () => {
      const end = plant(project, 'end.txt')
      const middle = join(outside, 'middle')
      symlinkSync(end, middle)
      const start = join(project, 'start')
      symlinkSync(middle, start)
      expect(summary(readCheck(start, contextOf({ deny: { session: [`Read(/${middle})`] } })))).toBe(
        `deny rule Read(/${middle})`,
      )
    })

    test('a Read deny on the link itself catches it, whatever it points to', () => {
      const target = plant(project, 'plain.txt')
      const link = join(outside, 'denied', 'link')
      mkdirSync(dirname(link))
      symlinkSync(target, link)
      expect(summary(readCheck(link, contextOf({ deny: { session: [under('Read', join(outside, 'denied'))] } })))).toBe(
        `deny rule Read(/${join(outside, 'denied')}/**)`,
      )
    })

    test('a dangling link is checked against where it would land', () => {
      const link = join(project, 'dangling')
      symlinkSync(join(outside, 'vault', 'not-yet'), link)
      mkdirSync(join(outside, 'vault'))
      expect(summary(readCheck(link, contextOf({ deny: { session: [under('Read', join(outside, 'vault'))] } })))).toBe(
        `deny rule Read(/${join(outside, 'vault')}/**)`,
      )
    })

    test('a link inside the project that leaves it is not covered by the working directory', () => {
      const link = join(project, 'escape')
      symlinkSync(plant(outside, 'a.txt'), link)
      expect(summary(readCheck(link, contextOf()))).toBe('ask workingDir')
    })

    test('a symlinked directory outside suggests both its spellings', () => {
      const real = join(outside, 'real')
      mkdirSync(real)
      const alias = join(outside, 'alias')
      symlinkSync(real, alias)
      plant(real, 'a.txt')
      expect(suggestionsOf(readCheck(join(alias, 'a.txt'), contextOf()))).toEqual(
        [alias, real].map(dir => ({
          type: 'addRules',
          rules: [{ toolName: 'Read', ruleContent: `/${dir}/**` }],
          behavior: 'allow',
          destination: 'session',
        })),
      )
    })

    test('a Read allow is matched on the requested path only, not the link target', () => {
      // Findings: allow rules do not follow links. Kept for parity.
      const allowed = join(outside, 'allowed')
      mkdirSync(allowed)
      const link = join(allowed, 'link')
      symlinkSync(plant(ws, 'private/elsewhere.txt'), link)
      expect(summary(readCheck(link, contextOf({ allow: { session: [under('Read', allowed)] } })))).toBe(
        `allow rule Read(/${allowed}/**)`,
      )
    })
  })

  describe('paths that always need a person', () => {
    const shapes: { name: string; make: () => string; fact: RegExp }[] = [
      { name: 'an 8.3 short name', make: () => plant(project, 'GIT~1/config'), fact: /Windows/ },
      { name: 'a trailing dot', make: () => plant(project, 'notes.txt.'), fact: /Windows/ },
      { name: 'a DOS device suffix', make: () => plant(project, 'report.CON'), fact: /Windows/ },
      { name: 'a component of three dots', make: () => plant(project, '.../x.txt'), fact: /Windows/ },
      {
        name: 'a link to a UNC path',
        make: () => {
          const link = join(project, 'share-link')
          symlinkSync('//fileserver/share/doc.txt', link)
          return link
        },
        fact: /UNC/,
      },
    ]

    for (const shape of shapes) {
      test(`${shape.name} asks, even in the working directory and under a Read allow`, () => {
        const path = shape.make()
        const decision = readCheck(path, contextOf({ mode: 'acceptEdits', allow: { session: ['Read(**)', 'Edit(**)'] } }))
        expect(summary(decision)).toBe('ask other')
        expect(messageOf(decision)).toContain(path)
        expect(messageOf(decision)).toMatch(shape.fact)
        expect(suggestionsOf(decision)).toBeUndefined()
      })
    }
  })
})

// ---- write ---------------------------------------------------------------

describe('checkWritePermissionForTool', () => {
  test('a tool that exposes no path is asked about by name', () => {
    const decision = (checkWritePermissionForTool as unknown as Checker)(
      { name: 'PathlessProbe' },
      {},
      contextOf({ mode: 'acceptEdits', allow: { session: ['Edit(**)'] } }),
    )
    expect(summary(decision)).toBe('ask -')
    expect(messageOf(decision)).toContain('PathlessProbe')
  })

  type Row = { name: string; file: () => string; setup: () => Setup; expected: string }
  const inProject = () => plant(project, 'src/app.ts')
  const inOutside = () => plant(outside, 'notes.ts')
  const projectClaudin = (rel: string) => () => plant(project, join('.claudin', rel))
  const rows: Row[] = [
    {
      name: 'an Edit deny beats acceptEdits in the working directory',
      file: inProject,
      setup: () => ({ mode: 'acceptEdits', deny: { projectSettings: ['Edit(/src/**)'] } }),
      expected: 'deny rule Edit(/src/**)',
    },
    {
      name: 'an Edit deny beats an Edit allow',
      file: inOutside,
      setup: () => ({ allow: { session: ['Edit(**)', under('Edit', outside)] }, deny: { userSettings: [`Edit(/${outside}/notes.ts)`] } }),
      expected: 'deny rule Edit(<outside-file>)',
    },
    {
      name: 'an Edit deny beats an Edit ask',
      file: inProject,
      setup: () => ({ ask: { session: ['Edit(/src/app.ts)'] }, deny: { session: ['Edit(/src/**)'] } }),
      expected: 'deny rule Edit(/src/**)',
    },
    {
      name: 'an Edit deny beats the session plan file',
      file: () => plant(getPlansDirectory(), 'draft.md'),
      setup: () => ({ deny: { session: [under('Edit', getPlansDirectory())] } }),
      expected: 'deny rule Edit(<plans>)',
    },
    {
      name: 'an Edit deny beats a session grant on .claudin',
      file: projectClaudin('settings.json'),
      setup: () => ({ allow: { session: ['Edit(/.claudin/**)'] }, deny: { localSettings: ['Edit(/.claudin/settings.json)'] } }),
      expected: 'deny rule Edit(/.claudin/settings.json)',
    },
    {
      name: 'a Read deny does not stop a write',
      file: inProject,
      setup: () => ({ mode: 'acceptEdits', deny: { session: ['Read(/src/**)'] } }),
      expected: 'allow mode acceptEdits',
    },
    {
      name: 'the session plan file is writable though .claudin is protected',
      file: () => plant(getPlansDirectory(), 'draft.md'),
      setup: () => ({}),
      expected: 'allow other',
    },
    {
      name: 'a file below the plans directory is not a plan file',
      file: () => plant(getPlansDirectory(), 'nested/draft.md'),
      setup: () => ({ mode: 'acceptEdits' }),
      expected: 'ask safetyCheck approvable',
    },
    {
      name: 'the project preview launch config is writable',
      file: projectClaudin('launch.json'),
      setup: () => ({}),
      expected: 'allow other',
    },
    {
      name: 'a session grant on /.claudin/** opens the project .claudin',
      file: projectClaudin('settings.json'),
      setup: () => ({ allow: { session: ['Edit(/.claudin/**)'] } }),
      expected: 'allow rule Edit(/.claudin/**)',
    },
    {
      name: 'a session grant narrowed to one skill opens that skill',
      file: projectClaudin('skills/tidy/SKILL.md'),
      setup: () => ({ allow: { session: ['Edit(/.claudin/skills/tidy/**)'] } }),
      expected: 'allow rule Edit(/.claudin/skills/tidy/**)',
    },
    {
      name: 'the same grant from project settings does not open .claudin',
      file: projectClaudin('skills/tidy/SKILL.md'),
      setup: () => ({ allow: { projectSettings: ['Edit(/.claudin/**)'] } }),
      expected: 'ask safetyCheck approvable',
    },
    {
      name: 'a session grant whose text holds .. does not open .claudin',
      file: projectClaudin('skills/v2..beta/SKILL.md'),
      setup: () => ({ allow: { session: ['Edit(/.claudin/skills/v2..beta/**)'] } }),
      expected: 'ask safetyCheck approvable',
    },
    {
      name: 'a session grant on one .claudin file (no /**) does not open it',
      file: projectClaudin('settings.json'),
      setup: () => ({ allow: { session: ['Edit(/.claudin/settings.json)'] } }),
      expected: 'ask safetyCheck approvable',
    },
    {
      name: 'a broad session grant not written under .claudin does not open it',
      file: projectClaudin('settings.json'),
      setup: () => ({ allow: { session: ['Edit(**)', `Edit(/${project}/**)`] } }),
      expected: 'ask safetyCheck approvable',
    },
    {
      name: '.git is protected even under acceptEdits and an Edit allow',
      file: () => plant(project, '.git/config'),
      setup: () => ({ mode: 'acceptEdits', allow: { session: ['Edit(**)'] } }),
      expected: 'ask safetyCheck approvable',
    },
    {
      name: 'a shell profile is protected',
      file: () => plant(project, '.bashrc'),
      setup: () => ({ mode: 'acceptEdits' }),
      expected: 'ask safetyCheck approvable',
    },
    {
      name: 'a suspicious Windows shape needs a person, not a classifier',
      file: () => plant(project, 'notes.txt.'),
      setup: () => ({ mode: 'acceptEdits', allow: { session: ['Edit(**)'] } }),
      expected: 'ask safetyCheck manual',
    },
    {
      name: 'an Edit ask beats acceptEdits',
      file: inProject,
      setup: () => ({ mode: 'acceptEdits', ask: { command: ['Edit(/src/**)'] } }),
      expected: 'ask rule Edit(/src/**)',
    },
    {
      name: 'an Edit ask beats an Edit allow',
      file: inOutside,
      setup: () => ({ allow: { session: [under('Edit', outside)] }, ask: { session: [`Edit(/${outside}/notes.ts)`] } }),
      expected: 'ask rule Edit(<outside-file>)',
    },
    {
      name: 'acceptEdits allows a write in the working directory',
      file: inProject,
      setup: () => ({ mode: 'acceptEdits' }),
      expected: 'allow mode acceptEdits',
    },
    {
      name: 'acceptEdits allows a write in an additional working directory',
      file: inOutside,
      setup: () => ({ mode: 'acceptEdits', extraDirs: [outside] }),
      expected: 'allow mode acceptEdits',
    },
    {
      name: 'acceptEdits does not reach outside the working directories',
      file: inOutside,
      setup: () => ({ mode: 'acceptEdits' }),
      expected: 'ask workingDir',
    },
    {
      name: 'an Edit allow grants a write outside the working directories',
      file: inOutside,
      setup: () => ({ allow: { policySettings: [under('Edit', outside)] } }),
      expected: `allow rule Edit(<outside>)`,
    },
    {
      name: 'default mode asks in the working directory, with no reason',
      file: inProject,
      setup: () => ({}),
      expected: 'ask -',
    },
    ...(['plan', 'bypassPermissions', 'auto', 'dontAsk'] as const).map(mode => ({
      name: `${mode} mode is not applied here: the working directory still asks`,
      file: inProject,
      setup: () => ({ mode }),
      expected: 'ask -',
    })),
    {
      name: 'outside every working directory and rule, the write asks',
      file: inOutside,
      setup: () => ({}),
      expected: 'ask workingDir',
    },
  ]

  for (const row of rows) {
    test(row.name, () => {
      const expected = row.expected
        .replace('<outside-file>', `/${outside}/notes.ts`)
        .replace('<outside>', `/${outside}/**`)
        .replace('<plans>', `/${getPlansDirectory()}/**`)
      expect(summary(writeCheck(row.file(), contextOf(row.setup())))).toBe(expected)
    })
  }

  test('an allow hands back the input it was given', () => {
    const file = plant(project, 'src/app.ts')
    const input = { file_path: file, content: 'y' }
    const decision = (checkWritePermissionForTool as unknown as Checker)(fileTool, input, contextOf({ mode: 'acceptEdits' }))
    expect(decision.behavior === 'allow' && decision.updatedInput).toBe(input)
  })

  test('the deny and ask messages name the path and the operation', () => {
    const file = plant(outside, 'a.txt')
    const denied = messageOf(writeCheck(file, contextOf({ deny: { session: [under('Edit', outside)] } })))
    expect(denied).toContain(file)
    expect(denied).toMatch(/\bedit\b/)
    expect(denied).toMatch(/denied/)
    for (const ctx of [contextOf(), contextOf({ ask: { session: [under('Edit', outside)] } })]) {
      const asked = messageOf(writeCheck(file, ctx))
      expect(asked).toContain(file)
      expect(asked).toMatch(/\bwrite\b/)
    }
    const relative = messageOf(writeCheck('notes/b.txt', contextOf({ deny: { session: ['Edit(notes/**)'] } })))
    expect(relative).toContain('notes/b.txt')
  })

  test('a safety ask carries the check message as its reason', () => {
    const file = plant(project, '.git/config')
    const decision = writeCheck(file, contextOf({ mode: 'acceptEdits' }))
    expect(decision.decisionReason).toEqual({
      type: 'safetyCheck',
      reason: messageOf(decision),
      classifierApprovable: true,
    })
    expect(messageOf(decision)).toContain(file)
  })

  test('caller-supplied resolved paths are what the deny and ask rules see', () => {
    const file = plant(project, 'src/app.ts')
    const hidden = plant(outside, 'secret.txt')
    const deny = contextOf({ mode: 'acceptEdits', deny: { session: [under('Edit', outside)] } })
    expect(summary(writeCheck(file, deny, [file, hidden]))).toBe(`deny rule Edit(/${outside}/**)`)
    expect(messageOf(writeCheck(file, deny, [file, hidden]))).toContain(file)
    const ask = contextOf({ mode: 'acceptEdits', ask: { session: [under('Edit', outside)] } })
    expect(summary(writeCheck(file, ask, [file, hidden]))).toBe(`ask rule Edit(/${outside}/**)`)
    // and the working directory test: one of them is outside
    expect(summary(writeCheck(file, contextOf({ mode: 'acceptEdits' }), [file, hidden]))).toBe('ask workingDir')
  })

  describe('suggestions', () => {
    const setMode = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }

    test('a protected file under a project skill suggests a session grant for that skill only', () => {
      const file = plant(project, '.claudin/skills/tidy/references/a.md')
      expect(suggestionsOf(writeCheck(file, contextOf()))).toEqual([
        {
          type: 'addRules',
          rules: [{ toolName: 'Edit', ruleContent: '/.claudin/skills/tidy/**' }],
          behavior: 'allow',
          destination: 'session',
        },
      ])
    })

    test('a protected file under a config-home skill suggests a home-anchored grant', () => {
      const file = plant(configHome, 'skills/tidy/SKILL.md')
      expect(suggestionsOf(writeCheck(file, contextOf()))).toEqual([
        {
          type: 'addRules',
          rules: [{ toolName: 'Edit', ruleContent: '~/.claudin/skills/tidy/**' }],
          behavior: 'allow',
          destination: 'session',
        },
      ])
    })

    test('any other protected file gets the ordinary suggestions', () => {
      expect(suggestionsOf(writeCheck(plant(project, '.git/HEAD'), contextOf()))).toEqual([setMode])
      expect(suggestionsOf(writeCheck(plant(project, '.git/HEAD'), contextOf({ mode: 'acceptEdits' })))).toEqual([])
      expect(suggestionsOf(writeCheck(plant(outside, '.zshrc'), contextOf()))).toEqual([
        setMode,
        { type: 'addDirectories', directories: [outside], destination: 'session' },
      ])
    })

    test('an ordinary ask suggests acceptEdits, and the directory when outside', () => {
      expect(suggestionsOf(writeCheck(plant(project, 'a.ts'), contextOf()))).toEqual([setMode])
      expect(suggestionsOf(writeCheck(plant(outside, 'deep/a.ts'), contextOf()))).toEqual([
        setMode,
        { type: 'addDirectories', directories: [join(outside, 'deep')], destination: 'session' },
      ])
    })

    test('a rule-backed ask carries no suggestions', () => {
      const decision = writeCheck(plant(project, 'a.ts'), contextOf({ ask: { session: ['Edit(/a.ts)'] } }))
      expect(suggestionsOf(decision)).toBeUndefined()
    })
  })

  describe('symbolic links', () => {
    test('an Edit deny on the target catches a link inside the project', () => {
      const link = join(project, 'link')
      symlinkSync(plant(outside, 'vault/key'), link)
      expect(summary(writeCheck(link, contextOf({ mode: 'acceptEdits', deny: { session: [under('Edit', join(outside, 'vault'))] } })))).toBe(
        `deny rule Edit(/${join(outside, 'vault')}/**)`,
      )
    })

    test('an Edit ask on the target catches a link inside the project', () => {
      const link = join(project, 'link')
      symlinkSync(plant(outside, 'vault/key'), link)
      expect(summary(writeCheck(link, contextOf({ mode: 'acceptEdits', ask: { session: [under('Edit', join(outside, 'vault'))] } })))).toBe(
        `ask rule Edit(/${join(outside, 'vault')}/**)`,
      )
    })

    test('a new file through a dangling link is checked where it would land', () => {
      mkdirSync(join(outside, 'vault'))
      const link = join(project, 'new-file')
      symlinkSync(join(outside, 'vault', 'created-later'), link)
      expect(summary(writeCheck(link, contextOf({ mode: 'acceptEdits' })))).toBe('ask workingDir')
      expect(summary(writeCheck(link, contextOf({ deny: { session: [under('Edit', join(outside, 'vault'))] } })))).toBe(
        `deny rule Edit(/${join(outside, 'vault')}/**)`,
      )
    })

    test('a link to a protected file is protected', () => {
      const link = join(project, 'innocent.txt')
      symlinkSync(plant(project, '.git/config'), link)
      expect(summary(writeCheck(link, contextOf({ mode: 'acceptEdits' })))).toBe('ask safetyCheck approvable')
    })

    test('an Edit allow is matched on the requested path only, not the link target', () => {
      // Findings: allow rules do not follow links. Kept for parity.
      const allowed = join(outside, 'allowed')
      mkdirSync(allowed)
      const link = join(allowed, 'link')
      symlinkSync(plant(ws, 'private/elsewhere.txt'), link)
      expect(summary(writeCheck(link, contextOf({ allow: { session: [under('Edit', allowed)] } })))).toBe(
        `allow rule Edit(/${allowed}/**)`,
      )
    })
  })
})

// ---- suggestions ---------------------------------------------------------

describe('generateSuggestions', () => {
  const setMode = { type: 'setMode', mode: 'acceptEdits', destination: 'session' } as const
  type Op = 'read' | 'write' | 'create'
  const rows: { op: Op; mode: Mode; where: 'inside' | 'outside'; expected: 'setMode' | 'readRule' | 'dirs' | 'setMode+dirs' | 'none' }[] = [
    { op: 'read', mode: 'default', where: 'inside', expected: 'setMode' },
    { op: 'read', mode: 'plan', where: 'inside', expected: 'setMode' },
    { op: 'read', mode: 'acceptEdits', where: 'inside', expected: 'none' },
    { op: 'read', mode: 'auto', where: 'inside', expected: 'none' },
    { op: 'read', mode: 'default', where: 'outside', expected: 'readRule' },
    { op: 'read', mode: 'bypassPermissions', where: 'outside', expected: 'readRule' },
    { op: 'write', mode: 'default', where: 'inside', expected: 'setMode' },
    { op: 'write', mode: 'plan', where: 'outside', expected: 'setMode+dirs' },
    { op: 'write', mode: 'acceptEdits', where: 'outside', expected: 'dirs' },
    { op: 'write', mode: 'bypassPermissions', where: 'inside', expected: 'none' },
    { op: 'write', mode: 'auto', where: 'outside', expected: 'dirs' },
    { op: 'create', mode: 'default', where: 'outside', expected: 'setMode+dirs' },
    { op: 'create', mode: 'dontAsk', where: 'inside', expected: 'none' },
  ]

  for (const row of rows) {
    test(`${row.op} ${row.where} in ${row.mode} mode: ${row.expected}`, () => {
      const file = plant(row.where === 'inside' ? project : outside, 'dir/a.txt')
      const dir = dirname(file)
      const dirs = { type: 'addDirectories', directories: [dir], destination: 'session' } as const
      const readRule = {
        type: 'addRules',
        rules: [{ toolName: 'Read', ruleContent: `/${dir}/**` }],
        behavior: 'allow',
        destination: 'session',
      } as const
      const byName: Record<typeof row.expected, unknown[]> = {
        setMode: [setMode],
        readRule: [readRule],
        dirs: [dirs],
        'setMode+dirs': [setMode, dirs],
        none: [],
      }
      const actual: unknown[] = generateSuggestions(file, row.op, contextOf({ mode: row.mode }))
      expect(actual).toEqual(byName[row.expected])
    })
  }

  test('a read of a file at the filesystem root suggests nothing: / is too broad', () => {
    expect(generateSuggestions('/no-such-file-at-root.txt', 'read', contextOf())).toStrictEqual([])
  })

  test('a directory outside is suggested as itself', () => {
    const dir = join(outside, 'tree')
    mkdirSync(dir)
    expect(generateSuggestions(dir, 'create', contextOf())).toEqual([
      setMode,
      { type: 'addDirectories', directories: [dir], destination: 'session' },
    ])
  })

  test('a symlinked directory outside is suggested in both spellings', () => {
    const real = join(outside, 'real')
    mkdirSync(real)
    const alias = join(outside, 'alias')
    symlinkSync(real, alias)
    expect(generateSuggestions(join(alias, 'new.txt'), 'write', contextOf({ mode: 'acceptEdits' }))).toEqual([
      { type: 'addDirectories', directories: [alias, real], destination: 'session' },
    ])
  })

  test('caller-supplied resolved paths decide inside or outside', () => {
    const file = plant(project, 'a.txt')
    const elsewhere = plant(outside, 'b.txt')
    expect(generateSuggestions(file, 'write', contextOf(), [file, elsewhere])).toEqual([
      setMode,
      { type: 'addDirectories', directories: [project], destination: 'session' },
    ])
  })
})

// ---- batches -------------------------------------------------------------

function listedPaths(message: string): string[] {
  return message.split('\n').slice(1)
}

describe('checkBatchWritePermission', () => {
  test('an empty batch is allowed', () => {
    expect(checkBatchWritePermission('ApplyPatch', [], contextOf())).toEqual({
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'other', reason: 'batch allow' },
    })
  })

  test('bypassPermissions allows the batch outright', () => {
    const a = plant(outside, 'a.txt')
    expect(checkBatchWritePermission('ApplyPatch', [a], contextOf({ mode: 'bypassPermissions' }))).toEqual({
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'mode', mode: 'bypassPermissions' },
    })
  })

  test('a batch every file of which is allowed is allowed', () => {
    const files = [plant(project, 'a.ts'), plant(project, 'b.ts'), plant(outside, 'c.ts')]
    const ctx = contextOf({ mode: 'acceptEdits', allow: { session: [under('Edit', outside)] } })
    expect(checkBatchWritePermission('Rename', files, ctx)).toEqual({
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'other', reason: 'batch allow' },
    })
  })

  test('one denied file denies the batch, naming only the denied files', () => {
    const ok = plant(project, 'ok.ts')
    const asked = plant(outside, 'asked.ts')
    const deniedA = plant(project, 'locked/a.ts')
    const deniedB = plant(project, 'locked/b.ts')
    const ctx = contextOf({ mode: 'acceptEdits', deny: { session: ['Edit(/locked/**)'] } })
    const decision = checkBatchWritePermission('ApplyPatch', [ok, deniedA, asked, deniedB], ctx)
    expect(summary(decision)).toBe('deny other')
    expect(decision.decisionReason).toEqual({ type: 'other', reason: 'batch deny' })
    expect(messageOf(decision)).toMatch(/denied/)
    expect(listedPaths(messageOf(decision))).toEqual([`  - ${deniedA}`, `  - ${deniedB}`])
  })

  test('files that ask make one ask for the batch, naming them and their count', () => {
    const ok = plant(project, 'ok.ts')
    const askA = plant(outside, 'a.ts')
    const askB = plant(project, '.git/config')
    const decision = checkBatchWritePermission('ApplyPatch', [askA, ok, askB], contextOf({ mode: 'acceptEdits' }), { confirmThreshold: 2 })
    expect(decision.decisionReason).toEqual({ type: 'other', reason: 'batch ask' })
    expect(decision.behavior).toBe('ask')
    expect(messageOf(decision).split('\n')[0]).toMatch(/\b2 files\b/)
    expect(messageOf(decision).split('\n')[0]).toMatch(/\bwrite\b/)
    expect(listedPaths(messageOf(decision))).toEqual([`  - ${askA}`, `  - ${askB}`])
    const single = checkBatchWritePermission('ApplyPatch', [askA], contextOf({ mode: 'acceptEdits' }))
    expect(messageOf(single).split('\n')[0]).toMatch(/\b1 file\b(?!s)/)
  })

  test('a batch at or over the confirm threshold asks even when every file is allowed', () => {
    const files = [plant(project, 'a.ts'), plant(project, 'b.ts'), plant(project, 'c.ts')]
    const ctx = contextOf({ mode: 'acceptEdits' })
    const decision = checkBatchWritePermission('Rename', files, ctx, { confirmThreshold: 3 })
    expect(decision.behavior).toBe('ask')
    expect(decision.decisionReason).toEqual({ type: 'other', reason: 'batch threshold' })
    const head = messageOf(decision).split('\n')[0] ?? ''
    expect(head).toMatch(/\b3 files\b/)
    expect(head).toMatch(/threshold 3\b/)
    expect(listedPaths(messageOf(decision))).toEqual(files.map(f => `  - ${f}`))
    const one = checkBatchWritePermission('Rename', [files[0]!], ctx, { confirmThreshold: 1 })
    expect(messageOf(one).split('\n')[0]).toMatch(/\b1 file\b(?!s)/)
  })

  test('below the threshold, or with a threshold of zero or none, an allowed batch is allowed', () => {
    const files = [plant(project, 'a.ts'), plant(project, 'b.ts')]
    const ctx = contextOf({ mode: 'acceptEdits' })
    for (const options of [{ confirmThreshold: 3 }, { confirmThreshold: 0 }, { confirmThreshold: -1 }, {}, undefined]) {
      expect(checkBatchWritePermission('Rename', files, ctx, options).behavior).toBe('allow')
    }
  })

  test('the threshold does not apply under bypassPermissions', () => {
    const files = [plant(project, 'a.ts'), plant(project, 'b.ts')]
    expect(checkBatchWritePermission('Rename', files, contextOf({ mode: 'bypassPermissions' }), { confirmThreshold: 1 }).behavior).toBe('allow')
  })
})

describe('checkBatchReadPermission', () => {
  test('an empty or fully allowed batch is allowed, handing back the real input', () => {
    const input = { file_paths: ['x'] }
    for (const paths of [[], [plant(project, 'a.ts'), plant(current, 'b.ts')]]) {
      const decision = checkBatchReadPermission('Read', paths, input, contextOf())
      expect(decision).toEqual({
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'other', reason: 'batch allow' },
      })
      expect(decision.behavior === 'allow' && decision.updatedInput).toBe(input)
    }
  })

  test('one denied file denies the batch with the first denial\'s reason, naming only denied files', () => {
    const ok = plant(project, 'ok.ts')
    const asked = plant(outside, 'asked.ts')
    const deniedA = plant(project, 'locked/a.ts')
    const deniedB = plant(project, 'vault/b.ts')
    const ctx = contextOf({ deny: { session: ['Read(/locked/**)', 'Read(/vault/**)'] } })
    const decision = checkBatchReadPermission('Read', [ok, asked, deniedA, deniedB], {}, ctx)
    expect(summary(decision)).toBe('deny rule Read(/locked/**)')
    expect(messageOf(decision).split('\n')[0]).toMatch(/\bread\b.*denied|denied.*\bread\b/)
    expect(listedPaths(messageOf(decision))).toEqual([`  - ${deniedA}`, `  - ${deniedB}`])
  })

  test('files that ask make one ask, naming them and their count', () => {
    const ok = plant(project, 'ok.ts')
    const askA = plant(outside, 'a.ts')
    const askB = plant(outside, 'b.ts')
    const decision = checkBatchReadPermission('Read', [askA, ok, askB], {}, contextOf())
    expect(summary(decision)).toBe('ask workingDir')
    const head = messageOf(decision).split('\n')[0] ?? ''
    expect(head).toMatch(/\b2 files\b/)
    expect(head).toMatch(/\bread\b/)
    expect(listedPaths(messageOf(decision))).toEqual([`  - ${askA}`, `  - ${askB}`])
    const single = checkBatchReadPermission('Read', [askA], {}, contextOf())
    expect(messageOf(single).split('\n')[0]).toMatch(/\b1 file\b(?!s)/)
  })

  test('the ask keeps a rule-backed reason over an earlier plain one', () => {
    const plain = plant(outside, 'plain.ts')
    const ruled = plant(project, 'ruled.ts')
    const ctx = contextOf({ ask: { session: ['Read(/ruled.ts)'] } })
    expect(summary(checkBatchReadPermission('Read', [plain, ruled], {}, ctx))).toBe('ask rule Read(/ruled.ts)')
  })

  test('there is no bypassPermissions shortcut: deny and ask rules still hold', () => {
    const file = plant(project, 'locked/a.ts')
    const bypass = (setup: Setup) => contextOf({ mode: 'bypassPermissions', ...setup })
    expect(summary(checkBatchReadPermission('Read', [file], {}, bypass({ deny: { session: ['Read(/locked/**)'] } })))).toBe(
      'deny rule Read(/locked/**)',
    )
    expect(summary(checkBatchReadPermission('Read', [file], {}, bypass({ ask: { session: ['Read(/locked/**)'] } })))).toBe(
      'ask rule Read(/locked/**)',
    )
  })
})
