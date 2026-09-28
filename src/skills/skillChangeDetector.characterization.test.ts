/**
 * Characterization suite for the skill hot-reload watcher
 * (skillChangeDetector.ts), written BEFORE its clean-base rewrite so the new
 * implementation has to pass it unchanged. It pins only the public contract,
 * `skillChangeDetector.{initialize, dispose, subscribe, resetForTesting}`, and
 * watches it from the outside: real directories under a temp root, real file
 * writes, a ConfigChange hook registered through the hooks API, and the public
 * caches of the modules a reload refreshes.
 * docs/tech/rewrite/skills/skillChangeDetector.md is the spec it goes with.
 *
 * Every location the detector reads is pointed at the temp root: the config
 * home (CLAUDIN_CONFIG_DIR), the project (the process working directory) and
 * the additional-directory list. afterAll puts all of it back.
 *
 * Timing. The watcher's first scan finishes after initialize() resolves, so a
 * test waits STARTUP_MS before touching files, or proves a directory is watched
 * with pulse(). Positive checks poll with generous timeouts. Negative checks
 * wait a window several times longer than a reload takes with FAST timings, so
 * a slow machine can only make them weaker, never red.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _getSkillLatchSnapshotForTests,
  _seedSentSkillNamesForTests,
  resetSentSkillNames,
  suppressNextSkillListing,
} from 'src/agent/attachments/attachments.js'
import { type Command, clearCommandsCache, getCommands, getSkillToolCommands } from 'src/commands/commands.js'
import {
  clearRegisteredHooks,
  getAdditionalDirectoriesForClaudeMd,
  getIsInteractive,
  getRegisteredHooks,
  registerHookCallbacks,
  setAdditionalDirectoriesForClaudeMd,
  setIsInteractive,
} from 'src/platform/bootstrap/state.js'
import type { HookCallbackMatcher } from 'src/shared/types/hooks.js'
import { addSkillDirectories, clearDynamicSkills, getSkillDirCommands } from 'src/skills/loadSkillsDir.js'
import { skillChangeDetector } from 'src/skills/skillChangeDetector.js'

type Timings = NonNullable<Parameters<typeof skillChangeDetector.resetForTesting>[0]>

/** A reload lands about 200 ms after a write with these. */
const FAST: Timings = { stabilityThreshold: 80, pollInterval: 20, reloadDebounce: 60, chokidarInterval: 40 }
const STARTUP_MS = 250
/** How long a negative check waits: three times what a FAST reload takes. */
const SILENCE_MS = 600
/** No notification for this long means a FAST batch has settled. */
const QUIET_MS = 300
const TIMEOUT_MS = 15_000

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function waitUntil(condition: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) return false
    await sleep(10)
  }
  return true
}

// ── What the tests observe ───────────────────────────────────────────────────

type Notes = { times: number[]; args: unknown[][] }
/** Every recorder bumps it, so a hook can tell whether subscribers already heard. */
let notificationCount = 0

function record(): Notes {
  const notes: Notes = { times: [], args: [] }
  skillChangeDetector.subscribe((...args: unknown[]) => {
    notificationCount++
    notes.times.push(Date.now())
    notes.args.push(args)
  })
  return notes
}

type HookCall = { event: string; source: string | undefined; filePath: string | undefined; notifiedBefore: number }
const hookCalls: HookCall[] = []
let blockReloads = false

/** A ConfigChange hook, registered the way an SDK host registers one. */
const configChangeHook: HookCallbackMatcher = {
  matcher: 'skills',
  hooks: [
    {
      type: 'callback',
      callback: async input => {
        const fields = input as { hook_event_name: string; source?: string; file_path?: string }
        hookCalls.push({
          event: fields.hook_event_name,
          source: fields.source,
          filePath: fields.file_path,
          notifiedBefore: notificationCount,
        })
        return blockReloads ? { decision: 'block', reason: 'held by the characterization suite' } : {}
      },
    },
  ],
}

const names = (commands: readonly Command[]) => commands.map(command => command.name)

// ── The places the detector looks at ─────────────────────────────────────────

