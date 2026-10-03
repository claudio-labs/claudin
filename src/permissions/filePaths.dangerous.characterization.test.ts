/**
 * permissions/filePaths: what may never be auto-edited.
 *
 * `checkPathSafetyForAutoEdit` and `isClaudeSettingsPath` are read through
 * the `filePermissions` barrel; `hasSuspiciousWindowsPathPattern` and
 * `isClaudeConfigFilePath` are exported only by their own modules.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { setFlagSettingsPath, setUseCoworkPlugins } from 'src/platform/bootstrap/state.js'
import {
  checkPathSafetyForAutoEdit,
  isClaudeSettingsPath,
} from 'src/permissions/filePermissions.js'
import { hasSuspiciousWindowsPathPattern } from 'src/permissions/filePermissions/dangerousPaths.js'
import { isClaudeConfigFilePath } from 'src/permissions/filePermissions/internalPaths.js'
import { openLab, type Lab } from 'src/permissions/__testutils__/filePathsLab.js'

let lab: Lab
beforeEach(() => {
  lab = openLab()
})
afterEach(() => {
  setUseCoworkPlugins(false)
  lab.close()
})

type Verdict = 'safe' | 'windows' | 'config' | 'sensitive'

/** Sorts a result into the four outcomes the callers tell apart. */
function verdictOf(result: ReturnType<typeof checkPathSafetyForAutoEdit>): Verdict {
  if (result.safe) return 'safe'
  if (!result.classifierApprovable) return 'windows'
  return /granted/.test(result.message) ? 'config' : 'sensitive'
}

describe('hasSuspiciousWindowsPathPattern', () => {
  const everywhere: Array<[string, string, boolean]> = [
    ['an ordinary path', '/repo/src/a.ts', false],
    ['an 8.3 short name', '/repo/GIT~1/config', true],
    ['an 8.3 short file name', 'C:/x/SETTIN~1.JSON', true],
    ['a tilde with no digit', '/repo/a~b/c', false],
    ['a home-relative path', '~/notes.md', false],
    ['the \\\\?\\ long-path prefix', '\\\\?\\C:\\repo\\a', true],
    ['the \\\\.\\ device prefix', '\\\\.\\C:\\repo\\a', true],
    ['the //?/ long-path prefix', '//?/C:/repo/a', true],
    ['the //./ device prefix', '//./C:/repo/a', true],
    ['a trailing dot', '/repo/.git.', true],
    ['a trailing space', '/repo/.claudin ', true],
    ['trailing dots', '/repo/.bashrc...', true],
    ['a trailing tab', '/repo/a.ts\t', true],
    ['a DOS device suffix CON', '/repo/.git.CON', true],
    ['a DOS device suffix in lower case', '/repo/settings.json.prn', true],
    ['a DOS device suffix AUX', '/repo/.bashrc.AUX', true],
    ['a DOS device suffix NUL', '/repo/x.nul', true],
    ['COM1', '/repo/x.COM1', true],
    ['LPT9', '/repo/x.lpt9', true],
    ['COM0 is not a device', '/repo/x.COM0', false],
    ['CONX is not a device', '/repo/x.CONX', false],
    ['a device name with no dot before it', '/repo/CON', false],
    ['three dots as a directory', '/repo/.../a.ts', true],
    ['three dots at the start', '.../a.ts', true],
    ['four dots between backslashes', 'C:\\repo\\....\\a', true],
    ['three dots as the last component', '/repo/...', true],
    ['three dots inside a name', '/app/[...slug]/page.tsx', false],
    ['three dots leading a name', '/repo/...b', false],
    ['a colon in a name off Windows', '/repo/a.txt:stream', false],
  ]
  for (const [name, path, flagged] of everywhere) {
    test(`on linux, ${name}: ${flagged ? 'flagged' : 'clean'}`, () => {
      lab.pretendPlatform('linux')
      expect(hasSuspiciousWindowsPathPattern(path)).toBe(flagged)
    })
  }

  const colon: Array<[string, string, boolean]> = [
    ['an alternate data stream', 'C:\\repo\\a.txt::$DATA', true],
    ['a named stream', '/repo/.bashrc:hidden', true],
    ['a drive letter alone', 'C:\\repo\\a.txt', false],
    ['a colon at index 2', 'ab:c', true],
    ['a colon at index 1 only', 'a:bc', false],
  ]
  for (const platform of ['windows', 'wsl'] as const) {
    for (const [name, path, flagged] of colon) {
      test(`on ${platform}, ${name}: ${flagged ? 'flagged' : 'clean'}`, () => {
        lab.pretendPlatform(platform)
        expect(hasSuspiciousWindowsPathPattern(path)).toBe(flagged)
      })
    }
  }

  test('a colon is not looked at on macOS', () => {
    lab.pretendPlatform('macos')
    expect(hasSuspiciousWindowsPathPattern('/repo/a.txt:stream')).toBe(false)
  })

  const unc = ['\\\\server\\share\\a.txt', '//server/share/a.txt', '\\\\10.0.0.1\\c$\\x']
  for (const path of unc) {
    test(`a UNC path ${path} is flagged on windows only`, () => {
      lab.pretendPlatform('linux')
      expect(hasSuspiciousWindowsPathPattern(path)).toBe(false)
      lab.pretendPlatform('windows')
      expect(hasSuspiciousWindowsPathPattern(path)).toBe(true)
    })
  }
})

