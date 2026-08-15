/**
 * Measure the per-turn token cost of every attachment type that ships with
 * Claudin.
 *
 * Each attachment kind is constructed with a *realistic* fixture (not a
 * pathological worst case), routed through the production renderer
 * `normalizeAttachmentForAPI`, joined into the wire string, and measured in
 * bytes + tokens. The result is a sorted table of attachment → wire cost,
 * which surfaces the heaviest per-turn injections so we know where to
 * trim.
 *
 * What it covers:
 *   - All branches of the `Attachment` union from `src/agent/attachments/attachments.ts`
 *     that have a fixed-shape renderer (file/IDE attachments depend on
 *     reading real files; we simulate those bodies inline).
 *   - Two profile sizes ("typical" and "heavy") so we can see how the
 *     cost scales.
 *
 * What it does NOT cover (out-of-scope, see other benches):
 *   - Tool schemas (see `measure-tool-schemas.ts`).
 *   - System prompt / memory / env (see `measure-token-budget.ts`).
 *   - microCompact savings (see `measure-microcompact-savings.ts`).
 *
 * Flags:
 *   --model=<name>   tokenizer ratio for token estimate (default claude-sonnet-4-5)
 *   --profile=typical|heavy   fixture size (default typical)
 *   --json           machine-readable output
 *
 * Read-only. No network. No filesystem writes.
 */

if (typeof (globalThis as { MACRO?: unknown }).MACRO === 'undefined') {
  Object.assign(globalThis, {
    MACRO: {
      VERSION: '99.0.0',
      DISPLAY_VERSION: '0.0.0-measure',
      BUILD_TIME: new Date().toISOString(),
      ISSUES_EXPLAINER:
        'report the issue at https://github.com/anthropics/claude-code/issues',
      PACKAGE_URL: '@claudiolabs/claudin',
    },
  })
}

import {
  getBytesPerTokenForModel,
  roughTokenCountEstimation,
} from '../src/shared/tokenEstimation.js'
import { getBashGitInstructionsBody } from '../src/tools/BashTool/prompt.js'
import type { Attachment } from '../src/agent/attachments/attachments.js'
import { normalizeAttachmentForAPI } from '../src/agent/messages/messages.js'
import { enableConfigs } from '../src/platform/config/config.js'

export type AttachmentRow = {
  kind: string
  bytes: number
  tokens: number
  wireMessages: number
  /** Set when the renderer returned [] (gated off / no-op) */
  empty: boolean
}

export type AttachmentBudgetResult = {
  model: string
  bytesPerToken: number
  profile: 'typical' | 'heavy'
  rows: AttachmentRow[]
  totalBytes: number
  totalTokens: number
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * Coerce a UserMessage's `content` (string or content-block array) into a
 * single string for measurement. Tool_use / tool_result blocks are
 * serialized so we don't drop their bytes — that's wire payload too.
 */
function userMessageContentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      if ((block as { type?: string }).type === 'text') {
        parts.push((block as { text?: string }).text ?? '')
        continue
      }
    }
    parts.push(JSON.stringify(block))
  }
  return parts.join('\n')
}

function renderAttachment(att: Attachment): { wire: string; messageCount: number } {
  const messages = normalizeAttachmentForAPI(att)
  const parts: string[] = []
  for (const m of messages) {
    parts.push(userMessageContentToString(m.message.content))
  }
  return { wire: parts.join('\n'), messageCount: messages.length }
}

type Profile = 'typical' | 'heavy'

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'

function bodyOfSize(targetBytes: number): string {
  if (targetBytes <= 0) return ''
  const repeats = Math.ceil(targetBytes / LOREM.length)
  return LOREM.repeat(repeats).slice(0, targetBytes)
}

