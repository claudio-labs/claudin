/**
 * Home-anchored file rules (`~/...`), driven with real files under a temp
 * HOME. The OS reads HOME once per process, so this file only runs as a child
 * of `homeAnchored.characterization.test.ts`, which sets HOME to a fresh temp
 * dir. Run any other way, it refuses before touching anything.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const home = process.env.HOME ?? ''
if (process.env.FILE_RULES_HOME_CHILD !== '1' || homedir() !== home || !home.includes('file-rules-home-')) {
  throw new Error('homeAnchored.child.ts must be spawned by homeAnchored.characterization.test.ts')
}

const {
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} = await import('src/permissions/filePermissions.js')
const { setCwdState, setOriginalCwd } = await import('src/platform/bootstrap/state.js')
const { getEmptyToolPermissionContext } = await import('src/tools/Tool.js')

type Ctx = ReturnType<typeof getEmptyToolPermissionContext>
type Rules = Ctx['alwaysAllowRules']
type Verdict = ReturnType<typeof checkReadPermissionForTool>
type Checker = (tool: unknown, input: unknown, ctx: Ctx) => Verdict

const tool = { name: 'Edit', getPath: (input: { file_path: string }) => input.file_path }
const read = (path: string, ctx: Ctx) => (checkReadPermissionForTool as unknown as Checker)(tool, { file_path: path }, ctx)
const write = (path: string, ctx: Ctx) => (checkWritePermissionForTool as unknown as Checker)(tool, { file_path: path }, ctx)

function ctxWith(lists: { allow?: Rules; deny?: Rules; ask?: Rules } = {}): Ctx {
  return {
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: lists.allow ?? {},
    alwaysDenyRules: lists.deny ?? {},
    alwaysAskRules: lists.ask ?? {},
  }
}

function brief(v: Verdict): string {
  const r = v.decisionReason
  if (r?.type === 'rule') return `${v.behavior} rule ${r.rule.source} ${r.rule.ruleValue.ruleContent}`
  if (r?.type === 'mode') return `${v.behavior} mode ${r.mode}`
  return `${v.behavior} ${r?.type ?? '-'}`
}

const project = join(home, 'work', 'project')
const configHome = join(home, '.claudin')

function put(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'x')
  return path
}

beforeAll(() => {
  ;(globalThis as { MACRO?: { VERSION: string } }).MACRO ??= { VERSION: 'characterization' }
  process.env.CLAUDIN_CONFIG_DIR = configHome
  process.env.CLAUDIN_TMPDIR = join(home, 'tmp')
  mkdirSync(join(home, 'tmp'), { recursive: true })
})

beforeEach(() => {
  for (const dir of ['work', '.ssh', '.claudin', 'notes']) rmSync(join(home, dir), { recursive: true, force: true })
  mkdirSync(project, { recursive: true })
  setOriginalCwd(project)
  setCwdState(project)
})

describe('a ~/ pattern is anchored at the home directory', () => {
  test('Read(~/.ssh/**) denies the real ~/.ssh and nothing named .ssh elsewhere', () => {
    const key = put(join(home, '.ssh', 'id_rsa'))
    const lookalike = put(join(project, '.ssh', 'id_rsa'))
    const ctx = ctxWith({ deny: { userSettings: ['Read(~/.ssh/**)'] } })
    expect(brief(read(key, ctx))).toBe('deny rule userSettings ~/.ssh/**')
    expect(brief(read(join(home, '.ssh'), ctx))).toBe('deny rule userSettings ~/.ssh/**')
    expect(brief(read(lookalike, ctx))).toBe('allow mode default')
    expect(brief(read(home, ctx))).toBe('ask workingDir')
  })

  test('a path written with ~/ is expanded before matching, and the message names the full path', () => {
    const key = put(join(home, '.ssh', 'id_ed25519'))
    const verdict = read('~/.ssh/id_ed25519', ctxWith({ deny: { projectSettings: ['Read(~/.ssh/**)'] } }))
    expect(brief(verdict)).toBe('deny rule projectSettings ~/.ssh/**')
    expect('message' in verdict ? verdict.message : '').toContain(key)
  })

  test('a link in the project to a key under ~/.ssh is denied', () => {
    const key = put(join(home, '.ssh', 'id_rsa'))
    const link = join(project, 'innocent.txt')
    symlinkSync(key, link)
    expect(brief(read(link, ctxWith({ deny: { session: ['Read(~/.ssh/**)'] } })))).toBe('deny rule session ~/.ssh/**')
    expect(brief(write(link, ctxWith({ deny: { session: ['Edit(~/.ssh/**)'] } })))).toBe('deny rule session ~/.ssh/**')
  })

  test('a ~/ allow grants reads and writes under home outside the working directory', () => {
    const note = put(join(home, 'notes', 'today.md'))
    expect(brief(read(note, ctxWith({ allow: { session: ['Read(~/notes/**)'] } })))).toBe('allow rule session ~/notes/**')
    expect(brief(write(note, ctxWith({ allow: { localSettings: ['Edit(~/notes/**)'] } })))).toBe('allow rule localSettings ~/notes/**')
  })

  test('~/** (the whole home) grants nothing as an allow rule', () => {
    // Findings: inert root-wide patterns. Pinned for allow rules only.
    const note = put(join(home, 'notes', 'today.md'))
    expect(brief(write(note, ctxWith({ allow: { session: ['Edit(~/**)'], userSettings: ['Edit(~/**)'] } })))).toBe('ask workingDir')
  })

  test('search tools see ~/ deny patterns keyed by the home directory', () => {
    const ctx = ctxWith({ deny: { userSettings: ['Read(~/.ssh/**)', 'Read(~/.aws/credentials)'] } })
    const byRoot = getFileReadIgnorePatterns(ctx)
    expect([...byRoot.entries()]).toEqual([[home, ['/.ssh/**', '/.aws/credentials']]])
    expect(normalizePatternsToPath(byRoot, home)).toEqual(['/.ssh/**', '/.aws/credentials'])
    expect(normalizePatternsToPath(byRoot, join(home, '.ssh'))).toEqual(['/**'])
    expect(normalizePatternsToPath(byRoot, project)).toEqual([])
  })
})

describe('the session grant on ~/.claudin', () => {
  test('a session Edit(~/.claudin/**) opens the config home', () => {
    const agent = put(join(configHome, 'agents', 'helper.md'))
    expect(brief(write(agent, ctxWith({ allow: { session: ['Edit(~/.claudin/**)'] } })))).toBe('allow rule session ~/.claudin/**')
  })

  test('the same rule from user settings does not', () => {
    const agent = put(join(configHome, 'agents', 'helper.md'))
    expect(brief(write(agent, ctxWith({ allow: { userSettings: ['Edit(~/.claudin/**)'] } })))).toBe('ask safetyCheck')
  })

  test('a config-home skill gets a home-anchored suggestion, and the grant it suggests opens it', () => {
    const skill = put(join(configHome, 'skills', 'tidy', 'SKILL.md'))
    const asked = write(skill, ctxWith())
    expect(brief(asked)).toBe('ask safetyCheck')
    expect('suggestions' in asked ? asked.suggestions : undefined).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Edit', ruleContent: '~/.claudin/skills/tidy/**' }],
        behavior: 'allow',
        destination: 'session',
      },
    ])
    expect(brief(write(skill, ctxWith({ allow: { session: ['Edit(~/.claudin/skills/tidy/**)'] } })))).toBe(
      'allow rule session ~/.claudin/skills/tidy/**',
    )
    const other = put(join(configHome, 'skills', 'other', 'SKILL.md'))
    expect(brief(write(other, ctxWith({ allow: { session: ['Edit(~/.claudin/skills/tidy/**)'] } })))).toBe('ask safetyCheck')
  })
})
