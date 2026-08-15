/**
 * "What's driving your token usage?" — a provider-agnostic, local-only analysis
 * that attributes recent token usage to subagent-heavy sessions and to named
 * subagent types (e.g. `fork`, `Explore`).
 *
 * Everything is derived from the on-disk session transcripts under
 * `~/.claudin/projects/` — nothing is sent anywhere. Token usage lives in each
 * assistant record's `message.usage`, and every record carries an ISO
 * `timestamp`, so results can be windowed to the last 24h / 7d. Subagents write
 * to their own `agent-<id>.jsonl` files with a sibling `agent-<id>.meta.json`
 * carrying `{ agentType }`, which is how usage is attributed per agent type.
 *
 * "% of usage" is approximated by total-token share (input + output + cache) —
 * there is no local rate-limit weighting — hence the "Approximate" framing.
 */

import type { Dirent } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from 'src/shared/debug.js'
import { isFsInaccessible } from 'src/shared/errors.js'
import {
  getProjectsDir,
  MAX_TRANSCRIPT_READ_BYTES,
} from 'src/sessions/pure/paths.js'
import { getSessionFilesWithMtime } from 'src/sessions/indexing/liteMetadata.js'

export type UsageWindow = 'day' | 'week'

export type AgentUsage = {
  agentType: string
  tokens: number
  /** Share of total windowed tokens, 0-100. */
  pct: number
}

export type ContributionResult = {
  window: UsageWindow
  totalTokens: number
  /** Number of sessions with any activity inside the window. */
  sessionCount: number
  /** Share (0-100) of tokens that came from subagent-heavy sessions. */
  subagentHeavyPct: number
  /** Per-agent-type token share, sorted desc, filtered to ≥ MIN_SHARE, top N. */
  agentBreakdown: AgentUsage[]
}

const WINDOW_MS: Record<UsageWindow, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
}

/** A session counts as "subagent-heavy" when this fraction of its tokens came
 * from subagents. */
const SUBAGENT_HEAVY_RATIO = 0.5
/** Minimum token share for an insight/table row to be surfaced (0-1). */
const MIN_SHARE = 0.05
/** Cap on the number of agent-type rows shown. */
const TOP_N = 5

const AGENT_FILE_RE = /^agent-.*\.jsonl$/

type ParsedRecord = {
  type?: string
  timestamp?: string
  message?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

/**
 * Sum the total tokens (input + output + cache create + cache read) across all
 * assistant records in a transcript whose timestamp falls at/after `cutoffMs`.
 * Fails soft: an unreadable/oversized/corrupt file contributes 0.
 */
async function sumTokensInWindow(
  filePath: string,
  cutoffMs: number,
): Promise<number> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`usageContribution: skip ${filePath}: ${String(e)}`)
    }
    return 0
  }
  // Guard against pathological multi-GB transcripts (inc-3930) — bail rather
  // than OOM. Byte length is an upper bound on the string length here.
  if (raw.length > MAX_TRANSCRIPT_READ_BYTES) return 0

  let total = 0
  for (const line of raw.split('\n')) {
    if (!line) continue
    let record: ParsedRecord
    try {
      record = JSON.parse(line) as ParsedRecord
    } catch {
      continue // partial/corrupt line — skip
    }
    if (record.type !== 'assistant') continue
    if (!record.timestamp) continue
    const ts = Date.parse(record.timestamp)
    if (Number.isNaN(ts) || ts < cutoffMs) continue
    const usage = record.message?.usage
    if (!usage) continue
    total +=
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0)
  }
  return total
}

/** Recursively collect every `agent-*.jsonl` path under a subagents dir
 * (subdirs like `subagents/workflows/<runId>/` are nested). */
async function collectAgentTranscripts(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (isFsInaccessible(e)) return []
    throw e
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectAgentTranscripts(full)))
    } else if (entry.isFile() && AGENT_FILE_RE.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** Read the agentType from a transcript's sibling `.meta.json`, or a fallback. */
async function readAgentType(agentJsonlPath: string): Promise<string> {
  const metaPath = agentJsonlPath.replace(/\.jsonl$/, '.meta.json')
  try {
    const raw = await readFile(metaPath, 'utf-8')
    const meta = JSON.parse(raw) as { agentType?: string }
    return meta.agentType || 'subagent'
  } catch {
    // Older agents or a missing/corrupt sidecar — bucket as generic.
    return 'subagent'
  }
}

/**
 * Compute the token-usage contribution breakdown for the given window by
 * scanning all local session transcripts. Provider-agnostic and read-only.
 */
export async function computeUsageContribution(
  window: UsageWindow,
): Promise<ContributionResult> {
  const cutoffMs = Date.now() - WINDOW_MS[window]
  const empty: ContributionResult = {
    window,
    totalTokens: 0,
    sessionCount: 0,
    subagentHeavyPct: 0,
    agentBreakdown: [],
  }

  const projectsDir = getProjectsDir()
  let projectDirents: Dirent[]
  try {
    projectDirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return empty // no projects dir yet
  }
  const projectDirs = projectDirents
    .filter(d => d.isDirectory())
    .map(d => join(projectsDir, d.name))

  let totalTokens = 0
  let subagentHeavyTokens = 0
  let sessionCount = 0
  const agentTypeTotals = new Map<string, number>()

  for (let i = 0; i < projectDirs.length; i++) {
    const projectDir = projectDirs[i]!
    const sessionFiles = await getSessionFilesWithMtime(projectDir)
    for (const [sessionId, info] of sessionFiles) {
      // Cheap prune: a file whose last write predates the window has no
      // in-window records. Skip without opening it.
      if (info.mtime < cutoffMs) continue

      const mainTokens =
        info.size > MAX_TRANSCRIPT_READ_BYTES
          ? 0
          : await sumTokensInWindow(info.path, cutoffMs)

      let sessionSubagentTokens = 0
      const subagentsDir = join(projectDir, sessionId, 'subagents')
      for (const agentPath of await collectAgentTranscripts(subagentsDir)) {
        const tokens = await sumTokensInWindow(agentPath, cutoffMs)
        if (tokens <= 0) continue
        sessionSubagentTokens += tokens
        const agentType = await readAgentType(agentPath)
        agentTypeTotals.set(
          agentType,
          (agentTypeTotals.get(agentType) ?? 0) + tokens,
        )
      }

      const sessionTotal = mainTokens + sessionSubagentTokens
      if (sessionTotal <= 0) continue
      sessionCount++
      totalTokens += sessionTotal
      if (sessionSubagentTokens / sessionTotal > SUBAGENT_HEAVY_RATIO) {
        subagentHeavyTokens += sessionTotal
      }
    }
    // Yield to the event loop periodically so a large scan doesn't block paint.
    if (i % 10 === 9) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  if (totalTokens === 0) return empty

  const agentBreakdown: AgentUsage[] = [...agentTypeTotals.entries()]
    .map(([agentType, tokens]) => ({
      agentType,
      tokens,
      pct: (tokens / totalTokens) * 100,
    }))
    .filter(a => a.tokens / totalTokens >= MIN_SHARE)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, TOP_N)

  return {
    window,
    totalTokens,
    sessionCount,
    subagentHeavyPct: (subagentHeavyTokens / totalTokens) * 100,
    agentBreakdown,
  }
}
