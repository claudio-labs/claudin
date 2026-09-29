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
//     session guidance, which that dump cannot render (empty tool registry),
//     and the CLI prefix block streaming.ts sends ahead of it (the identity);
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
import { getCLISyspromptPrefix } from 'src/agent/prompts/system.js'
import type { ModelFamily } from 'src/agent/prompts/familyAddendums/index.js'
import {
  _setToolPromptFamilyForTesting,
  isCompactToolPromptsEnabled,
  isLeanRemindersEnabled,
  isV2PromptFamily,
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
 * The two states that ship: the v2 text (since 2026-09-24, the Anthropic
 * family) and the text before it, which every other family still receives.
 * The system prompt comes from the bundle's dump in that state; the tool
 * descriptions and reminders are rendered live for `family`.
 */
const STATES = [
  { state: 'default (v2)', file: 'systemPrompt.main.txt', lean: true, family: null },
  { state: 'non-Anthropic family', file: 'systemPrompt.nonAnthropic.txt', lean: false, family: 'default' },
] as const

function enterState(s: { family: ModelFamily | null }): void {
  _setToolPromptFamilyForTesting(s.family)
}

function resetState(): void {
  _setToolPromptFamilyForTesting(null)
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
    // Since 2026-09-29 what matches is applied and the rest is reported; the
    // prompt must say so, or the model re-sends whole patches again.
    'NOT applied',
    // The format rules whose absence cost six malformed patches in the v2 A/B
    // (team memory `prompts-v2-2026-09`): a compaction must keep them.
    'Each hunk begins with a "@@" line',
    'each "@@" must sit at or after the previous hunk\'s',
    'give each file exactly ONE section',
    'lines you copied from the file (not remembered)',
    // The multi-file rule every family reads; the Anthropic family is told it
    // again by its addendum (ANTHROPIC_ONLY_MARKERS below).
    'Batch related edits into ONE call',
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
  Skill: ['skill', 'args', /slash command/i, /built-in CLI commands/i, 'already running', '<command-name>'],
  WebFetch: ['url', 'prompt', /markdown/i, /authenticated/i, 'HTTPS', /redirect/i, '15'],
  WebSearch: ['query', 'allowed_domains', 'blocked_domains', 'Sources', /current month/i],
  ReportFindings: ['findings', 'failure_scenario', 'verdict', 'outcome', /most-severe/i, 'print the findings as text'],
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
  ['model identity', 'powered by the model'],
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

// Sent to the Anthropic family only, by design: the family addendum
// (familyAddendums/anthropic.ts). Another family reads the same rule in the
// Patch description, which TOOL_MARKERS pins for every state.
const ANTHROPIC_ONLY_MARKERS = new Set(['one multi-file patch'])

describe('prompt feature coverage', () => {
  afterEach(resetState)

  test('every system prompt snapshot is present', () => {
    expect(STATES.map(s => (systemPromptOf(s.file) === null ? `${s.file} missing` : s.state))).toEqual([
      'default (v2)',
      'non-Anthropic family',
    ])
  })

  test('the v2 texts are on for this environment\'s family (otherwise the states below are one)', () => {
    expect(isCompactToolPromptsEnabled()).toBe(true)
    expect(isLeanRemindersEnabled()).toBe(true)
  })

  test('the v2 texts are off for a family outside Anthropic (otherwise that state is the default)', () => {
    _setToolPromptFamilyForTesting('default')
    expect(isCompactToolPromptsEnabled()).toBe(false)
    expect(isLeanRemindersEnabled()).toBe(false)
  })

  for (const s of STATES) {
    const { state, file, lean } = s
    for (const [name, markers] of Object.entries(TOOL_MARKERS)) {
      test(`${state}: ${name} still names every capability`, async () => {
        enterState(s)
        const tool = getAllBaseTools().find(t => t.name === name)
        expect(tool ? name : `${name} missing from getAllBaseTools()`).toBe(name)
        const text = await toolTextIn(tool!, lean)
        const missing = markers.filter(m => (typeof m === 'string' ? !text.includes(m) : !m.test(text)))
        expect(missing.map(String)).toEqual([])
      })
    }

    test(`${state}: every capability is named somewhere the model reads`, async () => {
      enterState(s)
      const systemPrompt = systemPromptOf(file)
      expect(systemPrompt === null ? `${file} missing` : 'present').toBe('present')
      const toolTexts = await Promise.all(getAllBaseTools().map(t => toolTextIn(t, lean)))
      const skillListing = formatCommandsWithinBudget([FAKE_SKILL], 200_000)
      const corpus = [getCLISyspromptPrefix(), systemPrompt, sessionGuidance(lean), ...toolTexts, getBashGitInstructionsBody(), skillListing].join('\n')
      const markers = s.family === null ? ANYWHERE_MARKERS : ANYWHERE_MARKERS.filter(([c]) => !ANTHROPIC_ONLY_MARKERS.has(c))
      const missing = markers.filter(([, m]) => (typeof m === 'string' ? !corpus.includes(m) : !m.test(corpus)))
      expect(missing.map(([capability]) => capability)).toEqual([])
    })
  }
})

// What the v2 texts change, against what another family receives. Both are
// decided when a description or reminder is built.
describe('prompt feature coverage — v2 tools and reminders', () => {
  afterEach(resetState)

  // Through the pure rule, not the live model: under the full suite a leaked
  // `model.js` mock makes getMainLoopModel() ignore an override, so a test that
  // sets one passes alone and fails in the run. The wiring from each reader to
  // that rule is pinned on the source instead.
  test('the v2 texts do not reach a model outside the Anthropic family', () => {
    expect(isV2PromptFamily('anthropic')).toBe(true)
    for (const family of ['default', 'openai-reasoning', 'gemini', 'kimi', 'glm', 'codex'] as const) {
      expect(isV2PromptFamily(family)).toBe(false)
    }
    const src = readFileSync(new URL('../toolPromptTier.ts', import.meta.url), 'utf8')
    for (const fn of ['isCompactToolPromptsEnabled', 'isLeanRemindersEnabled']) {
      const start = src.indexOf(`export function ${fn}(`)
      const body = src.slice(start, src.indexOf('\n}\n', start))
      expect(body).toContain('isV2PromptFamily(getMainLoopFamily())')
    }
    const start = src.indexOf('function getMainLoopFamily(')
    expect(src.slice(start, src.indexOf('\n}\n', start))).toContain('getFamilyForLogging(getMainLoopModel())')
  })

  // The system prompt and the memory section decide on the model the prompt is
  // built for, not the main loop's; the rendered text is the characterization
  // test's two snapshots.
  test('getSystemPrompt sends the v2 text to the v2 family only', () => {
    const src = readFileSync(new URL('../prompts.ts', import.meta.url), 'utf8')
    const start = src.indexOf('export async function getSystemPrompt(')
    const body = src.slice(start, src.indexOf('\n}\n', start))
    expect(body).toContain('const lean = isV2PromptFamily(getFamilyForLogging(model))')
    expect(body).toContain('loadMemoryPrompt(lean)')
  })

  test('Monitor waits behind ToolSearch only with the v2 tool descriptions', () => {
    expect(isDeferredTool(MonitorTool)).toBe(true)
    _setToolPromptFamilyForTesting('default')
    expect(isDeferredTool(MonitorTool)).toBe(false)
  })

  // Per tool, so a description that stops honoring the switch is caught even
  // while the others keep the total down. The marker tests above cannot see
  // it: the text another family receives names every marker too.
  for (const name of [
    'Read',
    'Grep',
    'Bash',
    'Build',
    'Typecheck',
    'RunTests',
    'Edit',
    'Write',
    'WebFetch',
    'WebSearch',
    'ReportFindings',
  ]) {
    test(`v2: the ${name} description is at most two thirds of what another family receives`, async () => {
      const tool = getAllBaseTools().find(t => t.name === name)!
      _setToolPromptFamilyForTesting('default')
      const before = (await tool.prompt(TOOL_OPTIONS)).length
      _setToolPromptFamilyForTesting(null)
      expect((await tool.prompt(TOOL_OPTIONS)).length).toBeLessThan(before * (2 / 3))
    })
  }

  test('v2: the skill listing keeps one short line per skill', () => {
    const long = { ...FAKE_SKILL, description: 'x'.repeat(200) } as unknown as Command
    _setToolPromptFamilyForTesting('default')
    const before = formatCommandsWithinBudget([long], 200_000)
    _setToolPromptFamilyForTesting(null)
    const after = formatCommandsWithinBudget([long], 200_000)
    expect(after.length).toBeLessThan(before.length)
    expect(after).toContain('coverage-fake-skill')
  })

  // The git protocol attachment is the same text in both states: the shorter
  // one measured on the branch dropped rules BashTool/prompt.test.ts pins.
  test('v2: the git reminder is the same text as before', () => {
    _setToolPromptFamilyForTesting('default')
    const before = getBashGitInstructionsBody()
    _setToolPromptFamilyForTesting(null)
    expect(getBashGitInstructionsBody()).toBe(before)
  })
})
