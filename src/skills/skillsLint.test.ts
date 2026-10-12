import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  type LintSkillFilesOptions,
  type SkillLintFinding,
  lintSkillFiles,
} from 'src/skills/skillsLint.js'

function makeDir(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, relPath)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

/** A project (`.claudin/…`) and a user config home (`skills/…`), both temporary. */
async function lint(
  project: Record<string, string>,
  user: Record<string, string> = {},
  options: Omit<LintSkillFilesOptions, 'root' | 'configHome'> = {},
) {
  const root = makeDir('skillslint-project-', project)
  const configHome = makeDir('skillslint-home-', user)
  const result = await lintSkillFiles({ root, configHome, ...options })
  return { ...result, root, configHome }
}

function skill(frontmatter: string, body = 'Do the thing.'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`
}

function kinds(findings: SkillLintFinding[]): string[] {
  return findings.map(f => f.kind)
}

const OK = skill('description: Summarize the diff before a commit')

describe('discovery', () => {
  test('finds user, project and legacy skills in loader precedence order', async () => {
    const { skills, filesChecked } = await lint(
      {
        '.claudin/skills/deploy/SKILL.md': OK,
        '.claudin/skills/ops/rollback/SKILL.md': OK,
        '.claudin/commands/old.md': OK,
      },
      { 'skills/mine/SKILL.md': OK },
    )
    expect(skills.map(s => [s.name, s.scope, s.legacy])).toEqual([
      ['mine', 'user', false],
      ['deploy', 'project', false],
      ['ops:rollback', 'project', false],
      ['old', 'project', true],
    ])
    expect(filesChecked).toBe(4)
  })

  test('a clean skill has no findings', async () => {
    const { findings, skills } = await lint({ '.claudin/skills/deploy/SKILL.md': OK })
    expect(findings).toEqual([])
    expect(skills[0]).toMatchObject({
      description: 'Summarize the diff before a commit',
      hasDescription: true,
      modelInvocable: true,
      userInvocable: true,
      conditional: false,
    })
  })

  test('a SKILL.md in a legacy commands dir hides its siblings, like the loader', async () => {
    const { skills } = await lint({
      '.claudin/commands/tool/SKILL.md': OK,
      '.claudin/commands/tool/helper.md': OK,
    })
    expect(skills.map(s => s.name)).toEqual(['tool'])
  })
})

describe('frontmatter that the loader loses', () => {
  test('YAML that never parses drops every key', async () => {
    const { findings, skills } = await lint({
      '.claudin/skills/a/SKILL.md': skill('description: "unclosed\nuser-invocable: false'),
    })
    expect(kinds(findings)).toContain('yaml_error')
    expect(findings.find(f => f.kind === 'yaml_error')?.severity).toBe('error')
    // The loader falls back to the body, and to the defaults.
    expect(skills[0]).toMatchObject({ description: 'Do the thing.', userInvocable: true })
  })

  test('frontmatter that is a list rather than a mapping is ignored whole', async () => {
    const { findings } = await lint({
      '.claudin/skills/a/SKILL.md': skill('- description\n- user-invocable'),
      '.claudin/skills/b/SKILL.md': '---\n---\nEmpty frontmatter is just absent.\n',
    })
    expect(findings.map(f => [f.file.split('/').at(-2), f.kind])).toEqual([
      ['a', 'yaml_error'],
      ['a', 'missing_description'],
      ['b', 'missing_description'],
    ])
  })

  test('a description that is a list is dropped', async () => {
    const { findings, skills } = await lint({
      '.claudin/skills/a/SKILL.md': skill('description:\n  - one\n  - two'),
    })
    expect(kinds(findings)).toEqual(['bad_value', 'missing_description'])
    expect(skills[0]?.description).toBe('Do the thing.')
  })

  test('YAML that parses only after the loader quotes it is a warning', async () => {
    const { findings, skills } = await lint({
      '.claudin/skills/a/SKILL.md': skill('description: Use when: the build fails'),
    })
    expect(kinds(findings)).toEqual(['yaml_autoquoted'])
    expect(skills[0]?.description).toBe('Use when: the build fails')
  })

  test('an unquoted " #" cuts the value', async () => {
    const { findings, skills } = await lint({
      '.claudin/skills/a/SKILL.md': skill('name: a\ndescription: Fixes the regression from #242 in CI'),
    })
    const finding = findings.find(f => f.kind === 'truncated_value')
    expect(finding?.line).toBe(3)
    expect(finding?.message).toContain('"Fixes the regression from"')
    expect(skills[0]?.description).toBe('Fixes the regression from')
  })

  test('a quoted " #" is fine', async () => {
    const { findings } = await lint({
      '.claudin/skills/a/SKILL.md': skill('description: "Fixes the regression from #242"'),
    })
    expect(findings).toEqual([])
  })

  test('unknown keys are reported, with the spelling the loader reads', async () => {
    const { findings } = await lint({
      '.claudin/skills/a/SKILL.md': skill(
        'description: x is the thing\nwhenToUse: when y\nglobs: src/**\nlicense: MIT\ncolour: red',
      ),
    })
    const unsupported = findings.filter(f => f.kind === 'unsupported_key')
    expect(unsupported.map(f => f.message.split('`')[1])).toEqual(['whenToUse', 'globs', 'colour'])
    expect(unsupported[0]?.fix).toContain('`when_to_use`')
    expect(unsupported[1]?.fix).toContain('`paths`')
  })

  test('a boolean the loader reads as false is an error', async () => {
    const { findings, skills } = await lint({
      '.claudin/skills/a/SKILL.md': skill('description: x\nuser-invocable: yes'),
      '.claudin/skills/b/SKILL.md': skill('description: x\ndisable-model-invocation: "true"'),
    })
    expect(kinds(findings)).toEqual(['bad_boolean'])
    expect(findings[0]?.message).toContain('hidden from the / menu')
    expect(skills.map(s => [s.name, s.userInvocable, s.modelInvocable])).toEqual([
      ['a', false, true],
      ['b', true, false],
    ])
  })

  test('values the loader ignores or degrades are reported', async () => {
    const { findings } = await lint({
      '.claudin/skills/a/SKILL.md': skill(
        [
          'description: x',
          'context: inline',
          'agent: Explore',
          'effort: turbo',
          'arguments:',
          '  - name: repo',
          'paths:',
          '  src: 1',
          'allowed-tools: 3',
          'shell: zsh',
        ].join('\n'),
      ),
    })
    const messages = findings.filter(f => f.kind === 'bad_value').map(f => f.message)
    expect(messages).toHaveLength(7)
    expect(messages.join('\n')).toContain('`context: inline`')
    expect(messages.join('\n')).toContain('`agent` is only used with `context: fork`')
    expect(messages.join('\n')).toContain('`effort: turbo`')
    expect(messages.join('\n')).toContain('`arguments`')
    expect(messages.join('\n')).toContain('loads unconditionally')
    expect(messages.join('\n')).toContain('`allowed-tools`')
    expect(messages.join('\n')).toContain('`shell: zsh`')
  })

  test('hooks that fail the schema are an error', async () => {
    const { findings } = await lint({
      '.claudin/skills/a/SKILL.md': skill(
        'description: x\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: shell',
      ),
    })
    expect(findings.map(f => [f.kind, f.severity])).toEqual([['bad_value', 'error']])
    expect(findings[0]?.message).toContain('none of them register')
  })

  test('valid hooks pass', async () => {
    const { findings } = await lint({
      '.claudin/skills/a/SKILL.md': skill(
        'description: x\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: echo hi',
      ),
    })
    expect(findings).toEqual([])
  })
})

