import { describe, expect, test } from 'bun:test'
import { getDescription } from 'src/tools/GrepTool/prompt.js'

const prompt = getDescription()

describe('Grep tool prompt — the symbols mode', () => {
  test('states what content mode cannot do, not a preference', () => {
    // The first version of this line said to "reach for symbols when you want
    // to know WHERE something is used". Measured inert: across 3 runs of
    // grep-rubric-ab on Sonnet 5 and a live session, `output_mode:"symbols"`
    // was chosen ZERO times, including on a run that made 5 Grep calls. It
    // lost because it was a preference competing with a declared default
    // (files_with_matches), and a preference needs the model to already
    // believe there is a problem with lines.
    //
    // The cost is real and we watched it land: asked which functions call
    // `buildReceipt`, the model used `content -C 2` and answered
    // `checkoutOrder`. The function is called `checkout` — a match line does
    // not carry its enclosing symbol, so the name had to be guessed. This
    // asserts the capability framing survives a rewrite; the preference
    // framing is what did not work.
    expect(prompt).toContain('does not carry the function it sits in')
    expect(prompt).not.toContain('Reach for "symbols" when')
  })

  test('names the supported languages once, not per mode', () => {
    // The 25-language list is already spelled out in the Read tool's reading
    // strategy. A second copy here was the third on the prompt surface and the
    // same duplication this change exists to remove — it also paid for the
    // longer sentence above, so the bullet came out shorter than it went in.
    expect(prompt).not.toContain('TS/JS, Python, Go, Java')
  })
})
