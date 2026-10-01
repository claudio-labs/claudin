/**
 * Invariant, end to end: the CLI that ships never changes what it already sent.
 *
 * Each scenario runs dist/cli.mjs — production flags, the real loop, tools,
 * hooks, attachments, system prompt and request builder — for several turns
 * in one headless process, against a scripted mock of the Messages API
 * (__testutils__/mockAnthropic.ts). Every request of the session's thread
 * must then extend the previous one: same system prompt, tools and request
 * parameters, every earlier message byte for byte (__testutils__/wireInvariant.ts).
 * The detector's strict mode runs too (CLAUDIN_CACHE_STRICT): it sees the
 * requests from inside, sub-agents included.
 *
 * Each scenario first proves it ran — every scripted tool call got a result,
 * and the shape it exists for reached the wire — so a scenario that stopped
 * early reads as "did not run", never as a cache verdict. There are no golden
 * files: a request is compared with the one before it, so new prompt text or
 * a new tool that keeps its bytes does not turn this red.
 *
 * A feature that adds something to a request (an attachment, a reminder, a
 * prompt section, a tool) belongs in a scenario here. Requires a build:
 * `bun run build` (CI builds before `bun test`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type MockServer,
  MOCK_ID_PREFIX,
  type SessionRun,
  type SessionSpec,
  runSession,
  startMockAnthropic,
} from 'src/agent/cache/__testutils__/mockAnthropic.js'
import { describeWireBreak, findWireBreak } from 'src/agent/cache/__testutils__/wireInvariant.js'
import { CACHE_STRICT_MARKER } from 'src/providers/cache/promptCacheBreakDetection.js'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')
// WIRE_E2E_LAUNCHER=<path> runs another build (a release, say) for a before/after.
const LAUNCHER = process.env.WIRE_E2E_LAUNCHER ?? join(REPO_ROOT, 'bin', 'claudin')

const bash = (command: string) => ({ name: 'Bash', input: { command, description: command } })
const call = (name: string, input: Record<string, unknown> = {}) => ({ name, input })

type Scenario = SessionSpec & {
  /** The shape this scenario exists for, checked on the wire before the cache verdict. */
  shape?: { label: string; text: string }
}

const SKILL = `---
name: demo
description: Demo checks for this repo.
---

Run the demo checks: echo the year with Bash.
`