describe('what the model and the user can see', () => {
  test('no description falls back to the first body line', async () => {
    const { findings, skills } = await lint({
      '.claudin/skills/a/SKILL.md': '# Release checklist\n\nSteps…\n',
    })
    expect(kinds(findings)).toEqual(['missing_description'])
    expect(findings[0]?.message).toContain('"Release checklist"')
    expect(skills[0]).toMatchObject({ description: 'Release checklist', hasDescription: false })
  })

  test('when_to_use pushed past the listing cap never reaches the model', async () => {
    const { findings } = await lint(
      {
        '.claudin/skills/a/SKILL.md': skill(`description: ${'d'.repeat(98)}\nwhen_to_use: when deploying`),
        '.claudin/skills/b/SKILL.md': skill(`description: ${'d'.repeat(120)}`),
        '.claudin/skills/c/SKILL.md': skill(
          `description: ${'d'.repeat(120)}\ndisable-model-invocation: true`,
        ),
      },
      {},
      { listingCap: 100 },
    )
    const truncated = findings.filter(f => f.kind === 'listing_truncated')
    expect(truncated.map(f => f.file.split('/').at(-2))).toEqual(['a', 'b'])
    expect(truncated[0]?.message).toContain('`when_to_use` never reaches the model')
    expect(truncated[1]?.message).toContain('it is 120')
  })

  test('a skill nobody can invoke is an error', async () => {
    const { findings } = await lint({
      '.claudin/skills/a/SKILL.md': skill(
        'description: x\nuser-invocable: false\ndisable-model-invocation: true',
      ),
    })
    expect(findings.map(f => [f.kind, f.severity])).toEqual([['unreachable', 'error']])
  })

  test('a frontmatter name that is not the invoked name', async () => {
    const { findings } = await lint({
      '.claudin/skills/deploy/SKILL.md': skill('name: ship\ndescription: x'),
      '.claudin/skills/ok/SKILL.md': skill('name: ok\ndescription: x'),
      '.claudin/skills/cat/leaf/SKILL.md': skill('name: leaf\ndescription: x'),
    })
    expect(findings.map(f => f.kind)).toEqual(['name_mismatch'])
    expect(findings[0]?.message).toContain('invoked as `/deploy`')
  })
})

