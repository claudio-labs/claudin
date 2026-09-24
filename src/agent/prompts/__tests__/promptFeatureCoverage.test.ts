// Every Claudin capability stays named in the text the model receives.
//
// The prompts v2 work (branch perf/prompts-v2) shrinks the system prompt, the
// memory section, the eager tool descriptions and the startup reminders toward
// Claude Code's size. The invariant is that no feature disappears on the way:
// a capability the model is never told about is a capability it does not use.
// This file is that invariant, written before the rewrite so it pins what ships
// today, and each checked marker names a capability, not a sentence — the v2
// text is free to say it in fewer words, in another place.
//
// Three corpora, each read from the source of truth for what is sent:
//   - the system prompt from the bundle's own dump (systemPrompt.*.txt, kept
//     byte-identical by systemPrompt.characterization.test.ts), plus the
//     session guidance, which that dump cannot render (empty tool registry);
//   - every eager tool's description and input schema, as tool.prompt() and
//     zodToJsonSchema produce them;
//   - the startup reminders: the git protocol and a skill listing.
// Markers that may move between places (a rule that travels from the system
// prompt to a tool description) are checked on all three together; a tool's
// own parameters and behaviors are checked on that tool alone.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'src/commands/commands.js'
import {
  buildAgentToolSection,
  getSessionSpecificGuidanceSection,
} from 'src/agent/prompts/prompts.js'
import {
  isCompactToolPromptsEnabled,
  isLeanRemindersEnabled,
  isV2PromptSwitchOn,
} from 'src/agent/prompts/toolPromptTier.js'
import { zodToJsonSchema } from 'src/shared/data/zodToJsonSchema.js'
import { getEmptyToolPermissionContext, type Tool } from 'src/tools/Tool.js'
import { getAllBaseTools } from 'src/tools/tools.js'
import { renderCompactAgentPrompt } from 'src/tools/AgentTool/prompt.js'
import { getBashGitInstructionsBody } from 'src/tools/BashTool/prompt.js'
import { MonitorTool } from 'src/tools/MonitorTool/MonitorTool.js'
import { formatCommandsWithinBudget } from 'src/tools/SkillTool/prompt.js'
import { isDeferredTool } from 'src/tools/ToolSearchTool/prompt.js'

const SNAPSHOT_DIR = join(__dirname, '__snapshots__')

/**
 * The two states that ship while the v2 killswitches exist: the default (the
 * v2 text since 2026-09-24) and every killswitch at `=0` (the text before it).
 * The system prompt comes from the bundle's dump in that state; the tool
 * descriptions and reminders are rendered live with `toolSwitches` set.
 */
const STATES = [
  { state: 'default (v2)', file: 'systemPrompt.main.txt', lean: true, toolSwitches: undefined },
  { state: 'killswitched', file: 'systemPrompt.legacy.txt', lean: false, toolSwitches: '0' },
] as const

const TOOL_SWITCHES = ['CLAUDIN_COMPACT_TOOL_PROMPTS', 'CLAUDIN_LEAN_REMINDERS'] as const

