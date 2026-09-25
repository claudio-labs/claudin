import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import {
  getIsNonInteractiveSession,
  setIsInteractive,
} from 'src/platform/bootstrap/state.js'
import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { WEB_RESEARCHER_AGENT } from 'src/tools/AgentTool/built-in/webResearcherAgent.js'
import { WEB_RESEARCHER_MANAGER_AGENT } from 'src/tools/AgentTool/built-in/webResearcherManagerAgent.js'
import {
  formatAgentLine,
  isLeanAgentPromptEnabled,
  isRunInBackgroundHidden,
  renderAgentPrompt,
  type AgentPromptDeps,
} from 'src/tools/AgentTool/prompt.js'

// The bullets are plain literals in the template, which is what makes source
// assertion the idiom for the first block (same as
// src/agent/prompts/prompts.test.ts). Claims about the RENDERED text go through
// `renderAgentPrompt` further down, with the process reads injected.
const src = readFileSync(new URL('./prompt.ts', import.meta.url), 'utf8')

describe('Agent tool prompt — proactive dispatch guidance', () => {
  test('tells the model to delegate a multi-file question, naming no agent', () => {
    // It used to say "Dispatch \`Explore\` autonomously", ungated — the bullet
    // shipped whether or not that agent was registered. `Code` is always
    // registered and a fork is always spawnable, so the replacement has no
    // such gap. Explore is named again, but only through EXPLORE_AGENT_TYPE
    // behind `exploreListed` — never as a literal (the renders below pin both
    // states).
    expect(src).toContain('- Delegate autonomously for any "investigate across N files" intent')
    expect(src).not.toMatch(/['"`]Explore['"`]/)
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

  test('does not tell the model to trust what an agent reports', () => {
    // `- The agent's outputs should generally be trusted` shipped in the same
    // request as CORRECTIONS_SECTION's "don't always take them at face value"
    // (prompts.ts). The system prompt owns that judgement, and it is the right
    // owner: forks, named agents and workflow workers all report as plain text
    // with no provenance, so a blanket trust line is the one claim the loop
    // cannot check.
    expect(src).not.toContain('outputs should generally be trusted')
  })
})

// `isForkSubagentEnabled()` folds to false under `bun test`, so the fork-on
// text the product ships is reachable only by injecting it. Defaults are the
// interactive shipping shape: fork on, agent list in an attachment, background
// available, not a teammate.
function makeDeps(overrides: Partial<AgentPromptDeps> = {}): AgentPromptDeps {
  return {
    isForkSubagentEnabled: () => true,
    shouldInjectAgentListInMessages: () => true,
    hasEmbeddedSearchTools: () => false,
    getSubscriptionType: () => null,
    isRunInBackgroundHidden: () => false,
    isInProcessTeammate: () => false,
    isTeammate: () => false,
    isLeanAgentPromptEnabled: () => false,
    isCompactToolPromptsEnabled: () => false,
    ...overrides,
  }
}

function render(
  overrides: Partial<AgentPromptDeps> = {},
  isCoordinator = false,
): string {
  return renderAgentPrompt([], isCoordinator, undefined, makeDeps(overrides))
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

const count = (text: string, needle: string) => text.split(needle).length - 1

/** Lines of `text` that the default shipping render does not have. */
function linesNotInDefault(text: string): string[] {
  const shipped = new Set(render().split('\n'))
  return text.split('\n').filter(line => !shipped.has(line))
}

describe('Agent tool description — the render with background available is pinned', () => {
  // Captured from getPrompt before the deps seam existed (2026-09-23), with the
  // same inputs stubbed in; all 512 input combinations matched after the
  // refactor. The description sits in the tools array, which is cached prefix:
  // a moved byte here re-writes every session's cache, so a change to this text
  // has to be a decision. To see what moved, render it and diff.
  test('fork on — the interactive shipping shape', () => {
    const text = render()
    expect(text.length).toBe(10012)
    expect(sha256(text)).toBe(
      '9d67455fd8d87c38177ad787ad27ea41fa2e29b8a370c3bc2829b10a1bb9e8ae',
    )
  })

  test('fork off', () => {
    const text = render({ isForkSubagentEnabled: () => false })
    expect(text.length).toBe(4304)
    expect(sha256(text)).toBe(
      'e18ba9b778b28b8f31a3392fb39abbdda94fea7efd465da0455b2cfa6edf52ac',
    )
  })
})

describe('Agent tool description — nothing about background where the schema hides it', () => {
  // AgentTool.tsx omits `run_in_background` under isRunInBackgroundHidden()
  // (`-p`, or background tasks off). Teaching it there spends tokens on a
  // parameter the model cannot pass, and `name` goes with it: its local jobs
  // are the panel label and SendMessage routing of a BACKGROUND agent.
  const hidden = render({ isRunInBackgroundHidden: () => true })

  test('mentions neither run_in_background nor name', () => {
    expect(hidden).not.toContain('run_in_background')
    expect(hidden).not.toContain('`name`')
    expect(hidden).not.toMatch(/^ *name: "/m)
    expect(hidden).toContain("with the agent's ID as the `to` field")
  })

  test('drops the foreground/background guidance and the background-only example', () => {
    for (const gone of [
      '**Foreground vs background.**',
      "**When backgrounded, don't peek.**",
      '**The announcement is not the launch.**',
      'Both running in the background.',
    ]) {
      expect(hidden).not.toContain(gone)
    }
  })

  test('keeps the fork section and the three foreground examples', () => {
    for (const kept of [
      '## Fork or fresh agent',
      'cheap on its first call only',
      "Don't set `model` on a fork",
      '**Writing a fork prompt.**',
      '## Writing the prompt',
      'description: "Branch ship-readiness audit"',
      'description: "Bisect this session\'s edits"',
      'description: "Independent migration review"',
    ]) {
      expect(hidden).toContain(kept)
    }
  })

  test('only subtracts: three lines are trimmed, none is new', () => {
    // The fork-cost paragraph without its `name` sentence, the first example's
    // commentary without "inline — no run_in_background", and the SendMessage
    // bullet without "or name". Anything else here is a rewrite.
    expect(linesNotInDefault(hidden)).toHaveLength(3)
  })

  test('the fork-off lane drops its background bullets too', () => {
    const text = render({
      isForkSubagentEnabled: () => false,
      isRunInBackgroundHidden: () => true,
    })
    expect(text).not.toContain('run_in_background')
    expect(text).not.toContain('Foreground vs background')
  })
})

describe('isRunInBackgroundHidden — one predicate for the schema and the description', () => {
  const priorEnv = process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS
  const priorNonInteractive = getIsNonInteractiveSession()

  afterEach(() => {
    if (priorEnv === undefined) delete process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS
    else process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS = priorEnv
    setIsInteractive(!priorNonInteractive)
  })

  test('hidden in -p, and when background tasks are off', () => {
    delete process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS
    setIsInteractive(true)
    expect(isRunInBackgroundHidden()).toBe(false)
    setIsInteractive(false)
    expect(isRunInBackgroundHidden()).toBe(true)
    setIsInteractive(true)
    process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS = '1'
    expect(isRunInBackgroundHidden()).toBe(true)
  })

  test('the input schema omits run_in_background by this same predicate', () => {
    // The schema is cached at first access, so it cannot be flipped in-process;
    // what can drift is a second, inlined predicate. Pin the call.
    const agentTool = readFileSync(new URL('./AgentTool.tsx', import.meta.url), 'utf8')
    expect(agentTool).toContain('const hideRunInBackground = isRunInBackgroundHidden();')
  })
})

describe('Agent tool description — CLAUDIN_LEAN_AGENT_PROMPT says each passage once', () => {
  const lean = render({ isLeanAgentPromptEnabled: () => true })

  test('the fork semantics appear once, in the fork section', () => {
    const forkSemantics = 're-reads all of it on every call it makes'
    expect(count(render(), forkSemantics)).toBe(2)
    expect(count(lean, forkSemantics)).toBe(1)
    expect(lean).toContain('## Fork or fresh agent')
  })

  test('the fresh-agent context rule appears once, in "Writing the prompt"', () => {
    expect(lean).toContain('it starts with zero context')
    expect(lean).not.toContain('starts without context')
  })

  test('the background example no longer restates the launch-announcement rule', () => {
    expect(lean).toContain('**The announcement is not the launch.**')
    expect(lean).toContain('Both running in the background.')
    expect(lean).not.toContain('the words alone launch nothing')
  })

  test('only removes repeats: the one changed line is the SendMessage bullet', () => {
    const changed = linesNotInDefault(lean)
    expect(changed).toHaveLength(1)
    expect(changed[0]).toEndWith('The agent resumes with its full context preserved.')
    expect(lean.length).toBeLessThan(render().length)
  })

  test('a coordinator keeps its only copy of the fork line', () => {
    // The slim coordinator description has no fork section to hold it.
    const coordinator = render({ isLeanAgentPromptEnabled: () => true }, true)
    expect(coordinator).toBe(render({}, true))
    expect(coordinator).toContain('omit it to fork yourself')
  })

  test('the fork-off render has no repeats to drop', () => {
    const off = { isForkSubagentEnabled: () => false }
    expect(render({ ...off, isLeanAgentPromptEnabled: () => true })).toBe(
      render(off),
    )
  })
})

describe('CLAUDIN_LEAN_AGENT_PROMPT is on unless set to 0', () => {
  // Latched once per module instance (the text is cached prefix), so each case
  // reads a FRESH instance with the variable pinned for its first read.
  async function leanWith(value: string | undefined): Promise<boolean> {
    const prior = process.env.CLAUDIN_LEAN_AGENT_PROMPT
    if (value === undefined) delete process.env.CLAUDIN_LEAN_AGENT_PROMPT
    else process.env.CLAUDIN_LEAN_AGENT_PROMPT = value
    try {
      const fresh: typeof import('src/tools/AgentTool/prompt.js') = await import(
        `./prompt.js?lean=${value}-${Date.now()}-${Math.random()}`
      )
      return fresh.isLeanAgentPromptEnabled()
    } finally {
      if (prior === undefined) delete process.env.CLAUDIN_LEAN_AGENT_PROMPT
      else process.env.CLAUDIN_LEAN_AGENT_PROMPT = prior
    }
  }

  test('unset or truthy: lean; 0 or false: the full text', async () => {
    expect(await leanWith(undefined)).toBe(true)
    expect(await leanWith('1')).toBe(true)
    expect(await leanWith('0')).toBe(false)
    expect(await leanWith('false')).toBe(false)
  })
})

describe('agent listing line — CLAUDIN_LEAN_AGENT_PROMPT uses whenToUseLean', () => {
  // Read through the inline list with `lean` injected, so the assertions hold
  // whatever CLAUDIN_LEAN_AGENT_PROMPT the test process was started with.
  type Listed = Parameters<typeof formatAgentLine>[0]
  function lineIn(agent: Listed, lean: boolean): string | undefined {
    return renderAgentPrompt([agent], false, undefined, makeDeps({
      shouldInjectAgentListInMessages: () => false,
      isLeanAgentPromptEnabled: () => lean,
    }))
      .split('\n')
      .find(line => line.startsWith(`- ${agent.agentType}: `))
  }

  test('flag off, the two WebResearcher lines are byte-identical to what shipped', () => {
    // Captured before the lean arm existed (2026-09-23): 564 and 912 chars.
    expect(sha256(lineIn(WEB_RESEARCHER_AGENT, false) ?? '')).toBe(
      '9f1544918500eb645cbda7d5ae307580aa83ab095d4fd5da50995a6885770bf1',
    )
    expect(sha256(lineIn(WEB_RESEARCHER_MANAGER_AGENT, false) ?? '')).toBe(
      '3ef41306dd4acdf5c3c161db71478b88f44478fc9c7e7eb4a8b1278bde03939e',
    )
  })

  test('lean, a line carries the lean text; an agent without one keeps its own', () => {
    const plain = { ...WEB_RESEARCHER_AGENT, agentType: 'Plain', whenToUseLean: undefined }
    expect(lineIn(WEB_RESEARCHER_AGENT, true)).toStartWith(
      `- WebResearcher: ${WEB_RESEARCHER_AGENT.whenToUseLean} (Tools:`,
    )
    expect(lineIn(plain, true)).toStartWith(
      `- Plain: ${WEB_RESEARCHER_AGENT.whenToUse} (Tools:`,
    )
  })

  test('the attachment path (formatAgentLine) renders the same line under the live flag', () => {
    for (const agent of [WEB_RESEARCHER_AGENT, WEB_RESEARCHER_MANAGER_AGENT]) {
      expect<string | undefined>(formatAgentLine(agent)).toBe(
        lineIn(agent, isLeanAgentPromptEnabled()),
      )
    }
  })
})

// The description names Explore only when the built-in is in the list it was
// rendered with (CLAUDIN_EXPLORE_AGENT). The pinned hashes above render with no
// agents, so they are the proof that the off state did not move a byte.
describe('Agent tool description — the Explore lane follows the agent list', () => {
  const SHAPES: Array<[string, Partial<AgentPromptDeps>, boolean]> = [
    ['compact', { isCompactToolPromptsEnabled: () => true }, false],
    ['full, fork on', {}, false],
    ['full, fork off', { isForkSubagentEnabled: () => false }, false],
    ['lean', { isLeanAgentPromptEnabled: () => true }, false],
    ['coordinator', {}, true],
  ]

  function renderWith(
    agents: Parameters<typeof renderAgentPrompt>[0],
    overrides: Partial<AgentPromptDeps>,
    isCoordinator = false,
    allowed?: string[],
  ): string {
    return renderAgentPrompt(agents, isCoordinator, allowed, makeDeps(overrides))
  }

  for (const [shape, overrides, isCoordinator] of SHAPES) {
    test(`${shape}: no Explore in the list, no Explore in the text`, () => {
      expect(renderWith([GENERAL_PURPOSE_AGENT], overrides, isCoordinator)).not.toContain('Explore')
    })
  }

  test('compact: the research line sends a codebase search to Explore', () => {
    const text = renderWith([GENERAL_PURPOSE_AGENT, EXPLORE_AGENT], {
      isCompactToolPromptsEnabled: () => true,
    })
    expect(text).toContain(
      '- Say whether you expect code or research. To search this codebase, use `subagent_type: "Explore"`: it is read-only and quotes what it finds verbatim, with line numbers. For other research pass `readOnly: true`',
    )
    // Everything else in the compact text is the off-state text.
    const off = renderWith([GENERAL_PURPOSE_AGENT], { isCompactToolPromptsEnabled: () => true })
    const changed = text.split('\n').filter(line => !off.split('\n').includes(line))
    expect(changed).toHaveLength(1)
  })

  test('full text: the research bullet, the readOnly line and the dispatch bullet name it', () => {
    const text = renderWith([GENERAL_PURPOSE_AGENT, EXPLORE_AGENT], {})
    expect(text).toContain('- **Research**: write the question out for a fresh agent: `Explore` for a search of this codebase, `Code` for anything else.')
    expect(text).toContain('To search this codebase, use `Explore` instead: it is read-only and quotes what it finds verbatim, with line numbers.')
    expect(text).toContain('Write the question out for `Explore`; fork only when the question is about this conversation.')
  })

  test('fork off: the readOnly line still names it', () => {
    const text = renderWith([GENERAL_PURPOSE_AGENT, EXPLORE_AGENT], { isForkSubagentEnabled: () => false })
    expect(text).toContain('To search this codebase, use `Explore` instead')
    expect(text).not.toContain('Write the question out for `Explore`')
  })

  test('a custom agent that happens to be called Explore is not the built-in', () => {
    const custom = { ...EXPLORE_AGENT, source: 'userSettings' } as unknown as typeof EXPLORE_AGENT
    const text = renderWith([GENERAL_PURPOSE_AGENT, custom], { isCompactToolPromptsEnabled: () => true })
    expect(text).not.toContain('subagent_type: "Explore"')
  })

  test('an Agent(x,y) restriction that leaves Explore out leaves it unnamed', () => {
    const text = renderWith([GENERAL_PURPOSE_AGENT, EXPLORE_AGENT], { isCompactToolPromptsEnabled: () => true }, false, ['Code'])
    expect(text).not.toContain('Explore')
  })
})