describe('files the loader skips', () => {
  test('markdown that is not a SKILL.md and belongs to no skill', async () => {
    const { findings } = await lint({
      '.claudin/skills/loose.md': OK,
      '.claudin/skills/foo/SKILL.md': OK,
      '.claudin/skills/foo/reference.md': 'details',
      '.claudin/skills/foo/docs/deep.md': 'details',
      '.claudin/skills/bar/bar.md': OK,
    })
    const ignored = findings.filter(f => f.kind === 'ignored_file')
    expect(ignored.map(f => f.file.split('/.claudin/skills/')[1])).toEqual(['bar/bar.md', 'loose.md'])
    expect(ignored[1]?.fix).toContain('`skills/loose/SKILL.md`')
  })

  test('legacy commands are flagged with their new home', async () => {
    const { findings } = await lint({ '.claudin/commands/ops/old.md': OK })
    expect(findings.map(f => f.kind)).toEqual(['legacy_command'])
    expect(findings[0]?.fix).toContain('`skills/ops/old/SKILL.md`')
  })
})

describe('names', () => {
  test('collisions with built-ins, bundled skills and other skills', async () => {
    const { findings } = await lint(
      {
        '.claudin/skills/review/SKILL.md': OK,
        '.claudin/skills/create/SKILL.md': OK,
        '.claudin/skills/dup/SKILL.md': OK,
      },
      { 'skills/dup/SKILL.md': OK },
      { builtinNames: new Set(['review', 'help']), bundledNames: new Set(['create']) },
    )
    const byKind = Object.fromEntries(findings.map(f => [f.kind, f]))
    expect(Object.keys(byKind).sort()).toEqual([
      'duplicate_name',
      'shadowed_by_bundled',
      'shadows_builtin',
    ])
    expect(byKind.shadows_builtin?.severity).toBe('warning')
    expect(byKind.shadowed_by_bundled?.severity).toBe('error')
    // The user skill is loaded first, so the project copy is the one that never runs.
    expect(byKind.duplicate_name?.file).toContain('skillslint-project-')
    expect(byKind.duplicate_name?.message).toContain('skillslint-home-')
  })
})
