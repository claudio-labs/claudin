/**
 * What a caller of the plan-file module can observe: where plans live, what a
 * session's plan file is called, how a resumed or forked session gets its
 * plan back, and which slug each session id holds.
 *
 * Everything runs for real inside a worktree lab: settings come from a temp
 * config directory, the session root is a fresh temp project per test, and
 * HOME points into the lab so the global git excludes file is a temp one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  clearAllPlanSlugs,
  clearPlanSlug,
  copyPlanForFork,
  copyPlanForResume,
  getPlan,
  getPlanFilePath,
  getPlanSlug,
  getPlansDirectory,
  setPlanSlug,
} from 'src/agent/plans/plans.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import type { AgentId, SessionId } from 'src/shared/types/ids.js'
import type { LogOption } from 'src/shared/types/logs.js'
import { openWorktreeLab, type WorktreeLab } from 'src/vcs/git/__testutils__/worktreeLab.js'

let lab: WorktreeLab
let project: string

beforeAll(() => {
  lab = openWorktreeLab()
  // A remote-session marker would switch resume onto the recovery path.
  lab.env.set('CLAUDE_CODE_ENVIRONMENT_KIND', undefined)
})

afterAll(() => {
  clearAllPlanSlugs()
  lab.close()
})

beforeEach(() => {
  clearAllPlanSlugs()
  lab.writeSettings({})
  project = lab.git.tempDir('plans-project')
})

/** Runs `action` with the session rooted at the current test's project. */
function inProject<T>(action: () => T): T {
  return lab.inSession(project, action)
}

/** A transcript whose messages carry `slug` the way a recorded session does. */
function transcriptWithSlug(slug: string | undefined): LogOption {
  const messages = [
    { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'start' } },
    { type: 'assistant', uuid: 'a-1', ...(slug === undefined ? {} : { slug }), message: { role: 'assistant', content: [] } },
  ]
  return { messages } as unknown as LogOption
}

const session = (label: string): SessionId => `session-${label}-${Math.random().toString(36).slice(2)}` as SessionId

describe('the plans directory', () => {
  const layouts: Array<{ name: string; setting: string | undefined; expected: (root: string) => string }> = [
    { name: 'no setting puts plans under .claudin/plans', setting: undefined, expected: root => join(root, '.claudin', 'plans') },
    { name: 'a relative setting resolves against the project', setting: 'docs/my-plans', expected: root => join(root, 'docs', 'my-plans') },
    { name: 'a setting that climbs out of the project is refused', setting: '../elsewhere', expected: root => join(root, '.claudin', 'plans') },
  ]

  for (const layout of layouts) {
    test(layout.name, () => {
      lab.writeSettings(layout.setting === undefined ? {} : { plansDirectory: layout.setting })
      const dir = inProject(() => getPlansDirectory())
      expect(dir).toBe(layout.expected(project))
      expect(statSync(dir).isDirectory()).toBe(true)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    })
  }

  // Each of these leaves a project-local path that cannot be proven to stay
  // inside the project, so plans go to the config directory instead.
  const unsafe: Array<{ name: string; plant: (root: string) => void }> = [
    { name: 'a .claudin symlink to another directory', plant: root => symlinkSync(lab.git.tempDir('plans-outside'), join(root, '.claudin'), 'dir') },
    { name: 'a .claudin symlink to nothing yet', plant: root => symlinkSync(join(root, '..', 'not-there-yet'), join(root, '.claudin'), 'dir') },
    { name: 'a .claudin regular file', plant: root => writeFileSync(join(root, '.claudin'), 'not a directory') },
  ]

  for (const layout of unsafe) {
    test(`${layout.name} sends plans to the config directory`, () => {
      layout.plant(project)
      const dir = inProject(() => getPlansDirectory())
      expect(dir).toBe(join(lab.configDir, 'plans'))
      expect(statSync(dir).isDirectory()).toBe(true)
    })
  }

  test('the answer is remembered per session root until the cache is dropped', () => {
    const first = inProject(() => getPlansDirectory())
    lab.writeSettings({ plansDirectory: 'later' })
    expect(inProject(() => getPlansDirectory())).toBe(first)
    getPlansDirectory.cache.clear?.()
    expect(inProject(() => getPlansDirectory())).toBe(join(project, 'later'))
  })
})

describe('plan slugs', () => {
  test('a session gets a three-word slug once and keeps it', () => {
    const id = session('slug')
    const slug = inProject(() => getPlanSlug(id))
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/)
    expect(inProject(() => getPlanSlug(id))).toBe(slug)
  })

  test('set, clear and clear-all act on the ids they are given', () => {
    const [a, b, c] = [session('a'), session('b'), session('c')]
    setPlanSlug(a, 'alpha-plan')
    setPlanSlug(b, 'beta-plan')
    setPlanSlug(c, 'gamma-plan')

    clearPlanSlug(b)
    const afterOne = inProject(() => [getPlanSlug(a), getPlanSlug(b), getPlanSlug(c)])
    expect(afterOne[0]).toBe('alpha-plan')
    expect(afterOne[1]).not.toBe('beta-plan')
    expect(afterOne[2]).toBe('gamma-plan')

    clearAllPlanSlugs()
    const afterAll = inProject(() => [getPlanSlug(a), getPlanSlug(c)])
    expect(afterAll).not.toContain('alpha-plan')
    expect(afterAll).not.toContain('gamma-plan')
  })

  test('without an id, clear acts on the current session', () => {
    setPlanSlug(getSessionId(), 'current-session-plan')
    clearPlanSlug()
    expect(inProject(() => getPlanSlug())).not.toBe('current-session-plan')
  })
})