function setToolSwitches(value: '0' | undefined): void {
  for (const name of TOOL_SWITCHES) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

function systemPromptOf(file: string): string | null {
  const path = join(SNAPSHOT_DIR, file)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

const FAKE_SKILL = {
  type: 'prompt',
  name: 'coverage-fake-skill',
  description: 'Fake skill that proves the listing names every skill',
  source: 'bundled',
} as unknown as Command

function sessionGuidance(lean: boolean): string {
  const tools = new Set(['AskUserQuestion', 'Agent', 'Skill', 'Grep', 'Glob'])
  // FORK_SUBAGENT ships on, but `feature()` reads false under `bun test`, so
  // the guidance above renders the fork-off lane; the shipping lane comes from
  // its pure seam, in its default (lean, background hidden in `-p`) shape.
  return [getSessionSpecificGuidanceSection(tools, [FAKE_SKILL], lean) ?? '', buildAgentToolSection(true, true, true)].join('\n')
}

const TOOL_OPTIONS = {
  getToolPermissionContext: async () => getEmptyToolPermissionContext(),
  tools: getAllBaseTools(),
  agents: [],
}

async function toolText(tool: Tool): Promise<string> {
  const description = await tool.prompt(TOOL_OPTIONS)
  const schema = JSON.stringify(
    'inputJSONSchema' in tool && tool.inputJSONSchema
      ? tool.inputJSONSchema
      : zodToJsonSchema(tool.inputSchema),
  )
  return `${description}\n${schema}`
}

/**
 * A tool's text in a state. The Agent description's compact text is only
 * reachable with fork on, which `feature()` hides under `bun test`, so in the
 * v2 state it comes from its pure renderer — the `-p` shape and the
 * interactive one.
 */
async function toolTextIn(tool: Tool, lean: boolean): Promise<string> {
  if (lean && tool.name === 'Agent') {
    return `${renderCompactAgentPrompt(true)}\n${renderCompactAgentPrompt(false)}\n${JSON.stringify(zodToJsonSchema(tool.inputSchema))}`
  }
  return toolText(tool)
}

/**
 * Per tool: what it can do, by marker. Parameter names are in the list on
 * purpose — a parameter the schema stops describing is a capability gone.
 */
const TOOL_MARKERS: Record<string, readonly (string | RegExp)[]> = {
  Read: [
    'outline',
    'symbol',
    "view='full'",
    'offset',
    'limit',
    'encoding',
    'pages',
    'PDF',
    /image/i,
    /notebook/i,
    /heading/i,
    /diff/i,
    'head and tail',
    '→',
    /re-read/i,
  ],
  Grep: [
    'symbols',
    /broad/i,
    'files_with_matches',
    'count',
    'head_limit',
    'multiline',
    '.gitignore',
    'no_ignore',
    'binary',
    'encoding',
    'smart-case',
  ],
  Patch: [
    '*** Begin Patch',
    '*** Add File',
    '*** Update File',
    '*** Delete File',
    '*** Move to',
    '*** End of File',
    '@@',
    'atomic',
    // The format rules whose absence cost six malformed patches in the v2 A/B
    // (team memory `prompts-v2-2026-09`): a compaction must keep them.
    'Each hunk begins with a "@@" line',
    'each "@@" must sit at or after the previous hunk\'s',
    'give each file exactly ONE section',
    'lines you copied from the file (not remembered)',
  ],
  Agent: ['subagent_type', /fork/i, 'readOnly', 'isolation', 'worktree', 'SendMessage', 'Code'],
  Bash: ['timeout', /absolute path/i, 'RunTests', 'Typecheck', 'Build', 'Git', 'Read', 'Grep', 'Glob'],
  Edit: ['old_string', 'new_string', 'replace_all'],
  Write: ['file_path', 'content'],
  Git: ['commands', 'cwd'],
  RunTests: ['command', 'path', 'pattern', 'framework'],
  Typecheck: ['baseline', 'checker', 'path'],
  Build: ['directory', 'system', 'path'],
  Glob: ['pattern', 'exclude', 'max_depth', 'sort'],
  WaitFor: ['until', 'settle_s', 'timeout_s', 'setup'],
  Skill: ['skill', 'args'],
}

/**
 * Checked on system prompt + session guidance + tools + reminders together:
 * the rewrite may move a rule from one place to another, not drop it.
 */
const ANYWHERE_MARKERS: ReadonlyArray<[string, string | RegExp]> = [
  ['identity', 'You are Claudin'],
  ['security policy', 'authorized security testing'],
  ['output is markdown', 'Github-flavored markdown'],
  ['permission modes', 'permission mode'],
  ['hooks', 'Hooks may intercept tool calls'],
  ['prompt injection', 'prompt-injection'],
  ['clickable references', 'file_path:line_number'],
  ['pronoun default', 'they/them'],
  ['report outcomes', 'Report outcomes faithfully'],
  ['do not end on a promise', /promise/i],
  ['act on what you know', 'When you have enough information to act, act'],
  ['compaction', 'summarized'],
  ['parallel tool calls', /parallel/i],
  ['one multi-file patch', 'ONE Patch'],
  ['private memory', '.claudin/memory/'],
  ['team memory', '.claudin/memory/team/'],
  ['team decisions', 'decisions/'],
  ['team bugs', 'bugs/'],
  ['team docs', 'docs/'],
  ['decision fields', 'impact:'],
  ['on-demand memory', 'paths:'],
  ['memory index', 'MEMORY.md'],
  ['remember', /remember/i],
  ['forget', /forget/i],
  ['verify recalled memory', /verify/i],
  ['memory links', '[[name]]'],
  ['memory types', 'feedback'],
  ['scratchpad', 'scratchpad'],
  ['results may be cleared', 'may be cleared'],
  ['token budget', 'token target'],
  ['answer length', 'shortest response'],
  ['working directory', 'Primary working directory'],
  ['model identity', 'model named'],
  ['sub-agent rule', /sub-agent/i],
  ['delegation threshold', /delegate/i],
  ['skills', 'Skill'],
  ['denied tool call', 'AskUserQuestion'],
  ['git reads in one call', 'git status'],
  ['stage by name', 'by name'],
  ['destructive commands only when named', '--force'],
  ['hook skips only when named', '--no-verify'],
  ['no interactive git', '`-i`'],
  ['no amend by default', /amend/i],
  ['no AI trailer', /attribution/i],
  ['GitHub via gh', 'gh pr create'],
  ['skill listing', 'coverage-fake-skill'],
]

describe('prompt feature coverage', () => {
  afterEach(() => setToolSwitches(undefined))

  test('both system prompt snapshots are present', () => {
    expect(STATES.map(s => (systemPromptOf(s.file) === null ? `${s.file} missing` : s.state))).toEqual([
      'default (v2)',
      'killswitched',
    ])
  })

  test('the switches resolve on by default and off at `=0` in this environment (otherwise the states below are one)', () => {
    expect(isCompactToolPromptsEnabled()).toBe(true)
    expect(isLeanRemindersEnabled()).toBe(true)
    setToolSwitches('0')
    expect(isCompactToolPromptsEnabled()).toBe(false)
    expect(isLeanRemindersEnabled()).toBe(false)
  })

  for (const { state, file, lean, toolSwitches } of STATES) {
    for (const [name, markers] of Object.entries(TOOL_MARKERS)) {
      test(`${state}: ${name} still names every capability`, async () => {
        setToolSwitches(toolSwitches)
        const tool = getAllBaseTools().find(t => t.name === name)
        expect(tool ? name : `${name} missing from getAllBaseTools()`).toBe(name)
        const text = await toolTextIn(tool!, lean)
        const missing = markers.filter(m => (typeof m === 'string' ? !text.includes(m) : !m.test(text)))
        expect(missing.map(String)).toEqual([])
      })
    }

    test(`${state}: every capability is named somewhere the model reads`, async () => {
      setToolSwitches(toolSwitches)
      const systemPrompt = systemPromptOf(file)
      expect(systemPrompt === null ? `${file} missing` : 'present').toBe('present')
      const toolTexts = await Promise.all(getAllBaseTools().map(t => toolTextIn(t, lean)))
      const skillListing = formatCommandsWithinBudget([FAKE_SKILL], 200_000)
      const corpus = [systemPrompt, sessionGuidance(lean), ...toolTexts, getBashGitInstructionsBody(), skillListing].join('\n')
      const missing = ANYWHERE_MARKERS.filter(([, m]) => (typeof m === 'string' ? !corpus.includes(m) : !m.test(corpus)))
      expect(missing.map(([capability]) => capability)).toEqual([])
    })
  }
})

// What the v2 tool switches change, against the killswitched text. Both are
// read when a description or reminder is built.
describe('prompt feature coverage — v2 tools and reminders', () => {
  afterEach(() => setToolSwitches(undefined))

  // Through the pure rule, not the live model: under the full suite a leaked
  // `model.js` mock makes getMainLoopModel() ignore an override, so a test that
  // sets one passes alone and fails in the run. The wiring from each switch to
  // that rule is pinned on the source instead.
  test('the switches do not reach a model outside the Anthropic family', () => {
    expect(isV2PromptSwitchOn(undefined, 'anthropic')).toBe(true)
    expect(isV2PromptSwitchOn('1', 'anthropic')).toBe(true)
    expect(isV2PromptSwitchOn('0', 'anthropic')).toBe(false)
    for (const family of ['default', 'openai-reasoning', 'gemini', 'kimi', 'glm', 'codex'] as const) {
      expect(isV2PromptSwitchOn(undefined, family)).toBe(false)
      expect(isV2PromptSwitchOn('1', family)).toBe(false)
    }
    const src = readFileSync(new URL('../toolPromptTier.ts', import.meta.url), 'utf8')
    for (const [fn, env] of [
      ['isCompactToolPromptsEnabled', 'CLAUDIN_COMPACT_TOOL_PROMPTS'],
      ['isLeanRemindersEnabled', 'CLAUDIN_LEAN_REMINDERS'],
    ] as const) {
      const start = src.indexOf(`export function ${fn}(`)
      const body = src.slice(start, src.indexOf('\n}\n', start))
      expect(body).toContain(`process.env.${env}`)
      expect(body).toContain('getFamilyForLogging(getMainLoopModel())')
    }
  })

  test('Monitor waits behind ToolSearch only with the v2 tool descriptions', () => {
    expect(isDeferredTool(MonitorTool)).toBe(true)
    setToolSwitches('0')
    expect(isDeferredTool(MonitorTool)).toBe(false)
  })

  // Per tool, so a description that stops honoring the switch is caught even
  // while the others keep the total down. The marker tests above cannot see
  // it: the killswitched text names every marker too.
  for (const name of ['Read', 'Grep', 'Bash', 'Build', 'Typecheck', 'RunTests']) {
    test(`v2: the ${name} description is at most two thirds of the killswitched one`, async () => {
      const tool = getAllBaseTools().find(t => t.name === name)!
      setToolSwitches('0')
      const before = (await tool.prompt(TOOL_OPTIONS)).length
      setToolSwitches(undefined)
      expect((await tool.prompt(TOOL_OPTIONS)).length).toBeLessThan(before * (2 / 3))
    })
  }

  test('v2: the skill listing keeps one short line per skill', () => {
    const long = { ...FAKE_SKILL, description: 'x'.repeat(200) } as unknown as Command
    setToolSwitches('0')
    const before = formatCommandsWithinBudget([long], 200_000)
    setToolSwitches(undefined)
    const after = formatCommandsWithinBudget([long], 200_000)
    expect(after.length).toBeLessThan(before.length)
    expect(after).toContain('coverage-fake-skill')
  })

  // The git protocol attachment is the same text in both states: the shorter
  // one measured on the branch dropped rules BashTool/prompt.test.ts pins.
  test('v2: the git reminder is the same text as before', () => {
    setToolSwitches('0')
    const before = getBashGitInstructionsBody()
    setToolSwitches(undefined)
    expect(getBashGitInstructionsBody()).toBe(before)
  })
})
