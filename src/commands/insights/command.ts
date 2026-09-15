/**
 * The /insights command and the pipeline run behind it.
 *
 * generateUsageReport is the only place the stages meet: scan, then meta (from
 * cache where possible), then facets (ditto), then aggregate, narrative and
 * HTML. Every phase batches and yields, because this runs inside the REPL and a
 * user with thousands of session files would otherwise watch it freeze.
 *
 * The Command object here is the module's default export, and
 * `src/commands/commands.ts` reaches it through a dynamic `import(...).default`
 * of the barrel — which is why the barrel has to re-export `default` and not
 * only the named symbols.
 */
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Command } from 'src/commands/commands.js'
import {
  aggregateData,
  safeKeys,
} from 'src/commands/insights/aggregate.js'
import {
  extractFacetsFromAPI,
  hasValidDates,
  logToSessionMeta,
} from 'src/commands/insights/extract.js'
import { generateHtmlReport } from 'src/commands/insights/html.js'
import { generateParallelInsights } from 'src/commands/insights/narrative.js'
import {
  getDataDir,
  getFacetsDir,
  loadCachedFacets,
  loadCachedSessionMeta,
  saveFacets,
  saveSessionMeta,
  scanAllSessions,
} from 'src/commands/insights/store.js'
import type {
  AggregatedData,
  InsightResults,
  LiteSessionInfo,
  SessionFacets,
  SessionMeta,
} from 'src/commands/insights/types.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { loadAllLogsFromSessionFile } from 'src/sessions/sessionStorage.js'
import type { LogOption } from 'src/shared/types/logs.js'

// ============================================================================
// Main Function
// ============================================================================

