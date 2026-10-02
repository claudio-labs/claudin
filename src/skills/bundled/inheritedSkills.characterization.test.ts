/**
 * Characterization suite for four bundled prompt skills (/update-config,
 * /batch, /debug, /loop) and for the list initBundledSkills registers.
 *
 * It was written against the old modules before their clean-base rewrite,
 * which has to pass it unchanged, so it reaches them only the way the CLI
 * does: through the registry, and through the text an invocation returns.
 * A prompt is held to the facts it has to state (paths, tool names, tool
 * parameters, report formats), never to its wording.
 *
 * docs/tech/rewrite/skills/bundledPromptSkills.md is the spec it goes with.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import escapeRegExp from 'lodash-es/escapeRegExp.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { isDeepStrictEqual } from 'util'
import { toJSONSchema } from 'zod/v4'

import { AUTONOMOUS_LOOP_DYNAMIC_SENTINEL, AUTONOMOUS_LOOP_SENTINEL, MAINTENANCE_PROMPT } from 'src/agent/loopSentinels.js'
import { getSettingsFilePathForSource } from 'src/platform/settings/settings.js'
import { SettingsSchema } from 'src/platform/settings/types.js'
import { getDebugLogPath, isDebugMode } from 'src/shared/debug.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { registerBatchSkill } from 'src/skills/bundled/batch.js'
import { registerDebugSkill } from 'src/skills/bundled/debug.js'
import { initBundledSkills } from 'src/skills/bundled/index.js'
import { registerLoopSkill } from 'src/skills/bundled/loop.js'
import { registerUpdateConfigSkill } from 'src/skills/bundled/updateConfig.js'
import { clearBundledSkills, getBundledSkills } from 'src/skills/bundledSkills.js'
import { CLAUDE_CODE_GUIDE_AGENT_TYPE } from 'src/tools/AgentTool/built-in/claudeCodeGuideAgent.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from 'src/tools/AskUserQuestionTool/prompt.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from 'src/tools/EnterPlanModeTool/constants.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { MONITOR_TOOL_NAME } from 'src/tools/MonitorTool/toolName.js'
import { CRON_CREATE_TOOL_NAME, CRON_DELETE_TOOL_NAME, DEFAULT_MAX_AGE_DAYS } from 'src/tools/ScheduleCronTool/prompt.js'
import { SCHEDULE_WAKEUP_TOOL_NAME, WAKEUP_MAX_DELAY_SECONDS, WAKEUP_MIN_DELAY_SECONDS } from 'src/tools/ScheduleWakeupTool/prompt.js'
import { SKILL_TOOL_NAME } from 'src/tools/SkillTool/constants.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { getIsGit } from 'src/vcs/git/git.js'

// initBundledSkills also registers skills that ship reference files, whose
// extraction root is named after MACRO.VERSION; only the build inlines it.
const buildGlobals = globalThis as { MACRO?: { VERSION?: string } }
buildGlobals.MACRO ??= { VERSION: '0.0.0-test' }

// None of the four skills reads the tool-use context.
const noContext = {} as ToolUseContext

afterAll(() => clearBundledSkills())

// -- Reading the registry and the prompts

type BundledCommand = ReturnType<typeof getBundledSkills>[number]

function registered(name: string): BundledCommand {
  const matches = getBundledSkills().filter(command => command.name === name)
  expect(matches.map(command => command.name)).toEqual([name])
  return matches[0]!
}

/** Invokes a registered skill as the Skill tool would, and returns its only block's text. */
async function run(name: string, args: string): Promise<string> {
  const blocks = await registered(name).getPromptForCommand(args, noContext)
  expect(blocks.map(block => block.type)).toEqual(['text'])
  const [block] = blocks
  return block?.type === 'text' ? block.text : ''
}

/** The part of the registered command that a skill's definition decides. */
function registrationOf(command: BundledCommand) {
  return {
    name: command.name,
    aliases: command.aliases,
    argumentHint: command.argumentHint,
    allowedTools: command.allowedTools,
    userInvocable: command.userInvocable,
    disableModelInvocation: command.disableModelInvocation,
    model: command.model,
    context: command.context,
    agent: command.agent,
    hooks: command.hooks,
    skillRoot: command.skillRoot,
    hasWhenToUse: command.whenToUse !== undefined,
  }
}