const LOCATIONS = ['userSkills', 'userCommands', 'projectSkills', 'projectCommands', 'extraSkills', 'extraCommands'] as const
type Location = (typeof LOCATIONS)[number]
type World = Record<Location, string> & {
  config: string
  project: string
  extra: string
  /** A skills directory no watcher covers, for skills discovered mid-session. */
  discovered: string
}

let suiteRoot = ''
let worlds = 0

/** A fresh config home, project and additional directory; `existing` says which locations exist. */
function world(existing: readonly Location[]): World {
  const base = join(suiteRoot, `world-${worlds++}`)
  const config = join(base, 'config')
  const project = join(base, 'project')
  const extra = join(base, 'extra')
  const w: World = {
    config,
    project,
    extra,
    discovered: join(base, 'discovered', '.claudin', 'skills'),
    userSkills: join(config, 'skills'),
    userCommands: join(config, 'commands'),
    projectSkills: join(project, '.claudin', 'skills'),
    projectCommands: join(project, '.claudin', 'commands'),
    extraSkills: join(extra, '.claudin', 'skills'),
    extraCommands: join(extra, '.claudin', 'commands'),
  }
  for (const dir of [config, project, extra]) mkdirSync(dir, { recursive: true })
  for (const location of existing) mkdirSync(w[location], { recursive: true })
  process.env.CLAUDIN_CONFIG_DIR = config
  process.chdir(project)
  setAdditionalDirectoriesForClaudeMd([extra])
  return w
}

