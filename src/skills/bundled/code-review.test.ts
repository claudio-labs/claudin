import { afterEach, describe, expect, test } from 'bun:test'

import { setIsInteractive } from 'src/bootstrap/state.js'
import { clearBundledSkills, getBundledSkills } from 'src/skills/bundledSkills.js'
import {
  buildCodeReviewPrompt,
  parseCodeReviewArgs,
  registerCodeReviewSkill,
  resolveReviewLevel,
} from 'src/skills/bundled/code-review.js'

afterEach(() => {
  clearBundledSkills()
})

describe('code-review skill registration', () => {
  test('registers a prompt-based skill named code-review', async () => {
    registerCodeReviewSkill()

    const skill = getBundledSkills().find(c => c.name === 'code-review')
    expect(skill).toBeDefined()
    if (skill?.type !== 'prompt') throw new Error('expected a prompt skill')

    const blocks = await skill.getPromptForCommand('', {} as never)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('Gather the diff')
    expect(text).toContain('finder angles')
  })

  test('advertises all five effort levels plus the flags', () => {
    registerCodeReviewSkill()
    const skill = getBundledSkills().find(c => c.name === 'code-review')
    expect(skill?.argumentHint).toBe(
      '[low|medium|high|xhigh|max] [--fix] [--comment] [<target>]',
    )
    expect(skill?.description).toContain('--fix')
    expect(skill?.description).toContain('reuse/simplification/efficiency')
  })
})

describe('parseCodeReviewArgs', () => {
  test('empty args: no explicit level, no flags, no target', () => {
    const parsed = parseCodeReviewArgs('')
    expect(parsed.explicit).toBeUndefined()
    expect(parsed.comment).toBe(false)
    expect(parsed.fix).toBe(false)
    expect(parsed.target).toBe('')
    expect(parsed.unrecognizedLevel).toBeUndefined()
    expect(parsed.ultraFallback).toBe(false)
  })

  test.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'parses %s as the explicit level',
    level => {
      const parsed = parseCodeReviewArgs(level)
      expect(parsed.explicit).toBe(level)
      expect(parsed.unrecognizedLevel).toBeUndefined()
    },
  )

  test('is case-insensitive and supports the med alias', () => {
    expect(parseCodeReviewArgs('HIGH').explicit).toBe('high')
    expect(parseCodeReviewArgs('Medium').explicit).toBe('medium')
    expect(parseCodeReviewArgs('med').explicit).toBe('medium')
  })

  test('flags parse anywhere and combine with level and target', () => {
    const parsed = parseCodeReviewArgs('--comment high --fix src/foo.ts')
    expect(parsed.explicit).toBe('high')
    expect(parsed.comment).toBe(true)
    expect(parsed.fix).toBe(true)
    expect(parsed.target).toBe('src/foo.ts')
  })

  test('a level-looking typo is recorded as unrecognizedLevel', () => {
    const parsed = parseCodeReviewArgs('highest')
    expect(parsed.explicit).toBeUndefined()
    expect(parsed.unrecognizedLevel).toBe('highest')
    expect(parsed.target).toBe('highest')
  })

  test('non-level text becomes the review target', () => {
    const parsed = parseCodeReviewArgs('check the auth flow')
    expect(parsed.explicit).toBeUndefined()
    expect(parsed.unrecognizedLevel).toBeUndefined()
    expect(parsed.target).toBe('check the auth flow')
  })

  test('ultra as the first token sets ultraFallback and keeps the target', () => {
    const parsed = parseCodeReviewArgs('ultra src/foo.ts --fix')
    expect(parsed.ultraFallback).toBe(true)
    expect(parsed.explicit).toBeUndefined()
    expect(parsed.fix).toBe(true)
    expect(parsed.target).toBe('src/foo.ts')
  })
})

describe('resolveReviewLevel', () => {
  test('explicit level wins; no context defaults to medium', () => {
    expect(resolveReviewLevel({ explicit: 'low', ultraFallback: false })).toBe(
      'low',
    )
    expect(
      resolveReviewLevel({ explicit: undefined, ultraFallback: false }),
    ).toBe('medium')
  })

  test('ultra falls back to max', () => {
    expect(
      resolveReviewLevel({ explicit: undefined, ultraFallback: true }),
    ).toBe('max')
  })
})