function fixtures(profile: Profile): Attachment[] {
  const small = profile === 'typical' ? 200 : 800
  const med = profile === 'typical' ? 1500 : 6000
  const large = profile === 'typical' ? 6000 : 24000
  const fileN = profile === 'typical' ? 3 : 12

  const result: Attachment[] = []

  result.push({
    type: 'directory',
    path: '/tmp/example',
    displayPath: 'example',
    content: bodyOfSize(med),
  })

  result.push({
    type: 'edited_text_file',
    filename: '/tmp/example/foo.ts',
    snippet: bodyOfSize(small),
  })

  result.push({
    type: 'selected_lines_in_ide',
    ideName: 'vscode',
    lineStart: 10,
    lineEnd: 60,
    filename: '/tmp/example/foo.ts',
    displayPath: 'foo.ts',
    content: bodyOfSize(med),
  })

  result.push({
    type: 'opened_file_in_ide',
    filename: '/tmp/example/foo.ts',
  })

  result.push({
    type: 'todo_reminder',
    itemCount: 3,
    content: [
      { id: '1', status: 'pending', subject: 'Task one', description: 'do thing' },
      { id: '2', status: 'in_progress', subject: 'Task two', description: 'doing' },
      { id: '3', status: 'completed', subject: 'Task three', description: 'done' },
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    ] as any,
  })

  result.push({
    type: 'task_reminder',
    itemCount: 2,
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    content: [
      { id: 'a', status: 'pending', subject: 'task A', description: 'd' },
      { id: 'b', status: 'completed', subject: 'task B', description: 'd' },
    ] as any,
  })

  result.push({
    type: 'nested_memory',
    path: '/home/u/.claudin/projects/x/memory/CLAUDE.md',
    displayPath: 'CLAUDE.md',
    content: {
      path: '/home/u/.claudin/projects/x/memory/CLAUDE.md',
      content: bodyOfSize(med),
      // biome-ignore lint/suspicious/noExplicitAny: simplified fixture
    } as any,
  })

  result.push({
    type: 'relevant_memories',
    memories: Array.from({ length: fileN }, (_, i) => ({
      path: `/home/u/.claudin/projects/x/memory/m${i}.md`,
      content: bodyOfSize(small),
      mtimeMs: Date.now() - i * 86400_000,
      header: `Saved ${i}d ago — m${i}.md`,
    })),
  })

  result.push({
    type: 'skill_listing',
    skillCount: fileN,
    isInitial: true,
    content: Array.from({ length: fileN }, (_, i) =>
      `- skill-${i}: short description for skill ${i} ${LOREM.slice(0, 80)}`,
    ).join('\n'),
  })

  // Use the real body produced by getBashGitInstructionsBody() so the row
  // reflects production. Earlier this slot used bodyOfSize(large) which made
  // the attachment look ~24KB heavy when it's actually ~3.5KB and emitted at
  // most ONCE per agentKey (the dedup Set in attachments.ts:3033).
  result.push({
    type: 'bash_git_instructions',
    content: getBashGitInstructionsBody(),
  })

  result.push({
    type: 'queued_command',
    prompt: bodyOfSize(small),
  })

  result.push({
    type: 'output_style',
    style: bodyOfSize(small),
  })

  result.push({
    type: 'diagnostics',
    isNew: true,
    files: Array.from({ length: fileN }, (_, i) => ({
      uri: `file:///tmp/example/file${i}.ts`,
      diagnostics: Array.from({ length: 4 }, (_, j) => ({
        severity: (j % 2 === 0 ? 'Error' : 'Warning') as 'Error' | 'Warning',
        message: `Diag ${j}: something went wrong here ${LOREM.slice(0, 60)}`,
        range: {
          start: { line: 10 + j, character: 1 },
          end: { line: 10 + j, character: 20 },
        },
        source: 'tsserver',
      })),
    })),
  })

  result.push({
    type: 'plan_mode',
    reminderType: 'full',
    planFilePath: '/tmp/plan.md',
    planExists: false,
  })

  result.push({
    type: 'plan_mode',
    reminderType: 'sparse',
    planFilePath: '/tmp/plan.md',
    planExists: true,
  })

  result.push({
    type: 'plan_mode_exit',
    planFilePath: '/tmp/plan.md',
    planExists: true,
  })

  result.push({
    type: 'auto_mode',
    reminderType: 'full',
  })

  result.push({
    type: 'auto_mode',
    reminderType: 'sparse',
  })

  result.push({
    type: 'critical_system_reminder',
    content: bodyOfSize(small),
  })

  result.push({
    type: 'plan_file_reference',
    planFilePath: '/tmp/plan.md',
    planContent: bodyOfSize(med),
  })

  result.push({
    type: 'token_usage',
    used: 50_000,
    total: 200_000,
    remaining: 150_000,
  })

  result.push({
    type: 'budget_usd',
    used: 0.42,
    total: 5,
    remaining: 4.58,
  })

  result.push({
    type: 'output_token_usage',
    turn: 1200,
    session: 35_000,
    budget: 100_000,
  })

  result.push({
    type: 'compaction_reminder',
  })

  result.push({
    type: 'context_efficiency',
  })

  result.push({
    type: 'date_change',
    newDate: '2026-05-04',
  })

  result.push({
    type: 'verify_plan_reminder',
  })

  result.push({
    type: 'deferred_tools_delta',
    addedNames: Array.from({ length: fileN }, (_, i) => `Tool${i}`),
    addedLines: Array.from(
      { length: fileN },
      (_, i) => `- Tool${i}: short description`,
    ),
    removedNames: [],
  })

  result.push({
    type: 'agent_listing_delta',
    isInitial: true,
    showConcurrencyNote: true,
    addedTypes: Array.from({ length: fileN }, (_, i) => `agent-${i}`),
    addedLines: Array.from(
      { length: fileN },
      (_, i) => `- agent-${i}: ${LOREM.slice(0, 80)}`,
    ),
    removedTypes: [],
  })

  result.push({
    type: 'mcp_instructions_delta',
    addedNames: Array.from({ length: Math.min(fileN, 4) }, (_, i) => `srv-${i}`),
    addedBlocks: Array.from(
      { length: Math.min(fileN, 4) },
      (_, i) => `## srv-${i}\n${bodyOfSize(small)}`,
    ),
    removedNames: [],
  })

  result.push({
    type: 'claude_md_delta',
    isInitial: true,
    contentHash: 'deadbeef',
    addedContent: bodyOfSize(med),
  })

  result.push({
    type: 'git_status_delta',
    content: bodyOfSize(small),
  })

  result.push({
    type: 'todo_reminder_delta',
    isInitial: true,
    added: Array.from({ length: 3 }, (_, i) => ({
      id: `t${i}`,
      status: 'pending',
      text: `Todo ${i}: ${LOREM.slice(0, 50)}`,
    })),
    statusChanged: [],
    removedIds: [],
    snapshot: Array.from({ length: 3 }, (_, i) => ({
      id: `t${i}`,
      status: 'pending',
    })),
  })

  return result
}

