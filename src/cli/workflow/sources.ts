// Trigger-source abstraction for `claudin workflow watch` (R3).
//
// The watch loop is source-agnostic: it polls a TriggerSource, dedups items by
// their stable `id`, dispatches a `workflow run` per new item, and optionally
// reports the result back. Two sources ship in v1:
//   - github: open issues carrying a label (reports back as an issue comment)
//   - url:    an arbitrary link/endpoint, polled over plain HTTP GET (no report)
//
// All polling is outbound-only — no inbound webhook server, no open port.

import { exec } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

import { logError } from 'src/utils/log.js'

import {
  commentOnIssue,
  listTriggerIssues,
  type TriggerIssue,
} from './githubSource.js'

/** One dispatchable unit of work. `id` is the persisted dedup key. */
export type TriggerItem = {
  id: string
  title: string
  body: string
}

export type TriggerResult = { prUrl: string | null }

export interface TriggerSource {
  /** Human-readable description for the startup log line. */
  describe(): string
  /** Poll the source. Returns [] on any error (fail-soft). */
  poll(): Promise<TriggerItem[]>
  /** Optionally report the run outcome back (e.g. an issue comment). */
  reportResult?(
    item: TriggerItem,
    result: TriggerResult,
    workflow: string,
  ): Promise<void>
}

// ── GitHub: labeled issues ────────────────────────────────────────────────

const GH_ID_RE = /^gh#(\d+)$/

export class GithubIssueSource implements TriggerSource {
  constructor(private readonly label: string) {}

  describe(): string {
    return `GitHub open issues labeled "${this.label}"`
  }

  async poll(): Promise<TriggerItem[]> {
    const issues = await listTriggerIssues(this.label)
    return issues.map(issueToItem)
  }

  async reportResult(
    item: TriggerItem,
    result: TriggerResult,
    workflow: string,
  ): Promise<void> {
    const m = item.id.match(GH_ID_RE)
    if (!m) return
    const comment = result.prUrl
      ? `🤖 Claudin ran the \`${workflow}\` workflow and opened a PR: ${result.prUrl}`
      : `⚠️ Claudin ran the \`${workflow}\` workflow for this issue but it did not complete successfully. See the runner logs.`
    await commentOnIssue(Number(m[1]), comment)
  }
}

function issueToItem(issue: TriggerIssue): TriggerItem {
  return { id: `gh#${issue.number}`, title: issue.title, body: issue.body ?? '' }
}

// ── URL: an arbitrary link/endpoint ───────────────────────────────────────

export class UrlSource implements TriggerSource {
  constructor(private readonly url: string) {}

  describe(): string {
    return `URL ${this.url}`
  }

  async poll(): Promise<TriggerItem[]> {
    let body: string
    try {
      const res = await fetch(this.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: { accept: 'application/json, text/plain, text/html;q=0.9' },
      })
      if (!res.ok) {
        logError(`workflow watch: GET ${this.url} → HTTP ${res.status}`)
        return []
      }
      body = await res.text()
    } catch (e) {
      logError(
        `workflow watch: GET ${this.url} failed: ${e instanceof Error ? e.message : String(e)}`,
      )
      return []
    }
    return parseUrlTriggers(this.url, body)
  }
}

// ── Command: an arbitrary local shell command ─────────────────────────────

const execAsync = promisify(exec)

export class CommandSource implements TriggerSource {
  constructor(private readonly command: string) {}

  describe(): string {
    return `output of \`${this.command}\``
  }

  async poll(): Promise<TriggerItem[]> {
    // Runs the user's own command (they opted in via --command) through the
    // shell each interval; stdout is parsed like the URL source. Non-zero exit
    // or spawn failure fails soft to no triggers.
    let stdout: string
    try {
      const res = await execAsync(this.command, {
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      })
      stdout = res.stdout
    } catch (e) {
      logError(
        `workflow watch: command failed: ${e instanceof Error ? e.message : String(e)}`,
      )
      return []
    }
    return parseFeed('cmd', `Output of \`${this.command}\``, stdout)
  }
}

/** Back-compat wrapper: parse a polled URL body into trigger items (pure). */
export function parseUrlTriggers(url: string, body: string): TriggerItem[] {
  return parseFeed('url', `Update from ${url}`, body)
}

/**
 * Parse a polled body (URL response or command stdout) into trigger items
 * (pure). If the body is a JSON array (or a `{tasks|items}` wrapper), each
 * element becomes a task — a string element is the task text, an object element
 * uses its `title`/`body` (with `task`/`description`/`name` fallbacks).
 * Otherwise the whole body is a single content-change trigger keyed by its hash
 * (prefixed with `kind`), so a run fires only when the output actually changes.
 */
export function parseFeed(
  kind: string,
  changeTitle: string,
  body: string,
): TriggerItem[] {
  const trimmed = body.trim()
  if (!trimmed) return []

  const feed = tryParseJsonFeed(kind, trimmed)
  if (feed) return feed

  return [
    { id: `${kind}:${sha12(trimmed)}`, title: changeTitle, body: trimmed },
  ]
}

function tryParseJsonFeed(kind: string, text: string): TriggerItem[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? (parsed.tasks ?? parsed.items)
      : null
  if (!Array.isArray(arr)) return null

  const items: TriggerItem[] = []
  for (const el of arr) {
    if (typeof el === 'string') {
      const s = el.trim()
      if (s)
        items.push({ id: `${kind}:${sha12(s)}`, title: firstLine(s), body: s })
      continue
    }
    if (!isRecord(el)) continue
    const title = str(el.title) ?? str(el.name) ?? ''
    const bodyText =
      str(el.body) ?? str(el.task) ?? str(el.description) ?? title
    if (!title && !bodyText) continue
    const rawId = idVal(el.id) ?? idVal(el.number)
    const id = rawId
      ? `${kind}#${rawId}`
      : `${kind}:${sha12(`${title}\n${bodyText}`)}`
    items.push({
      id,
      title: title || firstLine(bodyText),
      body: bodyText || title,
    })
  }
  return items
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** Accept a string or a finite number as a stable id. */
function idVal(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return str(v)
}

function firstLine(s: string): string {
  const line = s.split('\n', 1)[0]!.trim()
  return line.length > 100 ? `${line.slice(0, 99)}…` : line
}

function sha12(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12)
}
