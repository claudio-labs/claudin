/**
 * Characterization of the two memory prompts a shipped build puts in the
 * system prompt (`teamMemPrompts.ts`): the full one and the lean (v2) one,
 * both for a private directory plus the git-tracked team directory, and the
 * `.gitignore` advice they add when the team directory would be ignored.
 *
 * `loadMemoryPrompt` only reaches these behind the team build flag, which reads
 * false under `bun test`, so they are driven through their own exports. The
 * directories come from a real repository entered as the session's project.
 *
 * Since 2026-09-29 the lean prompt leaves its write-time rules (links, the team
 * subdirectories, the index line, `paths:`) to `buildMemoryWriteRules`, which a
 * refused memory write hands back; those facts are checked on what the model is
 * taught in total, `taught()`.
 */
import { describe, expect, test } from 'bun:test'
import { cpSync } from 'node:fs'
import { join, sep } from 'node:path'
import {
  buildCombinedMemoryPrompt,
  buildLeanCombinedMemoryPrompt,
  buildMemoryWriteRules,
} from 'src/memory/memdir/teamMemPrompts.js'
import {
  buildSearchingPastContextSection,
  DIRS_EXIST_GUIDANCE,
  MAX_ENTRYPOINT_LINES,
} from 'src/memory/memdir/memdir.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  MEMORY_TYPES,
  renderTeamCategoriesCompact,
  renderTeamCategoriesLean,
  TEAM_CATEGORIES,
} from 'src/memory/memdir/memoryTypes.js'
import { useMemdirWorld } from 'src/memory/memdir/__testutils__/memdirWorld.js'

const world = useMemdirWorld()

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')

type Builder = (extraGuidelines?: string[], indexesEmpty?: boolean) => string

const BUILDERS: Array<[string, Builder]> = [
  ['full', buildCombinedMemoryPrompt],
  ['lean', buildLeanCombinedMemoryPrompt],
]

const IGNORE_FIX = ['/.claudin/*', '!/.claudin/memory/', '/.claudin/memory/*', '!/.claudin/memory/team/']

/** Enters a fresh repository, optionally with one of the .gitignore fixtures. */
function enterRepo(gitignore?: string): { repo: string; autoDir: string; teamDir: string } {
  const w = world()
  const repo = w.repo(join(w.root, 'repo'))
  if (gitignore) cpSync(join(FIXTURES, 'gitignore', gitignore), join(repo, '.gitignore'))
  w.enter(repo)
  const autoDir = join(repo, '.claudin', 'memory') + sep
  return { repo, autoDir, teamDir: join(repo, '.claudin', 'memory', 'team') + sep }
}

/** The stretch of `text` that talks about `type`, up to the next type named in backticks. */
function typeClause(text: string, type: string): string {
  const start = text.indexOf(`\`${type}\``)
  if (start === -1) throw new Error(`type ${type} is not named`)
  let end = text.indexOf('\n', start)
  if (end === -1) end = text.length
  for (const other of MEMORY_TYPES) {
    if (other === type) continue
    const at = text.indexOf(`\`${other}\``, start + 1)
    if (at !== -1 && at < end) end = at
  }
  return text.slice(start, end)
}

function hasIgnoreAdvice(prompt: string): boolean {
  return prompt.split('\n').includes('!/.claudin/memory/team/')
}

/** The prompt, plus the write rules a refused write brings back for the lean one. */
function taught(build: Builder, teamDir: string): string {
  return build === buildLeanCombinedMemoryPrompt
    ? `${build()}\n${buildMemoryWriteRules(teamDir)}`
    : build()
}

