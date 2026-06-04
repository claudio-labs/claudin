import { describe, expect, test } from 'bun:test'
import {
  ANTI_NARRATION_HARNESS_BULLETS,
  TOOL_BATCHING_HARNESS_BULLET,
  buildHarnessItems,
  getHarnessSection,
  prependBullets,
} from './prompts.js'
import { ANTHROPIC_ANTI_NARRATION_ADDENDUM } from './familyAddendums/anthropic.js'

describe('getHarnessSection', () => {
  // The test preload (src/stubs/test-preload.ts) stubs `feature()` to false
  // for every flag, so this snapshot covers the ANTI_NARRATION-off path —
  // i.e. the legacy 6-bullet harness that ships when the flag is flipped
  // for A/B benches. Regression guard: any silent reordering or word loss
  // in the base bullets will fail this snapshot.
  test('flag-off snapshot is stable (legacy 6-bullet harness)', () => {
    expect(getHarnessSection()).toMatchSnapshot()
  })

  test('flag-off output contains none of the anti-narration bullets', () => {
    const section = getHarnessSection()
    for (const bullet of ANTI_NARRATION_HARNESS_BULLETS) {
      // Compare on a stable prefix — the bullet is long and `prependBullets`
      // adds list-marker formatting, so substring on the leading phrase is
      // both sufficient and resilient to bullet-marker changes.
      const prefix = bullet.slice(0, 60)
      expect(section).not.toContain(prefix)
    }
  })

  // Build-time `feature('ANTI_NARRATION')` is stubbed to false in tests, so
  // exercise the production code path through `buildHarnessItems(true)` and
  // re-compose the section exactly like `getHarnessSection` does. Guards
  // against accidental nesting / mis-spread of ANTI_NARRATION_HARNESS_BULLETS.
  test('flag-on rendered section snapshot (production wording)', () => {
    const rendered = ['# Harness', ...prependBullets(buildHarnessItems(true, true))].join(`\n`)
    expect(rendered).toMatchSnapshot()
  })

  test('flag-on rendered section includes every anti-narration bullet', () => {
    const items = buildHarnessItems(true, true)
    for (const bullet of ANTI_NARRATION_HARNESS_BULLETS) {
      expect(items).toContain(bullet)
    }
    // 6 base + 1 batching bullet (flag-on) + ANTI_NARRATION bullets
    expect(items).toHaveLength(7 + ANTI_NARRATION_HARNESS_BULLETS.length)
  })

  test('flag-on / batching-off rendered section snapshot (A/B kill-switch path)', () => {
    // Guards the antiNarration=on, toolBatching=off combination — the
    // A/B bench path when TOOL_BATCHING_NUDGE is flipped off in
    // scripts/build.ts. Without this snapshot a regression that only
    // affects the kill-switch shape ships silently.
    const rendered = ['# Harness', ...prependBullets(buildHarnessItems(true, false))].join(`\n`)
    expect(rendered).toMatchSnapshot()
  })

  test('TOOL_BATCHING_NUDGE-on rendered section includes the batching directive', () => {
    const onItems = buildHarnessItems(false, true)
    const offItems = buildHarnessItems(false, false)
    // Flag-on adds the batching directive as its own bullet (so the rule
    // stands alone and isn't buried inside a sentence about tool choice).
    expect(onItems).toHaveLength(offItems.length + 1)
    expect(onItems).toContain(TOOL_BATCHING_HARNESS_BULLET)
    expect(offItems).not.toContain(TOOL_BATCHING_HARNESS_BULLET)
  })
})

describe('ANTHROPIC_ANTI_NARRATION_ADDENDUM', () => {
  // Production wording is snapshot-locked here because the gated
  // ANTHROPIC_ADDENDUM resolves to null under the test preload.
  test('matches snapshot', () => {
    expect(ANTHROPIC_ANTI_NARRATION_ADDENDUM).toMatchSnapshot()
  })

  test('leads with the failures-immediately carve-out', () => {
    expect(ANTHROPIC_ANTI_NARRATION_ADDENDUM.startsWith(
      'Failures and unexpected results are reported immediately',
    )).toBe(true)
  })

  test('carves out plan-mode from the ≤5-bullet cap', () => {
    expect(ANTHROPIC_ANTI_NARRATION_ADDENDUM).toContain('Plan-mode output')
    expect(ANTHROPIC_ANTI_NARRATION_ADDENDUM).toContain('does not apply there')
  })

  test('numbers four checkpoints explicitly', () => {
    for (const marker of ['(1)', '(2)', '(3)', '(4)']) {
      expect(ANTHROPIC_ANTI_NARRATION_ADDENDUM).toContain(marker)
    }
  })
})

describe('ANTI_NARRATION_HARNESS_BULLETS', () => {
  // Exported so the production (flag-on) wording is locked down without
  // needing a parallel build configured for snapshot tests. If you change
  // the bullets intentionally, update this snapshot.
  test('matches snapshot', () => {
    expect(ANTI_NARRATION_HARNESS_BULLETS).toMatchSnapshot()
  })

  test('has three bullets', () => {
    expect(ANTI_NARRATION_HARNESS_BULLETS).toHaveLength(3)
  })

  test('first bullet carries the transcript-shape invariant', () => {
    expect(ANTI_NARRATION_HARNESS_BULLETS[0]).toContain(
      'transcript should contain tool calls and nothing else',
    )
  })

  test('second bullet carries the failures-immediately carve-out', () => {
    // Guards against accidental removal of the failure-reporting exception
    // that keeps the anti-narration rule from conflicting with
    // getActionsSection ("Report outcomes faithfully").
    expect(ANTI_NARRATION_HARNESS_BULLETS[1]).toContain(
      'Failures and unexpected results are reported immediately',
    )
  })
})
