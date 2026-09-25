import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { getBuiltInAgents } from 'src/tools/AgentTool/builtInAgents.js'
import { EXPLORE_AGENT_TYPE } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { formatAgentLine, getPrompt } from 'src/tools/AgentTool/prompt.js'
import { getEnterPlanModeToolPrompt } from 'src/tools/EnterPlanModeTool/prompt.js'

// The built-in `Explore` sub-agent was removed on 2026-08-18 and came back
// behind CLAUDIN_EXPLORE_AGENT. The removal found it named in six kinds of
// site — a definition, a registry push, a shared build flag, behavioral
// branches and eight prompts — and most of the prompts were NOT gated on the
// registry, so they advertised the agent whether or not it was registered.
// That is the failure mode this file guards, from both sides:
//
//  - every source file that names the agent type is on the list below, so a
//    new mention has to be read for its gate before it is added here;
//  - the prompts that do name it render without it when the gate is off and
//    with it when the gate is on.
//
// The gate is a runtime env, not `feature()`, which is what lets this assert on
// rendered text: `feature()` reads false outside a build.

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

// A REFERENCE to the agent, in every form one takes here — not the word.
// "Explore the codebase" is a plain imperative in plan mode's own workflow
// text, in `/init`'s template and in the Plan agent's prompt;
// `src/terminal/explorer/` is an unrelated feature. Each alternative is a real
// site the removal had to touch.
const AGENT_REFERENCE = new RegExp(
  [
    String.raw`['"\`]Explore['"\`]`, // a quoted agent type
    String.raw`\bExplore\s*:`, // an object key, e.g. SUBAGENT_BUDGET_PCT
    String.raw`\bExplore\s+(?:sub)?agent`, // "use the Explore agent"
    String.raw`(?:sub)?agent[_ ]?type\s*[=:]\s*'?Explore`,
    String.raw`EXPLORE_AGENT`,
    String.raw`\bExplore\s*[/,]\s*Plan`, // listed beside the other built-in
    String.raw`\bbuilt-?in:Explore`, // debug/cache labels
  ].join('|'),
)

// Where the agent may be named, and what gates each one.
const ALLOWED_SITES: Record<string, string> = {
  'src/tools/AgentTool/built-in/exploreAgent.ts': 'the definition',
  'src/tools/AgentTool/builtInAgents.ts': 'the gate and the registry push',
  'src/tools/AgentTool/constants.ts':
    'type sets consulted only for a spawned Explore agent',
  'src/agent/planDossier.ts': 'a zero budget, consulted only for a spawned Explore agent',
  'src/tools/AgentTool/prompt.ts': 'every mention behind exploreListed',
  'src/tools/EnterPlanModeTool/prompt.ts': 'behind isExploreAgentRegistered()',
}

test('only the listed files name Explore as an agent type', () => {
  const found = new Set<string>()
  for (const file of sourceFiles(SRC_ROOT)) {
    // Tests quote the literal to assert on it; a test cannot register an
    // agent, so production source is the surface that matters.
    if (/\.test\.tsx?$/.test(file)) continue
    const code = readFileSync(file, 'utf8')
    if (code.split('\n').some(line => AGENT_REFERENCE.test(line))) {
      found.add(relative(REPO_ROOT, file))
    }
  }
  expect([...found].sort()).toEqual(Object.keys(ALLOWED_SITES).sort())
})

test('Explore does not ride a build flag', () => {
  const build = readFileSync(join(REPO_ROOT, 'scripts/build/build.ts'), 'utf8')
  // It used to share BUILTIN_EXPLORE_PLAN_AGENTS with Plan, so neither could
  // be registered without the other.
  expect(build).not.toContain('BUILTIN_EXPLORE_PLAN_AGENTS')
  expect(build).not.toMatch(/BUILTIN_EXPLORE/)
  expect(build).toContain('BUILTIN_PLAN_AGENT: true')
})

describe('what the model is told, with the gate in each state', () => {
  const saved = process.env.CLAUDIN_EXPLORE_AGENT
  beforeEach(() => {
    delete process.env.CLAUDIN_EXPLORE_AGENT
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.CLAUDIN_EXPLORE_AGENT
    else process.env.CLAUDIN_EXPLORE_AGENT = saved
  })

  test('gate off: not registered, not listed, not named', async () => {
    const agents = getBuiltInAgents()
    expect(agents.map(a => a.agentType)).not.toContain(EXPLORE_AGENT_TYPE)
    expect(agents.map(formatAgentLine).join('\n')).not.toContain('Explore')
    expect(await getPrompt(agents)).not.toContain('Explore')
    expect(getEnterPlanModeToolPrompt()).not.toContain('Explore')
  })

  test('gate on: registered, listed, and named where a search is delegated', async () => {
    process.env.CLAUDIN_EXPLORE_AGENT = '1'
    const agents = getBuiltInAgents()
    expect(agents.map(a => a.agentType)).toContain(EXPLORE_AGENT_TYPE)
    expect(agents.map(formatAgentLine).join('\n')).toContain(`- ${EXPLORE_AGENT_TYPE}: `)
    expect(await getPrompt(agents)).toContain('To search this codebase, use `Explore`')
    expect(getEnterPlanModeToolPrompt()).toContain('with the `Explore` agent')
  })
})
