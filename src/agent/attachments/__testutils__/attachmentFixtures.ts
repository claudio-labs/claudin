/**
 * One payload per attachment type, for the render-stability invariant
 * (src/agent/attachments/renderStability.invariant.test.ts) and the loop's
 * prefix suite (src/agent/cache/loopPrefix.invariant.test.ts).
 *
 * A mapped type over the whole Attachment union: a new attachment type does not
 * compile until it gets a payload here — and with it, the checks that its bytes
 * stay put from the request that first sends it to every later one.
 */
import type { Attachment } from 'src/agent/attachments/attachments.js'

export type AttachmentFixtures = { [K in Attachment['type']]: Extract<Attachment, { type: K }> }

const TEXT_FILE = {
  type: 'text',
  file: {
    filePath: '/repo/src/quote.ts',
    content: 'export function quote() {}\n',
    numLines: 1,
    startLine: 1,
    totalLines: 1,
  },
} as never

export const ATTACHMENT_FIXTURES: AttachmentFixtures = {
  file: {
    type: 'file',
    filename: '/repo/src/quote.ts',
    displayPath: 'src/quote.ts',
    content: TEXT_FILE,
    rendered: '1→export function quote() {}',
  },
  compact_file_reference: {
    type: 'compact_file_reference',
    filename: '/repo/src/quote.ts',
    displayPath: 'src/quote.ts',
  },
  pdf_reference: {
    type: 'pdf_reference',
    filename: '/repo/docs/spec.pdf',
    pageCount: 12,
    fileSize: 48_000,
    displayPath: 'docs/spec.pdf',
  },
  already_read_file: {
    type: 'already_read_file',
    filename: '/repo/src/quote.ts',
    displayPath: 'src/quote.ts',
    content: TEXT_FILE,
  },
  edited_text_file: {
    type: 'edited_text_file',
    filename: '/repo/src/quote.ts',
    snippet: '1→export function quote(): string {}',
  },
  edited_image_file: {
    type: 'edited_image_file',
    filename: '/repo/logo.png',
    content: { type: 'image', file: { base64: 'iVBORw0KGgo=', type: 'image/png', originalSize: 8 } } as never,
  },
  directory: {
    type: 'directory',
    path: '/repo/src',
    content: 'quote.ts\nprice.ts',
    displayPath: 'src',
  },
  selected_lines_in_ide: {
    type: 'selected_lines_in_ide',
    ideName: 'VS Code',
    lineStart: 3,
    lineEnd: 5,
    filename: '/repo/src/quote.ts',
    content: 'return price * qty',
    displayPath: 'src/quote.ts',
  },
  opened_file_in_ide: { type: 'opened_file_in_ide', filename: '/repo/src/quote.ts' },
  todo_reminder: {
    type: 'todo_reminder',
    content: [{ content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' }],
    itemCount: 1,
  },
  task_reminder: {
    type: 'task_reminder',
    content: [
      { id: '1', subject: 'Write tests', description: 'cover quote()', status: 'in_progress', blocks: [], blockedBy: [] },
    ],
    itemCount: 1,
  },
  nested_memory: {
    type: 'nested_memory',
    path: '/repo/.claudin/rules/testing.md',
    displayPath: '.claudin/rules/testing.md',
    content: { path: '/repo/.claudin/rules/testing.md', type: 'Project', content: '# Testing\n\nUse bun test.' } as never,
  },
  nested_memory_batch: {
    type: 'nested_memory_batch',
    files: [{ path: '/repo/.claudin/rules/testing.md', displayPath: '.claudin/rules/testing.md', type: 'Project' as never }],
  },
  dynamic_skill: {
    type: 'dynamic_skill',
    skillDir: '/repo/.claudin/skills',
    skillNames: ['demo'],
    displayPath: '.claudin/skills',
  },
  skill_listing: { type: 'skill_listing', content: '- demo: Run the demo checks.', skillCount: 1, isInitial: true },
  bash_git_instructions: {
    type: 'bash_git_instructions',
    content: '# Committing changes with git\n\nOnly commit when asked.',
  },
  skill_discovery: {
    type: 'skill_discovery',
    skills: [{ name: 'demo', description: 'Run the demo checks.' }],
    signal: null,
    source: 'native',
  },
  queued_command: { type: 'queued_command', prompt: 'also update the README', commandMode: 'prompt' },
  output_style: { type: 'output_style', style: 'Explanatory' },
  diagnostics: {
    type: 'diagnostics',
    isNew: true,
    files: [
      {
        uri: 'file:///repo/src/quote.ts',
        diagnostics: [
          {
            message: "Cannot find name 'qty'.",
            severity: 'Error',
            range: { start: { line: 2, character: 9 }, end: { line: 2, character: 12 } },
            source: 'ts',
            code: '2304',
          },
        ],
      },
    ] as never,
  },
  plan_mode: {
    type: 'plan_mode',
    reminderType: 'full',
    planFilePath: '/repo/.claudin/plans/demo.md',
    planExists: false,
    rendered: 'Plan mode is active. Write the plan to /repo/.claudin/plans/demo.md.',
  },
  plan_mode_reentry: { type: 'plan_mode_reentry', planFilePath: '/repo/.claudin/plans/demo.md' },
  plan_mode_exit: { type: 'plan_mode_exit', planFilePath: '/repo/.claudin/plans/demo.md', planExists: true },
  auto_mode: { type: 'auto_mode', reminderType: 'full' },
  auto_mode_exit: { type: 'auto_mode_exit' },
  critical_system_reminder: { type: 'critical_system_reminder', content: 'Never push to main.' },
  plan_file_reference: {
    type: 'plan_file_reference',
    planFilePath: '/repo/.claudin/plans/demo.md',
    planContent: '# Plan\n\n1. Do it.',
  },
  mcp_resource: {
    type: 'mcp_resource',
    server: 'docs',
    uri: 'docs://readme',
    name: 'README',
    content: { contents: [{ uri: 'docs://readme', mimeType: 'text/plain', text: 'Hello.' }] },
  },
  command_permissions: { type: 'command_permissions', allowedTools: ['Bash(git status:*)'] },
  agent_mention: { type: 'agent_mention', agentType: 'Explore' },
  task_status: {
    type: 'task_status',
    taskId: 'task_1',
    taskType: 'local_bash',
    status: 'completed',
    description: 'bun test',
    deltaSummary: '13564 pass',
  },
  container_transition: {
    type: 'container_transition',
    transitions: [{ name: 'db', from: 'running', to: 'exited', issue: 'exit code 137' }],
    elidedCount: 0,
  },
  async_hook_response: {
    type: 'async_hook_response',
    processId: 'p1',
    hookName: 'PostToolUse:Bash',
    hookEvent: 'PostToolUse',
    response: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'lint passed' } } as never,
    stdout: '',
    stderr: '',
    exitCode: 0,
  },
  token_usage: { type: 'token_usage', used: 120_000, total: 1_000_000, remaining: 880_000 },
  budget_usd: { type: 'budget_usd', used: 1.5, total: 10, remaining: 8.5 },
  output_token_usage: { type: 'output_token_usage', turn: 2_000, session: 40_000, budget: 500_000 },
  structured_output: { type: 'structured_output', data: { ok: true } },
  teammate_mailbox: {
    type: 'teammate_mailbox',
    messages: [{ from: 'researcher', text: 'Found it in quote.ts.', timestamp: '2026-10-01T12:00:00.000Z' }],
  },
  team_context: {
    type: 'team_context',
    agentId: 'agent_1',
    agentName: 'researcher',
    teamName: 'team',
    teamConfigPath: '/repo/.claudin/team.json',
    taskListPath: '/repo/.claudin/tasks',
  },
  hook_cancelled: { type: 'hook_cancelled', hookName: 'PreToolUse:Bash', toolUseID: 'toolu_1', hookEvent: 'PreToolUse' },
  hook_blocking_error: {
    type: 'hook_blocking_error',
    blockingError: { blockingError: 'rm is not allowed here', command: 'guard.sh' },
    hookName: 'PreToolUse:Bash',
    toolUseID: 'toolu_1',
    hookEvent: 'PreToolUse',
  },
  hook_non_blocking_error: {
    type: 'hook_non_blocking_error',
    hookName: 'PostToolUse:Bash',
    stderr: 'warning: slow',
    stdout: '',
    exitCode: 1,
    toolUseID: 'toolu_1',
    hookEvent: 'PostToolUse',
  },
  hook_error_during_execution: {
    type: 'hook_error_during_execution',
    content: 'spawn ENOENT',
    hookName: 'PostToolUse:Bash',
    toolUseID: 'toolu_1',
    hookEvent: 'PostToolUse',
  },
  hook_stopped_continuation: {
    type: 'hook_stopped_continuation',
    message: 'Stopped by the CI guard',
    hookName: 'PostToolUse:Bash',
    toolUseID: 'toolu_1',
    hookEvent: 'PostToolUse',
  },
  hook_success: {
    type: 'hook_success',
    content: 'Loaded the project context.',
    hookName: 'SessionStart',
    toolUseID: 'toolu_1',
    hookEvent: 'SessionStart',
  },
  hook_additional_context: {
    type: 'hook_additional_context',
    content: ['lint passed'],
    hookName: 'PostToolUse:Bash',
    toolUseID: 'toolu_1',
    hookEvent: 'PostToolUse',
  },
  hook_system_message: {
    type: 'hook_system_message',
    content: 'Formatting applied.',
    hookName: 'PostToolUse:Edit',
    toolUseID: 'toolu_1',
    hookEvent: 'PostToolUse',
  },
  hook_permission_decision: {
    type: 'hook_permission_decision',
    decision: 'allow',
    toolUseID: 'toolu_1',
    hookEvent: 'PreToolUse',
  },
  invoked_skills: {
    type: 'invoked_skills',
    skills: [{ name: 'demo', path: 'projectSettings:demo', content: 'Run the checks.' }],
  },
  max_turns_reached: { type: 'max_turns_reached', maxTurns: 10, turnCount: 11 },
  current_session_memory: {
    type: 'current_session_memory',
    content: '# Session notes',
    path: '/repo/.claudin/session.md',
    tokenCount: 4,
  },
  teammate_shutdown_batch: { type: 'teammate_shutdown_batch', count: 2 },
  compaction_reminder: { type: 'compaction_reminder' },
  context_efficiency: { type: 'context_efficiency' },
  date_change: { type: 'date_change', newDate: '2026-10-02' },
  ultrathink_effort: { type: 'ultrathink_effort', level: 'high' },
  deferred_tools_delta: {
    type: 'deferred_tools_delta',
    addedNames: ['WebFetch'],
    addedLines: ['WebFetch'],
    removedNames: [],
  },
  agent_listing_delta: {
    type: 'agent_listing_delta',
    addedTypes: ['Explore'],
    addedLines: ['- Explore: Read-only search agent.'],
    removedTypes: [],
    isInitial: true,
  },
  mcp_instructions_delta: {
    type: 'mcp_instructions_delta',
    addedNames: ['docs'],
    addedBlocks: ['## docs\nAsk before writing.'],
    removedNames: [],
  },
  claude_md_delta: {
    type: 'claude_md_delta',
    addedContent: 'Contents of /repo/AGENTS.md:\n\nUse bun.',
    contentHash: 'abc123',
    isInitial: true,
  },
  memory_index: {
    type: 'memory_index',
    indexes: [
      {
        path: '/repo/.claudin/memory/MEMORY.md',
        displayPath: '.claudin/memory/MEMORY.md',
        kind: 'auto',
        entryCount: 3,
        totalEntryCount: 3,
      },
    ],
  },
  git_status_delta: { type: 'git_status_delta', content: 'Current branch: main\n\nStatus:\n(clean)' },
  todo_reminder_delta: {
    type: 'todo_reminder_delta',
    added: [{ id: '1', status: 'in_progress', text: 'Write tests' }],
    statusChanged: [],
    removedIds: [],
    isInitial: true,
    snapshot: [{ id: '1', status: 'in_progress' }],
  },
  task_reconcile: {
    type: 'task_reconcile',
    reason: 'orphan_in_progress',
    stale: [{ id: '1', subject: 'Run the checks', status: 'in_progress' }],
    signature: '1:in_progress',
  },
  companion_intro: { type: 'companion_intro', name: 'Pip', species: 'otter' },
  bagel_console: { type: 'bagel_console', errorCount: 1, warningCount: 0, sample: 'TypeError: x is undefined' },
}
