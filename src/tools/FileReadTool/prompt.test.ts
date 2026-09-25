import { describe, expect, test } from 'bun:test'
import {
  importWithReadMulti,
  importWithReadGlobs,
  importWithReadMultiUnset,
} from 'src/tools/FileReadTool/__testutils__/readMultiFlag.js'
import {
  LINE_FORMAT_INSTRUCTION,
  renderPromptTemplate,
} from 'src/tools/FileReadTool/prompt.js'

type PromptModule = typeof import('src/tools/FileReadTool/prompt.js')

const PROMPT = 'src/tools/FileReadTool/prompt.js'

const prompt = renderPromptTemplate(LINE_FORMAT_INSTRUCTION)

const ORDINAL_RE = /^(\d+)\. /

describe('Read tool prompt — the reading-strategy list', () => {
  test('numbers each step exactly once', () => {
    // A merge once left two bullets numbered `1.` — the old wording and the
    // new one — so the rendered list read 1, 1, 2, 3, 4 and handed the model
    // the same step twice. Neither an equality nor a prefix check catches that
    // pair (the first ends in `.` where the second has `,`); the ordinals do.
    const ordinals = prompt
      .split('\n')
      .map(line => ORDINAL_RE.exec(line)?.[1])
      .filter((n): n is string => n !== undefined)
    expect(ordinals).toEqual(['1', '2', '3', '4'])
  })

  test('names the supported languages once', () => {
    // The list used to appear twice: once in the strategy header and again in
    // a bullet below that re-stated the strategy itself. Two copies of a fact
    // is how the two halves drift apart.
    expect(prompt.split('TS/JS, Python, Go, Java').length - 1).toBe(1)
  })

  test('says what the outline covers beyond those languages', () => {
    // The non-code cases are the part that only that paragraph carries, and
    // the reason it survived the compression.
    expect(prompt).toContain('Markdown and HTML outline by heading')
    expect(prompt).toContain("symbol='<path>' returns that file's hunks")
    expect(prompt).toContain('head and tail with the line count')
  })

  test('never recommends reading the whole file', () => {
    // The offset/limit bullet used to end "it's recommended to read the whole
    // file by not providing these parameters", ten lines under "Default to
    // surgical reads". Both shipped, in the tool that dominates token spend.
    // The alternative wording already existed but hung on a runtime flag that
    // always resolved to its default here, so it could never render.
    expect(prompt).not.toContain('recommended to read the whole file')
    expect(prompt).toContain('only read that part')
  })

  test('prices a read in turns, not just in bytes', () => {
    // The first version of this line promised "targeted reads cost ~95% less".
    // True per CALL and misleading per SESSION, which is the unit that gets
    // billed: a targeted read also costs a turn, and a turn re-sends the whole
    // conversation. Measured on Sonnet 5 over a 10-file session, obeying the
    // old wording moved targeted reads from 61% to 78% of all reads and the
    // session cost UP 35% — 23 reads against 18, 32 turns against 25. A ladder
    // with no exit is what produced that: nothing said when to stop slicing.
    expect(prompt).not.toContain('95% less')
    expect(prompt).toContain('costs a turn on top of its bytes')
  })

  test('does not tell the model to avoid exploring', () => {
    // A draft read "slice when you know where to look, not to explore", which
    // contradicts step 1 — starting an unknown file at view='outline' IS
    // exploring, and it is the step the ladder opens with. Measured, that
    // clause moved whole-body reads from 32% to 40% of all reads across three
    // reps per arm (read-strategy-ab, 2026-09-14) while the bill did not move
    // at all: cache_read differed by 0.15% between the arms. So it pushed shape
    // in the direction the ladder argues against and bought nothing for it.
    expect(prompt).not.toContain('not to explore')
  })

  test('sets no slice ceiling', () => {
    // A draft closed step 3 with "coming back for a third slice means read it
    // whole". Measured over 1,625 non-test files in src/, a 40-line slice fits
    // into one whole read 1.6x under 100 lines but 9.4x at 250-600, 22x at
    // 600-1500 and 45x past 1500 — so a fixed ceiling of three bites hardest on
    // the files where slicing actually pays. The session A/B agreed: the arm
    // that sliced more was the cheaper one over three reps. Any future ceiling
    // has to come with its own measurement.
    expect(prompt).not.toContain('third slice')
    expect(prompt).not.toMatch(/read it whole instead/)
  })
})

describe('Read tool prompt — delegation is not its subject', () => {
  test('carries no fork or sub-agent guidance', () => {
    // It used to end with a "Multi-file investigations" block telling the
    // model to `fork yourself (Agent with no subagent_type)`, contradicting
    // both AgentTool/prompt.ts and getAgentToolSection() in the same request —
    // a fork measured 4x the cost of a fresh `Code` agent at equal answers
    // (scripts/bench/ab/fork-vs-fresh-ab.ts, 2026-09-09). Delegation policy
    // has one owner now: the system prompt plus the Agent tool. Bringing any
    // of it back here re-opens the drift that made the two disagree.
    expect(prompt).not.toContain('fork')
    expect(prompt).not.toContain('subagent')
    expect(prompt).not.toContain('Agent tool')
  })
})