describe.each(BUILDERS)('the %s combined prompt', (_name, build) => {
  test('names both directories, the team one as git-tracked, and says they exist', () => {
    const { autoDir, teamDir } = enterRepo()
    const prompt = build()
    expect(prompt.split('\n')[0]).toBe('# Memory')
    expect(prompt).toContain(`\`${autoDir}\``)
    expect(prompt).toContain(`\`${teamDir}\``)
    expect(prompt).toMatch(/private/)
    expect(prompt).toContain('git-tracked')
    expect(prompt).toContain('`git status`')
    expect(prompt).toMatch(/commits/)
    expect(prompt).toContain(DIRS_EXIST_GUIDANCE)
  })

  test('remember saves now, forget finds and removes', () => {
    enterRepo()
    const prompt = build()
    expect(prompt).toMatch(/remember/)
    expect(prompt).toMatch(/forget/)
    expect(prompt).toMatch(/remove/)
  })

  test('shows the frontmatter example whole and explains [[name]] links', () => {
    const { teamDir } = enterRepo()
    const lines = build().split('\n')
    const start = lines.indexOf(MEMORY_FRONTMATTER_EXAMPLE[0]!)
    expect(lines.slice(start, start + MEMORY_FRONTMATTER_EXAMPLE.length)).toEqual([
      ...MEMORY_FRONTMATTER_EXAMPLE,
    ])
    expect(taught(build, teamDir)).toContain('`[[name]]`')
    expect(taught(build, teamDir)).toContain('`name:`')
  })

  test('gives each type its scope: user private, feedback private unless a convention, project and reference team', () => {
    enterRepo()
    const prompt = build()
    expect(typeClause(prompt, 'user')).toMatch(/always private/)
    const feedback = typeClause(prompt, 'feedback')
    expect(feedback).toMatch(/team/)
    expect(feedback).toMatch(/convention/)
    // The lean types line leaves Why/How to the frontmatter template.
    const whyHow = build === buildCombinedMemoryPrompt ? feedback : prompt
    expect(whyHow).toContain('**Why:**')
    expect(whyHow).toContain('**How to apply:**')
    expect(typeClause(prompt, 'project')).toMatch(/team/)
    expect(typeClause(prompt, 'project')).toMatch(/absolute/)
    expect(typeClause(prompt, 'reference')).toMatch(/team/)
  })

  test('the team categories, then the team root for anything else', () => {
    const { teamDir } = enterRepo()
    const lines = taught(build, teamDir).split('\n')
    const rendered =
      build === buildCombinedMemoryPrompt
        ? renderTeamCategoriesCompact(teamDir)
        : renderTeamCategoriesLean(teamDir)
    const start = lines.indexOf(rendered[0]!)
    expect(start).toBeGreaterThan(0)
    expect(lines.slice(start, start + rendered.length)).toEqual(rendered)
    expect(lines[start + rendered.length]).toMatch(/team root/)
  })

  test('the indexes: both in context, the pointer line, the sections, the 200-line cut', () => {
    const { teamDir } = enterRepo()
    const prompt = taught(build, teamDir)
    expect(prompt).toContain('`MEMORY.md`')
    expect(prompt).toMatch(/indexes/)
    expect(prompt).toMatch(/`- \[Title\]\(file\.md\) — [^`]*hook`/)
    expect(prompt).toMatch(/150/)
    for (const category of TEAM_CATEGORIES) expect(prompt).toContain(`## ${category.section}`)
    expect(prompt).toContain('## Decisions / ## Bugs / ## Docs')
    expect(prompt).toMatch(/subdirectory/)
    expect(prompt).toMatch(/link/)
    expect(prompt).toContain(`${MAX_ENTRYPOINT_LINES}`)
    expect(prompt).toMatch(/truncated/)
  })

  test('paths: works like a rule, relative to the project root, on the first matching Read', () => {
    const { teamDir } = enterRepo()
    const prompt = taught(build, teamDir)
    expect(prompt).toContain('`paths:`')
    expect(prompt).toMatch(/rule/)
    expect(prompt).toMatch(/project root/)
    expect(prompt).toMatch(/Read/)
  })

  test('updates rather than duplicates, skips the derivable, never puts secrets in team memory', () => {
    enterRepo()
    const prompt = build()
    expect(prompt).toMatch(/duplicat/)
    expect(prompt).toMatch(/git history/)
    expect(prompt).toMatch(/(never[^.\n]*secrets|secrets[^.\n]*never)[^.\n]*team memory/i)
  })

  test('recall: check when asked, empty when told to ignore it, background not instructions, verify', () => {
    enterRepo()
    const prompt = build()
    expect(prompt).toMatch(/recall/)
    expect(prompt).toMatch(/ignore/)
    expect(prompt).toContain('`<system-reminder>`')
    expect(prompt).toMatch(/not[^.\n]{0,40}instructions/)
    expect(prompt).toMatch(/verify/)
  })

  test('plans and task lists stay out of memory', () => {
    enterRepo()
    expect(build()).toMatch(/Plan/)
    expect(build()).toMatch(/task/)
  })

  test('extra guidelines appear, each on its own line, before the search section', () => {
    enterRepo()
    const lines = build(['GUIDE-ONE', 'GUIDE-TWO']).split('\n')
    const at = lines.indexOf('GUIDE-ONE')
    expect(at).toBeGreaterThan(0)
    expect(lines[at + 1]).toBe('GUIDE-TWO')
    expect(lines.findIndex(line => line.includes('glob="*.jsonl"'))).toBeGreaterThan(at)
  })

  test('the empty-index note is one insertion right after the index sentence, and the only change', () => {
    enterRepo()
    const shipped = build()
    const noted = build(undefined, true)
    expect(build(undefined, false)).toBe(shipped)
    expect(noted.length).toBeGreaterThan(shipped.length)
    let at = 0
    while (noted[at] === shipped[at]) at++
    const inserted = noted.slice(at, at + noted.length - shipped.length)
    expect(noted).toBe(shipped.slice(0, at) + inserted + shipped.slice(at))
    expect(inserted).toMatch(/empty/)
    expect(inserted).toMatch(/nothing/)
    expect(noted.split(inserted)).toHaveLength(2)
    const line = noted.split('\n').find(l => l.includes(inserted))!
    expect(line.indexOf('indexes')).toBeLessThan(line.indexOf(inserted))
    expect(line.indexOf(inserted) + inserted.length).toBeLessThan(line.length)
  })
})

