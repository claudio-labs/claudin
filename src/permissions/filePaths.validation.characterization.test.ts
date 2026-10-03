/**
 * permissions/filePaths: validating the paths a shell command names.
 *
 * `src/permissions/pathValidation.ts` has no barrel. The OS sandbox is the
 * one boundary stubbed here: whether it is on, and its write allow/deny
 * lists, come from spies on `SandboxManager`. The lists themselves name real
 * directories and symlinks under the lab root.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getScratchpadDir } from 'src/agent/scratchpad.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import {
  expandTilde,
  formatDirectoryList,
  getGlobBaseDirectory,
  isDangerousRemovalPath,
  isPathAllowed,
  isPathInSandboxWriteAllowlist,
  validateGlobPattern,
  validatePath,
  type FileOperationType,
} from 'src/permissions/pathValidation.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import { getPlansDirectory } from 'src/agent/plans/plans.js'
import {
  absoluteRule,
  openLab,
  permissionContext,
  type Lab,
} from 'src/permissions/__testutils__/filePathsLab.js'

let lab: Lab
beforeEach(() => {
  lab = openLab()
})
afterEach(() => {
  lab.close()
})

/** Runs `fn` with the sandbox on, and always turns it back off. */
function withSandbox<T>(allowOnly: string[], denyWithinAllow: string[], fn: () => T): T {
  const on = spyOn(SandboxManager, 'isSandboxingEnabled').mockImplementation(() => true)
  const cfg = spyOn(SandboxManager, 'getFsWriteConfig').mockImplementation(() => ({
    allowOnly,
    denyWithinAllow,
  }))
  try {
    return fn()
  } finally {
    on.mockRestore()
    cfg.mockRestore()
  }
}

describe('formatDirectoryList', () => {
  const table: Array<[string[], string]> = [
    [[], ''],
    [['/a'], "'/a'"],
    [['/a', '/b c'], "'/a', '/b c'"],
    [['1', '2', '3', '4', '5'], "'1', '2', '3', '4', '5'"],
    [['1', '2', '3', '4', '5', '6'], "'1', '2', '3', '4', '5', and 1 more"],
    [['1', '2', '3', '4', '5', '6', '7', '8'], "'1', '2', '3', '4', '5', and 3 more"],
  ]
  for (const [dirs, text] of table) {
    test(`${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'}`, () => {
      expect(formatDirectoryList(dirs)).toBe(text)
    })
  }
})

describe('getGlobBaseDirectory', () => {
  /** One `pattern => base` per line. */
  const parse = (block: string) => block.trim().split('\n').map(line => line.trim().split(' => '))

  const offWindows = parse(String.raw`
    /repo/src/a.ts => /repo/src/a.ts
    /repo/src/*.ts => /repo/src
    /repo/**/x.ts => /repo
    src/**/x => src
    *.ts => .
    /*.conf => /
    /repo/{a,b}/c => /repo
    /repo/b?c => /repo
    /repo/[ab]/c => /repo
    /repo/x} => /repo
    /a/b/c*/d/* => /a/b
    C:\repo\*.ts => .
  `)
  test.each(offWindows)('off Windows, %s has base %s', (pattern, base) => {
    lab.pretendPlatform('linux')
    expect(getGlobBaseDirectory(pattern!)).toBe(base!)
  })

  const onWindows = parse(String.raw`
    C:\repo\src\*.ts => C:\repo\src
    C:\repo/mixed\*.ts => C:\repo/mixed
    C:/repo/*.ts => C:/repo
    *.ts => .
  `)
  test.each(onWindows)('on Windows, %s has base %s', (pattern, base) => {
    lab.pretendPlatform('windows')
    expect(getGlobBaseDirectory(pattern!)).toBe(base!)
  })
})