function writeSkill(root: string, name: string): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\ndescription: ${name}\n---\nThe ${name} skill.\n`)
}

/** Appends to `file` `times` times, `everyMs` apart; resolves with the time of the last write. */
async function grow(file: string, times: number, everyMs: number): Promise<number> {
  let last = 0
  for (let i = 0; i < times; i++) {
    if (i > 0) await sleep(everyMs)
    appendFileSync(file, `line ${i}\n`)
    last = Date.now()
  }
  return last
}

// ── Driving the detector ─────────────────────────────────────────────────────

async function start(timings: Timings = FAST): Promise<Notes> {
  await skillChangeDetector.resetForTesting(timings)
  const notes = record()
  await skillChangeDetector.initialize()
  await sleep(STARTUP_MS)
  return notes
}

/** Resolves once no notification has arrived for `quietMs`. */
async function settle(notes: Notes, quietMs = QUIET_MS): Promise<void> {
  let seen: number
  do {
    seen = notes.times.length
    await sleep(quietMs)
  } while (notes.times.length !== seen)
}

let pulses = 0
/** Writes fresh files into `dir` until the detector reports one: true when `dir` is watched. */
async function pulse(dir: string, notes: Notes, giveUpMs = 2500): Promise<boolean> {
  const before = notes.times.length
  const deadline = Date.now() + giveUpMs
  while (Date.now() < deadline) {
    writeFileSync(join(dir, `pulse-${pulses++}.txt`), 'pulse')
    if (await waitUntil(() => notes.times.length > before, 600)) {
      await settle(notes)
      return true
    }
  }
  return false
}

async function expectReported(notes: Notes, label: string, act: () => void): Promise<void> {
  const before = notes.times.length
  act()
  const reported = await waitUntil(() => notes.times.length > before)
  expect({ label, reported }).toEqual({ label, reported: true })
  await settle(notes)
}

async function expectSilence(notes: Notes, label: string, act: () => void): Promise<void> {
  const before = notes.times.length
  act()
  await sleep(SILENCE_MS)
  expect({ label, notified: notes.times.length - before }).toEqual({ label, notified: 0 })
}

// ── Process-wide state this file borrows ─────────────────────────────────────

const savedCwd = process.cwd()
const savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
const savedSimple = process.env.CLAUDIN_SIMPLE
let savedInteractive = false
let savedAdditionalDirectories: string[] = []
let hadRegisteredHooks = false

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeAll(() => {
  suiteRoot = realpathSync(mkdtempSync(join(tmpdir(), 'skill-change-detector-')))
  // Bare mode skips hooks and skill discovery; a file that leaked it must not decide this one.
  delete process.env.CLAUDIN_SIMPLE
  // Outside an interactive session hooks run without a workspace-trust check.
  savedInteractive = getIsInteractive()
  setIsInteractive(false)
  savedAdditionalDirectories = [...getAdditionalDirectoriesForClaudeMd()]
  hadRegisteredHooks = getRegisteredHooks() !== null
  registerHookCallbacks({ ConfigChange: [configChangeHook] })
})

beforeEach(() => {
  blockReloads = false
  hookCalls.length = 0
  notificationCount = 0
})

afterEach(async () => {
  await skillChangeDetector.dispose()
  await skillChangeDetector.resetForTesting()
  // A reload whose hooks were already running when dispose() came still finishes: let it land here.
  await sleep(50)
  clearDynamicSkills()
  resetSentSkillNames()
})

afterAll(() => {
  const registered = getRegisteredHooks()?.ConfigChange
  const index = registered ? registered.indexOf(configChangeHook) : -1
  if (registered && index !== -1) registered.splice(index, 1)
  if (!hadRegisteredHooks) clearRegisteredHooks()
  setIsInteractive(savedInteractive)
  setAdditionalDirectoriesForClaudeMd(savedAdditionalDirectories)
  clearCommandsCache()
  restoreEnv('CLAUDIN_CONFIG_DIR', savedConfigDir)
  restoreEnv('CLAUDIN_SIMPLE', savedSimple)
  // Leave the temp root before deleting it.
  process.chdir(savedCwd)
  rmSync(suiteRoot, { recursive: true, force: true })
})

// ── The tests ────────────────────────────────────────────────────────────────

describe('skillChangeDetector: the watched locations', () => {
  test(
    'watches the user and project skills and commands directories, and the skills directory of every additional directory',
    async () => {
      const w = world(['userSkills', 'userCommands', 'projectSkills', 'projectCommands', 'extraSkills'])
      const notes = await start()
      const watched: Record<string, boolean> = {}
      for (const location of ['userSkills', 'userCommands', 'projectSkills', 'projectCommands', 'extraSkills'] as const) {
        watched[location] = await pulse(w[location], notes)
      }
      expect(watched).toEqual({
        userSkills: true,
        userCommands: true,
        projectSkills: true,
        projectCommands: true,
        extraSkills: true,
      })
    },
    TIMEOUT_MS,
  )

  test(
    "watches nothing else: not the config home, not the project, not .claudin itself, not an additional directory's commands",
    async () => {
      const w = world(['userSkills', 'extraSkills', 'extraCommands'])
      mkdirSync(join(w.config, 'agents'))
      mkdirSync(join(w.project, '.claudin'))
      const notes = await start()
      await expectSilence(notes, 'outside the watched locations', () => {
        writeFileSync(join(w.config, 'settings.json'), '{}')
        writeFileSync(join(w.config, 'agents', 'helper.md'), 'x')
        writeFileSync(join(w.project, 'README.md'), 'x')
        writeFileSync(join(w.project, '.claudin', 'settings.json'), '{}')
        writeFileSync(join(w.extra, '.claudin', 'settings.json'), '{}')
        writeFileSync(join(w.extraCommands, 'tool.md'), 'x')
      })
      await expectReported(notes, 'control', () => writeFileSync(join(w.userSkills, 'control.md'), 'x'))
    },
    TIMEOUT_MS,
  )

  test(
    'a location missing when initialize() runs is not watched, even once it appears, and a second initialize() does not add it',
    async () => {
      const w = world([])
      const notes = await start()
      const late = [w.userSkills, w.userCommands, w.projectSkills, w.projectCommands, w.extraSkills]
      for (const dir of late) mkdirSync(dir, { recursive: true })
      await sleep(STARTUP_MS)
      await expectSilence(notes, 'created after initialize()', () => {
        late.forEach((dir, i) => writeFileSync(join(dir, `late-${i}.md`), 'x'))
      })
      await skillChangeDetector.initialize()
      await sleep(STARTUP_MS)
      await expectSilence(notes, 'after a second initialize()', () => {
        late.forEach((dir, i) => writeFileSync(join(dir, `later-${i}.md`), 'x'))
      })
    },
    TIMEOUT_MS,
  )
})

describe('skillChangeDetector: what counts as a change', () => {
  test(
    'a new skill, an edit (even one that keeps the size), a deleted file and a deleted skill directory are all changes',
    async () => {
      const w = world(['userSkills'])
      writeSkill(w.userSkills, 'existing')
      const existing = join(w.userSkills, 'existing', 'SKILL.md')
      const anHourAgo = new Date(Date.now() - 3_600_000)
      utimesSync(existing, anHourAgo, anHourAgo)
      const notes = await start()
      await expectReported(notes, 'new skill', () => writeSkill(w.userSkills, 'fresh'))
      await expectReported(notes, 'same-size edit', () => {
        writeFileSync(existing, readFileSync(existing, 'utf8').toUpperCase())
      })
      await expectReported(notes, 'deleted file', () => unlinkSync(existing))
      await expectReported(notes, 'deleted skill directory', () => {
        rmSync(join(w.userSkills, 'fresh'), { recursive: true })
      })
    },
    TIMEOUT_MS,
  )

  test(
    'files already there when initialize() runs are not reported, but they are watched',
    async () => {
      const w = world(['userSkills'])
      writeSkill(w.userSkills, 'existing')
      writeFileSync(join(w.userSkills, 'loose.md'), 'x')
      const notes = await start()
      await sleep(SILENCE_MS)
      // Counted from initialize(): a report of the startup scan lands inside STARTUP_MS.
      expect(notes.times).toEqual([])
      await expectReported(notes, 'edit of a file found at startup', () => {
        appendFileSync(join(w.userSkills, 'existing', 'SKILL.md'), 'more\n')
      })
    },
    TIMEOUT_MS,
  )

  test(
    'files up to two directories below a watched directory count; deeper ones do not',
    async () => {
      const w = world(['userSkills'])
      const notes = await start()
      await expectSilence(notes, 'three directories down', () => {
        mkdirSync(join(w.userSkills, 'a', 'b', 'c'), { recursive: true })
        writeFileSync(join(w.userSkills, 'a', 'b', 'c', 'too-deep.md'), 'x')
      })
      await expectReported(notes, 'two directories down', () => {
        mkdirSync(join(w.userSkills, 'group', 'skill'), { recursive: true })
        writeFileSync(join(w.userSkills, 'group', 'skill', 'SKILL.md'), 'x')
      })
    },
    TIMEOUT_MS,
  )

  test(
    'creating or removing an empty directory is not a change',
    async () => {
      const w = world(['userSkills'])
      const notes = await start()
      await expectSilence(notes, 'empty directory created', () => mkdirSync(join(w.userSkills, 'empty-skill')))
      await expectSilence(notes, 'empty directory removed', () => rmSync(join(w.userSkills, 'empty-skill'), { recursive: true }))
      await expectReported(notes, 'control', () => writeFileSync(join(w.userSkills, 'control.md'), 'x'))
    },
    TIMEOUT_MS,
  )

  test(
    'anything inside a .git directory, or a .git file, is ignored; a name that only starts with .git is not',
    async () => {
      const w = world(['userSkills'])
      const notes = await start()
      await expectSilence(notes, '.git', () => {
        mkdirSync(join(w.userSkills, '.git'))
        writeFileSync(join(w.userSkills, '.git', 'HEAD'), 'ref: refs/heads/main\n')
        mkdirSync(join(w.userSkills, 'vendored', '.git'), { recursive: true })
        writeFileSync(join(w.userSkills, 'vendored', '.git', 'config'), '[core]\n')
        mkdirSync(join(w.userSkills, 'submodule'))
        writeFileSync(join(w.userSkills, 'submodule', '.git'), 'gitdir: ../.git/modules/submodule\n')
      })
      await expectReported(notes, '.gitignore', () => writeFileSync(join(w.userSkills, '.gitignore'), 'node_modules\n'))
    },
    TIMEOUT_MS,
  )

  test(
    'editor backup and swap files are ignored',
    async () => {
      const w = world(['userSkills'])
      const notes = await start()
      await expectSilence(notes, 'editor temporaries', () => {
        writeFileSync(join(w.userSkills, 'SKILL.md~'), 'backup')
        writeFileSync(join(w.userSkills, '.SKILL.md.swp'), 'swap')
        writeFileSync(join(w.userSkills, '.SKILL.md.swx'), 'swap')
        writeFileSync(join(w.userSkills, '.subl3f2a.tmp'), 'sublime')
      })
      await expectReported(notes, 'control', () => writeFileSync(join(w.userSkills, 'control.md'), 'x'))
    },
    TIMEOUT_MS,
  )

  test.skipIf(process.platform === 'win32')(
    'special files such as a FIFO are ignored',
    async () => {
      const w = world(['userSkills'])
      const notes = await start()
      await expectSilence(notes, 'fifo', () => {
        expect(spawnSync('mkfifo', [join(w.userSkills, 'pipe')]).status).toBe(0)
      })
      await expectReported(notes, 'control', () => writeFileSync(join(w.userSkills, 'control.md'), 'x'))
    },
    TIMEOUT_MS,
  )
})

describe('skillChangeDetector: batching and timing', () => {
  test(
    'a burst of changes is one reload: the ConfigChange hooks run once, for source "skills" and one of the changed files, and only then are subscribers told, once',
    async () => {
      const w = world(['userSkills'])
      const notes = await start({ ...FAST, reloadDebounce: 400 })
      const files = ['one', 'two', 'three'].map(name => join(w.userSkills, `${name}.md`))
      for (const file of files) writeFileSync(file, 'x')
      expect(await waitUntil(() => notes.times.length > 0)).toBe(true)
      await settle(notes, 800)
      expect(notes.times).toHaveLength(1)
      expect(hookCalls).toHaveLength(1)
      expect(hookCalls[0]).toMatchObject({ event: 'ConfigChange', source: 'skills', notifiedBefore: 0 })
      expect(files).toContain(hookCalls[0]?.filePath ?? 'no hook call')
    },
    TIMEOUT_MS,
  )

  test(
    'changes further apart than the quiet period are separate reloads, each hook run naming its own file',
    async () => {
      const w = world(['userSkills'])
      const notes = await start()
      const first = join(w.userSkills, 'first.md')
      const second = join(w.userSkills, 'second.md')
      await expectReported(notes, 'first', () => writeFileSync(first, 'x'))
      await expectReported(notes, 'second', () => writeFileSync(second, 'x'))
      expect(notes.times).toHaveLength(2)
      expect(hookCalls.map(call => call.filePath)).toEqual([first, second])
    },
    TIMEOUT_MS,
  )

  test(
    'the quiet period starts over with every change, so a slow trickle is still one reload',
    async () => {
      const w = world(['userSkills'])
      const notes = await start({ ...FAST, reloadDebounce: 800 })
      let lastWrite = 0
      for (let i = 0; i < 4; i++) {
        if (i > 0) await sleep(250)
        writeFileSync(join(w.userSkills, `trickle-${i}.md`), 'x')
        lastWrite = Date.now()
      }
      expect(await waitUntil(() => notes.times.length > 0, 5000)).toBe(true)
      expect(notes.times[0]! - lastWrite).toBeGreaterThanOrEqual(700)
      await sleep(1000)
      expect(notes.times).toHaveLength(1)
      expect(hookCalls).toHaveLength(1)
    },
    TIMEOUT_MS,
  )

  test(
    'a file that keeps changing counts only once it has stayed unchanged for the stability threshold',
    async () => {
      const w = world(['userSkills'])
      const notes = await start({ stabilityThreshold: 1500, pollInterval: 20, reloadDebounce: 20, chokidarInterval: 40 })
      const lastWrite = await grow(join(w.userSkills, 'growing.md'), 5, 100)
      expect(notes.times).toEqual([])
      expect(await waitUntil(() => notes.times.length > 0, 6000)).toBe(true)
      expect(notes.times[0]! - lastWrite).toBeGreaterThanOrEqual(1400)
      await sleep(QUIET_MS)
      expect(notes.times).toHaveLength(1)
    },
    TIMEOUT_MS,
  )

  test(
    'by default a change waits for the file to stay unchanged about a second, then for 300 ms of quiet',
    async () => {
      const w = world(['userSkills'])
      // Only the file-system polling is sped up: stability and quiet period keep their defaults.
      const notes = await start({ chokidarInterval: 40 })
      const lastWrite = await grow(join(w.userSkills, 'growing.md'), 6, 100)
      expect(notes.times).toEqual([])
      expect(await waitUntil(() => notes.times.length > 0, 5000)).toBe(true)
      const latency = notes.times[0]! - lastWrite
      expect(latency).toBeGreaterThanOrEqual(1200)
      expect(latency).toBeLessThanOrEqual(3500)
      await sleep(600)
      expect(notes.times).toHaveLength(1)
    },
    TIMEOUT_MS,
  )
})

describe('skillChangeDetector: what a reload does', () => {
  test(
    'subscribers, even ones added before initialize(), are called once per reload with no arguments; an unsubscribed one is not',
    async () => {
      const w = world(['userSkills'])
      await skillChangeDetector.resetForTesting(FAST)
      const first = record()
      const second = record()
      const dropped: unknown[][] = []
      const unsubscribe = skillChangeDetector.subscribe((...args: unknown[]) => {
        dropped.push(args)
      })
      unsubscribe()
      await skillChangeDetector.initialize()
      await sleep(STARTUP_MS)
      await expectReported(first, 'change', () => writeFileSync(join(w.userSkills, 'one.md'), 'x'))
      expect(first.args).toEqual([[]])
      expect(second.args).toEqual([[]])
      expect(dropped).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    'a reload drops the skill and command caches and the record of announced skills, before subscribers hear of it',
    async () => {
      const w = world(['userSkills'])
      writeSkill(w.userSkills, 'alpha')
      await start()
      const skillsBefore = await getSkillDirCommands(w.project)
      expect(names(skillsBefore)).toContain('alpha')
      expect(names(await getCommands(w.project))).toContain('alpha')
      _seedSentSkillNamesForTests('', ['alpha'])
      suppressNextSkillListing()

      type Seen = {
        skills: Promise<Command[]>
        commands: Promise<Command[]>
        latch: ReturnType<typeof _getSkillLatchSnapshotForTests>
      }
      let seen: Seen | undefined
      skillChangeDetector.subscribe(() => {
        seen ??= {
          skills: getSkillDirCommands(w.project),
          commands: getCommands(w.project),
          latch: _getSkillLatchSnapshotForTests(),
        }
      })
      writeSkill(w.userSkills, 'beta')
      // Until the detector reacts, both listings come from cache.
      expect(await getSkillDirCommands(w.project)).toBe(skillsBefore)
      expect(names(await getCommands(w.project))).not.toContain('beta')

      expect(await waitUntil(() => seen !== undefined)).toBe(true)
      expect(names(await seen!.skills)).toEqual(expect.arrayContaining(['alpha', 'beta']))
      expect(names(await seen!.commands)).toEqual(expect.arrayContaining(['alpha', 'beta']))
      expect(seen!.latch).toEqual({ suppressNext: false, sentByAgent: {} })
    },
    TIMEOUT_MS,
  )

  test(
    'a ConfigChange hook that blocks cancels the reload: caches, the announced-skill record and subscribers are left alone',
    async () => {
      const w = world(['userSkills'])
      writeSkill(w.userSkills, 'alpha')
      const notes = await start()
      const skillsBefore = await getSkillDirCommands(w.project)
      _seedSentSkillNamesForTests('', ['alpha'])
      blockReloads = true

      writeSkill(w.userSkills, 'blocked')
      expect(await waitUntil(() => hookCalls.length > 0)).toBe(true)
      await sleep(QUIET_MS)
      expect(notes.times).toEqual([])
      expect(await getSkillDirCommands(w.project)).toBe(skillsBefore)
      expect(_getSkillLatchSnapshotForTests()).toEqual({ suppressNext: false, sentByAgent: { '': ['alpha'] } })

      // The blocked batch is not retried; the next change reloads everything.
      blockReloads = false
      await expectReported(notes, 'after unblocking', () => writeSkill(w.userSkills, 'allowed'))
      expect(names(await getSkillDirCommands(w.project))).toEqual(expect.arrayContaining(['alpha', 'blocked', 'allowed']))
    },
    TIMEOUT_MS,
  )
})

describe('skillChangeDetector: skills discovered during the session', () => {
  test(
    'a discovery load tells each subscriber once and refreshes the command lists, before it resolves; disk caches, the announced-skill record and hooks are left alone',
    async () => {
      const w = world([])
      // Two lifecycles first: the discovery hookup must not pile up across initialize() calls.
      await skillChangeDetector.resetForTesting(FAST)
      await skillChangeDetector.initialize()
      await skillChangeDetector.dispose()
      const notes = await start()

      writeSkill(w.discovered, 'discovered-skill')
      const skillToolBefore = await getSkillToolCommands(w.project)
      const onDiskBefore = await getSkillDirCommands(w.project)
      _seedSentSkillNamesForTests('', ['already-announced'])

      await addSkillDirectories([w.discovered])
      expect(notes.args).toEqual([[]])
      expect(names(skillToolBefore)).not.toContain('discovered-skill')
      expect(names(await getSkillToolCommands(w.project))).toContain('discovered-skill')
      expect(await getSkillDirCommands(w.project)).toBe(onDiskBefore)
      expect(_getSkillLatchSnapshotForTests()).toEqual({
        suppressNext: false,
        sentByAgent: { '': ['already-announced'] },
      })
      expect(hookCalls).toEqual([])
    },
    TIMEOUT_MS,
  )
})

describe('skillChangeDetector: lifecycle', () => {
  test(
    'initialize() is idempotent, called twice at once or again later: there is one watcher, and dispose() closes it',
    async () => {
      const w = world(['userSkills'])
      await skillChangeDetector.resetForTesting(FAST)
      const notes = record()
      expect(await Promise.all([skillChangeDetector.initialize(), skillChangeDetector.initialize()])).toEqual([
        undefined,
        undefined,
      ])
      expect(await skillChangeDetector.initialize()).toBeUndefined()
      await sleep(STARTUP_MS)
      expect(await pulse(w.userSkills, notes)).toBe(true)

      await skillChangeDetector.dispose()
      const late = record()
      hookCalls.length = 0
      await expectSilence(late, 'after dispose()', () => writeFileSync(join(w.userSkills, 'after-dispose.md'), 'x'))
      expect(hookCalls).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    'dispose() closes the watcher, drops every subscriber, resolves, and can be called again',
    async () => {
      const w = world(['userSkills'])
      const notes = await start()
      expect(await pulse(w.userSkills, notes)).toBe(true)
      const heard = notes.times.length

      expect(await skillChangeDetector.dispose()).toBeUndefined()
      expect(await skillChangeDetector.dispose()).toBeUndefined()
      // Dropped: a discovery load no longer reaches the old subscriber.
      writeSkill(w.discovered, 'after-dispose')
      await addSkillDirectories([w.discovered])
      expect(notes.times).toHaveLength(heard)
      // Closed: a change on disk no longer reloads, not even for a subscriber added afterwards.
      const late = record()
      hookCalls.length = 0
      await expectSilence(late, 'after dispose()', () => writeFileSync(join(w.userSkills, 'after-dispose.md'), 'x'))
      expect(hookCalls).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    'dispose() cancels a reload that is still waiting out its quiet period',
    async () => {
      const w = world(['userSkills'])
      await start({ ...FAST, reloadDebounce: 1500 })
      writeFileSync(join(w.userSkills, 'pending.md'), 'x')
      // Long enough for the change to be seen, well short of the quiet period.
      await sleep(600)
      await skillChangeDetector.dispose()
      const late = record()
      await sleep(1600)
      expect(hookCalls).toEqual([])
      expect(late.times).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    'dispose() before initialize() keeps the detector off; resetForTesting() re-arms it, drops subscribers, and stops a running watcher',
    async () => {
      const w = world(['userSkills'])
      await skillChangeDetector.resetForTesting(FAST)
      await skillChangeDetector.dispose()
      await skillChangeDetector.initialize()
      const off = record()
      await sleep(STARTUP_MS)
      await expectSilence(off, 'initialize() after dispose()', () => writeFileSync(join(w.userSkills, 'while-off.md'), 'x'))

      await skillChangeDetector.resetForTesting(FAST)
      const on = record()
      await skillChangeDetector.initialize()
      await sleep(STARTUP_MS)
      expect(await pulse(w.userSkills, on)).toBe(true)
      expect(off.times).toEqual([])

      const heard = on.times.length
      await skillChangeDetector.resetForTesting(FAST)
      const late = record()
      hookCalls.length = 0
      await expectSilence(late, 'after resetForTesting()', () => writeFileSync(join(w.userSkills, 'after-reset.md'), 'x'))
      expect(on.times).toHaveLength(heard)
      expect(hookCalls).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    'the watcher never keeps the process alive, and graceful shutdown disposes it',
    () => {
      const w = world(['userSkills'])
      const host = join(w.config, 'host.mjs')
      writeFileSync(host, HOST_SCRIPT)
      const result = spawnSync(
        process.execPath,
        [
          `--preload=${Bun.resolveSync('src/stubs/test-preload.ts', import.meta.dir)}`,
          host,
          Bun.resolveSync('src/skills/skillChangeDetector.js', import.meta.dir),
          Bun.resolveSync('src/shared/cleanupRegistry.js', import.meta.dir),
          w.userSkills,
        ],
        { cwd: w.project, env: { ...process.env, CLAUDIN_CONFIG_DIR: w.config }, encoding: 'utf8', timeout: 15_000 },
      )
      // Killed by the timeout means the watcher held the process open.
      expect({ signal: result.signal, status: result.status, stderr: result.status === 0 ? '' : result.stderr }).toEqual({
        signal: null,
        status: 0,
        stderr: '',
      })
      const report = result.stdout.trim().split('\n').pop() ?? ''
      expect(JSON.parse(report)).toEqual({ liveBeforeShutdown: true, heardAfterShutdown: 0, liveAtExit: true })
    },
    30_000,
  )
})

/**
 * Runs in a process of its own, the way the CLI hosts the detector: it
 * initializes, proves the watcher live, runs the graceful-shutdown cleanups,
 * then initializes again and simply ends without disposing.
 */
const HOST_SCRIPT = `
const [detectorPath, registryPath, root] = process.argv.slice(2)
const { writeFileSync } = await import('node:fs')
const { join } = await import('node:path')
const { skillChangeDetector } = await import(detectorPath)
const { runCleanupFunctions } = await import(registryPath)
const timings = ${JSON.stringify(FAST)}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let files = 0
async function isLive() {
  let heard = 0
  const unsubscribe = skillChangeDetector.subscribe(() => { heard++ })
  for (let attempt = 0; attempt < 6 && heard === 0; attempt++) {
    writeFileSync(join(root, 'live-' + files++ + '.txt'), 'x')
    for (let tick = 0; tick < 30 && heard === 0; tick++) await sleep(20)
  }
  await sleep(${QUIET_MS})
  unsubscribe()
  return heard > 0
}
const report = {}
await skillChangeDetector.resetForTesting(timings)
await skillChangeDetector.initialize()
await sleep(${STARTUP_MS})
report.liveBeforeShutdown = await isLive()
await runCleanupFunctions()
let heardAfterShutdown = 0
skillChangeDetector.subscribe(() => { heardAfterShutdown++ })
writeFileSync(join(root, 'after-shutdown.txt'), 'x')
await sleep(${SILENCE_MS})
report.heardAfterShutdown = heardAfterShutdown
await skillChangeDetector.resetForTesting(timings)
await skillChangeDetector.initialize()
await sleep(${STARTUP_MS})
report.liveAtExit = await isLive()
console.log(JSON.stringify(report))
`