describe('where each prompt ends', () => {
  test('only the full prompt spells out a categorized index line; the lean one leaves the index rules to the write rules', () => {
    const { teamDir } = enterRepo()
    const full = buildCombinedMemoryPrompt()
    expect(full).toContain('`- [Title](bugs/file.md) — hook`')
    expect(full).toContain('`- [Title](file.md) — one-line hook`')
    expect(full).toMatch(/no frontmatter/)
    expect(full).toMatch(/topic/)
    expect(buildLeanCombinedMemoryPrompt()).not.toContain('`- [Title](file.md) — hook`')
    expect(buildMemoryWriteRules(teamDir)).toContain('`- [Title](file.md) — hook`')
  })

  test('the full prompt ends with the full past-context section for the private directory', () => {
    const { autoDir } = enterRepo()
    const lines = buildCombinedMemoryPrompt().split('\n')
    const section = buildSearchingPastContextSection(autoDir)
    expect(lines.slice(-section.length)).toEqual(section)
  })

  test('the lean prompt ends with the one-line search', () => {
    const { autoDir } = enterRepo()
    const lines = buildLeanCombinedMemoryPrompt().split('\n')
    expect(lines.at(-1)).toBe(buildSearchingPastContextSection(autoDir, true)[0])
    expect(lines).not.toContain('## Searching past context')
  })

  test('with the search switched off, neither prompt names the transcripts', () => {
    enterRepo()
    process.env.CLAUDIN_MEMORY_PAST_CONTEXT = 'off'
    for (const [, build] of BUILDERS) expect(build()).not.toContain('*.jsonl')
  })

  test('the lean prompt is under two thirds of the full one', () => {
    enterRepo()
    expect(buildLeanCombinedMemoryPrompt().length).toBeLessThan(
      (buildCombinedMemoryPrompt().length * 2) / 3,
    )
  })
})

describe('the .gitignore advice', () => {
  test.each(BUILDERS)('%s: a blanket ignore of .claudin/ in the repository adds the carve-out', (_name, build) => {
    const { teamDir } = enterRepo('blanket.gitignore')
    const lines = build().split('\n')
    const fence = lines.indexOf(IGNORE_FIX[0]!) - 1
    expect(lines[fence]).toBe('```')
    expect(lines.slice(fence + 1, fence + 1 + IGNORE_FIX.length)).toEqual(IGNORE_FIX)
    expect(lines[fence + 1 + IGNORE_FIX.length]).toBe('```')
    const advice = lines[fence - 1]!
    expect(advice).toContain('`.gitignore`')
    expect(advice).toContain('`.claudin/`')
    expect(advice).toContain(`\`${teamDir}\``)
    expect(advice).toMatch(/approve/)
    expect(advice).toMatch(/ask/)
  })

  test.each(BUILDERS)('%s: the advice comes before the search section', (_name, build) => {
    enterRepo('blanket-no-slash.gitignore')
    const lines = build().split('\n')
    const advice = lines.indexOf('!/.claudin/memory/team/')
    const search = lines.findIndex(line => line.includes('glob="*.jsonl"'))
    expect(advice).toBeGreaterThan(0)
    expect(search).toBeGreaterThan(advice)
  })

  test.each([
    ['carved-out.gitignore'],
    ['star-only.gitignore'],
    ['unrelated.gitignore'],
    [undefined],
  ])('no advice with %p', gitignore => {
    enterRepo(gitignore)
    for (const [, build] of BUILDERS) expect(hasIgnoreAdvice(build())).toBe(false)
  })

  test('no advice when the memory is not inside the repository', () => {
    const w = world()
    enterRepo('blanket.gitignore')
    w.settings('user', { autoMemoryProjectLocal: false })
    for (const [, build] of BUILDERS) expect(hasIgnoreAdvice(build())).toBe(false)

    w.settings('user', { autoMemoryDirectory: join(w.root, 'elsewhere') })
    for (const [, build] of BUILDERS) expect(hasIgnoreAdvice(build())).toBe(false)
  })

  test('no advice outside a repository', () => {
    const w = world()
    cpSync(join(FIXTURES, 'gitignore', 'blanket.gitignore'), join(w.project, '.gitignore'))
    for (const [, build] of BUILDERS) expect(hasIgnoreAdvice(build())).toBe(false)
  })
})