export async function generateUsageReport(): Promise<{
  insights: InsightResults
  htmlPath: string
  data: AggregatedData
  facets: Map<string, SessionFacets>
}> {
  // Phase 1: Lite scan — filesystem metadata only (no JSONL parsing)
  const allScannedSessions = await scanAllSessions()
  const totalSessionsScanned = allScannedSessions.length

  // Phase 2: Load SessionMeta — use cache where available, parse only uncached
  // Read cached metas in parallel batches to avoid blocking the event loop
  const META_BATCH_SIZE = 50
  const MAX_SESSIONS_TO_LOAD = 200
  let allMetas: SessionMeta[] = []
  const uncachedSessions: LiteSessionInfo[] = []

  for (let i = 0; i < allScannedSessions.length; i += META_BATCH_SIZE) {
    const batch = allScannedSessions.slice(i, i + META_BATCH_SIZE)
    const results = await Promise.all(
      batch.map(async sessionInfo => ({
        sessionInfo,
        cached: await loadCachedSessionMeta(sessionInfo.sessionId),
      })),
    )
    for (const { sessionInfo, cached } of results) {
      if (cached) {
        allMetas.push(cached)
      } else if (uncachedSessions.length < MAX_SESSIONS_TO_LOAD) {
        uncachedSessions.push(sessionInfo)
      }
    }
  }

  // Load full message data only for uncached sessions and compute SessionMeta
  const logsForFacets = new Map<string, LogOption>()

  // Filter out /insights meta-sessions (facet extraction API calls get logged as sessions)
  const isMetaSession = (log: LogOption): boolean => {
    for (const msg of log.messages.slice(0, 5)) {
      if (msg.type === 'user' && msg.message) {
        const content = msg.message.content
        if (typeof content === 'string') {
          if (
            content.includes('RESPOND WITH ONLY A VALID JSON OBJECT') ||
            content.includes('record_facets')
          ) {
            return true
          }
        }
      }
    }
    return false
  }

  // Load uncached sessions in batches to yield to event loop between batches
  const LOAD_BATCH_SIZE = 10
  for (let i = 0; i < uncachedSessions.length; i += LOAD_BATCH_SIZE) {
    const batch = uncachedSessions.slice(i, i + LOAD_BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(async sessionInfo => {
        try {
          return await loadAllLogsFromSessionFile(sessionInfo.path)
        } catch {
          return []
        }
      }),
    )
    // Collect metas synchronously, then save them in parallel (independent writes)
    const metasToSave: SessionMeta[] = []
    for (const logs of batchResults) {
      for (const log of logs) {
        if (isMetaSession(log) || !hasValidDates(log)) continue
        const meta = logToSessionMeta(log)
        allMetas.push(meta)
        metasToSave.push(meta)
        // Keep the log around for potential facet extraction
        logsForFacets.set(meta.session_id, log)
      }
    }
    await Promise.all(metasToSave.map(meta => saveSessionMeta(meta)))
  }

  // Deduplicate session branches (keep the one with most user messages per session_id)
  // This prevents inflated totals when a session has multiple conversation branches
  const bestBySession = new Map<string, SessionMeta>()
  for (const meta of allMetas) {
    const existing = bestBySession.get(meta.session_id)
    if (
      !existing ||
      meta.user_message_count > existing.user_message_count ||
      (meta.user_message_count === existing.user_message_count &&
        meta.duration_minutes > existing.duration_minutes)
    ) {
      bestBySession.set(meta.session_id, meta)
    }
  }
  // Replace allMetas with deduplicated list and remove unused logs from logsForFacets
  const keptSessionIds = new Set(bestBySession.keys())
  allMetas = [...bestBySession.values()]
  for (const sessionId of logsForFacets.keys()) {
    if (!keptSessionIds.has(sessionId)) {
      logsForFacets.delete(sessionId)
    }
  }

  // Sort all metas by start_time descending (most recent first)
  allMetas.sort((a, b) => b.start_time.localeCompare(a.start_time))

  // Pre-filter obviously minimal sessions to save API calls
  // (matching Python's substantive filtering concept)
  const isSubstantiveSession = (meta: SessionMeta): boolean => {
    // Skip sessions with very few user messages
    if (meta.user_message_count < 2) return false
    // Skip very short sessions (< 1 minute)
    if (meta.duration_minutes < 1) return false
    return true
  }

  const substantiveMetas = allMetas.filter(isSubstantiveSession)

  // Phase 3: Facet extraction — only for sessions without cached facets
  const facets = new Map<string, SessionFacets>()
  const toExtract: Array<{ log: LogOption; sessionId: string }> = []
  const MAX_FACET_EXTRACTIONS = 50

  // Load cached facets for all substantive sessions in parallel
  const cachedFacetResults = await Promise.all(
    substantiveMetas.map(async meta => ({
      sessionId: meta.session_id,
      cached: await loadCachedFacets(meta.session_id),
    })),
  )
  for (const { sessionId, cached } of cachedFacetResults) {
    if (cached) {
      facets.set(sessionId, cached)
    } else {
      const log = logsForFacets.get(sessionId)
      if (log && toExtract.length < MAX_FACET_EXTRACTIONS) {
        toExtract.push({ log, sessionId })
      }
    }
  }

  // Extract facets for sessions that need them (50 concurrent)
  const CONCURRENCY = 50
  for (let i = 0; i < toExtract.length; i += CONCURRENCY) {
    const batch = toExtract.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async ({ log, sessionId }) => {
        const newFacets = await extractFacetsFromAPI(log, sessionId)
        return { sessionId, newFacets }
      }),
    )
    // Collect facets synchronously, save in parallel (independent writes)
    const facetsToSave: SessionFacets[] = []
    for (const { sessionId, newFacets } of results) {
      if (newFacets) {
        facets.set(sessionId, newFacets)
        facetsToSave.push(newFacets)
      }
    }
    await Promise.all(facetsToSave.map(f => saveFacets(f)))
  }

  // Filter out warmup/minimal sessions (matching Python's is_minimal)
  // A session is minimal if warmup_minimal is the ONLY goal category
  const isMinimalSession = (sessionId: string): boolean => {
    const sessionFacets = facets.get(sessionId)
    if (!sessionFacets) return false
    const cats = sessionFacets.goal_categories
    const catKeys = safeKeys(cats).filter(k => (cats[k] ?? 0) > 0)
    return catKeys.length === 1 && catKeys[0] === 'warmup_minimal'
  }

  const substantiveSessions = substantiveMetas.filter(
    s => !isMinimalSession(s.session_id),
  )

  const substantiveFacets = new Map<string, SessionFacets>()
  for (const [sessionId, f] of facets) {
    if (!isMinimalSession(sessionId)) {
      substantiveFacets.set(sessionId, f)
    }
  }

  const aggregated = aggregateData(substantiveSessions, substantiveFacets)
  aggregated.total_sessions_scanned = totalSessionsScanned

  // Generate parallel insights from Claude (6 sections)
  const insights = await generateParallelInsights(aggregated, facets)

  // Generate HTML report
  const htmlReport = generateHtmlReport(aggregated, insights)

  // Save reports
  try {
    await mkdir(getDataDir(), { recursive: true })
  } catch {
    // Directory may already exist
  }

  const htmlPath = join(getDataDir(), 'report.html')
  await writeFile(htmlPath, htmlReport, {
    encoding: 'utf-8',
    mode: 0o600,
  })

  return {
    insights,
    htmlPath,
    data: aggregated,
    facets: substantiveFacets,
  }
}