describe('expandTilde', () => {
  const home = homedir()
  const table: Array<[string, string]> = [
    ['~', home],
    ['~/', `${home}/`],
    ['~/notes/a.md', `${home}/notes/a.md`],
    ['~root/.ssh', '~root/.ssh'],
    ['~+', '~+'],
    ['~-/x', '~-/x'],
    ['~1', '~1'],
    ['a/~/b', 'a/~/b'],
    ['/abs/~', '/abs/~'],
    ['', ''],
  ]
  if (process.platform !== 'win32') table.push(['~\\x', '~\\x'])
  for (const [input, out] of table) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(out)}`, () => {
      expect(expandTilde(input)).toBe(out)
    })
  }
})

describe('isDangerousRemovalPath', () => {
  const table: Array<[string, boolean]> = [
    ['*', true],
    ['/repo/build/*', true],
    ['build/*', true],
    ['C:\\foo\\*', true],
    ['/', true],
    ['//', true],
    ['/usr', true],
    ['/usr/', true],
    ['/tmp', true],
    ['/etc//', true],
    ['/usr/local', false],
    ['/repo/build', false],
    ['/repo/*.log', false],
    ['C:\\', true],
    ['C:', true],
    ['c:/', true],
    ['C:\\Windows', true],
    ['C:\\\\Windows', true],
    ['D:/Users/', true],
    ['C:\\Windows\\System32', false],
    ['relative', false],
    ['.', false],
    ['', false],
  ]
  for (const [path, dangerous] of table) {
    test(`${JSON.stringify(path)}: ${dangerous ? 'dangerous' : 'ordinary'}`, () => {
      expect(isDangerousRemovalPath(path)).toBe(dangerous)
    })
  }

  test('the home directory, with or without a trailing slash', () => {
    const home = homedir()
    expect(isDangerousRemovalPath(home)).toBe(true)
    expect(isDangerousRemovalPath(`${home}/`)).toBe(true)
    expect(isDangerousRemovalPath(join(home, 'projects', 'x'))).toBe(false)
  })
})

describe('isPathInSandboxWriteAllowlist', () => {
  test('is false while the sandbox is off', () => {
    expect(SandboxManager.isSandboxingEnabled()).toBe(false)
    expect(isPathInSandboxWriteAllowlist(join(lab.outside, 'a'))).toBe(false)
  })

  test('a path under an allowed directory', () => {
    const allowed = lab.dir(join(lab.root, 'sbx-a'))
    withSandbox([allowed], [], () => {
      expect(isPathInSandboxWriteAllowlist(join(allowed, 'x', 'y.txt'))).toBe(true)
      expect(isPathInSandboxWriteAllowlist(allowed)).toBe(true)
      expect(isPathInSandboxWriteAllowlist(join(lab.outside, 'y.txt'))).toBe(false)
      expect(isPathInSandboxWriteAllowlist(`${allowed}-evil/x`)).toBe(false)
    })
  })

  test('a deny entry inside an allowed directory wins', () => {
    const allowed = lab.dir(join(lab.root, 'sbx-b'))
    const denied = join(allowed, '.claudin', 'settings.json')
    withSandbox([allowed], [denied], () => {
      expect(isPathInSandboxWriteAllowlist(denied)).toBe(false)
      expect(isPathInSandboxWriteAllowlist(join(allowed, 'ok.txt'))).toBe(true)
    })
  })

  test('an allow entry that is a symlink covers its target', () => {
    const real = lab.dir(join(lab.root, 'sbx-real'))
    const alias = lab.link(join(lab.root, 'sbx-alias'), real)
    withSandbox([alias], [], () => {
      expect(isPathInSandboxWriteAllowlist(join(real, 'f.txt'))).toBe(true)
    })
  })

  test('a deny entry that is a symlink covers its target', () => {
    const allowed = lab.dir(join(lab.root, 'sbx-c'))
    const realDeny = lab.dir(join(allowed, 'locked'))
    const aliasDeny = lab.link(join(allowed, 'locked-alias'), realDeny)
    withSandbox([allowed], [aliasDeny], () => {
      expect(isPathInSandboxWriteAllowlist(join(realDeny, 'f'))).toBe(false)
    })
  })

  test('a path that links out of the allowed directory is refused', () => {
    const allowed = lab.dir(join(lab.root, 'sbx-d'))
    const escape = lab.link(join(allowed, 'esc'), lab.file(join(lab.outside, 'target')))
    withSandbox([allowed], [], () => {
      expect(isPathInSandboxWriteAllowlist(escape)).toBe(false)
    })
  })

  test('an empty allow list allows nothing', () => {
    withSandbox([], [], () => {
      expect(isPathInSandboxWriteAllowlist(join(lab.project, 'a'))).toBe(false)
    })
  })
})

describe('isPathAllowed', () => {
  const ops: FileOperationType[] = ['read', 'write', 'create']

  test('a read inside a working directory is allowed with no reason', () => {
    const f = lab.file(join(lab.project, 'a.ts'))
    expect(isPathAllowed(f, permissionContext(), 'read')).toEqual({ allowed: true })
  })

  for (const op of ['write', 'create'] as const) {
    test(`a ${op} inside a working directory needs acceptEdits`, () => {
      const f = join(lab.project, 'a.ts')
      expect(isPathAllowed(f, permissionContext({ mode: 'acceptEdits' }), op)).toEqual({ allowed: true })
      for (const mode of ['default', 'plan', 'bypassPermissions', 'dontAsk'] as const) {
        expect(isPathAllowed(f, permissionContext({ mode }), op)).toEqual({ allowed: false })
      }
    })
  }

  for (const op of ops) {
    test(`a ${op} outside every working directory is refused with no reason`, () => {
      const f = join(lab.outside, 'a.ts')
      expect(isPathAllowed(f, permissionContext({ mode: 'acceptEdits' }), op)).toEqual({ allowed: false })
    })
  }

  test('an added working directory counts like the cwd', () => {
    const f = join(lab.outside, 'a.ts')
    const ctx = permissionContext({ mode: 'acceptEdits', dirs: [lab.outside] })
    for (const op of ops) expect(isPathAllowed(f, ctx, op).allowed).toBe(true)
  })

  test('a deny rule wins over the working directory, citing the rule', () => {
    const f = lab.file(join(lab.project, 'secret.env'))
    const ctx = permissionContext({
      mode: 'acceptEdits',
      deny: [absoluteRule('Read', f), absoluteRule('Edit', f)],
    })
    for (const op of ops) {
      const result = isPathAllowed(f, ctx, op)
      expect(result.allowed).toBe(false)
      expect(result.decisionReason?.type).toBe('rule')
      if (result.decisionReason?.type === 'rule') {
        expect(result.decisionReason.rule.ruleBehavior).toBe('deny')
        expect(result.decisionReason.rule.ruleValue.toolName).toBe(op === 'read' ? 'Read' : 'Edit')
      }
    }
  })

  test('a Read deny rule does not refuse a write, an Edit deny rule does not refuse a read', () => {
    const f = lab.file(join(lab.project, 'x.ts'))
    const readDenied = permissionContext({ mode: 'acceptEdits', deny: [absoluteRule('Read', f)] })
    expect(isPathAllowed(f, readDenied, 'write').allowed).toBe(true)
    const editDenied = permissionContext({ mode: 'acceptEdits', deny: [absoluteRule('Edit', f)] })
    expect(isPathAllowed(f, editDenied, 'read').allowed).toBe(true)
  })

  test('a deny rule wins over the harness carve-outs', () => {
    const p = join(getScratchpadDir(), 'x.py')
    const ctx = permissionContext({ deny: [absoluteRule('Edit', p), absoluteRule('Read', p)] })
    expect(isPathAllowed(p, ctx, 'write').decisionReason?.type).toBe('rule')
    expect(isPathAllowed(p, ctx, 'read').decisionReason?.type).toBe('rule')
  })

  test('a write to a harness directory is allowed in any mode, with its reason', () => {
    const p = join(getScratchpadDir(), 'x.py')
    const result = isPathAllowed(p, permissionContext({ mode: 'plan' }), 'create')
    expect(result.allowed).toBe(true)
    expect(result.decisionReason).toMatchObject({ type: 'other' })
  })

  test('the plan file is writable although .claudin is a protected directory', () => {
    const plan = join(getPlansDirectory(), 'p.md')
    expect(isPathAllowed(plan, permissionContext(), 'write').allowed).toBe(true)
  })

  test('a read of a harness directory outside the working dirs is allowed, with its reason', () => {
    const p = join(lab.config, 'tasks', 'list.json')
    const result = isPathAllowed(p, permissionContext(), 'read')
    expect(result.allowed).toBe(true)
    expect(result.decisionReason?.type).toBe('other')
  })

  test('a write to a protected path is refused even in acceptEdits, citing the safety check', () => {
    const ctx = permissionContext({ mode: 'acceptEdits' })
    const table: Array<[string, boolean]> = [
      [join(lab.project, '.git', 'config'), true],
      [join(lab.project, '.bashrc'), true],
      [join(lab.project, '.claudin', 'settings.json'), true],
      [join(lab.project, 'GIT~1', 'config'), false],
    ]
    for (const [p, approvable] of table) {
      const result = isPathAllowed(p, ctx, 'write')
      expect(result.allowed).toBe(false)
      expect(result.decisionReason).toMatchObject({ type: 'safetyCheck', classifierApprovable: approvable })
      if (result.decisionReason?.type === 'safetyCheck') expect(result.decisionReason.reason).toContain(p)
    }
  })

  test('a read of a protected path inside the working dir is allowed', () => {
    const p = lab.file(join(lab.project, '.git', 'config'))
    expect(isPathAllowed(p, permissionContext(), 'read')).toEqual({ allowed: true })
  })

  test('the safety check wins over an allow rule', () => {
    const p = join(lab.project, '.bashrc')
    const ctx = permissionContext({ allow: [absoluteRule('Edit', p)] })
    expect(isPathAllowed(p, ctx, 'write').decisionReason?.type).toBe('safetyCheck')
  })

  test('an allow rule opens a path outside the working dirs, citing the rule', () => {
    const p = join(lab.outside, 'shared.txt')
    const ctx = permissionContext({ allow: [absoluteRule('Edit', p), absoluteRule('Read', p)] })
    for (const op of ops) {
      const result = isPathAllowed(p, ctx, op)
      expect(result.allowed).toBe(true)
      expect(result.decisionReason).toMatchObject({ type: 'rule' })
    }
  })

  test('an allow rule opens a write inside the working dir outside acceptEdits', () => {
    const p = join(lab.project, 'gen', 'out.txt')
    const ctx = permissionContext({ allow: [absoluteRule('Edit', `${join(lab.project, 'gen')}/**`)] })
    expect(isPathAllowed(p, ctx, 'write').decisionReason).toMatchObject({ type: 'rule' })
  })

  test('the sandbox write allowlist opens writes outside the working dirs', () => {
    const allowed = lab.dir(join(lab.root, 'sbx-out'))
    withSandbox([allowed], [], () => {
      const result = isPathAllowed(join(allowed, 'f.txt'), permissionContext(), 'write')
      expect(result.allowed).toBe(true)
      expect(result.decisionReason).toMatchObject({ type: 'other' })
      if (result.decisionReason?.type === 'other') expect(result.decisionReason.reason).toMatch(/sandbox/i)
    })
  })

  test('the sandbox write allowlist does not lift the acceptEdits gate inside the working dirs', () => {
    withSandbox([lab.project], [], () => {
      expect(isPathAllowed(join(lab.project, 'f.txt'), permissionContext(), 'write')).toEqual({ allowed: false })
    })
  })

  test('the sandbox write allowlist does not open reads', () => {
    const allowed = lab.dir(join(lab.root, 'sbx-r'))
    withSandbox([allowed], [], () => {
      expect(isPathAllowed(join(allowed, 'f.txt'), permissionContext(), 'read')).toEqual({ allowed: false })
    })
  })

  test('the sandbox write allowlist does not lift the safety check', () => {
    const allowed = lab.dir(join(lab.root, 'sbx-s'))
    withSandbox([allowed], [], () => {
      expect(isPathAllowed(join(allowed, '.bashrc'), permissionContext(), 'write').decisionReason?.type).toBe(
        'safetyCheck',
      )
    })
  })

  test('a supplied list of forms replaces resolving the path', () => {
    const escape = lab.link(join(lab.project, 'esc'), lab.file(join(lab.outside, 's')))
    const ctx = permissionContext()
    expect(isPathAllowed(escape, ctx, 'read').allowed).toBe(false)
    expect(isPathAllowed(escape, ctx, 'read', [escape]).allowed).toBe(true)
  })
})

describe('validateGlobPattern', () => {
  test('checks the directory the glob expands in, resolved', () => {
    lab.dir(join(lab.project, 'src'))
    const result = validateGlobPattern('src/*.ts', lab.project, permissionContext(), 'read')
    expect(result).toEqual({ allowed: true, resolvedPath: join(lab.project, 'src'), decisionReason: undefined })
  })

  test('an absolute glob outside the working dirs is refused', () => {
    const result = validateGlobPattern(`${lab.outside}/*.conf`, lab.project, permissionContext(), 'read')
    expect(result.allowed).toBe(false)
    expect(result.resolvedPath).toBe(lab.outside)
  })

  test('a glob whose base directory links out is refused at the real directory', () => {
    lab.link(join(lab.project, 'linked'), lab.outside)
    const result = validateGlobPattern('linked/**/*.txt', lab.project, permissionContext(), 'read')
    expect(result.allowed).toBe(false)
    expect(result.resolvedPath).toBe(lab.outside)
  })

  test('a glob with a dot-dot is judged on the whole path, not its base', () => {
    const result = validateGlobPattern('sub/../../elsewhere/*.txt', lab.project, permissionContext(), 'read')
    expect(result.allowed).toBe(false)
    expect(result.resolvedPath).toBe(join(lab.outside, '*.txt'))
  })

  test('a glob with a dot-dot that stays inside is allowed', () => {
    const result = validateGlobPattern('a/../b/*.txt', lab.project, permissionContext(), 'read')
    expect(result.allowed).toBe(true)
    expect(result.resolvedPath).toBe(join(lab.project, 'b', '*.txt'))
  })

  test('the base of a bare glob is the cwd', () => {
    const result = validateGlobPattern('*.md', lab.project, permissionContext(), 'read')
    expect(result.resolvedPath).toBe(lab.project)
    expect(result.allowed).toBe(true)
  })
})