export async function measureAttachmentBudget(options: {
  model?: string
  profile?: Profile
} = {}): Promise<AttachmentBudgetResult> {
  const model = options.model ?? 'claude-sonnet-4-5'
  const profile: Profile = options.profile ?? 'typical'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)
  const rows: AttachmentRow[] = []

  for (const att of fixtures(profile)) {
    let row: AttachmentRow
    try {
      const { wire, messageCount } = renderAttachment(att)
      const b = bytes(wire)
      row = {
        kind: att.type,
        bytes: b,
        tokens: roughTokenCountEstimation(wire, ratio),
        wireMessages: messageCount,
        empty: messageCount === 0 || b === 0,
      }
    } catch (err) {
      row = {
        kind: `${att.type} <error: ${(err as Error).message}>`,
        bytes: 0,
        tokens: 0,
        wireMessages: 0,
        empty: true,
      }
    }
    rows.push(row)
  }

  rows.sort((a, b) => b.bytes - a.bytes)

  let totalBytes = 0
  let totalTokens = 0
  for (const r of rows) {
    totalBytes += r.bytes
    totalTokens += r.tokens
  }

  return {
    model,
    bytesPerToken: ratio,
    profile,
    rows,
    totalBytes,
    totalTokens,
  }
}

function formatTable(result: AttachmentBudgetResult): string {
  const lines: string[] = []
  lines.push(
    `# Attachments budget — model=${result.model} (bytes/token=${result.bytesPerToken}) profile=${result.profile}`,
  )
  lines.push('')
  const headers = ['attachment', 'bytes', 'tokens', 'msgs']
  const data = result.rows.map(r => [
    r.empty ? `${r.kind} (gated/empty)` : r.kind,
    r.bytes.toLocaleString('en-US'),
    r.tokens.toLocaleString('en-US'),
    String(r.wireMessages),
  ])
  data.push([
    'TOTAL',
    result.totalBytes.toLocaleString('en-US'),
    result.totalTokens.toLocaleString('en-US'),
    '',
  ])
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map(row => row[i]!.length)),
  )
  const fmt = (row: string[]) =>
    row.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  lines.push(fmt(headers))
  lines.push(widths.map(w => '-'.repeat(w)).join('  '))
  for (const row of data) lines.push(fmt(row))
  return lines.join('\n')
}

function parseArgs(argv: readonly string[]): {
  model: string
  profile: Profile
  asJson: boolean
} {
  let model = 'claude-sonnet-4-5'
  let profile: Profile = 'typical'
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
    else if (arg.startsWith('--profile=')) {
      const v = arg.slice('--profile='.length)
      if (v === 'typical' || v === 'heavy') profile = v
      else throw new Error(`unknown profile: ${v}`)
    }
  }
  return { model, profile, asJson }
}

async function main(): Promise<void> {
  const { model, profile, asJson } = parseArgs(process.argv.slice(2))
  const result = await measureAttachmentBudget({ model, profile })
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  process.stdout.write(`${formatTable(result)}\n`)
}

const invokedDirectly = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  try {
    return import.meta.url === new URL(process.argv[1], 'file://').href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
