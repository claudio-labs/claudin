import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'

// `getPrompt` is async, reads the live agent registry and pulls in the tool
// tree, so the rendered text is not reachable from a unit test. The bullets are
// plain literals in the template, which is what makes source assertion the
// idiom here (same as src/agent/prompts/prompts.test.ts).
const src = readFileSync(new URL('./prompt.ts', import.meta.url), 'utf8')

describe('Agent tool prompt — proactive dispatch guidance', () => {
  test('tells the model to delegate a multi-file question, naming no agent', () => {
    // It used to say "Dispatch \`Explore\` autonomously", ungated — the bullet
    // shipped whether or not that agent was registered. `Code` is always
    // registered and a fork is always spawnable, so the replacement has no
    // such gap.
    expect(src).toContain('- Delegate autonomously for any "investigate across N files" intent')
    expect(src).not.toContain('Explore')
  })

  test('the fork-or-fresh tail of the bullet is gated on fork being enabled', () => {
    // Ungated it would mention forking on a build where `isForkSubagentEnabled()`
    // is false and `subagent_type` is mandatory — the same defect the Explore
    // bullet had, moved to a different agent.
    const tail = src.indexOf('fork only when the question is about this conversation')
    expect(tail).toBeGreaterThan(-1)
    const gate = src.lastIndexOf('forkEnabled ?', tail)
    expect(gate).toBeGreaterThan(-1)
    // The gate must be the ternary on this same line, not some earlier use.
    expect(src.slice(gate, tail)).not.toContain('\n')
  })

  test('the fork-off build still gets the dispatch bullet', () => {
    // An earlier cut gated the whole bullet to `''`, so a build with fork
    // disabled shipped NO "investigate across N files" guidance at all.
    // Delegation is right either way; only the fork-or-fresh tail is gated,
    // so the bullet's head must sit outside any `forkEnabled` ternary.
    const bullet = src.indexOf('- Delegate autonomously for any')
    const tail = src.indexOf('${forkEnabled ?', bullet)
    expect(tail).toBeGreaterThan(bullet)
    expect(src.slice(bullet, tail)).not.toContain('\n')
  })

  test('the bullet frames the win as context, not speed', () => {
    // The reason it exists — a serial chain of Reads costs the parent's
    // context. A rewrite that keeps the dispatch but drops the reason stops
    // competing with the model's default of reading files itself.
    expect(src).toContain('costs less context than narrating between them')
  })

  test('the fork section explains context inheritance', () => {
    // Fork is the other lane; this is the sentence that has to stay true of it.
    expect(src).toContain('inherits your full conversation context')
  })

  test('the fork section states the per-call re-read and prefers a fresh agent', () => {
    // "Forks are cheap because they share your prompt cache" was true of the
    // first call only. fork-vs-fresh-ab.ts (Sonnet 5, N=3, 2026-09-09): same
    // task, same 27 child calls, fork child 4× the fresh one. The section has
    // to carry the cost and the default that follows from it, or the model
    // goes back to forking implementation work under a 300k parent.
    // The sentence survives in a comment as history; the template must not.
    const section = src.slice(src.indexOf('## Fork or fresh agent'), src.indexOf('## Writing the prompt'))
    expect(section).not.toContain('Forks are cheap')
    expect(section).toContain('cheap on its first call only')
    expect(src).toContain('re-reads all of it on every call')
    expect(src).toContain('Default to a fresh agent with a complete brief')
  })

  test('the examples show both lanes, each with its reason', () => {
    // A self-contained brief goes to a fresh Code agent; a task about the
    // session itself is the fork. Without the fork example the model reads the
    // section as "never fork"; without the Code one it reads it as before.
    expect(src).toContain('subagent_type: "Code",\n  prompt: "Audit what\'s left')
    expect(src).toContain('name: "footer-bisect"')
  })
})
