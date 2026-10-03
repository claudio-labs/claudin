/**
 * permissions/filePaths: the harness's own directories, which the agent may
 * read or write without a prompt, and the per-skill edit scope.
 *
 * The locations are taken from the modules that own them (plans, scratchpad,
 * memory, sessions, temp dir, bundled skills); this suite pins only which of
 * them this unit opens, for which operation, and how tightly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join, sep } from 'node:path'

import { getPlansDirectory } from 'src/agent/plans/plans.js'
import { getScratchpadDir } from 'src/agent/scratchpad.js'
import { getToolResultsDir } from 'src/agent/tools/toolResultStorage.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { getSessionMemoryDir } from 'src/memory/session/paths.js'
import {
  checkEditableInternalPath,
  checkReadableInternalPath,
} from 'src/permissions/filePermissions.js'
import { getClaudeSkillScope } from 'src/permissions/filePermissions/internalPaths.js'
import { getSessionId, setCwdState } from 'src/platform/bootstrap/state.js'
import { getProjectTempDir } from 'src/platform/tmpdir.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { getBundledSkillsRoot } from 'src/skills/bundledSkillsRoot.js'
import { getAgentMemoryDir } from 'src/tools/AgentTool/agentMemory.js'
import { openLab, type Lab } from 'src/permissions/__testutils__/filePathsLab.js'

let lab: Lab
beforeEach(() => {
  lab = openLab()
})
afterEach(() => {
  lab.close()
})

const INPUT = { file_path: 'kept as given' }

/** The reason text of an allow, or 'passthrough'. */
function outcome(result: ReturnType<typeof checkEditableInternalPath>): string {
  if (result.behavior === 'passthrough') return 'passthrough'
  if (result.behavior !== 'allow') throw new Error(`unexpected ${result.behavior}`)
  const reason = result.decisionReason
  if (reason?.type !== 'other') throw new Error('allow without an "other" reason')
  return reason.reason
}

const write = (p: string) => outcome(checkEditableInternalPath(p, INPUT))
const read = (p: string) => outcome(checkReadableInternalPath(p, INPUT))

function under(dir: string, ...rest: string[]): string {
  return join(dir, ...rest)
}

