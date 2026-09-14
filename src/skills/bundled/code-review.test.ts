import { afterEach, describe, expect, test } from 'bun:test'

import { setIsInteractive } from 'src/platform/bootstrap/state.js'
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
    expect(text).toContain('## Scope')
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

  test('medium runs 4 angles for precision with ≤8 findings', () => {
    const text = promptFor('medium')
    expect(text).toContain('**precision** at medium effort')
    expect(text).toContain('**4 independent finder angles**')
    expect(text).toContain('single ReportFindings tool call')
    expect(text).toContain('Keep the 8 most severe')
    // The wrapper/proxy angle is xhigh+ only.
    expect(text).not.toContain('Angle D')
  })

  test('high runs 4 angles for recall with ≤10 findings', () => {
    const text = promptFor('high')
    expect(text).toContain('**recall** at high effort')
    expect(text).toContain('**4 independent finder angles**')
    expect(text).toContain('recall-biased')
    expect(text).toContain('single ReportFindings tool call')
    expect(text).toContain('Keep the 10 most severe')
  })

  test('xhigh and max run 5 angles with a sweep and ≤15 findings', () => {
    for (const level of ['xhigh', 'max'] as const) {
      const text = promptFor(level)
      expect(text).toContain('**5 independent finder angles**')
      expect(text).toContain('Angle D — wrapper/proxy correctness')
      expect(text).toContain('Sweep for gaps')
      expect(text).toContain('single ReportFindings tool call')
      expect(text).toContain('Keep the 15 most severe')
    }
  })

  test('every multi-agent level folds the cleanup axes into one angle', () => {
    for (const level of ['medium', 'high', 'xhigh', 'max'] as const) {
      const text = promptFor(level)
      expect(text).toContain('### Angle Z — cleanup pass')
      for (const axis of [
        '**reuse**',
        '**simplification**',
        '**efficiency**',
        '**altitude**',
      ]) {
        expect(text).toContain(axis)
      }
    }
  })

  // Upstream hands xhigh/max the precision ladder plus a one-line override, so
  // the two highest levels could refute a race as "speculative" while `high`
  // could not. Every recall level gets the recall ladder here.
  test('every recall level gets the recall verdict ladder', () => {
    for (const level of ['high', 'xhigh', 'max'] as const) {
      expect(promptFor(level)).toContain('**PLAUSIBLE by default**')
    }
    expect(promptFor('medium')).not.toContain('**PLAUSIBLE by default**')
  })

  test('verification is batched by file, not spawned per candidate', () => {
    for (const level of ['medium', 'high', 'xhigh', 'max'] as const) {
      const text = promptFor(level)
      expect(text).toContain('Verify (batched by file)')
      expect(text).toContain('**one verifier per file**')
    }
  })

  test('every multi-agent level tells finders to pass candidates through', () => {
    for (const level of ['medium', 'high', 'xhigh', 'max'] as const) {
      expect(promptFor(level)).toContain(
        'Pass every candidate with a nameable failure scenario through',
      )
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
    expect(text).toContain('max effort → 5 angles')
  })

  test('an unrecognized level-like token prefixes a warning note', () => {
    const text = promptFor('maximum')
    expect(text).toContain('Ignoring unrecognized effort "maximum"')
  })
})

describe('code-review scope block', () => {
  const scope = {
    range: 'origin/main...HEAD',
    includesWorkingTree: true,
    files: [
      { path: 'src/a.ts', additions: 40, deletions: 2, binary: false, untracked: false },
      { path: 'src/b.ts', additions: 1, deletions: 1, binary: false, untracked: false },
    ],
    totalAdditions: 41,
    totalDeletions: 3,
  }

  test('a resolved scope pins one range for every angle', () => {
    const text = buildCodeReviewPrompt(
      parseCodeReviewArgs('high'),
      undefined,
      scope,
    )
    expect(text).toContain('git diff origin/main...HEAD')
    expect(text).toContain('git diff HEAD')
    expect(text).toContain('src/a.ts (+40 −2)')
    expect(text).toContain('do not substitute another one')
    // The model no longer picks the range, so the fallback chain is gone.
    expect(text).not.toContain('@{upstream}')
  })

  test('an unresolved scope falls back to the range chain', () => {
    const text = buildCodeReviewPrompt(parseCodeReviewArgs('high'), undefined, null)
    expect(text).toContain('@{upstream}')
    expect(text).toContain('use the same range for every angle')
  })

  test('a named target overrides a resolved scope', () => {
    const text = buildCodeReviewPrompt(
      parseCodeReviewArgs('high 123'),
      undefined,
      scope,
    )
    expect(text).toContain('Review target: `123`')
    expect(text).not.toContain('src/a.ts (+40 −2)')
  })

  test('low reads the scope instead of restating the git commands', () => {
    const text = buildCodeReviewPrompt(
      parseCodeReviewArgs('low'),
      undefined,
      scope,
    )
    expect(text).toContain('read the diff named in the Scope section above')
    expect(text).toContain('git diff origin/main...HEAD')
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