/**
 * What all four leave at the registry's defaults: invocable by the user, no
 * aliases, no model or agent of their own, run inline, no hooks, and no
 * reference files to extract.
 */
const SHARED_REGISTRATION = { aliases: undefined, userInvocable: true, model: undefined, context: undefined, agent: undefined, hooks: undefined, skillRoot: undefined }

type OwnRegistration = Pick<ReturnType<typeof registrationOf>, 'name' | 'argumentHint' | 'allowedTools' | 'disableModelInvocation' | 'hasWhenToUse'>

/** Pins the whole registration: what the skill sets, and that it leaves the rest at the defaults. */
function expectRegistration(command: BundledCommand, own: OwnRegistration): void {
  expect(registrationOf(command)).toEqual({ ...SHARED_REGISTRATION, ...own })
  expect(command.isEnabled?.() ?? true).toBe(true)
}

type Fact = string | RegExp

/** The facts `text` fails to state; a failure lists all of them at once. */
function missing(text: string, facts: readonly Fact[]): string[] {
  return facts
    .filter(fact => (typeof fact === 'string' ? !text.includes(fact) : !fact.test(text)))
    .map(fact => String(fact))
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

// -- /update-config

const FENCED_JSON_RE = /```json\n([\s\S]*?)\n```/g

let settingsSchemaJson: unknown
/** The settings schema as JSON Schema for its input side, the shape a settings file is written in. */
function expectedSettingsSchema(): unknown {
  settingsSchemaJson ??= JSON.parse(JSON.stringify(toJSONSchema(SettingsSchema(), { io: 'input' })))
  return settingsSchemaJson
}

function parsedOrUndefined(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined // hand-written examples carry comments; they are not the schema
  }
}

/** Counts the fenced blocks that hold exactly the settings schema, and returns the prompt without them. */
function splitOffSchema(text: string): { schemaBlocks: number; guidance: string } {
  let schemaBlocks = 0
  let guidance = text
  for (const [block, body] of text.matchAll(FENCED_JSON_RE)) {
    if (isDeepStrictEqual(parsedOrUndefined(body!), expectedSettingsSchema())) {
      schemaBlocks++
      guidance = guidance.replace(block, '')
    }
  }
  return { schemaBlocks, guidance }
}

const SETTINGS_GUIDANCE_FACTS: readonly Fact[] = [
  // The three files, their scope, and which one wins.
  '~/.claudin/settings.json',
  /(^|[^~/])\.claudin\/settings\.json/m,
  '.claudin/settings.local.json',
  /\buser\b\s*(→|->|>|,?\s*then)\s*project\b\s*(→|->|>|,?\s*then)\s*local\b/i,
  /gitignore/i,
  // Changing them: merge into what is there, and ask when the target is unclear.
  /\bmerg/i,
  ASK_USER_QUESTION_TOOL_NAME,
  // The keys people ask for most, and the rule syntax of permissions.
  '"allow"',
  '"deny"',
  '"ask"',
  'defaultMode',
  'additionalDirectories',
  /\w\([^)\n]*:\*\)/,
  '"env"',
  '"model"',
  'alwaysThinkingEnabled',
  'attribution',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'enabledPlugins',
  /\w@[\w-]+/,
  'language',
  'cleanupPeriodDays',
  'respectGitignore',
  'spinnerTipsEnabled',
  'spinnerVerbs',
  'spinnerTipsOverride',
  'syntaxHighlightingDisabled',
  // Where to look when a hook does not run.
  /--debug\b/,
]

const HOOK_EVENTS_EXPLAINED = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'PreCompact',
  'PostCompact',
  'UserPromptSubmit',
  'SessionStart',
]

