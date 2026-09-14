import { describe, expect, test } from 'bun:test'
import { getDescription } from 'src/tools/GrepTool/prompt.js'

const prompt = getDescription()

describe('Grep tool prompt — the symbols mode', () => {
  test('carries no sentence steering the model toward it', () => {
    // Two were tried and both measured inert, which is why there is none now.
    //
    // The first was a preference — "reach for symbols when you want to know
    // WHERE something is used". Zero symbols calls across 3 runs of
    // grep-rubric-ab and a live session. It lost to a declared default
    // (files_with_matches), because a preference needs the model to already
    // believe lines are a problem.
    //
    // The second stated the capability instead: a match line does not carry
    // its enclosing function, so "which functions call this" cannot be answered
    // from content mode — we had watched the model answer `checkoutOrder` for a
    // function named `checkout`. Better writing, same result: 0 of 44 Grep
    // calls in the feature arm against 0 of 43 in the baseline
    // (read-strategy-ab, 2026-09-14, 3 reps per arm).
    //
    // Two forms, four measurements, no movement, and it cost 135 bytes on every
    // request. The lane that DOES work here is behaviour, not instruction:
    // GrepTool/autoPivot.ts already returns the symbol map on its own when a
    // search is broad, measured over 5,109 recorded results. Widen that before
    // writing a third sentence.
    expect(prompt).not.toContain('symbols" when')
    expect(prompt).not.toContain('does not carry the function it sits in')
  })

  test('does not promise coverage it cannot deliver', () => {
    // The 25-language list that used to qualify the modes bullet was wrong by
    // omission — Dart and Groovy ARE scanned and were missing — and the "code
    // files" that briefly replaced it was wrong by over-promise: .ex, .exs and
    // the PowerShell extensions resolve to a language that scanSymbols returns
    // nothing for, so every match renders "(matched outside any symbol)" with
    // no line saying the scanner does not cover that file. Naming no scope is
    // the only honest option that fits on the line.
    expect(prompt).not.toContain('TS/JS, Python, Go, Java')
    expect(prompt).not.toContain('signature (code files)')
  })
})