describe('plan files', () => {
  test('the main thread and each sub-agent get their own file next to each other', () => {
    setPlanSlug(getSessionId(), 'shared-slug')
    const paths = inProject(() => ({
      main: getPlanFilePath(),
      child: getPlanFilePath('a1b2c3' as AgentId),
      dir: getPlansDirectory(),
    }))
    expect(paths.main).toBe(join(paths.dir, 'shared-slug.md'))
    expect(paths.child).toBe(join(paths.dir, 'shared-slug-agent-a1b2c3.md'))
  })

  test('reading a plan returns null until it is written, then its text', () => {
    setPlanSlug(getSessionId(), 'readable-plan')
    const child = 'f00d' as AgentId
    expect(inProject(() => [getPlan(), getPlan(child)])).toEqual([null, null])

    inProject(() => {
      writeFileSync(getPlanFilePath(), '# main plan\n')
      writeFileSync(getPlanFilePath(child), '# child plan\n')
    })
    expect(inProject(() => [getPlan(), getPlan(child)])).toEqual(['# main plan\n', '# child plan\n'])
  })

  test('a plan path that cannot be read as a file reads as no plan', () => {
    setPlanSlug(getSessionId(), 'a-directory-plan')
    inProject(() => mkdirSync(getPlanFilePath()))
    expect(inProject(() => getPlan())).toBeNull()
  })
})

describe('copying a plan for a resumed session', () => {
  test('a transcript without a slug restores nothing', async () => {
    const target = session('resume-none')
    expect(await inProject(() => copyPlanForResume(transcriptWithSlug(undefined), target))).toBe(false)
    expect(inProject(() => getPlanSlug(target))).not.toBe('none')
  })

  test('the transcript slug is adopted, and the result says whether its file is there', async () => {
    const cases = [
      { slug: 'present-plan-file', write: true, expected: true },
      { slug: 'absent-plan-file', write: false, expected: false },
    ]
    for (const c of cases) {
      const target = session(c.slug)
      if (c.write) inProject(() => writeFileSync(join(getPlansDirectory(), `${c.slug}.md`), 'kept'))
      const restored = await inProject(() => copyPlanForResume(transcriptWithSlug(c.slug), target))
      expect({ slug: c.slug, restored }).toEqual({ slug: c.slug, restored: c.expected })
      expect(inProject(() => getPlanSlug(target))).toBe(c.slug)
      expect(existsSync(inProject(() => join(getPlansDirectory(), `${c.slug}.md`)))).toBe(c.write)
    }
  })

  test('without a target id the current session takes the slug', async () => {
    clearPlanSlug()
    expect(await inProject(() => copyPlanForResume(transcriptWithSlug('current-resumed')))).toBe(false)
    expect(inProject(() => getPlanSlug())).toBe('current-resumed')
  })

  test('a plan path that is not a readable file is reported as not restored', async () => {
    const target = session('resume-dir')
    inProject(() => mkdirSync(join(getPlansDirectory(), 'dir-shaped.md')))
    expect(await inProject(() => copyPlanForResume(transcriptWithSlug('dir-shaped'), target))).toBe(false)
  })
})

describe('copying a plan for a forked session', () => {
  test('the fork gets a new slug holding a copy of the original plan', async () => {
    const target = session('fork')
    inProject(() => writeFileSync(join(getPlansDirectory(), 'origin-plan.md'), '# the original\n'))
    expect(await inProject(() => copyPlanForFork(transcriptWithSlug('origin-plan'), target))).toBe(true)

    const forkSlug = inProject(() => getPlanSlug(target))
    expect(forkSlug).not.toBe('origin-plan')
    const dir = inProject(() => getPlansDirectory())
    expect(readFileSync(join(dir, `${forkSlug}.md`), 'utf8')).toBe('# the original\n')
    expect(readFileSync(join(dir, 'origin-plan.md'), 'utf8')).toBe('# the original\n')
  })

  test('nothing is copied when there is no slug or no original file', async () => {
    const outcomes = await inProject(async () => [
      await copyPlanForFork(transcriptWithSlug(undefined), session('fork-noslug')),
      await copyPlanForFork(transcriptWithSlug('never-written'), session('fork-nofile')),
    ])
    expect(outcomes).toEqual([false, false])
  })

  test('a copy that fails for another reason is reported as not copied', async () => {
    const target = session('fork-blocked')
    setPlanSlug(target, 'blocked-target')
    const dir = inProject(() => getPlansDirectory())
    writeFileSync(join(dir, 'source-plan.md'), 'text')
    mkdirSync(join(dir, 'blocked-target.md'))
    expect(await inProject(() => copyPlanForFork(transcriptWithSlug('source-plan'), target))).toBe(false)
    expect(statSync(join(dir, 'blocked-target.md')).isDirectory()).toBe(true)
  })
})