const HOOK_REFERENCE_FACTS: readonly Fact[] = [
  ...HOOK_EVENTS_EXPLAINED.map(event => new RegExp(`\\b${event}\\b`)),
  // The shape of an entry, and the three kinds of hook.
  '"matcher"',
  '"timeout"',
  '"statusMessage"',
  /"type":\s*"command"/,
  /"type":\s*"prompt"/,
  /"type":\s*"agent"/,
  // What a hook reads on stdin, and what its JSON output may carry.
  'session_id',
  'tool_name',
  'tool_input',
  'tool_response',
  'systemMessage',
  '"continue"',
  'stopReason',
  'suppressOutput',
  '"decision"',
  'hookSpecificOutput',
  'hookEventName',
  'additionalContext',
  'permissionDecision',
  'permissionDecisionReason',
  'updatedInput',
  // Building a hook that provably works: safe payload handling, a piped
  // test run, a jq check of the written file, and the reload caveat.
  /\bxargs\b/,
  'read -r f',
  /echo '\{/,
  '2>/dev/null || true',
  /\bjq -e '\.hooks\./,
  '.claudin/settings.local.json',
  /\.gitignore\b/,
  '/hooks',
  /\brestart/i,
]

describe('/update-config', () => {
  beforeEach(() => {
    clearBundledSkills()
    registerUpdateConfigSkill()
  })

  test('registers for users and the model alike, pre-approving Read only', () => {
    expectRegistration(registered('update-config'), { name: 'update-config', argumentHint: '[what to configure]', allowedTools: ['Read'], disableModelInvocation: false, hasWhenToUse: false })
  })

  test('its description routes event-driven automation, permissions and env vars to it', () => {
    const facts = ['settings.json', 'settings.local.json', /\bhooks?\b/i, /\bharness\b/i, /\bmemory\b/i, /\bpermissions?\b/i, /\benv\b/i]
    expect(missing(registered('update-config').description, facts)).toEqual([])
  })

  test('with no request it returns the settings guidance and the live settings schema', async () => {
    const { schemaBlocks, guidance } = splitOffSchema(await run('update-config', ''))
    expect(schemaBlocks).toBe(1)
    expect(missing(guidance, SETTINGS_GUIDANCE_FACTS)).toEqual([])
    expect(missing(guidance, HOOK_REFERENCE_FACTS)).toEqual([])
  })

  test('a request only adds itself at the end', async () => {
    const bare = await run('update-config', '')
    const request = 'allow npm commands without prompting'
    const asked = await run('update-config', request)
    expect(asked.startsWith(bare)).toBe(true)
    expect(asked.trimEnd().endsWith(request)).toBe(true)
  })

  test('[hooks-only] returns the hooks reference alone, exactly as the full prompt carries it', async () => {
    const hooksOnly = await run('update-config', '[hooks-only]')
    expect(splitOffSchema(hooksOnly).schemaBlocks).toBe(0)
    expect(missing(hooksOnly, HOOK_REFERENCE_FACTS)).toEqual([])
    expect(await run('update-config', '')).toContain(hooksOnly)
  })

  test('after [hooks-only], the rest of the line becomes the task; a blank rest adds nothing', async () => {
    const hooksOnly = await run('update-config', '[hooks-only]')
    expect(await run('update-config', '[hooks-only]  \t ')).toBe(hooksOnly)

    const summary = 'PostToolUse on Write|Edit that runs ruff format on the file'
    const withTask = await run('update-config', `[hooks-only] ${summary}  `)
    expect(withTask.startsWith(hooksOnly)).toBe(true)
    expect(withTask.trimEnd().endsWith(summary)).toBe(true)
    expect(withTask).not.toContain('[hooks-only]')
  })
})

// -- /batch