describe('code-review prompt content by level', () => {
  function promptFor(args: string): string {
    return buildCodeReviewPrompt(parseCodeReviewArgs(args))
  }

  test('low is a single inline pass with no subagents', () => {
    const text = promptFor('low')
    expect(text).toContain('low effort → 1 diff pass')
    expect(text).toContain('No subagents')
    expect(text).not.toContain('finder angles')
  })

  test('medium runs 7 angles for precision with ≤8 findings', () => {
    const text = promptFor('medium')
    expect(text).toContain('**precision** at medium effort')
    expect(text).toContain('**7 independent finder angles**')
    expect(text).toContain('single ReportFindings tool call')
    expect(text).toContain('keep the 8 most severe')
    expect(text).not.toContain('Angle D')
  })

  test('high runs 7 angles for recall with ≤10 findings', () => {
    const text = promptFor('high')
    expect(text).toContain('**recall** at high effort')
    expect(text).toContain('**7 independent finder angles**')
    expect(text).toContain('recall-biased')
    expect(text).toContain('single ReportFindings tool call')
    expect(text).toContain('keep the 10 most severe')
  })

  test('xhigh and max run 9 angles with a sweep and ≤15 findings', () => {
    for (const level of ['xhigh', 'max'] as const) {
      const text = promptFor(level)
      expect(text).toContain('**9 independent finder angles**')
      expect(text).toContain('Angle E')
      expect(text).toContain('Sweep for gaps')
      expect(text).toContain('single ReportFindings tool call')
      expect(text).toContain('keep the 15 most severe')
    }
  })

  test('every multi-agent level includes the cleanup angles', () => {
    for (const level of ['medium', 'high', 'xhigh', 'max'] as const) {
      const text = promptFor(level)
      expect(text).toContain('### Reuse')
      expect(text).toContain('### Simplification')
      expect(text).toContain('### Efficiency')
      expect(text).toContain('### Altitude')
    }
  })

  test('--comment appends the GitHub posting addendum', () => {
    const text = promptFor('high --comment')
    expect(text).toContain('Posting to GitHub (--comment)')
    expect(text).toContain('gh api')
  })

  test('--fix appends the apply-fixes addendum', () => {
    const text = promptFor('high --fix')
    expect(text).toContain('Applying fixes (--fix)')
    expect(text).toContain('apply the')
  })

  test('a free-text target is surfaced as a review-target line', () => {
    const text = promptFor('high src/services/api')
    expect(text).toContain('Review target: `src/services/api`')
  })

  test('ultra prefixes the local-fallback note and uses the max prompt', () => {
    const text = promptFor('ultra')
    expect(text).toContain("ultra (cloud review) isn't available in Claudin")
    expect(text).toContain('max effort → 5+4 angles')
  })

  test('an unrecognized level-like token prefixes a warning note', () => {
    const text = promptFor('maximum')
    expect(text).toContain('Ignoring unrecognized effort "maximum"')
  })
})

describe('code-review headless output fallback', () => {
  // Restore the process default (non-interactive) so state doesn't leak to
  // other test files under the serial coverage run.
  afterEach(() => setIsInteractive(false))

  test('non-interactive medium+ also prints the JSON fallback for stdout', () => {
    setIsInteractive(false)
    const text = buildCodeReviewPrompt(parseCodeReviewArgs('high'))
    expect(text).toContain('Headless output (non-interactive session)')
    expect(text).toContain('failure_scenario')
  })

  test('interactive review omits the JSON fallback (tool render is shown)', () => {
    setIsInteractive(true)
    const text = buildCodeReviewPrompt(parseCodeReviewArgs('high'))
    expect(text).not.toContain('Headless output (non-interactive session)')
  })

  test('low never gets the headless fallback (already prints text)', () => {
    setIsInteractive(false)
    const text = buildCodeReviewPrompt(parseCodeReviewArgs('low'))
    expect(text).not.toContain('Headless output (non-interactive session)')
  })
})