describe('validatePath', () => {
  const v = (path: string, op: FileOperationType = 'read', ctx = permissionContext()) =>
    validatePath(path, lab.project, ctx, op)

  test('a relative path is resolved against the given cwd', () => {
    const f = lab.file(join(lab.project, 'src', 'a.ts'))
    expect(v('src/a.ts')).toEqual({ allowed: true, resolvedPath: f, decisionReason: undefined })
  })

  test('the cwd argument decides, not the session cwd', () => {
    const r = validatePath('a.ts', lab.outside, permissionContext(), 'read')
    expect(r.resolvedPath).toBe(join(lab.outside, 'a.ts'))
    expect(r.allowed).toBe(false)
  })

  test('one quote is stripped from each end', () => {
    const f = lab.file(join(lab.project, 'q.txt'))
    for (const quoted of ['"q.txt"', "'q.txt'", '"q.txt', "q.txt'", `"${f}"`]) {
      expect(v(quoted).resolvedPath).toBe(f)
    }
    expect(v('""q.txt""').resolvedPath).toBe(join(lab.project, '"q.txt"'))
  })

  test('a path outside every working directory is refused', () => {
    const r = v(join(lab.outside, 'x.txt'))
    expect(r).toEqual({ allowed: false, resolvedPath: join(lab.outside, 'x.txt'), decisionReason: undefined })
  })

  test('a dot-dot that climbs out is refused at the normalized path', () => {
    const r = v('src/../../elsewhere/x.txt')
    expect(r.allowed).toBe(false)
    expect(r.resolvedPath).toBe(join(lab.outside, 'x.txt'))
  })

  test('a dot-dot that stays inside is allowed', () => {
    expect(v('src/../x.txt').allowed).toBe(true)
  })

  test('a symlink that leaves is refused, and reported at its target', () => {
    const target = lab.file(join(lab.outside, 'secret.txt'))
    lab.link(join(lab.project, 'alias.txt'), target)
    expect(v('alias.txt')).toMatchObject({ allowed: false, resolvedPath: target })
  })

  test('a directory symlink that leaves is refused for a new file under it', () => {
    lab.link(join(lab.project, 'out'), lab.outside)
    const r = v('out/new.txt', 'create', permissionContext({ mode: 'acceptEdits' }))
    expect(r.allowed).toBe(false)
  })

  test('a dangling symlink that leaves is refused', () => {
    lab.link(join(lab.project, 'later.txt'), join(lab.outside, 'later.txt'))
    expect(v('later.txt', 'write', permissionContext({ mode: 'acceptEdits' })).allowed).toBe(false)
  })

  test('a symlink that stays inside is allowed and reported at its target', () => {
    const target = lab.file(join(lab.project, 'real', 't.txt'))
    lab.link(join(lab.project, 'alias.txt'), target)
    expect(v('alias.txt')).toMatchObject({ allowed: true, resolvedPath: target })
  })

  test('a symlink to a shell rc file is refused for writing as a sensitive file', () => {
    const rc = lab.file(join(lab.project, '.bashrc'))
    lab.link(join(lab.project, 'notes.txt'), rc)
    const r = v('notes.txt', 'write', permissionContext({ mode: 'acceptEdits' }))
    expect(r.allowed).toBe(false)
    expect(r.decisionReason?.type).toBe('safetyCheck')
  })

  test('another case of the working directory is allowed when nothing exists there (parity, finding 2)', () => {
    const r = v(join(lab.project.toUpperCase(), 'new.txt'))
    expect(r.allowed).toBe(true)
  })

  test('~ and ~/ expand to the home directory', () => {
    const home = homedir()
    const name = 'filepaths-lab-absent-entry'
    const ctx = permissionContext({ dirs: [home] })
    expect(v(`~/${name}`, 'read', ctx)).toMatchObject({ allowed: true, resolvedPath: join(home, name) })
    expect(v(`~/${name}`).allowed).toBe(false)
    expect(v('~', 'read', ctx).allowed).toBe(true)
  })

  /** The four refusals that need a human, and the fact each reason states. */
  const refusals: Array<[string, string, FileOperationType, RegExp]> = [
    ['~root/.ssh/id_rsa', '~user', 'read', /tilde/i],
    ['~+/x', '~+', 'read', /tilde/i],
    ['~-/x', '~-', 'read', /tilde/i],
    ['~1', '~N', 'read', /tilde/i],
    ['"~root"', 'a quoted ~user', 'read', /tilde/i],
    ['$HOME/.ssh/id_rsa', '$VAR', 'read', /shell expansion/i],
    ['${HOME}/x', '${VAR}', 'read', /shell expansion/i],
    ['$(pwd)/x', '$(cmd)', 'write', /shell expansion/i],
    ['src/$x', 'a $ inside', 'read', /shell expansion/i],
    ['%USERPROFILE%\\x', '%VAR%', 'read', /shell expansion/i],
    ['50%.txt', 'a lone %', 'read', /shell expansion/i],
    ['=rg', 'zsh =cmd', 'read', /shell expansion/i],
    ['src/*.ts', 'a glob for write', 'write', /glob/i],
    ['src/{a,b}.ts', 'braces for create', 'create', /glob/i],
    ['src/a?.ts', 'a ? for write', 'write', /glob/i],
    ['src/[ab].ts', 'brackets for write', 'write', /glob/i],
  ]
  for (const [path, name, op, reason] of refusals) {
    test(`refused for a human: ${name} (${op})`, () => {
      const r = v(path, op, permissionContext({ mode: 'acceptEdits', dirs: [lab.root] }))
      expect(r.allowed).toBe(false)
      expect(r.decisionReason?.type).toBe('other')
      if (r.decisionReason?.type === 'other') expect(r.decisionReason.reason).toMatch(reason)
      expect(r.resolvedPath).toBe(path.replace(/^['"]|['"]$/g, ''))
    })
  }

  test('an = inside a path is fine', () => {
    expect(v('a=b.txt').allowed).toBe(true)
  })

  test('the tilde check comes before the expansion check', () => {
    const r = v('~$USER/x')
    expect(r.decisionReason?.type === 'other' && r.decisionReason.reason).toMatch(/tilde/i)
  })

  test('the expansion check comes before the glob check', () => {
    const r = v('$D/*.txt', 'write')
    expect(r.decisionReason?.type === 'other' && r.decisionReason.reason).toMatch(/shell expansion/i)
  })

  test('the glob refusal for writes asks for an exact path', () => {
    const r = v('*.log', 'write')
    expect(r.decisionReason?.type === 'other' && r.decisionReason.reason).toMatch(/exact file path/i)
  })

  test('a glob for read is judged by its base directory', () => {
    lab.dir(join(lab.project, 'src'))
    expect(v('src/**/*.ts')).toEqual({ allowed: true, resolvedPath: join(lab.project, 'src'), decisionReason: undefined })
    expect(v(`${lab.outside}/*.txt`).allowed).toBe(false)
  })

  test('a glob for read with a dot-dot is judged on the whole path', () => {
    const r = v('x/../../elsewhere/*')
    expect(r).toMatchObject({ allowed: false, resolvedPath: join(lab.outside, '*') })
  })

  test('a UNC path is refused for a human on Windows, before anything else', () => {
    lab.pretendPlatform('windows')
    for (const p of ['\\\\server\\share\\x.txt', '//server/share/x.txt', '"\\\\evil@SSL@443\\x"']) {
      const r = v(p)
      expect(r.allowed).toBe(false)
      expect(r.decisionReason?.type === 'other' && r.decisionReason.reason).toMatch(/UNC/)
    }
    const both = v('\\\\server\\$x')
    expect(both.decisionReason?.type === 'other' && both.decisionReason.reason).toMatch(/UNC/)
  })

  test('off Windows a UNC-looking path is an ordinary refused path', () => {
    lab.pretendPlatform('linux')
    const r = v('//server/share/x.txt')
    expect(r.allowed).toBe(false)
    expect(r.decisionReason).toBeUndefined()
    expect(r.resolvedPath).toBe('//server/share/x.txt')
  })

  test('a write in acceptEdits is allowed inside, refused in default mode', () => {
    expect(v('new.txt', 'write', permissionContext({ mode: 'acceptEdits' })).allowed).toBe(true)
    expect(v('new.txt', 'write').allowed).toBe(false)
  })
})

describe('the shell route and the memory carve-out (finding 1)', () => {
  test('a link to an existing file is judged at its target, so the carve-out does not apply', () => {
    lab.gitInit(lab.project)
    lab.forget()
    const secret = lab.file(join(lab.outside, 'id_rsa'), 'key')
    const link = lab.link(join(getAutoMemPath(), 'notes.md'), secret)
    for (const op of ['read', 'write'] as const) {
      const r = validatePath(link, lab.project, permissionContext(), op)
      expect(r.resolvedPath).toBe(secret)
      expect(r.allowed).toBe(false)
    }
  })

  test('a dangling link is judged at the link, so a write through it is allowed (finding 1)', () => {
    lab.gitInit(lab.project)
    lab.forget()
    const absent = join(lab.outside, 'authorized_keys')
    const link = lab.link(join(getAutoMemPath(), 'keys.md'), absent)
    const r = validatePath(link, lab.project, permissionContext(), 'write')
    expect(r.resolvedPath).toBe(link)
    expect(r.allowed).toBe(true)
    expect(r.decisionReason?.type === 'other' && r.decisionReason.reason).toMatch(/auto memory/i)
  })
})