describe('checkEditableInternalPath: what may be written without asking', () => {
  type Row = [string, () => string, RegExp]
  const allowed: Row[] = [
    ['a plan file of this session', () => under(getPlansDirectory(), 'calm-river.md'), /plan/i],
    ['an agent plan file', () => under(getPlansDirectory(), 'calm-river-agent-a1.md'), /plan/i],
    ['a file in the scratchpad', () => under(getScratchpadDir(), 'probe.py'), /scratchpad/i],
    ['a nested scratchpad file', () => under(getScratchpadDir(), 'a', 'b.txt'), /scratchpad/i],
    ['the scratchpad itself', () => getScratchpadDir(), /scratchpad/i],
    ['user-scope agent memory', () => under(getAgentMemoryDir('rev', 'user'), 'm.md'), /agent memory/i],
    ['project-scope agent memory', () => under(getAgentMemoryDir('rev', 'project'), 'm.md'), /agent memory/i],
    ['local-scope agent memory', () => under(getAgentMemoryDir('rev', 'local'), 'm.md'), /agent memory/i],
    ['an auto memory file', () => under(getAutoMemPath(), 'user_role.md'), /auto memory/i],
    ['the auto memory index', () => under(getAutoMemPath(), 'MEMORY.md'), /auto memory/i],
    ['the preview launch config', () => under(lab.project, '.claudin', 'launch.json'), /launch/i],
    ['the launch config in another case', () => under(lab.project, '.CLAUDIN', 'Launch.JSON'), /launch/i],
  ]
  for (const [name, build, reason] of allowed) {
    test(`allowed: ${name}`, () => {
      const said = write(build())
      expect(said).toMatch(reason)
      expect(said).toMatch(/writ/i)
    })
  }

  test('an allow hands back the very input it was given', () => {
    const result = checkEditableInternalPath(under(getScratchpadDir(), 'x'), INPUT)
    expect(result.behavior).toBe('allow')
    if (result.behavior === 'allow') expect(result.updatedInput).toBe(INPUT)
  })

  test('anything else passes through with an empty message', () => {
    expect(checkEditableInternalPath(join(lab.outside, 'a.ts'), INPUT)).toEqual({
      behavior: 'passthrough',
      message: '',
    })
  })

  const refused: Array<[string, () => string]> = [
    ['an ordinary project file', () => under(lab.project, 'src', 'a.ts')],
    ['a plan in a subdirectory', () => under(getPlansDirectory(), 'old', 'p.md')],
    ['a plan that is not markdown', () => under(getPlansDirectory(), 'p.txt')],
    ['a dot-dot out of the plans directory', () => `${getPlansDirectory()}${sep}..${sep}evil.md`],
    ['the plans directory itself', () => getPlansDirectory()],
    ['a sibling of the scratchpad', () => `${getScratchpadDir()}-evil${sep}x`],
    ['a dot-dot out of the scratchpad', () => `${getScratchpadDir()}${sep}..${sep}..${sep}x`],
    ['a sibling of auto memory', () => `${getAutoMemPath().slice(0, -1)}-old${sep}m.md`],
    ['auto memory in another case', () => under(getAutoMemPath().toUpperCase(), 'm.md')],
    ['launch.json in a subdirectory', () => under(lab.project, '.claudin', 'sub', 'launch.json')],
    ['launch.json in the config home', () => under(lab.config, 'launch.json')],
    ['launch.json of another project', () => under(lab.outside, '.claudin', 'launch.json')],
    ['the project settings', () => under(lab.project, '.claudin', 'settings.json')],
    ['session memory (read-only)', () => under(getSessionMemoryDir(), 'summary.md')],
    ['a tool result (read-only)', () => under(getToolResultsDir(), 'r.txt')],
    ['the project temp dir (read-only)', () => under(getProjectTempDir(), 'other', 'x')],
    ['a task file (read-only)', () => under(lab.config, 'tasks', 't.json')],
    ['a team file (read-only)', () => under(lab.config, 'teams', 't.json')],
    ['a bundled skill file (read-only)', () => under(getBundledSkillsRoot(), 'ref.md')],
  ]
  for (const [name, build] of refused) {
    test(`not opened: ${name}`, () => {
      expect(write(build())).toBe('passthrough')
    })
  }

  for (const off of ['0', 'false', 'no', 'off']) {
    test(`CLAUDIN_SCRATCHPAD=${off} closes the scratchpad`, () => {
      const p = under(getScratchpadDir(), 'x.py')
      process.env.CLAUDIN_SCRATCHPAD = off
      expect(write(p)).toBe('passthrough')
      expect(read(p)).not.toMatch(/scratchpad/i)
    })
  }

  test('CLAUDIN_SCRATCHPAD=1 keeps it open', () => {
    process.env.CLAUDIN_SCRATCHPAD = '1'
    expect(write(under(getScratchpadDir(), 'x.py'))).toMatch(/scratchpad/i)
  })

  test('a memory directory override withholds the auto memory write carve-out', () => {
    const custom = lab.dir(join(lab.root, 'cowork-memory'))
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = custom
    lab.forget()
    const inside = under(getAutoMemPath(), 'm.md')
    expect(inside.startsWith(custom)).toBe(true)
    expect(write(inside)).toBe('passthrough')
    expect(read(inside)).toMatch(/auto memory/i)
  })

  test('an override that is not absolute is ignored and the carve-out stays', () => {
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = 'relative/dir'
    lab.forget()
    expect(write(under(getAutoMemPath(), 'm.md'))).toMatch(/auto memory/i)
  })

  test('a remote memory mount moves user and local agent memory', () => {
    const mount = lab.dir(join(lab.root, 'mount'))
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = mount
    lab.forget()
    expect(write(join(mount, 'agent-memory', 'rev', 'm.md'))).toMatch(/agent memory/i)
    expect(write(join(mount, 'projects', 'p', 'agent-memory-local', 'rev', 'm.md'))).toMatch(/agent memory/i)
    expect(write(join(mount, 'agent-memory-local', 'rev', 'm.md'))).toBe('passthrough')
    expect(write(join(lab.config, 'agent-memory', 'rev', 'm.md'))).toBe('passthrough')
  })

  test('a plansDirectory setting moves the writable plans', () => {
    lab.file(join(lab.project, '.claudin', 'settings.json'), JSON.stringify({ plansDirectory: 'docs/plans' }))
    lab.forget()
    expect(write(join(lab.project, 'docs', 'plans', 'p.md'))).toMatch(/plan/i)
    expect(write(join(lab.project, '.claudin', 'plans', 'p.md'))).toBe('passthrough')
  })

  test('a planted .claudin symlink cannot carry the plans out of the project', () => {
    const away = lab.dir(join(lab.outside, 'captured'))
    lab.link(join(lab.project, '.claudin'), away)
    lab.forget()
    expect(write(join(lab.project, '.claudin', 'plans', 'p.md'))).toBe('passthrough')
    expect(write(join(away, 'plans', 'p.md'))).toBe('passthrough')
    expect(write(join(lab.config, 'plans', 'p.md'))).toMatch(/plan/i)
  })
})