const BATCH_USAGE_EXAMPLE_RE = /^[\s>*`-]*\/batch\s+\S/m

describe('/batch', () => {
  let repository: string
  let plainDirectory: string

  beforeAll(() => {
    repository = mkdtempSync(join(tmpdir(), 'batch-repo-'))
    mkdirSync(join(repository, '.git'))
    plainDirectory = mkdtempSync(join(tmpdir(), 'batch-plain-'))
  })

  afterAll(() => {
    rmSync(repository, { recursive: true, force: true })
    rmSync(plainDirectory, { recursive: true, force: true })
  })

  beforeEach(() => {
    clearBundledSkills()
    registerBatchSkill()
  })

  /** Runs /batch in a session whose working directory is `directory`. */
  async function runIn(directory: string, args: string): Promise<string> {
    // Whether the session is in a repository is memoized for the process:
    // start from a cold answer and leave one behind.
    getIsGit.cache.clear?.()
    try {
      return await runWithCwdOverride(directory, () => run('batch', args))
    } finally {
      getIsGit.cache.clear?.()
    }
  }

  test('registers for users only, with an instruction as its argument and no tool pre-approved', () => {
    expectRegistration(registered('batch'), { name: 'batch', argumentHint: '<instruction>', allowedTools: [], disableModelInvocation: true, hasWhenToUse: true })
  })

  test('its description and whenToUse name the parallel, worktree-isolated, PR-per-unit shape', () => {
    const command = registered('batch')
    expect(missing(command.description, [/\b5\s*[–-]\s*30\b/, /\bworktree/i, /\bPRs?\b/, /\bparallel\b/i, /\bplan\b/i])).toEqual([])
    expect(missing(command.whenToUse ?? '', [/\bmigrations?\b/i, /\brefactor/i, /\brenames?\b/i, /\bindependent\b/i, /\bparallel\b/i])).toEqual([])
  })

  test('with no instruction it answers with usage examples, before checking for a repository', async () => {
    const text = await runIn(plainDirectory, '  \n ')
    expect(text).toMatch(BATCH_USAGE_EXAMPLE_RE)
    expect(text).not.toContain(ENTER_PLAN_MODE_TOOL_NAME)
  })

  test('outside a git repository it explains that /batch needs one', async () => {
    const text = await runIn(plainDirectory, 'migrate the tests to vitest')
    expect(missing(text, [/\bgit\b/i, /\brepo(sitory)?\b/i, /\bworktrees?\b/i])).toEqual([])
    expect(text).not.toMatch(BATCH_USAGE_EXAMPLE_RE)
    expect(text).not.toContain(ENTER_PLAN_MODE_TOOL_NAME)
  })

  test('inside a repository the orchestration prompt carries the instruction, trimmed', async () => {
    const args = '  migrate the tests to vitest \n'
    const text = await runIn(repository, args)
    expect(text).toContain('migrate the tests to vitest')
    expect(text).not.toContain(args)
    expect(text).toContain(ENTER_PLAN_MODE_TOOL_NAME)
  })

  test('phase one researches and decomposes the work inside plan mode', async () => {
    const text = await runIn(repository, 'rename the logger')
    const facts = [
      ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME,
      /\b5\s*[–-]\s*30\b/,
      /\bworktree\b/i,
      /\bend-to-end\b|\be2e\b/i,
      /\btmux\b/,
      /\bcurl\b/,
    ]
    expect(missing(text, facts)).toEqual([])
    expect(text.indexOf(ENTER_PLAN_MODE_TOOL_NAME)).toBeLessThan(text.indexOf(EXIT_PLAN_MODE_TOOL_NAME))
  })

  test('phase two launches one isolated background agent per unit, all at once', async () => {
    const text = await runIn(repository, 'rename the logger')
    const facts = [
      new RegExp(`\\b${AGENT_TOOL_NAME}\\b`),
      /\bisolation\b\W{0,5}worktree\b/,
      /\brun_in_background\b\W{0,5}true\b/,
      /\b(single|one)\b[^.\n]*\bmessage\b/i,
      new RegExp(`\\bsubagent_type\\b\\W{0,5}${GENERAL_PURPOSE_AGENT.agentType}\\b`),
    ]
    expect(missing(text, facts)).toEqual([])
  })

  test('each worker reviews, tests, opens a PR and reports it on the line the tracker reads', async () => {
    const text = await runIn(repository, 'rename the logger')
    const facts = [
      new RegExp(`\\b${SKILL_TOOL_NAME}\\b`),
      /\bskill\b\W{0,5}code-review\b/,
      /\bargs\b\W{0,5}medium\b/,
      /\bpush\b/i,
      'gh pr create',
      /PR: none\b/,
    ]
    expect(missing(text, facts)).toEqual([])
    // Stated once to the workers and once to the tracker that parses it.
    expect(text.split('PR: <url>').length - 1).toBeGreaterThanOrEqual(2)
  })

  test('phase three tracks the units in a status table', async () => {
    const text = await runIn(repository, 'rename the logger')
    const facts = [/\|\s*#\s*\|\s*Unit\s*\|\s*Status\s*\|\s*PR\s*\|/, /\brunning\b/, /\bdone\b/, /\bfailed\b/]
    expect(missing(text, facts)).toEqual([])
  })
})

// -- /debug

describe('/debug', () => {
  const savedLogPath = process.env.CLAUDIN_DEBUG_LOGS_DIR
  let logs: string

  beforeAll(() => {
    logs = mkdtempSync(join(tmpdir(), 'debug-skill-'))
  })

  afterAll(() => {
    restoreEnv('CLAUDIN_DEBUG_LOGS_DIR', savedLogPath)
    rmSync(logs, { recursive: true, force: true })
  })

  beforeEach(() => {
    clearBundledSkills()
    registerDebugSkill()
  })

  /** Points this session's debug log at `name` under the temp dir (the variable names the file itself). */
  function logAt(name: string): string {
    const path = join(logs, name)
    process.env.CLAUDIN_DEBUG_LOGS_DIR = path
    expect(getDebugLogPath()).toBe(path)
    return path
  }

  // First on purpose: it is the one test that can see logging switch on.
  // Invoking /debug leaves it on for the rest of the process, and other
  // suites (the skill-cost bench) invoke it too, so what was true before is
  // read at run time rather than assumed.
  test('switches debug logging on, and announces that only when it was off', async () => {
    const path = logAt('switch-on.log')
    const wasOn = isDebugMode()

    const first = await run('debug', '')
    expect(isDebugMode()).toBe(true)
    const second = await run('debug', '')

    if (!wasOn) {
      expect(missing(first, [path, /reproduc/i, /--debug\b/])).toEqual([])
      expect(first.length).toBeGreaterThan(second.length)
    }
    expect(second).not.toMatch(/--debug\b/)
  })

  test('registers for users only, pre-approving Read, Grep and Glob', () => {
    const command = registered('debug')
    expectRegistration(command, { name: 'debug', argumentHint: '[issue description]', allowedTools: ['Read', 'Grep', 'Glob'], disableModelInvocation: true, hasWhenToUse: false })
    expect(missing(command.description, [/\bdebug logging\b/i, /\bdiagnos/i])).toEqual([])
  })

  test('names the log, its size and its last lines', async () => {
    const path = logAt('tail.log')
    const lines = Array.from({ length: 30 }, (_, i) => `2026-09-27T10:00:${String(i).padStart(2, '0')}.000Z [DEBUG] tail probe ${String(i + 1).padStart(2, '0')} end`)
    const content = `${lines.join('\n')}\n`
    writeFileSync(path, content)

    const text = await run('debug', '')
    const probe = (n: number) => `tail probe ${String(n).padStart(2, '0')} end`
    expect(missing(text, [path, formatFileSize(Buffer.byteLength(content)), /\b20\b[^\n]*\blines?\b/i])).toEqual([])
    // The newest nineteen lines are in; the twentieth from the end may or may not be.
    expect(missing(text, Array.from({ length: 19 }, (_, i) => probe(12 + i)))).toEqual([])
    for (let n = 1; n <= 10; n++) expect(text).not.toContain(probe(n))
  })

  test('reads no more than the last 64 KiB of a large log', async () => {
    const path = logAt('large.log')
    // Twenty lines of 10,000 bytes each: line 15 starts 60,000 bytes from the
    // end and line 14 starts 70,000 bytes from it.
    const blocks = Array.from({ length: 20 }, (_, i) => `block-${String(i + 1).padStart(2, '0')}:${'x'.repeat(9990)}`)
    const content = `${blocks.join('\n')}\n`
    writeFileSync(path, content)

    const text = await run('debug', '')
    expect(missing(text, [formatFileSize(Buffer.byteLength(content)), 'block-15:', 'block-20:'])).toEqual([])
    expect(text).not.toContain('block-14:')
    expect(text).not.toContain('block-01:')
  })

  test('a log that does not exist yet is not reported as a failure', async () => {
    logAt('never-written.log')
    const text = await run('debug', '')
    expect(text).toMatch(/\bno\b[^.\n]*\blog\b|\blog\b[^.\n]*\b(does not|doesn't|not yet)\b/i)
    expect(text).not.toContain('ENOENT')
  })

  test.skipIf(process.platform === 'win32')('a log that cannot be read is reported with the reason', async () => {
    mkdirSync(logAt('a-directory.log'))
    expect(await run('debug', '')).toMatch(/\bEISDIR\b/)
  })

  test('embeds the issue as given, or asks for a summary of the log when there is none', async () => {
    logAt('issue.log')
    const issue = 'the status line flickers after a resize'
    expect(await run('debug', issue)).toContain(issue)
    expect(await run('debug', '')).toMatch(/summar/i)
  })

  test('lists the user, project and local settings files', async () => {
    logAt('settings.log')
    const paths = (['userSettings', 'projectSettings', 'localSettings'] as const).map(source => getSettingsFilePathForSource(source)!)
    expect(new Set(paths).size).toBe(3)
    expect(missing(await run('debug', ''), paths)).toEqual([])
  })

  test('points the model at error and warning lines, and at the claudin-guide agent', async () => {
    logAt('pointers.log')
    expect(missing(await run('debug', ''), ['[ERROR]', '[WARN]', CLAUDE_CODE_GUIDE_AGENT_TYPE])).toEqual([])
  })
})

// -- /loop

/** A fixed loop schedules a recurring cron task; a self-paced one re-arms a wakeup (its delaySeconds). */
const CRON_SCHEDULE_RE = /\brecurring\b\W{0,5}true\b/
const WAKEUP_DELAY_PARAMETER = 'delaySeconds'
const PROJECT_LOOP_FILE_RE = /(^|[^~/])\.claudin\/loop\.md/m

function loopShape(text: string): { schedule: 'cron' | 'wakeup'; maintenance: boolean } {
  const cron = CRON_SCHEDULE_RE.test(text)
  const wakeup = text.includes(WAKEUP_DELAY_PARAMETER)
  expect(cron).not.toBe(wakeup)
  return { schedule: cron ? 'cron' : 'wakeup', maintenance: text.includes(MAINTENANCE_PROMPT) }
}

/** Whether `body` stands alone between a BEGIN line and an END line, as prompts to run or schedule do. */
function delimits(text: string, body: string): boolean {
  return new RegExp(`\\bBEGIN\\b[^\\n]*\\n${escapeRegExp(body)}\\n[^\\n]*\\bEND\\b`).test(text)
}

/** Nothing but an interval: a fixed maintenance loop, and the interval it normalizes to. */
const BARE_INTERVALS: ReadonlyArray<readonly [args: string, interval: string]> = [
  ['15m', '15m'],
  ['  15m \t', '15m'],
  ['90s', '90s'],
  ['5 sec', '5s'],
  ['45 secs', '45s'],
  ['1 second', '1s'],
  ['20 seconds', '20s'],
  ['10min', '10m'],
  ['3 mins', '3m'],
  ['1 minute', '1m'],
  ['2 minutes', '2m'],
  ['12hr', '12h'],
  ['2 hrs', '2h'],
  ['1 hour', '1h'],
  ['6 hours', '6h'],
  ['1d', '1d'],
  ['1 day', '1d'],
  ['2days', '2d'],
  ['007m', '7m'],
  ['5M', '5m'],
  ['2 Hours', '2h'],
]

/** An interval with a prompt, leading as one token or trailing as an "every" clause. */
const FIXED_PROMPTS: ReadonlyArray<readonly [args: string, interval: string, prompt: string]> = [
  ['5m check the deploy', '5m', 'check the deploy'],
  ['2h check logs', '2h', 'check logs'],
  ['30s ping the endpoint', '30s', 'ping the endpoint'],
  ['check the deploy every 20m', '20m', 'check the deploy'],
  ['run tests every 5 minutes', '5m', 'run tests'],
  ['poll the queue EVERY 3 hrs', '3h', 'poll the queue'],
  ['summarize the inbox every 1 day', '1d', 'summarize the inbox'],
]

/** No interval the parser accepts: the whole text, trimmed, is the prompt of a self-paced loop. */
const SELF_PACED_PROMPTS = [
  'check the deploy',
  'check every PR',
  'check every 5 PRs',
  // A leading interval is a single token: with a space before its unit, it
  // is part of the prompt.
  '5 minutes check the deploy',
  'watch  the build\nand report',
]

/** Interval-looking arguments that must never schedule a cron task. */
const NOT_INTERVALS = ['0m', '0 minutes', '5w', '5ms', '1.5h', '-5m', '5m,']

describe('/loop', () => {
  const savedCronSwitch = process.env.CLAUDIN_DISABLE_CRON

  afterEach(() => restoreEnv('CLAUDIN_DISABLE_CRON', savedCronSwitch))

  beforeEach(() => {
    clearBundledSkills()
    registerLoopSkill()
  })

  test('registers for users and the model, taking an optional interval and prompt', () => {
    const command = registered('loop')
    expect(registrationOf(command)).toEqual({ ...SHARED_REGISTRATION, name: 'loop', argumentHint: '[interval] [prompt]', allowedTools: [], disableModelInvocation: false, hasWhenToUse: true })
    expect(missing(command.description, [/\binterval\b/i, /\breschedul/i, /\bmaintenance\b/i])).toEqual([])
    expect(missing(command.whenToUse ?? '', [/\bpoll/i, /\brecurring\b/i, /\bsession\b/i])).toEqual([])
  })

  test('is enabled unless CLAUDIN_DISABLE_CRON is truthy, read at call time', () => {
    const command = registered('loop')
    delete process.env.CLAUDIN_DISABLE_CRON
    expect(command.isEnabled?.()).toBe(true)
    process.env.CLAUDIN_DISABLE_CRON = '1'
    expect(command.isEnabled?.()).toBe(false)
    process.env.CLAUDIN_DISABLE_CRON = 'true'
    expect(command.isEnabled?.()).toBe(false)
    process.env.CLAUDIN_DISABLE_CRON = '0'
    expect(command.isEnabled?.()).toBe(true)
  })

  for (const [args, interval] of BARE_INTERVALS) {
    test(`${JSON.stringify(args)} is a fixed maintenance loop every ${interval}`, async () => {
      const text = await run('loop', args)
      expect(loopShape(text)).toEqual({ schedule: 'cron', maintenance: true })
      expect(text).toMatch(new RegExp(`\\b${interval}\\b`))
      // The scheduled body is the fixed sentinel, expanded when it fires.
      expect(delimits(text, AUTONOMOUS_LOOP_SENTINEL)).toBe(true)
      expect(text).not.toContain(AUTONOMOUS_LOOP_DYNAMIC_SENTINEL)
      expect(text).toMatch(/\bsentinel\b/i)
    })
  }

  for (const [args, interval, prompt] of FIXED_PROMPTS) {
    test(`${JSON.stringify(args)} runs ${JSON.stringify(prompt)} every ${interval}`, async () => {
      const text = await run('loop', args)
      expect(loopShape(text)).toEqual({ schedule: 'cron', maintenance: false })
      expect(text).toMatch(new RegExp(`\\b${interval}\\b`))
      expect(delimits(text, prompt)).toBe(true)
      expect(text).not.toContain(AUTONOMOUS_LOOP_SENTINEL)
      expect(text).not.toContain(AUTONOMOUS_LOOP_DYNAMIC_SENTINEL)
    })
  }

  for (const prompt of SELF_PACED_PROMPTS) {
    test(`${JSON.stringify(prompt)} is a self-paced loop that reschedules itself through /loop`, async () => {
      const text = await run('loop', `  ${prompt} `)
      expect(loopShape(text)).toEqual({ schedule: 'wakeup', maintenance: false })
      expect(delimits(text, prompt)).toBe(true)
      expect(delimits(text, `/loop ${prompt}`)).toBe(true)
      expect(text).not.toContain(AUTONOMOUS_LOOP_SENTINEL)
      expect(text).not.toContain(AUTONOMOUS_LOOP_DYNAMIC_SENTINEL)
    })
  }

  for (const args of NOT_INTERVALS) {
    test(`${JSON.stringify(args)} is not accepted as an interval`, async () => {
      expect(await run('loop', args)).not.toMatch(CRON_SCHEDULE_RE)
    })
  }

  for (const args of ['', '   ', '\n\t']) {
    test(`${JSON.stringify(args)} is a self-paced maintenance loop`, async () => {
      const text = await run('loop', args)
      expect(loopShape(text)).toEqual({ schedule: 'wakeup', maintenance: true })
      expect(delimits(text, AUTONOMOUS_LOOP_DYNAMIC_SENTINEL)).toBe(true)
      expect(text).not.toContain(AUTONOMOUS_LOOP_SENTINEL)
      expect(text).toMatch(/\bsentinel\b/i)
      // The project's loop.md wins over the user's, and both over the built-in prompt.
      const projectFile = PROJECT_LOOP_FILE_RE.exec(text)
      expect(projectFile).not.toBeNull()
      expect(projectFile!.index).toBeLessThan(text.indexOf('~/.claudin/loop.md'))
    })
  }

  test('a self-paced loop paces itself with one wakeup per turn, and never with cron', async () => {
    const text = await run('loop', 'check the deploy')
    const facts = [
      new RegExp(`\\b${SCHEDULE_WAKEUP_TOOL_NAME}\\b`),
      /\bonce\b/i,
      WAKEUP_DELAY_PARAMETER,
      new RegExp(`\\b${WAKEUP_MIN_DELAY_SECONDS}\\b`),
      new RegExp(`\\b${WAKEUP_MAX_DELAY_SECONDS}\\b`),
      /\breason\b/,
      /\breplac/i,
      new RegExp(`\\b(do not|don't|never)\\b[^\\n]*\\b${CRON_CREATE_TOOL_NAME}\\b`, 'i'),
      new RegExp(`\\b(do not|don't|never)\\b[^\\n]*\\b${SCHEDULE_WAKEUP_TOOL_NAME}\\b`, 'i'),
      /\bcancel\b\W{0,5}true\b/,
      new RegExp(`\\b${MONITOR_TOOL_NAME}\\b`),
      /\b1200\s*[–-]\s*1800/,
      new RegExp(`\\b${SKILL_TOOL_NAME}\\b`),
    ]
    expect(missing(text, facts)).toEqual([])
  })

  test('a fixed loop schedules a session-only recurring cron task and runs once right away', async () => {
    const text = await run('loop', '5m check the deploy')
    const facts = [
      new RegExp(`\\b${CRON_CREATE_TOOL_NAME}\\b`),
      /\bdurable\b\W{0,5}false\b/,
      new RegExp(`\\b${DEFAULT_MAX_AGE_DAYS}[ -]days?\\b`),
      new RegExp(`\\b${CRON_DELETE_TOOL_NAME}\\b`),
      /\bround/i,
      /\bminute/i,
      /\bimmediate/i,
      new RegExp(`\\b${SKILL_TOOL_NAME}\\b`),
    ]
    expect(missing(text, facts)).toEqual([])
  })

  test('a fixed maintenance loop runs the built-in maintenance prompt now', async () => {
    expect(await run('loop', '30m')).toContain(MAINTENANCE_PROMPT)
  })
})

