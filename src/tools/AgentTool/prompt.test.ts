import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'

// `getPrompt` is async, reads the live agent registry and pulls in the tool
// tree, so the rendered text is not reachable from a unit test. The bullets are
// plain literals in the template, which is what makes source assertion the
// idiom here (same as src/agent/prompts/prompts.test.ts).
const src = readFileSync(new URL('./prompt.ts', import.meta.url), 'utf8')

describe('Agent tool prompt — proactive dispatch guidance', () => {
  test('tells the model to fork for a multi-file question, naming no agent', () => {
    // It used to say "Dispatch \`Explore\` autonomously", ungated — the bullet
    // shipped whether or not that agent was registered. A fork is always
    // spawnable, so the replacement has no such gap.
    expect(src).toContain('- Fork autonomously for any "investigate across N files" intent')
    expect(src).not.toContain('Explore')
  })

  test('the dispatch bullet is gated on fork being enabled', () => {
    // Ungated it would advise forking on a build where `isForkSubagentEnabled()`
    // is false and `subagent_type` is mandatory — the same defect the Explore
    // bullet had, moved to a different agent. Gating alone is not enough
    // either: see the next test.
    const bullet = src.indexOf('- Fork autonomously for any')
    const gate = src.lastIndexOf('forkEnabled', bullet)
    expect(gate).toBeGreaterThan(-1)
    // The gate must be the ternary immediately above it, not some earlier use.
    expect(src.slice(gate, bullet)).not.toContain('\n-')
  })

  test('the fork-off build still gets the dispatch bullet', () => {
    // First cut gated the bullet to `''`, so a build with fork disabled shipped
    // NO "investigate across N files" guidance at all — a regression against the
    // ungated Explore bullet it replaced. Delegation is right either way; only
    // the context-inheritance wording is fork-specific.
    expect(src).toContain('- Delegate autonomously for any "investigate across N files" intent')
  })

  test('the bullet frames the win as context, not speed', () => {
    // The reason it exists — a serial chain of Reads costs the parent's
    // context. A rewrite that keeps the dispatch but drops the reason stops
    // competing with the model's default of reading files itself.
    expect(src).toContain('costs less context than narrating between them')
  })

  test('the fork section explains context inheritance', () => {
    // Survives the Explore question either way: fork is the other lane, and if
    // it becomes the recommended one this is the sentence that has to be true.
    expect(src).toContain('inherits your full conversation context')
  })
})