describe('checkReadableInternalPath: what may be read without asking', () => {
  type Row = [string, () => string, RegExp]
  const allowed: Row[] = [
    ['session memory', () => under(getSessionMemoryDir(), 'summary.md'), /session memory/i],
    ['a past session in the project directory', () => under(getProjectDir(lab.project), 'old', 'x.jsonl'), /project directory/i],
    ['the project directory itself', () => getProjectDir(lab.project), /project directory/i],
    ['a plan file', () => under(getPlansDirectory(), 'p.md'), /plan/i],
    ['a scratchpad file', () => under(getScratchpadDir(), 'out.log'), /scratchpad/i],
    ['another session in the project temp dir', () => under(getProjectTempDir(), 'other-session', 'o.txt'), /temp/i],
    ['agent memory', () => under(getAgentMemoryDir('rev', 'project'), 'm.md'), /agent memory/i],
    [
      'auto memory of a repository',
      () => {
        lab.gitInit(lab.project)
        lab.forget()
        return under(getAutoMemPath(), 'm.md')
      },
      /auto memory/i,
    ],
    ['the tasks directory', () => join(lab.config, 'tasks'), /task/i],
    ['a task file', () => under(lab.config, 'tasks', 'list', '1.json'), /task/i],
    ['the teams directory', () => join(lab.config, 'teams'), /team/i],
    ['a team file', () => under(lab.config, 'teams', 'red', 'config.json'), /team/i],
    ['a bundled skill reference', () => under(getBundledSkillsRoot(), 'skill', 'ref.md'), /bundled skill/i],
  ]
  for (const [name, build, reason] of allowed) {
    test(`allowed: ${name}`, () => {
      const said = read(build())
      expect(said).toMatch(reason)
      expect(said).toMatch(/read/i)
    })
  }

  test('outside a repository, auto memory is read as part of the project directory', () => {
    const memory = getAutoMemPath()
    expect(memory.startsWith(getProjectDir(lab.project))).toBe(true)
    expect(read(under(memory, 'm.md'))).toMatch(/project directory/i)
  })

  test('a tool result is opened even when the cwd has moved away', () => {
    const moved = lab.dir(join(lab.root, 'moved'))
    setCwdState(moved)
    const result = under(getToolResultsDir(), 'r.txt')
    expect(result.startsWith(getProjectDir(lab.project))).toBe(true)
    expect(read(result)).toMatch(/tool result/i)
    expect(read(getToolResultsDir())).toMatch(/tool result/i)
  })

  test('session memory and the project directory follow the current cwd', () => {
    const moved = lab.dir(join(lab.root, 'moved'))
    setCwdState(moved)
    expect(read(under(getProjectDir(moved), 'x'))).toMatch(/project directory/i)
    expect(read(under(getProjectDir(lab.project), 'x'))).toBe('passthrough')
  })

  test('an allow hands back the very input it was given', () => {
    const result = checkReadableInternalPath(under(lab.config, 'tasks', 'a'), INPUT)
    expect(result.behavior).toBe('allow')
    if (result.behavior === 'allow') expect(result.updatedInput).toBe(INPUT)
  })

  const refused: Array<[string, () => string]> = [
    ['an outside file', () => join(lab.outside, 'secret')],
    ['the config home settings', () => join(lab.config, 'settings.json')],
    ['a sibling of tasks', () => under(lab.config, 'tasks-evil', 'x')],
    ['a sibling of teams', () => under(lab.config, 'teams2', 'x')],
    ['a dot-dot out of tasks', () => `${lab.config}${sep}tasks${sep}..${sep}settings.json`],
    ['a sibling of the project directory', () => `${getProjectDir(lab.project)}-x${sep}y`],
    ['another project', () => under(getProjectDir(lab.outside), 'x.jsonl')],
    ['the bundled skills root itself', () => getBundledSkillsRoot()],
    ['a plan in a subdirectory', () => under(getPlansDirectory(), 'sub', 'p.md')],
    ['the preview launch config', () => under(lab.project, '.claudin', 'launch.json')],
  ]
  for (const [name, build] of refused) {
    test(`not opened: ${name}`, () => {
      expect(read(build())).toBe('passthrough')
    })
  }
})

