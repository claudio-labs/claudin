import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { expect, test } from 'bun:test'

// The built-in `Explore` sub-agent was removed on 2026-08-18. It had six kinds
// of site — a definition, a registry push, a shared feature flag, three
// behavioral `agentType === 'Explore'` branches, and eight prompts that named
// it — and most of those prompts were NOT gated on the registry, so they went
// on advertising the agent whether or not it was registered. That asymmetry is
// what this file guards: a partial reintroduction is the failure mode, not a
// clean one.
//
// It has to assert on SOURCE, not on rendered output. `feature()` resolves
// natively and reads false outside a build (.claudin/rules/build-system.md), so
// a test that renders the system prompt cannot see the gated branch at all — it
// would pass with the agent fully wired back in.
//
// If you are here because this test failed and you are deliberately adding an
// agent named Explore back: delete this file in the same commit, and put the
// numbers that justify it in the message. The ones that justified the removal
// are in .claudin/memory/team/explore-agent-removed.md.

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SRC_ROOT = join(REPO_ROOT, 'src')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

test('the agent definition and its module are gone', () => {
  for (const p of [
    'src/tools/AgentTool/built-in/exploreAgent.ts',
    'src/tools/AgentTool/built-in/exploreAgent.test.ts',
  ]) {
    expect({ path: p, exists: existsSync(join(REPO_ROOT, p)) }).toEqual({
      path: p,
      exists: false,
    })
  }
})

// A REFERENCE to the agent, in every form one can take here — not the word.
// "Explore the codebase" is a plain imperative and appears in plan mode's own
// workflow text, in `/init`'s template and in the Plan agent's prompt;
// `src/terminal/explorer/` is an unrelated feature. Two earlier passes got this
// boundary wrong in opposite directions: matching only `'Explore'` missed the
// bare `Explore: 0` key in `SUBAGENT_BUDGET_PCT`, and matching the bare word
// flagged all the prose. Each alternative below corresponds to a real site the
// removal had to touch.
const AGENT_REFERENCE = new RegExp(
  [
    String.raw`['"\`]Explore['"\`]`, // a quoted agent type
    String.raw`\bExplore\s*:`, // an object key, e.g. SUBAGENT_BUDGET_PCT
    String.raw`\bExplore\s+(?:sub)?agent`, // "use the Explore agent"
    String.raw`(?:sub)?agent[_ ]?type\s*[=:]\s*'?Explore`,
    String.raw`EXPLORE_AGENT`,
    String.raw`\bExplore\s*[/,]\s*Plan`, // listed beside the other built-in
    // Debug/cache labels build the type into a colon-delimited string, so the
    // quoted-literal alternative above never sees it. Both forms were found
    // still live in a review pass after the removal looked complete.
    String.raw`\bbuilt-?in:Explore`,
  ].join('|'),
)

test('no source file names Explore as an agent type', () => {
  const violations: string[] = []
  for (const file of sourceFiles(SRC_ROOT)) {
    // Tests legitimately quote the literal — several assert on its ABSENCE,
    // which would otherwise make this guard fail on the very code that keeps
    // the removal honest. A test cannot register an agent, so production
    // source is the surface that matters.
    if (/\.test\.tsx?$/.test(file)) continue
    const code = readFileSync(file, 'utf8')
    for (const [i, line] of code.split('\n').entries()) {
      if (AGENT_REFERENCE.test(line)) {
        violations.push(`${relative(REPO_ROOT, file)}:${i + 1}`)
      }
    }
  }
  expect(violations).toEqual([])
})

// The eight prompts that named the agent. Most shipped UNGATED, so grepping the
// registry would not have found them, and three were only found after the first
// pass looked done — two `whenToUse` strings that end "or anything inside the
// local repo (use the Explore agent)", and the teammate-selection prompt. They
// are listed by path on purpose, so a file going missing (renamed, split) fails
// here instead of silently dropping its share of the guard.
const PROMPT_FILES = [
  'src/agent/prompts/prompts.ts',
  'src/agent/messages/planMode.ts',
  'src/tools/AgentTool/prompt.ts',
  'src/tools/FileReadTool/prompt.ts',
  // The serial-Read nudge told the model to "dispatch the Explore agent …
  // subagent_type=Explore" from a module whose name says nothing about prompts.
  'src/tools/FileReadTool/serialReadNudge.ts',
  'src/tools/AgentTool/built-in/webResearcherAgent.ts',
  'src/tools/AgentTool/built-in/webResearcherManagerAgent.ts',
  'src/tools/TeamCreateTool/prompt.ts',
]

test('no prompt advertises the agent, by name or by subagent_type', () => {
  // Deliberately narrower than the bare word: "Explore the codebase" is the
  // phase name in plan mode's own workflow text and is not a reference to any
  // agent. What may not appear is the quoted type or a subagent_type= for it.
  const ADVERTISES = /['"`]Explore['"`]|subagent_type\s*=\s*'?Explore|EXPLORE_AGENT|Explore agent/
  const violations: string[] = []
  for (const p of PROMPT_FILES) {
    const full = join(REPO_ROOT, p)
    expect({ path: p, exists: existsSync(full) }).toEqual({
      path: p,
      exists: true,
    })
    const code = readFileSync(full, 'utf8')
    for (const [i, line] of code.split('\n').entries()) {
      if (ADVERTISES.test(line)) {
        violations.push(`${p}:${i + 1}`)
      }
    }
  }
  expect(violations).toEqual([])
})

test('the shared Explore/Plan feature flag is gone from the build', () => {
  const build = readFileSync(join(REPO_ROOT, 'scripts/build/build.ts'), 'utf8')
  // Renamed to BUILTIN_PLAN_AGENT. Leaving the old name would fold `feature()`
  // for an agent that no longer exists, and the flag table is not validated
  // against call sites by any other test.
  expect(build).not.toContain('BUILTIN_EXPLORE_PLAN_AGENTS')
  expect(build).toContain('BUILTIN_PLAN_AGENT: true')
})
