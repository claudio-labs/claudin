import { afterEach, describe, expect, test } from 'bun:test'

import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { parseCodeReviewArgs, registerCodeReviewSkill } from './code-review.js'

afterEach(() => {
  clearBundledSkills()
})

describe('code-review skill registration', () => {
  test('registers a prompt-based skill named code-review', async () => {
    registerCodeReviewSkill()

    const skill = getBundledSkills().find(c => c.name === 'code-review')
    expect(skill).toBeDefined()
    expect(skill?.type).toBe('prompt')

    const blocks = await skill!.getPromptForCommand('', {} as never)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('Code Review')
    expect(text).toContain('correctness bugs')
  })
})

describe('parseCodeReviewArgs', () => {
  test('defaults to high effort with no comment flag', () => {
    const parsed = parseCodeReviewArgs('')
    expect(parsed.effort).toBe('high')
    expect(parsed.comment).toBe(false)
    expect(parsed.invalidEffort).toBeUndefined()
    expect(parsed.focus).toBe('')
  })

  test.each(['low', 'medium', 'high'] as const)(
    'parses %s as the effort level',
    level => {
      const parsed = parseCodeReviewArgs(level)
      expect(parsed.effort).toBe(level)
      expect(parsed.invalidEffort).toBeUndefined()
    },
  )

  test('is case-insensitive for effort levels', () => {
    expect(parseCodeReviewArgs('HIGH').effort).toBe('high')
    expect(parseCodeReviewArgs('Medium').effort).toBe('medium')
  })

  test('falls back to high on an invalid single-token effort', () => {
    const parsed = parseCodeReviewArgs('foo')
    expect(parsed.effort).toBe('high')
    expect(parsed.invalidEffort).toBe('foo')
    expect(parsed.focus).toBe('')
  })

  test('parses --comment alone with default high effort', () => {
    const parsed = parseCodeReviewArgs('--comment')
    expect(parsed.effort).toBe('high')
    expect(parsed.comment).toBe(true)
  })

  test('parses effort and --comment regardless of order', () => {
    const a = parseCodeReviewArgs('high --comment')
    expect(a.effort).toBe('high')
    expect(a.comment).toBe(true)

    const b = parseCodeReviewArgs('--comment low')
    expect(b.effort).toBe('low')
    expect(b.comment).toBe(true)
  })

  test('treats extra text beyond effort and flag as focus', () => {
    const parsed = parseCodeReviewArgs('medium --comment check the auth flow')
    expect(parsed.effort).toBe('medium')
    expect(parsed.comment).toBe(true)
    expect(parsed.focus).toBe('check the auth flow')
  })

  test('treats multiple non-flag tokens as focus, not an invalid effort', () => {
    const parsed = parseCodeReviewArgs('review the parser')
    expect(parsed.effort).toBe('high')
    expect(parsed.invalidEffort).toBeUndefined()
    expect(parsed.focus).toBe('review the parser')
  })
})

describe('code-review prompt content by effort', () => {
  async function promptFor(args: string): Promise<string> {
    clearBundledSkills()
    registerCodeReviewSkill()
    const skill = getBundledSkills().find(c => c.name === 'code-review')
    const blocks = await skill!.getPromptForCommand(args, {} as never)
    return (blocks[0] as { text: string }).text
  }

  test('high effort embeds the ultrathink keyword', async () => {
    expect(await promptFor('high')).toContain('ultrathink')
  })

  test('low effort does not embed the ultrathink keyword', async () => {
    expect(await promptFor('low')).not.toContain('ultrathink')
  })

  test('comment mode references posting to the pull request', async () => {
    const text = await promptFor('--comment')
    expect(text).toContain('gh pr view')
    expect(text).toContain('gh pr diff')
  })
})
