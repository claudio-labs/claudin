import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Command } from 'src/shared/types/command.js'
import {
  nameScopedSkills,
  scopedVariantNote,
  skillScope,
  type ScopedSkill,
  type SkillCommand,
} from 'src/skills/scopedSkills.js'

const ROOT = join('/', 'repo')

function skill(name: string, skillRoot: string, extra: Partial<SkillCommand> = {}): SkillCommand {
  return { type: 'prompt', name, description: `${name} things`, userFacingName: () => name, skillRoot, ...extra } as SkillCommand
}
const scoped = (name: string, scope: string): ScopedSkill => ({
  skill: skill(name, join(ROOT, scope, '.claudin', 'skills', name)),
  dir: join(ROOT, scope),
})
const unscoped = (name: string): ScopedSkill => ({ skill: skill(name, join(ROOT, '.claudin', 'skills', name)) })

describe('skillScope', () => {
  test('is the directory relative to the root, written with /', () => {
    expect(skillScope(join(ROOT, 'apps', 'web'), ROOT)).toBe('apps/web')
  })
})

describe('nameScopedSkills', () => {
  test('a unique scoped skill keeps its bare name; an unscoped one passes through untouched', () => {
    const reacty = unscoped('reacty')
    const [web, root] = nameScopedSkills([scoped('deploy', 'apps/web'), reacty], new Set(), ROOT)
    expect(web).toMatchObject({ name: 'deploy', scope: 'apps/web', description: '(from apps/web/, for files under it) deploy things' })
    expect(root).toBe(reacty.skill)
  })

  test('a collision qualifies it, and the qualified name is what it answers to', () => {
    const [web] = nameScopedSkills([scoped('deploy', 'apps/web')], new Set(['deploy']), ROOT)
    expect(web).toMatchObject({ name: 'apps/web:deploy', scope: 'apps/web' })
    expect(web?.userFacingName?.()).toBe('apps/web:deploy')
    expect(web?.description).toBe('(apps/web/ variant of "deploy": use it for files under apps/web/) deploy things')
  })

  test('a qualified name that is already taken is not offered', () => {
    const named = nameScopedSkills([scoped('deploy', 'web'), scoped('lint', 'web')], new Set(['deploy', 'web:deploy']), ROOT)
    expect(named.map(c => c.name)).toEqual(['lint'])
  })
})

describe('scopedVariantNote', () => {
  const rootDeploy = skill('deploy', join(ROOT, '.claudin', 'skills', 'deploy'))
  const beside = (...entries: ScopedSkill[]): Command[] => [rootDeploy, ...nameScopedSkills(entries, new Set(['deploy']), ROOT)]

  test('names each variant offered under <scope>:<name>', () => {
    expect(scopedVariantNote('deploy', rootDeploy, beside(scoped('deploy', 'apps/web'), scoped('deploy', 'tools')))).toBe(
      'Directory-scoped variants of the "deploy" skill exist in this repository:\n' +
        '- `apps/web:deploy` — for files under apps/web/\n' +
        '- `tools:deploy` — for files under tools/\n' +
        '"deploy" is the unscoped one; call a variant by its exact name to use it instead.',
    )
  })

  test('none, or only the skill itself: no note', () => {
    expect(scopedVariantNote('deploy', rootDeploy, [rootDeploy])).toBeNull()
    const web = nameScopedSkills([scoped('release', 'apps/web')], new Set(['release']), ROOT)
    expect(scopedVariantNote('release', web[0], web)).toBeNull()
  })

  // getCommands drops a scoped skill whose qualified name a plugin owns; the
  // plugin's command must not be named in its place.
  test('a command that only happens to be named <x>:<name> is not a variant', () => {
    const plugin = { type: 'prompt', name: 'web:deploy', description: 'plugin deploy', source: 'plugin' } as Command
    expect(scopedVariantNote('deploy', rootDeploy, [rootDeploy, plugin])).toBeNull()
  })

  test('called through a scoped skill holding the bare name, it says which one that is', () => {
    const web = skill('deploy', join(ROOT, 'apps', 'web', '.claudin', 'skills', 'deploy'), { scope: 'apps/web' })
    const api = skill('apps/api:deploy', join(ROOT, 'apps', 'api', '.claudin', 'skills', 'deploy'), { scope: 'apps/api' })
    expect(scopedVariantNote('deploy', web, [web, api])).toBe(
      'Directory-scoped variants of the "deploy" skill exist in this repository:\n' +
        '- `apps/api:deploy` — for files under apps/api/\n' +
        '"deploy" is the apps/web/ one; call a variant by its exact name to use it instead.',
    )
  })
})
