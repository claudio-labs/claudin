import { describe, expect, test } from 'bun:test'
import { appendQueryMessage } from 'src/agent/repl/queryMessages.js'
import {
  describeActivity,
  describeToolCall,
  describeToolCalls,
  findRunningToolCalls,
} from 'src/agent/ui/messages/toolActivityLabel.js'
import type { Message } from 'src/shared/types/message.js'

const call = (name: string, input?: unknown) => describeToolCall({ name, input: input ?? {} })

describe('describeToolCall — what one call is doing, in three words at most', () => {
  test('file tools name the file, not its path', () => {
    expect(call('Read', { file_path: '/repo/src/terminal/spinner/Spinner.tsx' })).toBe('Reading Spinner.tsx')
    expect(call('Edit', { file_path: '/repo/a.ts' })).toBe('Editing a.ts')
    expect(call('Write', { file_path: '/repo/notes.md' })).toBe('Writing notes.md')
    expect(call('NotebookEdit', { notebook_path: '/repo/n.ipynb' })).toBe('Editing n.ipynb')
  })

  test('a batch Read counts its files; a batch of one names it', () => {
    expect(call('Read', { file_paths: ['/a.ts', '/b.ts', '/c.ts'] })).toBe('Reading 3 files')
    expect(call('Read', { file_paths: ['/a.ts'] })).toBe('Reading a.ts')
    expect(call('Read', { file_paths: [] })).toBe('Reading')
  })

  test('a Patch names its one file or counts several', () => {
    const patch = (...files: string[]) =>
      ['*** Begin Patch', ...files.map(f => `*** Update File: ${f}\n@@\n-a\n+b`), '*** End Patch'].join('\n')
    expect(call('Patch', { patchText: patch('src/x.ts') })).toBe('Editing x.ts')
    expect(call('Patch', { patchText: patch('a.ts', 'b.ts') })).toBe('Editing 2 files')
    expect(call('apply_patch', { patchText: '*** Add File: new.ts\n+x' })).toBe('Editing new.ts')
    expect(call('Patch', { patchText: 'no headers' })).toBe('Editing')
  })

  test('search tools name the pattern, cut when long', () => {
    expect(call('Grep', { pattern: 'useBlink' })).toBe('Searching useBlink')
    expect(call('Glob', { pattern: '**/*.test.ts' })).toBe('Finding **/*.test.ts')
    expect(call('Grep', { pattern: 'a'.repeat(40) })).toBe(`Searching ${'a'.repeat(27)}…`)
  })

  test('a shell command reads as its program and subcommand', () => {
    const bash = (command: string) => call('Bash', { command })
    expect(bash('bun test src/x.test.ts 2>&1 | tail -5')).toBe('Running bun test')
    expect(bash('git status --short')).toBe('Running git status')
    expect(bash('cd /repo && make build')).toBe('Running make build')
    expect(bash('FOO=1 BAR=2 node script.js')).toBe('Running node')
    expect(bash('sleep 10 && echo fim')).toBe('Running sleep')
    expect(bash('ls -la')).toBe('Running ls')
    expect(bash('/usr/bin/python3 -c "print(1)"')).toBe('Running python3')
    expect(bash('bun run build')).toBe('Running bun build')
    expect(bash('npm exec tsc')).toBe('Running npm tsc')
    expect(bash('npm run')).toBe('Running npm run')
    expect(bash('cd /repo')).toBe('Running cd')
    expect(bash('   ')).toBe('Running')
    expect(call('PowerShell', { command: 'Get-ChildItem -Force' })).toBe('Running Get-ChildItem')
  })

  test('the Git tool reads as its first command', () => {
    expect(call('Git', { commands: ['git log -5', 'git status'] })).toBe('Running git log')
    expect(call('Git', { commands: 'git status' })).toBe('Running')
  })

  test('web tools name the host, or the web', () => {
    expect(call('WebFetch', { url: 'https://docs.example.com/a/b?c=d' })).toBe('Fetching docs.example.com')
    expect(call('WebFetch', { url: 'not a url' })).toBe('Fetching')
    expect(call('WebSearch', { query: 'nerd fonts' })).toBe('Searching web')
  })

  test('an agent call names the agent type, or the task', () => {
    expect(call('Agent', { subagent_type: 'Explore', prompt: 'x' })).toBe('Delegating to Explore')
    expect(call('Agent', { prompt: 'x' })).toBe('Delegating task')
    expect(call('Task', { subagent_type: 'Plan' })).toBe('Delegating to Plan')
    expect(call('SendMessage', { to: 'researcher' })).toBe('Messaging researcher')
    expect(call('ListAgents')).toBe('Listing agents')
  })

  test('fixed phrases for the tools that have no object worth naming', () => {
    expect(call('RunTests')).toBe('Running tests')
    expect(call('Typecheck')).toBe('Typechecking')
    expect(call('Build')).toBe('Building')
    expect(call('Container')).toBe('Running container')
    expect(call('Skill', { skill: 'pre-pr' })).toBe('Running pre-pr')
    for (const name of ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput', 'TodoWrite']) {
      expect(call(name)).toBe('Updating tasks')
    }
    expect(call('WaitFor')).toBe('Waiting')
    expect(call('Monitor')).toBe('Waiting')
    expect(call('AskUserQuestion')).toBe('Asking you')
    expect(call('EnterPlanMode')).toBe('Planning')
    expect(call('ExitPlanMode')).toBe('Planning')
    expect(call('LSP')).toBe('Querying LSP')
    expect(call('Rename', { symbol: 'getTaskIcon' })).toBe('Renaming getTaskIcon')
    expect(call('ToolSearch')).toBe('Loading tools')
    for (const name of ['Workflow', 'ListWorkflows', 'WorkflowStatus']) expect(call(name)).toBe('Running workflow')
  })

  test('an MCP call names its server; any other tool its own name', () => {
    expect(call('mcp__context7__resolve-library-id')).toBe('Calling context7')
    expect(call('mcp____x')).toBe('Calling MCP')
    expect(call('CronCreate')).toBe('Running CronCreate')
  })

  test('a call whose input has not arrived is its verb alone', () => {
    expect(describeToolCall({ name: 'Edit', input: undefined })).toBe('Editing')
    expect(describeToolCall({ name: 'Bash', input: null })).toBe('Running')
    expect(call('Edit', { file_path: '   ' })).toBe('Editing')
  })

  test('never more than three words', () => {
    expect(call('Grep', { pattern: 'one two three four' })).toBe('Searching one two')
    expect(call('Skill', { skill: 'a b c d' })).toBe('Running a b')
  })
})

