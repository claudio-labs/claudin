import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { clearBundledSkills, getBundledSkills } from 'src/skills/bundledSkills.js'
import {
  type SkillDoctorInputs,
  buildSkillDoctorPrompt,
  collectTakenNames,
  registerSkillDoctorSkill,
} from 'src/skills/bundled/skillDoctor.js'

afterEach(() => {
  clearBundledSkills()
})

const NOW = Date.now()
const DAY = 86_400_000

function write(base: string, files: Record<string, string>, mtime?: number): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(base, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
    if (mtime !== undefined) utimesSync(abs, mtime / 1000, mtime / 1000)
  }
}

function skillCall(id: string, skill: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(NOW - DAY).toISOString(),
    message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] },
  })
}

function inputs(
  sessions: number,
  overrides: Partial<SkillDoctorInputs> = {},
): SkillDoctorInputs {
  const root = mkdtempSync(join(tmpdir(), 'skilldoctor-project-'))
  const configHome = mkdtempSync(join(tmpdir(), 'skilldoctor-home-'))
  const transcriptDir = mkdtempSync(join(tmpdir(), 'skilldoctor-transcripts-'))

  const old = NOW - 40 * DAY
  write(
    root,
    {
      '.claudin/skills/deploy/SKILL.md': '---\ndescription: Ship the current branch to staging\n---\nSteps.\n',
      '.claudin/skills/review/SKILL.md': '---\ndescription: Review a pull request in depth\n---\nSteps.\n',
      '.claudin/skills/ghost/SKILL.md': '---\ndescription: Handle the thing\nuser-invocable: yes\n---\nSteps.\n',
    },
    old,
  )
  write(root, { '.claudin/skills/fresh/SKILL.md': '---\ndescription: Brand new\n---\nSteps.\n' })

  for (let i = 0; i < sessions; i++) {
    write(transcriptDir, { [`s${i}.jsonl`]: i === 0 ? skillCall('t1', 'deploy') : '' })
  }

  return {
    root,
    configHome,
    transcriptDir,
    builtinNames: new Set(['review', 'help']),
    bundledNames: new Set(['create', 'skill-doctor']),
    listingCap: 100,
    now: NOW,
    ...overrides,
  }
}

describe('/skill-doctor registration', () => {
  test('registers as a user- and model-invocable prompt skill that may edit', () => {
    registerSkillDoctorSkill()
    const skill = getBundledSkills().find(command => command.name === 'skill-doctor')
    expect(skill?.type).toBe('prompt')
    if (skill?.type !== 'prompt') throw new Error('expected a prompt skill')
    expect(skill.userInvocable).toBe(true)
    expect(skill.disableModelInvocation).toBe(false)
    expect(skill.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Edit'])
  })

  test('taken names come from the real command registry and bundled skills', async () => {
    registerSkillDoctorSkill()
    const { builtinNames, bundledNames } = await collectTakenNames()
    expect(builtinNames.has('help')).toBe(true)
    expect(builtinNames.has('review')).toBe(true)
    expect(bundledNames.has('skill-doctor')).toBe(true)
  })
})

describe('/skill-doctor prompt', () => {
  test('embeds the lint findings as computed facts', async () => {
    const text = await buildSkillDoctorPrompt(inputs(12))
    expect(text).toContain('Checked 4 skill file(s): 4 project, 0 user.')
    expect(text).toContain('Mechanical findings (already computed — do not re-derive these):')
    expect(text).toContain('- [error] .claudin/skills/ghost/SKILL.md — `user-invocable: yes` is read as false')
    expect(text).toContain('- [warning] .claudin/skills/review/SKILL.md — replaces the built-in `/review`')
  })

  test('the usage table counts invocations and marks what not to judge', async () => {
    const text = await buildSkillDoctorPrompt(inputs(12))
    expect(text).toContain('From 12 session(s) in the last 30 days')
    expect(text).toMatch(/\| deploy \| project \| 1 \| 0 \| \d{4}-\d{2}-\d{2} \|/)
    expect(text).toMatch(/\| review \| project \| 0 \| 0 \| — \|/)
    expect(text).toMatch(/\| fresh \| project \| 0 \| 0 \| — \| [\d-]+ \| changed < 7 days ago \|/)
    expect(text).not.toContain('Only 12 session(s)')
  })

  test('too few sessions to call anything "never triggers"', async () => {
    const text = await buildSkillDoctorPrompt(inputs(3))
    expect(text).toContain('**Only 3 session(s) to go on**')
  })

  test('the listing cap and the taken names reach the instructions', async () => {
    const text = await buildSkillDoctorPrompt(inputs(12, { listingCap: 250 }))
    expect(text).toContain('cut\nat 250 chars for the current model')
    expect(text).toContain('Bundled skills (matched before any skill on disk): create, skill-doctor.')
    expect(text).toContain('a skill with one of these names replaces it): help, review.')
  })

  test('edits only what the user confirms', async () => {
    const text = await buildSkillDoctorPrompt(inputs(12))
    expect(text).toContain('apply only what the user confirms')
    expect(text).toContain('Nothing is applied without that answer.')
  })

  test('a project with no skills says so', async () => {
    const empty = inputs(0)
    const text = await buildSkillDoctorPrompt({
      ...empty,
      root: mkdtempSync(join(tmpdir(), 'skilldoctor-empty-')),
    })
    expect(text).toContain('No skills found')
    expect(text).not.toContain('| Skill | Scope |')
  })
})
