import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getPlansDirectory } from 'src/agent/plans/plans.js'
import { getScratchpadDir } from 'src/agent/scratchpad.js'
import { getToolResultsDir } from 'src/agent/tools/toolResultStorage.js'
import {
  getOriginalCwd,
  getProjectRoot,
  setProjectRoot,
} from 'src/platform/bootstrap/state.js'
import { getProjectTempDir } from 'src/platform/tmpdir.js'
import { getPrivateMemPath, getGlobalMemPath } from 'src/memory/memdir/paths.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getBundledSkillsRoot } from 'src/skills/bundledSkillsRoot.js'
import {
  checkEditableInternalPath,
  checkReadableInternalPath,
  checkShellEditableInternalPath,
  getClaudeSkillScope,
  isClaudeConfigFilePath,
  isClaudeSettingsPath,
} from 'src/permissions/filePermissions/internalPaths.js'

// The auto-memory carve-outs: the memory directory is read and written with
// no prompt, though `.claudin` sits in DANGEROUS_DIRECTORIES. Pinned against a
// fresh git project and config home, so the real ~/.claudin and this repo's
// own memory are never resolved.
const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_GLOBAL_MEMORY',
  'CLAUDIN_SIMPLE',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
] as const

describe('auto-memory carve-outs', () => {
  const savedEnv = new Map<string, string | undefined>()
  let previousProjectRoot: string
  let priorMacro: unknown
  let root: string
  let memDir: string

  beforeAll(() => {
    // A read that falls through every carve-out reaches the bundled-skills
    // root, which reads the build-time MACRO.VERSION.
    priorMacro = (globalThis as Record<string, unknown>).MACRO
    ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: 'test' }
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
    for (const key of ENV_KEYS) delete process.env[key]
    root = mkdtempSync(join(tmpdir(), 'internal-paths-'))
    const project = join(root, 'project')
    mkdirSync(join(project, '.git'), { recursive: true })
    process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
    previousProjectRoot = getProjectRoot()
    setProjectRoot(project)
    getPrivateMemPath.cache.clear?.()
    memDir = getPrivateMemPath()
  })

  afterAll(() => {
    setProjectRoot(previousProjectRoot)
    getPrivateMemPath.cache.clear?.()
    if (priorMacro === undefined) delete (globalThis as Record<string, unknown>).MACRO
    else (globalThis as Record<string, unknown>).MACRO = priorMacro
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  test('the memory dir resolves inside the fresh project', () => {
    expect(memDir).toBe(join(root, 'project', '.claudin', 'memory') + '/')
  })

  test('a memory file is writable and readable with no prompt', () => {
    const file = join(memDir, 'feedback-x.md')
    expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('allow')
    expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('allow')
  })

  test('a team memory file rides the same carve-out', () => {
    const file = join(memDir, 'team', 'bugs', 'x.md')
    expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('allow')
  })

  test('a shell write keeps every carve-out but team memory', () => {
    const team = join(memDir, 'team', 'bugs', 'x.md')
    expect(checkShellEditableInternalPath(team).behavior).toBe('passthrough')
    for (const file of [
      join(memDir, 'feedback-x.md'),
      join(getGlobalMemPath(), 'user-language.md'),
      join(getPlansDirectory(), 'some-plan.md'),
    ]) {
      expect([file, checkShellEditableInternalPath(file).behavior]).toEqual([file, 'allow'])
    }
  })

  test('a sibling directory sharing the prefix is not memory', () => {
    const file = join(root, 'project', '.claudin', 'memoryx', 'x.md')
    expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
    expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
  })

  test('a traversal out of the memory dir is not memory', () => {
    // Raw, not join()ed: join would resolve the `..` before the check sees it.
    const file = `${memDir}../settings.json`
    expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
    expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
  })

  test('the Cowork override is readable but gets no write carve-out', () => {
    const override = join(root, 'cowork-memory')
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = override
    getPrivateMemPath.cache.clear?.()
    try {
      const file = join(override, 'x.md')
      expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('allow')
      expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
    } finally {
      delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
      getPrivateMemPath.cache.clear?.()
    }
  })

  test('a global memory file is writable and readable with no prompt', () => {
    const file = join(getGlobalMemPath(), 'user-language.md')
    expect(file.startsWith(join(root, 'config'))).toBe(true)
    expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('allow')
    expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('allow')
  })

  test('a traversal out of the global dir is not memory', () => {
    // Raw, not join()ed: join would resolve the `..` before the check sees it.
    const file = `${getGlobalMemPath()}../settings.json`
    expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
  })

  test('the reason names the directory, team beating the private dir it sits in', () => {
    const reason = (result: { decisionReason?: unknown }) =>
      (result.decisionReason as { reason?: string } | undefined)?.reason
    const cases = [
      ['global', join(getGlobalMemPath(), 'user-language.md')],
      ['private', join(memDir, 'feedback-x.md')],
      ['team', join(memDir, 'team', 'bugs', 'x.md')],
    ] as const
    for (const [scope, file] of cases) {
      expect(reason(checkEditableInternalPath(file, { file_path: file }))).toBe(
        `${scope} memory files are allowed for writing`,
      )
      expect(reason(checkReadableInternalPath(file, { file_path: file }))).toBe(
        `${scope} memory files are allowed for reading`,
      )
    }
  })

  test('with auto memory off, no memory dir is carved out', () => {
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
    try {
      for (const file of [
        join(memDir, 'feedback-x.md'),
        join(memDir, 'team', 'bugs', 'x.md'),
        join(getGlobalMemPath(), 'user-language.md'),
      ]) {
        expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
        expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
      }
    } finally {
      delete process.env.CLAUDIN_DISABLE_AUTO_MEMORY
    }
  })

  test('CLAUDIN_GLOBAL_MEMORY=0 takes the global carve-out with it', () => {
    process.env.CLAUDIN_GLOBAL_MEMORY = '0'
    try {
      const file = join(getGlobalMemPath(), 'user-language.md')
      expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
      expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
    } finally {
      delete process.env.CLAUDIN_GLOBAL_MEMORY
    }
  })

  // SECURITY: the carve-out follows symlinks. A repo can commit a symlink
  // under .claudin/memory/; what it leads to decides, not where it sits.
  describe('symlinks inside a memory dir', () => {
    let outside: string

    beforeAll(() => {
      outside = join(root, 'outside')
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'id_rsa'), 'secret')
      mkdirSync(memDir, { recursive: true })
    })

    afterEach(() => {
      rmSync(join(memDir, 'team'), { recursive: true, force: true })
      rmSync(join(memDir, 'leak.md'), { force: true })
    })

    const verdicts = (file: string) => [
      checkEditableInternalPath(file, { file_path: file }).behavior,
      checkReadableInternalPath(file, { file_path: file }).behavior,
    ]

    test('a file symlink leading out of the memory dir gets no carve-out', () => {
      symlinkSync(join(outside, 'id_rsa'), join(memDir, 'leak.md'))
      expect(verdicts(join(memDir, 'leak.md'))).toEqual(['passthrough', 'passthrough'])
    })

    test('a team dir symlinked out of the project gets no carve-out, for a file there or a new one', () => {
      symlinkSync(outside, join(memDir, 'team'), 'dir')
      expect(verdicts(join(memDir, 'team', 'id_rsa'))).toEqual(['passthrough', 'passthrough'])
      expect(verdicts(join(memDir, 'team', 'new.md'))).toEqual(['passthrough', 'passthrough'])
    })

    test('a global dir the user keeps elsewhere through a symlink keeps its carve-out', () => {
      const real = join(root, 'dotfiles', 'claudin-memory')
      mkdirSync(real, { recursive: true })
      const globalDir = getGlobalMemPath()
      rmSync(globalDir, { recursive: true, force: true })
      mkdirSync(join(globalDir, '..'), { recursive: true })
      symlinkSync(real, globalDir.replace(/\/$/, ''), 'dir')
      try {
        writeFileSync(join(real, 'user-language.md'), 'x')
        expect(verdicts(join(globalDir, 'user-language.md'))).toEqual(['allow', 'allow'])
        expect(verdicts(join(globalDir, 'new.md'))).toEqual(['allow', 'allow'])
      } finally {
        rmSync(globalDir.replace(/\/$/, ''), { force: true })
      }
    })
  })

  // The carve-outs beside memory, each pinned by the reason that names it, so
  // a reordering that lets an earlier branch swallow a later one shows.
  describe('the other internal carve-outs', () => {
    const reasonOf = (result: { behavior: string; decisionReason?: unknown }) =>
      result.behavior === 'allow'
        ? (result.decisionReason as { reason?: string } | undefined)?.reason
        : result.behavior

    test('each writable internal path is allowed under its own reason', () => {
      const cases: [string, string][] = [
        [join(getPlansDirectory(), 'some-plan.md'), 'Plan files for current session are allowed for writing'],
        [join(getScratchpadDir(), 'notes.txt'), 'Scratchpad files for current session are allowed for writing'],
        [join(getCwd(), '.claudin', 'agent-memory', 'x.md'), 'Agent memory files are allowed for writing'],
        [join(getOriginalCwd(), '.claudin', 'launch.json'), 'Preview launch config is allowed for writing'],
      ]
      for (const [file, reason] of cases) {
        expect([file, reasonOf(checkEditableInternalPath(file, { file_path: file }))]).toEqual([file, reason])
      }
    })

    test('a plan file must sit directly in the plans dir and be markdown', () => {
      for (const file of [
        join(getPlansDirectory(), 'nested', 'plan.md'),
        join(getPlansDirectory(), 'plan.txt'),
      ]) {
        expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
      }
    })

    test('CLAUDIN_SCRATCHPAD=0 takes the scratchpad carve-out with it', () => {
      const prior = process.env.CLAUDIN_SCRATCHPAD
      process.env.CLAUDIN_SCRATCHPAD = '0'
      try {
        const file = join(getScratchpadDir(), 'notes.txt')
        expect(checkEditableInternalPath(file, { file_path: file }).behavior).toBe('passthrough')
        expect(checkReadableInternalPath(file, { file_path: file }).behavior).not.toBe('passthrough')
      } finally {
        if (prior === undefined) delete process.env.CLAUDIN_SCRATCHPAD
        else process.env.CLAUDIN_SCRATCHPAD = prior
      }
    })

    test('each readable internal path is allowed under its own reason', () => {
      const config = getClaudinConfigHomeDir()
      const cases: [string, string][] = [
        [join(getProjectDir(getCwd()), 'session.jsonl'), 'Project directory files are allowed for reading'],
        [join(getScratchpadDir(), 'notes.txt'), 'Scratchpad files for current session are allowed for reading'],
        [join(getProjectTempDir(), 'other-session', 'x.txt'), 'Project temp directory files are allowed for reading'],
        [join(getCwd(), '.claudin', 'agent-memory', 'x.md'), 'Agent memory files are allowed for reading'],
        [join(config, 'tasks', 'list.json'), 'Task files are allowed for reading'],
        [join(config, 'teams', 'team.json'), 'Team files are allowed for reading'],
        [join(getBundledSkillsRoot(), 'skill', 'ref.md'), 'Bundled skill reference files are allowed for reading'],
      ]
      for (const [file, reason] of cases) {
        expect([file, reasonOf(checkReadableInternalPath(file, { file_path: file }))]).toEqual([file, reason])
      }
    })

    test('a persisted tool result is readable', () => {
      // Its dir sits under the ORIGINAL cwd's project dir, the project-dir
      // branch under the current one: which reason fires depends on whether an
      // earlier suite moved the cwd, so only the verdict is pinned.
      const file = join(getToolResultsDir(), 'out.txt')
      expect(checkReadableInternalPath(file, { file_path: file }).behavior).toBe('allow')
    })

    test('the bare tasks and teams dirs are readable, a sibling sharing the prefix is not', () => {
      const config = getClaudinConfigHomeDir()
      for (const dir of ['tasks', 'teams']) {
        expect(checkReadableInternalPath(join(config, dir), {}).behavior).toBe('allow')
        expect(checkReadableInternalPath(join(config, `${dir}x`, 'a.json'), {}).behavior).toBe('passthrough')
      }
    })

    test('a plan file is readable as one', () => {
      const file = join(getPlansDirectory(), 'some-plan.md')
      expect(reasonOf(checkReadableInternalPath(file, { file_path: file }))).toBe(
        'Plan files for current session are allowed for reading',
      )
    })
  })

  describe('settings and config files', () => {
    test('any project settings file counts, through a redundant ./ too', () => {
      for (const file of [
        '/somewhere/else/.claudin/settings.json',
        '/somewhere/else/.claudin/settings.local.json',
        '/somewhere/else/./.claudin/./settings.json',
      ]) {
        expect([file, isClaudeSettingsPath(file)]).toEqual([file, true])
      }
      expect(isClaudeSettingsPath('/somewhere/else/.claudin/settings.json.bak')).toBe(false)
    })

    test('commands, agents and skills of this project are config, other .claudin files are not', () => {
      const base = join(getOriginalCwd(), '.claudin')
      for (const dir of ['commands', 'agents', 'skills']) {
        expect(isClaudeConfigFilePath(join(base, dir, 'x.md'))).toBe(true)
      }
      expect(isClaudeConfigFilePath(join(base, 'rules', 'x.md'))).toBe(false)
    })
  })

  describe('getClaudeSkillScope', () => {
    test('a file inside a project or global skill names that skill only', () => {
      expect(getClaudeSkillScope(join(getOriginalCwd(), '.claudin', 'skills', 'MySkill', 'SKILL.md'))).toEqual({
        skillName: 'MySkill',
        pattern: '/.claudin/skills/MySkill/**',
      })
      expect(getClaudeSkillScope(join(getClaudinConfigHomeDir(), 'skills', 'deploy', 'refs', 'a.md'))).toEqual({
        skillName: 'deploy',
        pattern: '~/.claudin/skills/deploy/**',
      })
    })

    test('no scope for a file directly under skills/, a traversal, a glob name or another dir', () => {
      const skills = join(getOriginalCwd(), '.claudin', 'skills')
      for (const file of [
        join(skills, 'loose.md'),
        `${skills}/v2..beta/SKILL.md`,
        `${skills}/*/SKILL.md`,
        `${skills}/a[b]/SKILL.md`,
        join(getOriginalCwd(), '.claudin', 'rules', 'x', 'y.md'),
      ]) {
        expect([file, getClaudeSkillScope(file)]).toEqual([file, null])
      }
    })
  })
})