describe('isClaudeSettingsPath', () => {
  test('a .claudin/settings.json in any directory', () => {
    expect(isClaudeSettingsPath(join(lab.outside, 'proj', '.claudin', 'settings.json'))).toBe(true)
    expect(isClaudeSettingsPath(join(lab.outside, '.claudin', 'settings.local.json'))).toBe(true)
  })

  const tricks: Array<[string, (l: Lab) => string]> = [
    ['mixed case', l => join(l.outside, '.ClAuDiN', 'Settings.Local.JSON')],
    ['redundant dot segments', l => `${l.outside}/./.claudin/./settings.json`],
    ['a dot-dot detour', l => `${l.outside}/.claudin/hooks/../settings.json`],
    ['a doubled separator', l => `${l.outside}//.claudin//settings.json`],
    ['a path relative to the cwd', () => '.claudin/settings.json'],
  ]
  for (const [name, build] of tricks) {
    test(`still recognised through ${name}`, () => {
      expect(isClaudeSettingsPath(build(lab))).toBe(true)
    })
  }

  test('~ expands to the home directory', () => {
    expect(isClaudeSettingsPath('~/.claudin/settings.json')).toBe(true)
    expect(isClaudeSettingsPath(join(homedir(), '.claudin', 'settings.json'))).toBe(true)
  })

  const notSettings: Array<[string, (l: Lab) => string]> = [
    ['a backup copy', l => join(l.outside, '.claudin', 'settings.json.bak')],
    ['a settings.json outside .claudin', l => join(l.outside, 'settings.json')],
    ['the legacy .claude directory', l => join(l.outside, '.claude', 'settings.json')],
    ['another file in .claudin', l => join(l.outside, '.claudin', 'launch.json')],
    ['a name that ends like it', l => join(l.outside, 'x.claudin', 'settings.json')],
  ]
  for (const [name, build] of notSettings) {
    test(`not: ${name}`, () => {
      expect(isClaudeSettingsPath(build(lab))).toBe(false)
    })
  }

  test("the user's settings file in the config home", () => {
    expect(isClaudeSettingsPath(join(lab.config, 'settings.json'))).toBe(true)
    expect(isClaudeSettingsPath(join(lab.config, 'SETTINGS.JSON'))).toBe(true)
    expect(isClaudeSettingsPath(join(lab.config, 'other.json'))).toBe(false)
  })

  test('the cowork user settings file replaces settings.json when cowork is on', () => {
    expect(isClaudeSettingsPath(join(lab.config, 'cowork_settings.json'))).toBe(false)
    setUseCoworkPlugins(true)
    expect(isClaudeSettingsPath(join(lab.config, 'cowork_settings.json'))).toBe(true)
  })

  test('the managed settings file', () => {
    expect(isClaudeSettingsPath(join(lab.admin, 'managed-settings.json'))).toBe(true)
  })

  test('the file given with --settings', () => {
    const flag = lab.file(join(lab.root, 'cli', 'extra.json'), '{}')
    expect(isClaudeSettingsPath(flag)).toBe(false)
    setFlagSettingsPath(flag)
    expect(isClaudeSettingsPath(flag)).toBe(true)
  })
})