// ============================================================================
// Command Definition
// ============================================================================

const usageReport: Command = {
  type: 'prompt',
  name: 'insights',
  description: 'Generate a report analyzing your Claudin sessions',
  contentLength: 0, // Dynamic content
  progressMessage: 'analyzing your sessions',
  source: 'builtin',
  async getPromptForCommand(_args) {
    const { insights, htmlPath, data } = await generateUsageReport()

    let reportUrl = `file://${htmlPath}`
    let uploadHint = ''

    // Build header with stats
    const sessionLabel =
      data.total_sessions_scanned &&
      data.total_sessions_scanned > data.total_sessions
        ? `${data.total_sessions_scanned.toLocaleString()} sessions total · ${data.total_sessions} analyzed`
        : `${data.total_sessions} sessions`
    const stats = [
      sessionLabel,
      `${data.total_messages.toLocaleString()} messages`,
      `${Math.round(data.total_duration_hours)}h`,
      `${data.git_commits} commits`,
    ].join(' · ')


    // Build markdown summary from insights
    const atAGlance = insights.at_a_glance
    const summaryText = atAGlance
      ? `## At a Glance

${atAGlance.whats_working ? `**What's working:** ${atAGlance.whats_working} See _Impressive Things You Did_.` : ''}

${atAGlance.whats_hindering ? `**What's hindering you:** ${atAGlance.whats_hindering} See _Where Things Go Wrong_.` : ''}

${atAGlance.quick_wins ? `**Quick wins to try:** ${atAGlance.quick_wins} See _Features to Try_.` : ''}

${atAGlance.ambitious_workflows ? `**Ambitious workflows:** ${atAGlance.ambitious_workflows} See _On the Horizon_.` : ''}`
      : '_No insights generated_'

    const header = `# Claudin Insights

${stats}
${data.date_range.start} to ${data.date_range.end}
`

    const userSummary = `${header}${summaryText}

Your full shareable insights report is ready: ${reportUrl}${uploadHint}`

    // Return prompt for Claude to respond to
    return [
      {
        type: 'text',
        text: `The user just ran /insights to generate a usage report analyzing their Claudin sessions.

Here is the full insights data:
${jsonStringify(insights, null, 2)}

Report URL: ${reportUrl}
HTML file: ${htmlPath}
Facets directory: ${getFacetsDir()}

Here is what the user sees:
${userSummary}

Now output the following message exactly:

<message>
Your shareable insights report is ready:
${reportUrl}${uploadHint}

Want to dig into any section or try one of the suggestions?
</message>`,
      },
    ]
  },
}

export default usageReport
