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
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'src/commands/commands.js'
import {
  buildAgentToolSection,
  getSessionSpecificGuidanceSection,
} from 'src/agent/prompts/prompts.js'
import { zodToJsonSchema } from 'src/shared/data/zodToJsonSchema.js'
import { getEmptyToolPermissionContext, type Tool } from 'src/tools/Tool.js'
import { getAllBaseTools } from 'src/tools/tools.js'
import { getBashGitInstructionsBody } from 'src/tools/BashTool/prompt.js'
import { formatCommandsWithinBudget } from 'src/tools/SkillTool/prompt.js'

const SNAPSHOT_DIR = join(__dirname, '__snapshots__')

/** The shipped system prompt, one entry per state the bundle was dumped in. */
function systemPromptStates(): Array<[string, string, boolean]> {
  const states: Array<[string, string, boolean]> = []
  for (const [state, file, lean] of [
    ['default', 'systemPrompt.main.txt', false],
    ['v2', 'systemPrompt.lean.txt', true],
  ] as const) {
    const path = join(SNAPSHOT_DIR, file)
    if (existsSync(path)) states.push([state, readFileSync(path, 'utf8'), lean])
  }
  return states
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
  apply_patch: [
    '*** Begin Patch',
    '*** Add File',
    '*** Update File',
    '*** Delete File',
    '*** Move to',
    '*** End of File',
    '@@',
    'atomic',
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
  ['one multi-file patch', 'ONE apply_patch'],
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
  const states = systemPromptStates()

  test('both system prompt snapshots are present', () => {
    expect(states.map(([state]) => state)).toEqual(['default', 'v2'])
  })

  for (const [name, markers] of Object.entries(TOOL_MARKERS)) {
    test(`${name} still names every capability`, async () => {
      const tool = getAllBaseTools().find(t => t.name === name)
      expect(tool ? name : `${name} missing from getAllBaseTools()`).toBe(name)
      const text = await toolText(tool!)
      const missing = markers.filter(m => (typeof m === 'string' ? !text.includes(m) : !m.test(text)))
      expect(missing.map(String)).toEqual([])
    })
  }

  for (const [state, systemPrompt, lean] of states) {
    test(`${state}: every capability is named somewhere the model reads`, async () => {
      const toolTexts = await Promise.all(getAllBaseTools().map(toolText))
      const skillListing = formatCommandsWithinBudget([FAKE_SKILL], 200_000)
      const corpus = [systemPrompt, sessionGuidance(lean), ...toolTexts, getBashGitInstructionsBody(), skillListing].join('\n')
      const missing = ANYWHERE_MARKERS.filter(([, m]) => (typeof m === 'string' ? !corpus.includes(m) : !m.test(corpus)))
      expect(missing.map(([capability]) => capability)).toEqual([])
    })
  }
})