const SCENARIOS: Scenario[] = [
  {
    key: 'tools',
    files: { 'a.ts': "export const NAME = 'alpha'\n" },
    turns: [
      { prompt: 'Look around.', steps: [{ tools: [bash('echo a')] }, { tools: [call('Read', { file_path: 'a.ts' })] }, { text: 'done' }] },
      { prompt: 'Thanks.', steps: [{ text: 'ok' }] },
    ],
  },
  {
    key: 'edit',
    files: { 'a.ts': "export const NAME = 'alpha'\n" },
    turns: [
      {
        prompt: 'Rename it.',
        steps: [
          { tools: [call('Read', { file_path: 'a.ts' })] },
          { tools: [call('Edit', { file_path: 'a.ts', old_string: "'alpha'", new_string: "'beta'" })] },
          { tools: [call('Read', { file_path: 'a.ts' })] },
          { text: 'renamed' },
        ],
      },
      { prompt: 'Thanks.', steps: [{ text: 'ok' }] },
    ],
  },
  {
    // #273: a Skill whose prompt command emits a turn-start attachment.
    key: 'skill',
    files: { '.claudin/skills/demo/SKILL.md': SKILL },
    env: { CLAUDIN_ENABLE_TASKS: '1' },
    shape: { label: 'the task_reconcile reminder', text: 'task list out of sync' },
    turns: [
      {
        prompt: 'Run the demo checks.',
        steps: [
          { tools: [call('TaskCreate', { subject: 'Run checks', description: 'run them' })] },
          { tools: [call('TaskUpdate', { taskId: '1', status: 'in_progress' })] },
          { tools: [call('Skill', { skill: 'demo' })] },
          { tools: [bash('date +%Y')] },
          { text: 'done' },
        ],
      },
      { prompt: 'Is 221 prime?', steps: [{ text: 'no' }] },
    ],
  },
  {
    key: 'hook',
    settings: {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: `echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"lint passed"}}'`,
              },
            ],
          },
        ],
      },
    },
    shape: { label: "the hook's additional context", text: 'lint passed' },
    turns: [
      { prompt: 'Build it.', steps: [{ tools: [bash('echo built')] }, { text: 'built' }] },
      { prompt: 'Thanks.', steps: [{ text: 'ok' }] },
    ],
  },
  {
    key: 'todos',
    turns: [
      {
        prompt: 'Plan it.',
        steps: [
          { tools: [call('TodoWrite', { todos: [{ content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' }] })] },
          { tools: [bash('echo working')] },
          { text: 'planned' },
        ],
      },
      { prompt: 'Continue.', steps: [{ tools: [bash('echo more')] }, { text: 'ok' }] },
    ],
  },
  {
    key: 'toolsearch',
    turns: [
      {
        prompt: 'Find the plan tools.',
        steps: [{ tools: [call('ToolSearch', { query: 'select:EnterPlanMode,ExitPlanMode', max_results: 2 })] }, { tools: [bash('echo c')] }, { text: 'found' }],
      },
      { prompt: 'Thanks.', steps: [{ text: 'ok' }] },
    ],
  },
  {
    key: 'agent',
    shape: { label: 'the sub-agent reply', text: 'ok' },
    turns: [
      {
        prompt: 'Ask a helper.',
        steps: [
          { tools: [call('Agent', { description: 'probe', prompt: 'Say ok. [e2e-sub agent]', subagent_type: 'Code' })] },
          { text: 'asked' },
        ],
      },
      { prompt: 'Thanks.', steps: [{ text: 'ok' }] },
    ],
  },
  {
    key: 'planmode',
    turns: [
      { prompt: 'Plan first.', steps: [{ tools: [call('EnterPlanMode')] }, { tools: [bash('ls')] }, { text: 'planning' }] },
      { prompt: 'Go on.', steps: [{ tools: [bash('echo still planning')] }, { text: 'ok' }] },
    ],
  },
  {
    key: 'worktree',
    shape: { label: 'the env_delta announcement', text: 'The environment changed since the start of this session' },
    turns: [
      { prompt: 'Work isolated.', steps: [{ tools: [call('EnterWorktree', { name: 'e2e' })] }, { tools: [bash('pwd')] }, { text: 'in' }] },
      { prompt: 'Thanks.', steps: [{ tools: [bash('pwd')] }, { text: 'ok' }] },
    ],
  },
  {
    // A local command between two turns adds its output to the history.
    key: 'slash',
    turns: [
      { prompt: 'Hello.', steps: [{ tools: [bash('echo a')] }, { text: 'hi' }] },
      { prompt: '/cost', steps: [] },
      { prompt: 'Thanks.', steps: [{ text: 'ok' }] },
    ],
  },
]

let mock: MockServer
let root: string
const runs = new Map<string, Promise<SessionRun>>()

beforeAll(async () => {
  if (!existsSync(BUNDLE)) return
  mock = await startMockAnthropic()
  root = mkdtempSync(join(tmpdir(), 'claudin-wire-prefix-'))
  for (const s of SCENARIOS) runs.set(s.key, runSession(mock, LAUNCHER, root, s))
})

afterAll(() => {
  mock?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

test('the bundle exists', () => {
  expect(existsSync(BUNDLE) ? 'present' : `MISSING — run \`bun run build\` first: ${BUNDLE}`).toBe('present')
})

describe.skipIf(!existsSync(BUNDLE))('the shipped CLI never changes what it already sent', () => {
  for (const scenario of SCENARIOS) {
    test(
      scenario.key,
      async () => {
        const run = await runs.get(scenario.key)!
        const main = run.captures.filter(c => c.thread === 'main').map(c => c.body)
        const calls = scenario.turns.flatMap(t => t.steps.flatMap(s => s.tools ?? []))

        // Did it run? Every scripted call answered, every response the mock's.
        expect(
          {
            exitCode: run.exitCode,
            answered: run.results.size,
            foreignResponses: run.modelIds.filter(id => !id.startsWith(MOCK_ID_PREFIX)),
          },
          `scenario did not run as scripted — stderr: ${run.stderr.slice(-600)}`,
        ).toEqual({ exitCode: 0, answered: calls.length, foreignResponses: [] })
        if (scenario.shape) {
          const reached = run.captures.some(c => JSON.stringify(c.body.messages).includes(scenario.shape!.text))
          expect(reached, `${scenario.shape.label} never reached the wire`).toBe(true)
        }

        const broken = findWireBreak(main)
        expect(broken ? describeWireBreak(broken) : null).toBeNull()
        expect(run.stderr.split('\n').filter(l => l.startsWith(CACHE_STRICT_MARKER))).toEqual([])
      },
      120_000,
    )
  }
})