// "off" is CLAUDIN_READ_MULTI=0, the killswitch since the batch Read became
// the default. The describe keeps its name so its snapshots keep their keys.
describe('Read tool prompt — CLAUDIN_READ_MULTI off', () => {
  // Taken before the batch Read existed: under the killswitch both
  // descriptions must stay byte-identical, so the pinned text is the proof.
  test('the legacy description is pinned byte for byte', async () => {
    const mod = await importWithReadMulti<PromptModule>(PROMPT, false)
    expect(mod.renderPromptTemplate(mod.LINE_FORMAT_INSTRUCTION)).toMatchSnapshot()
  })

  test('the compact description is pinned byte for byte', async () => {
    const mod = await importWithReadMulti<PromptModule>(PROMPT, false)
    expect(
      mod.renderCompactPromptTemplate(mod.LINE_FORMAT_INSTRUCTION),
    ).toMatchSnapshot()
  })
})

describe('Read tool prompt — CLAUDIN_READ_MULTI on', () => {
  const BATCH_LINE =
    '- `file_paths` reads up to 20 files in one call — each as `view`/`symbol` say, within 25k tokens in total.'

  test('both descriptions name file_paths in one line', async () => {
    const mod = await importWithReadMulti<PromptModule>(PROMPT, true)
    const legacy = mod.renderPromptTemplate(mod.LINE_FORMAT_INSTRUCTION)
    const compact = mod.renderCompactPromptTemplate(mod.LINE_FORMAT_INSTRUCTION)
    for (const text of [legacy, compact]) {
      expect(text.split('\n').filter(line => line === BATCH_LINE)).toHaveLength(1)
    }
  })

  test('the line is the only difference from the flag-off text', async () => {
    const off = await importWithReadMulti<PromptModule>(PROMPT, false)
    const on = await importWithReadMulti<PromptModule>(PROMPT, true)
    const strip = (text: string) =>
      text
        .split('\n')
        .filter(line => line !== BATCH_LINE)
        .join('\n')
    expect(strip(on.renderPromptTemplate(on.LINE_FORMAT_INSTRUCTION))).toBe(
      off.renderPromptTemplate(off.LINE_FORMAT_INSTRUCTION),
    )
    expect(strip(on.renderCompactPromptTemplate(on.LINE_FORMAT_INSTRUCTION))).toBe(
      off.renderCompactPromptTemplate(off.LINE_FORMAT_INSTRUCTION),
    )
  })

  test('compact stays under two thirds of legacy with the line in both', async () => {
    // The same bound promptFeatureCoverage holds per tool, for the default
    // text it now sees; checked here against the explicit =1 as well.
    const mod = await importWithReadMulti<PromptModule>(PROMPT, true)
    const legacy = mod.renderPromptTemplate(mod.LINE_FORMAT_INSTRUCTION)
    const compact = mod.renderCompactPromptTemplate(mod.LINE_FORMAT_INSTRUCTION)
    expect(compact.length).toBeLessThan(legacy.length * (2 / 3))
  })
})

describe('Read tool prompt — the default, CLAUDIN_READ_MULTI unset', () => {
  test('both descriptions are the ones =1 renders, batch line included', async () => {
    const unset = await importWithReadMultiUnset<PromptModule>(PROMPT)
    const on = await importWithReadMulti<PromptModule>(PROMPT, true)
    expect(unset.renderPromptTemplate(unset.LINE_FORMAT_INSTRUCTION)).toBe(
      on.renderPromptTemplate(on.LINE_FORMAT_INSTRUCTION),
    )
    expect(unset.renderCompactPromptTemplate(unset.LINE_FORMAT_INSTRUCTION)).toBe(
      on.renderCompactPromptTemplate(on.LINE_FORMAT_INSTRUCTION),
    )
    expect(unset.renderCompactPromptTemplate(unset.LINE_FORMAT_INSTRUCTION)).toContain(
      '`file_paths` reads up to 20 files in one call',
    )
  })
})

// CLAUDIN_READ_GLOBS (readGlobs.ts). Off — unset, the default — is the text
// the arms above pin: every one of them loads with the variable unset.
describe('Read tool prompt — CLAUDIN_READ_GLOBS on', () => {
  const BATCH_LINE =
    '- `file_paths` reads up to 20 files in one call — each as `view`/`symbol` say, within 25k tokens in total.'
  const GLOB_LINE =
    '- `file_paths` reads up to 50 files in one call — each as `view`/`symbol` say, within 25k tokens in total; a glob like `src/*.ts` reads every match.'

  test('the batch line takes globs in both descriptions, and nothing else changes', async () => {
    const on = await importWithReadGlobs<PromptModule>(PROMPT, true)
    const off = await importWithReadGlobs<PromptModule>(PROMPT, false)
    for (const render of ['renderPromptTemplate', 'renderCompactPromptTemplate'] as const) {
      const onText = on[render](on.LINE_FORMAT_INSTRUCTION)
      const offText = off[render](off.LINE_FORMAT_INSTRUCTION)
      expect(onText.split('\n').filter(line => line === GLOB_LINE)).toHaveLength(1)
      expect(offText.split('\n').filter(line => line === BATCH_LINE)).toHaveLength(1)
      expect(onText.replace(GLOB_LINE, BATCH_LINE)).toBe(offText)
    }
  })
})