describe('describeToolCalls — several at once', () => {
  test('none says nothing, one is described', () => {
    expect(describeToolCalls([])).toBeUndefined()
    expect(describeToolCalls([{ name: 'Grep', input: { pattern: 'x' } }])).toBe('Searching x')
  })

  test('the same kind of work is counted with its noun', () => {
    const reads = ['/a.ts', '/b.ts', '/c.ts'].map(file_path => ({ name: 'Read', input: { file_path } }))
    expect(describeToolCalls(reads)).toBe('Reading 3 files')
    // Edit and Patch are both "Editing files".
    expect(describeToolCalls([{ name: 'Edit', input: {} }, { name: 'Patch', input: {} }])).toBe('Editing 2 files')
    expect(describeToolCalls([{ name: 'Bash', input: {} }, { name: 'Git', input: {} }])).toBe('Running 2 commands')
  })

  test('mixed work, or work with no noun, is counted as tools', () => {
    expect(describeToolCalls([{ name: 'Read', input: {} }, { name: 'Grep', input: {} }])).toBe('Running 2 tools')
    expect(describeToolCalls([{ name: 'Build', input: {} }, { name: 'Build', input: {} }])).toBe('Running 2 tools')
  })
})

const assistant = (...blocks: object[]) => ({ type: 'assistant', message: { content: blocks } })
const use = (id: string, name: string, input: object = {}) => ({ type: 'tool_use', id, name, input })

