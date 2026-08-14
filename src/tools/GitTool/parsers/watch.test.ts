import { describe, expect, test } from 'bun:test'
import {
  PR_CHECKS_POLL,
  PR_CHECKS_WATCH,
  RUN_WATCH,
  RUN_WATCH_POLL,
} from 'src/tools/GitTool/__fixtures__/watchPolls.js'
import { renderRunLog } from './gh.js'
import { renderWatchPolls } from './watch.js'

describe('renderWatchPolls', () => {
  test('keeps the last `gh pr checks --watch` refresh and counts the rest', () => {
    const rendered = renderWatchPolls(PR_CHECKS_WATCH)
    expect(rendered).not.toBeNull()
    expect(rendered).toContain('… 2 earlier refreshes omitted')
    // The final state, whole: four checks, all passing, with their real elapsed.
    expect(rendered).toContain(PR_CHECKS_POLL)
    // And nothing from the refreshes before it.
    expect(rendered).not.toContain('pending')
    expect((rendered as string).length).toBeLessThan(PR_CHECKS_WATCH.length)
  })

  test('keeps the last `gh run watch` refresh and the completion line after it', () => {
    const rendered = renderWatchPolls(RUN_WATCH)
    expect(rendered).not.toBeNull()
    expect(rendered).toContain('… 2 earlier refreshes omitted')
    expect(rendered).toContain(RUN_WATCH_POLL.trim())
    expect(rendered).toContain('completed with success')
    // The glyph flips and the age line re-words between refreshes; neither may
    // break the anchor, so no in-progress block survives.
    expect(rendered).not.toContain('about 1 minute ago')
  })

  test('declines a single poll — `gh pr checks` without --watch', () => {
    expect(renderWatchPolls(PR_CHECKS_POLL)).toBeNull()
  })

  test('declines empty output', () => {
    expect(renderWatchPolls('')).toBeNull()
    expect(renderWatchPolls('\n\n')).toBeNull()
  })

  test('declines text where the anchor repeats at uneven distances', () => {
    // A repeated word inside prose, not a stack of refreshes: the gaps are 1
    // and 5, so the shape check is what has to decline this.
    const prose = ['status: ok', 'status: ok', 'a', 'b', 'c', 'd', 'status: ok'].join('\n')
    expect(renderWatchPolls(prose)).toBeNull()
  })

  test('shape alone cannot tell a run log from a one-check watch', () => {
    // Both are "the same first tab-field on every line, evenly spaced", so this
    // collapses a run log to its last line — which is why `budget.ts` routes
    // ONLY the two watch commands here, exactly as `renderRunLog` is pinned to
    // `run view`. The pin is the guard; there is no shape test that could be.
    const log = [
      'smoke-and-tests\tRun tests\t2026-07-24T21:19:54.2638189Z bun test',
      'smoke-and-tests\tRun tests\t2026-07-24T21:19:55.2638189Z 1 pass',
      'smoke-and-tests\tRun tests\t2026-07-24T21:19:56.2638189Z done',
    ].join('\n')
    expect(renderRunLog(log)).not.toBeNull()
    const collapsed = renderWatchPolls(log)
    expect(collapsed).toContain('done')
    expect(collapsed).not.toContain('1 pass')
  })
})