describe('the memory carve-out and symlinks (parity, finding 1)', () => {
  test('a link committed in a repository memory directory opens its target', () => {
    lab.gitInit(lab.project)
    lab.forget()
    const memory = getAutoMemPath()
    expect(memory).toBe(join(lab.project, '.claudin', 'memory') + sep)
    const secret = lab.file(join(lab.outside, 'id_rsa'), 'key')
    const link = lab.link(join(memory, 'team', 'notes.md'), secret)
    expect(write(link)).toMatch(/auto memory/i)
    expect(read(link)).toMatch(/auto memory/i)
    expect(write(secret)).toBe('passthrough')
  })

  const repoControlled: Array<[string, () => string, RegExp]> = [
    ['project agent memory', () => under(getAgentMemoryDir('rev', 'project'), 'x.md'), /agent memory/i],
    ['local agent memory', () => under(getAgentMemoryDir('rev', 'local'), 'x.md'), /agent memory/i],
    ['a plan file', () => under(getPlansDirectory(), 'evil.md'), /plan/i],
    ['the preview launch config', () => under(lab.project, '.claudin', 'launch.json'), /launch/i],
    ['the scratchpad', () => under(getScratchpadDir(), 'x'), /scratchpad/i],
  ]
  for (const [name, place, reason] of repoControlled) {
    test(`the same holds for ${name}`, () => {
      const secret = lab.file(join(lab.outside, '.bashrc'))
      const link = lab.link(place(), secret)
      expect(write(link)).toMatch(reason)
    })
  }
})

describe('getClaudeSkillScope', () => {
  test('a file inside a project skill', () => {
    expect(getClaudeSkillScope(join(lab.project, '.claudin', 'skills', 'deploy', 'SKILL.md'))).toEqual({
      skillName: 'deploy',
      pattern: '/.claudin/skills/deploy/**',
    })
  })

  test('a file deep inside a skill of the config home is spelled from ~', () => {
    expect(getClaudeSkillScope(join(lab.config, 'skills', 'lint', 'refs', 'a.md'))).toEqual({
      skillName: 'lint',
      pattern: '~/.claudin/skills/lint/**',
    })
  })

  test('the directory is matched in any case, the name keeps its own', () => {
    expect(getClaudeSkillScope(join(lab.project, '.CLAUDIN', 'Skills', 'MySkill', 'x.md'))).toEqual({
      skillName: 'MySkill',
      pattern: '/.claudin/skills/MySkill/**',
    })
  })

  test('a relative path is taken from the current cwd', () => {
    expect(getClaudeSkillScope('.claudin/skills/rel/x.md')?.skillName).toBe('rel')
  })

  test('a dot-dot is applied before matching', () => {
    const p = `${lab.project}/.claudin/skills/a/../b/x.md`
    expect(getClaudeSkillScope(p)?.skillName).toBe('b')
  })

  const none: Array<[string, (l: Lab) => string]> = [
    ['a file directly under skills', l => join(l.project, '.claudin', 'skills', 'README.md')],
    ['the skill directory itself', l => join(l.project, '.claudin', 'skills', 'deploy')],
    ['the skills directory', l => join(l.project, '.claudin', 'skills')],
    ['a name holding two dots', l => join(l.project, '.claudin', 'skills', 'v2..beta', 'x.md')],
    ['a name that is a star', l => join(l.project, '.claudin', 'skills', '*', 'x.md')],
    ['a name with a question mark', l => join(l.project, '.claudin', 'skills', 'a?b', 'x.md')],
    ['a name with brackets', l => join(l.project, '.claudin', 'skills', '[ab]', 'x.md')],
    ['a dot-dot that leaves skills', l => `${l.project}/.claudin/skills/../commands/x.md`],
    ['another project', l => join(l.outside, '.claudin', 'skills', 's', 'x.md')],
    ['a sibling of skills', l => join(l.project, '.claudin', 'skills-old', 's', 'x.md')],
    ['the project commands', l => join(l.project, '.claudin', 'commands', 'x.md')],
  ]
  for (const [name, build] of none) {
    test(`no scope for ${name}`, () => {
      expect(getClaudeSkillScope(build(lab))).toBeNull()
    })
  }
})