describe('findRunningToolCalls', () => {
  test('nothing in progress scans nothing', () => {
    expect(findRunningToolCalls([assistant(use('a', 'Read'))], new Set())).toEqual([])
  })

  test('the in-progress calls, oldest first, across messages', () => {
    const messages = [
      assistant(use('a', 'Read', { file_path: '/a.ts' })),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } },
      assistant({ type: 'text', text: 'hi' }, use('b', 'Grep'), use('c', 'Bash')),
      { type: 'attachment' },
    ]
    expect(findRunningToolCalls(messages, new Set(['b', 'c']))).toEqual([
      { name: 'Grep', input: {} },
      { name: 'Bash', input: {} },
    ])
  })

  test('a message whose content is not a block list is skipped', () => {
    expect(findRunningToolCalls([{ type: 'assistant', message: { content: 'text' } }], new Set(['a']))).toEqual([])
  })

  test('only the newest 50 messages are scanned', () => {
    const old = assistant(use('old', 'Read'))
    const filler = Array.from({ length: 50 }, () => ({ type: 'user' }))
    expect(findRunningToolCalls([old, ...filler], new Set(['old']))).toEqual([])
    expect(findRunningToolCalls([old, ...filler.slice(1)], new Set(['old']))).toHaveLength(1)
  })

  test('progress messages do not count toward the 50', () => {
    const old = assistant(use('old', 'Read'))
    const ticks = Array.from({ length: 200 }, () => ({ type: 'progress' }))
    expect(findRunningToolCalls([old, ...ticks], new Set(['old']))).toHaveLength(1)
  })
})

// A running call's own progress lands in the REPL's messages after it: an
// agent's steps are appended, and two commands' ticks alternate, so the
// "replace the last tick" rule in appendQueryMessage never fires.
describe('a long-running call keeps its label', () => {
  const PROFILE = { immediateStubTokens: Infinity, stubKeepHeadChars: 0 }
  const toolUse = (id: string, name: string, input: unknown) =>
    ({ type: 'assistant', uuid: `a-${id}`, message: { role: 'assistant', content: [use(id, name, input as object)] } }) as unknown as Message
  const progress = (parentToolUseID: string, type: string, n: number) =>
    ({ type: 'progress', uuid: `p-${parentToolUseID}-${n}`, parentToolUseID, toolUseID: `${parentToolUseID}-${n}`, data: { type } }) as unknown as Message

  test('a sub-agent past 50 steps still reads as delegating', () => {
    let messages: Message[] = [toolUse('t1', 'Agent', { subagent_type: 'Explore', prompt: 'x' })]
    for (let i = 0; i < 60; i++) messages = appendQueryMessage(messages, progress('t1', 'agent_progress', i), PROFILE)
    expect(describeActivity(messages, new Set(['t1']), [])).toBe('Delegating to Explore')
  })

  test('two parallel commands running ~30s still read as running', () => {
    let messages: Message[] = [
      toolUse('b1', 'Bash', { command: 'bun test' }),
      toolUse('b2', 'Bash', { command: 'bun run typecheck' }),
    ]
    for (let s = 0; s < 30; s++) {
      messages = appendQueryMessage(messages, progress('b1', 'bash_progress', s), PROFILE)
      messages = appendQueryMessage(messages, progress('b2', 'bash_progress', s), PROFILE)
    }
    expect(describeActivity(messages, new Set(['b1', 'b2']), [])).toBe('Running 2 commands')
  })
})

describe('describeActivity', () => {
  const messages = [assistant(use('a', 'Edit', { file_path: '/repo/x.ts' }))]

  test('running calls come first', () => {
    expect(describeActivity(messages, new Set(['a']), [{ contentBlock: { name: 'Bash' } }])).toBe('Editing x.ts')
  })

  test('else the newest call still streaming in, verb only', () => {
    const streaming = [{ contentBlock: { name: 'Read' } }, { contentBlock: { name: 'Write' } }]
    expect(describeActivity(messages, new Set(), streaming)).toBe('Writing')
  })

  test('else nothing, so the spinner falls back on its mode', () => {
    expect(describeActivity(messages, new Set(), [])).toBeUndefined()
  })
})