describe('isClaudeConfigFilePath', () => {
  const inProject: Array<[string, string[], boolean]> = [
    ['a command', ['.claudin', 'commands', 'deploy.md'], true],
    ['an agent', ['.claudin', 'agents', 'reviewer.md'], true],
    ['a skill file', ['.claudin', 'skills', 'mine', 'SKILL.md'], true],
    ['the commands directory itself', ['.claudin', 'commands'], true],
    ['commands in another case', ['.CLAUDIN', 'Commands', 'x.md'], true],
    ['the project settings', ['.claudin', 'settings.json'], true],
    ['a hook script', ['.claudin', 'hooks', 'pre.sh'], false],
    ['the rules', ['.claudin', 'rules', 'r.md'], false],
    ['a sibling named like commands', ['.claudin', 'commands-old', 'x.md'], false],
  ]
  for (const [name, parts, config] of inProject) {
    test(`in the original cwd, ${name}: ${config}`, () => {
      expect(isClaudeConfigFilePath(join(lab.project, ...parts))).toBe(config)
    })
  }

  test("another project's commands are not this session's config", () => {
    expect(isClaudeConfigFilePath(join(lab.outside, '.claudin', 'commands', 'x.md'))).toBe(false)
  })

  test('a dot-dot that leaves commands is judged by where it lands', () => {
    const p = `${lab.project}/.claudin/commands/../hooks/x.sh`
    expect(isClaudeConfigFilePath(p)).toBe(false)
  })
})

