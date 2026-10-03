/**
 * Transcript material for the `sessions/resume` characterization suites.
 *
 * Lines come out the way the CLI writes them: `parentUuid` is the first key and
 * `uuid` sits right before `timestamp`. The byte scans that run over large
 * transcripts only recognise a message laid out like that, so the suites can
 * build files of any size from these helpers.
 */
import type { UUID } from 'crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { TranscriptMessage } from 'src/shared/types/logs.js'

/** The session every built line belongs to, unless a line says otherwise. */
export const SESSION = '5e55104e-0000-4000-8000-00000000abcd' as UUID

/** Message number `n` as a uuid, so a suite can talk about `id(3)`. */
export function id(n: number): UUID {
  return `0000c0de-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

/** A fixed moment plus `seconds`, as the ISO text a transcript stores. */
export function second(seconds: number): string {
  return new Date(Date.UTC(2026, 8, 30, 9, 0, 0) + seconds * 1000).toISOString()
}

export type Line = Record<string, unknown>

export type Placement = {
  /** The entry this one hangs off; `null` starts a chain. */
  parent?: UUID | null
  /** Seconds after the fixed moment. */
  at?: number
  session?: string
  sidechain?: boolean
  /** More top-level fields, written after the common ones. */
  more?: Line
}

function place(kind: string, uuid: UUID, body: Line, where: Placement): Line {
  return {
    parentUuid: where.parent ?? null,
    isSidechain: where.sidechain ?? false,
    type: kind,
    ...body,
    uuid,
    timestamp: second(where.at ?? 0),
    userType: 'external',
    cwd: '/work/app',
    sessionId: where.session ?? SESSION,
    version: '0.0.0-test',
    ...where.more,
  }
}

export function prompt(uuid: UUID, text: string, where: Placement = {}): Line {
  return place('user', uuid, { message: { role: 'user', content: text } }, where)
}

export function reply(
  uuid: UUID,
  content: string | Line[],
  where: Placement & { responseId?: string } = {},
): Line {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  const usage = {
    input_tokens: 1200,
    output_tokens: 80,
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 900,
    service_tier: 'standard',
  }
  const message = {
    id: where.responseId ?? `resp-${uuid.slice(-6)}`,
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: blocks,
    usage,
  }
  return place('assistant', uuid, { message }, where)
}

export function toolUse(callId: string, name = 'Read', input: Line = { file_path: '/work/app/a.ts' }): Line {
  return { type: 'tool_use', id: callId, name, input }
}

export function toolResult(uuid: UUID, callId: string, output: string, where: Placement = {}): Line {
  const content = [{ type: 'tool_result', tool_use_id: callId, content: output }]
  return place('user', uuid, { message: { role: 'user', content } }, where)
}

export function attachment(uuid: UUID, body: Line, where: Placement = {}): Line {
  return place('attachment', uuid, { attachment: body }, where)
}

export function hookOutput(uuid: UUID, callId: string, event: string, where: Placement = {}): Line {
  const body = { type: 'hook_success', hookName: event, hookEvent: event, toolUseID: callId, content: '' }
  return attachment(uuid, body, where)
}

export type Preserved = { headUuid: UUID; anchorUuid: UUID; tailUuid: UUID }

export function compactBoundary(uuid: UUID, where: Placement & { preserved?: Preserved } = {}): Line {
  const compactMetadata = {
    trigger: 'manual',
    preTokens: 4000,
    ...(where.preserved && { preservedSegment: where.preserved }),
  }
  const body = { subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info', isMeta: false, compactMetadata }
  return place('system', uuid, body, where)
}

export function notice(uuid: UUID, text: string, where: Placement = {}): Line {
  return place('system', uuid, { subtype: 'informational', content: text, level: 'info', isMeta: false }, where)
}

/** A progress entry as builds before the progress removal wrote it. */
export function oldProgress(uuid: UUID, parent: UUID | null): Line {
  return {
    parentUuid: parent,
    isSidechain: false,
    type: 'progress',
    data: { type: 'bash_progress', output: '...' },
    toolUseID: 'toolu_progress',
    uuid,
    timestamp: second(0),
  }
}

/** The lines as an in-memory transcript map, in write order. */
export function asMap(lines: Line[]): Map<UUID, TranscriptMessage> {
  return new Map(lines.map(line => [line.uuid as UUID, line as unknown as TranscriptMessage]))
}

export function jsonl(lines: Array<Line | string>): string {
  return lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'
}

export function writeJsonl(path: string, lines: Array<Line | string>): string {
  writeFileSync(path, jsonl(lines))
  return path
}

/** A fresh directory; `cleanup` removes every one handed out so far. */
export function scratchDirs(prefix: string): { make(): string; cleanup(): void } {
  const made: string[] = []
  return {
    make() {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
      made.push(dir)
      return dir
    },
    cleanup() {
      for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The text a message shows, whether its content is a string or blocks. */
export function textOf(message: unknown): string {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = block as { text?: string; type?: string; name?: string; content?: unknown }
      if (b.type === 'tool_use') return `<call ${b.name}>`
      if (b.type === 'tool_result') return `<result ${String(b.content)}>`
      return b.text ?? ''
    })
    .join('')
}

/** Uuids of messages, in order. */
export const uuids = (messages: Iterable<{ uuid: string }>): string[] => [...messages].map(m => m.uuid)