// -- The registration list

const BUNDLED_SKILLS_IN_ORDER = [
  'update-config',
  'debug',
  'code-review',
  'batch',
  'simplify',
  'verify',
  'run',
  'fewer-permission-prompts',
  'create',
  'refresh-rules',
  'loop',
]

describe('initBundledSkills', () => {
  const savedCronSwitch = process.env.CLAUDIN_DISABLE_CRON

  afterEach(() => {
    restoreEnv('CLAUDIN_DISABLE_CRON', savedCronSwitch)
    clearBundledSkills()
  })

  test('registers every bundled skill once, in a fixed order', () => {
    clearBundledSkills()
    initBundledSkills()
    expect(getBundledSkills().map(command => command.name)).toEqual(BUNDLED_SKILLS_IN_ORDER)
  })

  test('registers /loop even with cron disabled, which then hides it through isEnabled', () => {
    process.env.CLAUDIN_DISABLE_CRON = '1'
    clearBundledSkills()
    initBundledSkills()
    expect(getBundledSkills().map(command => command.name)).toEqual(BUNDLED_SKILLS_IN_ORDER)
    expect(registered('loop').isEnabled?.()).toBe(false)
    for (const name of ['update-config', 'debug', 'batch']) {
      expect(registered(name).isEnabled?.() ?? true).toBe(true)
    }
  })

  test('the four skills it registers are the same as when registered on their own', () => {
    const registrars: ReadonlyArray<readonly [string, () => void]> = [
      ['update-config', registerUpdateConfigSkill],
      ['debug', registerDebugSkill],
      ['batch', registerBatchSkill],
      ['loop', registerLoopSkill],
    ]
    clearBundledSkills()
    initBundledSkills()
    const fromList = registrars.map(([name]) => registrationOf(registered(name)))
    const alone = registrars.map(([name, register]) => {
      clearBundledSkills()
      register()
      return registrationOf(registered(name))
    })
    expect(fromList).toEqual(alone)
  })
})