describe('checkPathSafetyForAutoEdit', () => {
  test('an ordinary source file is safe', () => {
    expect(checkPathSafetyForAutoEdit(lab.file(join(lab.project, 'src', 'a.ts')))).toEqual({ safe: true })
  })

  const dirs = ['.git', '.vscode', '.idea', '.claude', '.claudin']
  for (const d of dirs) {
    test(`anything under ${d} is sensitive, at any depth and in any case`, () => {
      expect(verdictOf(checkPathSafetyForAutoEdit(join(lab.project, d, 'x')))).toBe('sensitive')
      expect(verdictOf(checkPathSafetyForAutoEdit(join(lab.project, 'a', 'b', d, 'c', 'x')))).toBe('sensitive')
      expect(verdictOf(checkPathSafetyForAutoEdit(join(lab.project, d.toUpperCase(), 'x')))).toBe('sensitive')
    })
  }

  test('a directory named like a protected one is not protected', () => {
    for (const name of ['.github', '.gitx', 'git', '.vscode-old', '.claudinx']) {
      expect(checkPathSafetyForAutoEdit(join(lab.project, name, 'a.yml')).safe).toBe(true)
    }
  })

  const files = [
    '.gitconfig',
    '.gitmodules',
    '.bashrc',
    '.bash_profile',
    '.zshrc',
    '.zprofile',
    '.profile',
    '.ripgreprc',
    '.mcp.json',
    '.claude.json',
  ]
  for (const f of files) {
    test(`the file ${f} is sensitive wherever it sits, in any case`, () => {
      expect(verdictOf(checkPathSafetyForAutoEdit(join(lab.project, f)))).toBe('sensitive')
      expect(verdictOf(checkPathSafetyForAutoEdit(join(lab.outside, 'deep', f.toUpperCase())))).toBe('sensitive')
    })
  }

  test('look-alike file names are not protected (parity, finding 3)', () => {
    const lookAlikes = ['.zshenv', '.bash_login', '.zlogin', '.envrc', '.npmrc', 'bashrc', '.bashrc.bak', 'x.gitconfig']
    for (const name of lookAlikes) {
      expect(checkPathSafetyForAutoEdit(join(lab.project, name)).safe).toBe(true)
    }
  })

  test('.claudin/worktrees/ is the one place under .claudin that is not sensitive', () => {
    const inWorktree = join(lab.project, '.claudin', 'worktrees', 'agent-1', 'src', 'a.ts')
    expect(checkPathSafetyForAutoEdit(inWorktree).safe).toBe(true)
    const shouted = join(lab.project, '.CLAUDIN', 'WorkTrees', 'agent-1', 'a.ts')
    expect(checkPathSafetyForAutoEdit(shouted).safe).toBe(true)
  })

  test('the worktree exemption does not cover what the worktree itself protects', () => {
    const base = join(lab.project, '.claudin', 'worktrees', 'agent-1')
    expect(verdictOf(checkPathSafetyForAutoEdit(join(base, '.claudin', 'settings.local.json')))).toBe('config')
    expect(verdictOf(checkPathSafetyForAutoEdit(join(base, '.claudin', 'hooks', 'x.sh')))).toBe('sensitive')
    expect(verdictOf(checkPathSafetyForAutoEdit(join(base, '.git', 'config')))).toBe('sensitive')
    expect(verdictOf(checkPathSafetyForAutoEdit(join(base, '.bashrc')))).toBe('sensitive')
  })

  test('the worktree exemption is for .claudin only', () => {
    const p = join(lab.project, '.claude', 'worktrees', 'a', 'x.ts')
    expect(verdictOf(checkPathSafetyForAutoEdit(p))).toBe('sensitive')
  })

  test('a config file is reported as not granted, not as sensitive', () => {
    for (const parts of [
      ['.claudin', 'settings.json'],
      ['.claudin', 'settings.local.json'],
      ['.claudin', 'commands', 'c.md'],
      ['.claudin', 'agents', 'a.md'],
      ['.claudin', 'skills', 's', 'SKILL.md'],
    ]) {
      const p = join(lab.project, ...parts)
      const result = checkPathSafetyForAutoEdit(p)
      expect(verdictOf(result)).toBe('config')
    }
  })

  test('a Windows pattern beats every other reason', () => {
    const p = join(lab.project, '.claudin', 'settings.json.')
    expect(verdictOf(checkPathSafetyForAutoEdit(p))).toBe('windows')
  })

  test('the three refusals carry the path and their own facts', () => {
    const win = join(lab.project, 'GIT~1', 'config')
    const cfg = join(lab.project, '.claudin', 'settings.json')
    const git = join(lab.project, '.git', 'HEAD')
    const facts: Array<[string, RegExp[], boolean]> = [
      [win, [/suspicious Windows path pattern/, /manual approval/, /write to/], false],
      [cfg, [/haven't granted/, /write to/], true],
      [git, [/sensitive file/, /edit /], true],
    ]
    for (const [path, needles, approvable] of facts) {
      const result = checkPathSafetyForAutoEdit(path)
      if (result.safe) throw new Error(`${path} should be refused`)
      expect(result.classifierApprovable).toBe(approvable)
      expect(result.message).toContain(path)
      for (const needle of needles) expect(result.message).toMatch(needle)
    }
  })

  test('UNC paths are sensitive off Windows and suspicious on Windows', () => {
    for (const p of ['//server/share/a.ts', '\\\\server\\share\\a.ts']) {
      lab.pretendPlatform('linux')
      expect(verdictOf(checkPathSafetyForAutoEdit(p))).toBe('sensitive')
      lab.pretendPlatform('windows')
      expect(verdictOf(checkPathSafetyForAutoEdit(p))).toBe('windows')
    }
  })

  test('an alternate data stream is suspicious on Windows', () => {
    lab.pretendPlatform('windows')
    expect(verdictOf(checkPathSafetyForAutoEdit(join(lab.project, 'notes.txt:evil')))).toBe('windows')
  })

  test('~ is expanded before the checks', () => {
    expect(verdictOf(checkPathSafetyForAutoEdit('~/.bashrc'))).toBe('sensitive')
    expect(verdictOf(checkPathSafetyForAutoEdit('~/.claudin/settings.json'))).toBe('config')
  })

  const viaLinks: Array<[string, Verdict, (l: Lab) => string]> = [
    [
      'a file symlink to a shell rc file',
      'sensitive',
      l => l.link(join(l.project, 'notes.txt'), l.file(join(l.outside, '.bashrc'))),
    ],
    [
      'a dangling symlink to a shell rc file',
      'sensitive',
      l => l.link(join(l.project, 'notes.txt'), join(l.outside, '.zshrc')),
    ],
    [
      'a new file under a symlink to .git',
      'sensitive',
      l => join(l.link(join(l.project, 'hooks-dir'), l.dir(join(l.outside, '.git'))), 'hooks', 'pre-commit'),
    ],
    [
      'a symlink to the project settings',
      'config',
      l => l.link(join(l.project, 'cfg.json'), l.file(join(l.project, '.claudin', 'settings.json'), '{}')),
    ],
    [
      'a symlink to a path with a Windows pattern',
      'windows',
      l => l.link(join(l.project, 'w.txt'), join(l.outside, 'GIT~1')),
    ],
  ]
  for (const [name, verdict, build] of viaLinks) {
    test(`followed through ${name}`, () => {
      const p = build(lab)
      const result = checkPathSafetyForAutoEdit(p)
      expect(verdictOf(result)).toBe(verdict)
      if (!result.safe) expect(result.message).toContain(p)
    })
  }

  test('a supplied list of forms replaces the path for every check', () => {
    const rc = join(lab.project, '.bashrc')
    expect(checkPathSafetyForAutoEdit(rc, [join(lab.project, 'a.ts')]).safe).toBe(true)
    const result = checkPathSafetyForAutoEdit(join(lab.project, 'a.ts'), [rc])
    expect(verdictOf(result)).toBe('sensitive')
    if (!result.safe) expect(result.message).toContain(join(lab.project, 'a.ts'))
  })
})
