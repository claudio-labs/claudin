/**
 * Rolling many sessions into one number set: the multi-clauding detector, the
 * AggregatedData that both the HTML report and the narrative prompts read, and
 * the export payload the background upload sends.
 *
 * safeEntries and safeKeys guard the same hazard — a facet bucket the model
 * simply omitted — and live here because five of their six call sites are
 * aggregateData and buildExportData. Only safeKeys is exported, for the
 * minimal-session filter in command.ts; safeEntries has no caller outside.
 */
import type {
  AggregatedData,
  InsightResults,
  InsightsExport,
  SessionFacets,
  SessionMeta,
} from 'src/commands/insights/types.js'

/**
 * Detects multi-clauding (using multiple Claude sessions concurrently).
 * Uses a sliding window to find the pattern: session1 -> session2 -> session1
 * within a 30-minute window.
 */
export function detectMultiClauding(
  sessions: Array<{
    session_id: string
    user_message_timestamps: string[]
  }>,
): {
  overlap_events: number
  sessions_involved: number
  user_messages_during: number
} {
  const OVERLAP_WINDOW_MS = 30 * 60000
  const allSessionMessages: Array<{ ts: number; sessionId: string }> = []

  for (const session of sessions) {
    for (const timestamp of session.user_message_timestamps) {
      try {
        const ts = new Date(timestamp).getTime()
        allSessionMessages.push({ ts, sessionId: session.session_id })
      } catch {
        // Skip invalid timestamps
      }
    }
  }

  allSessionMessages.sort((a, b) => a.ts - b.ts)

  const multiClaudeSessionPairs = new Set<string>()
  const messagesDuringMulticlaude = new Set<string>()

  // Sliding window: sessionLastIndex tracks the most recent index for each session
  let windowStart = 0
  const sessionLastIndex = new Map<string, number>()

  for (let i = 0; i < allSessionMessages.length; i++) {
    const msg = allSessionMessages[i]!

    // Shrink window from the left
    while (
      windowStart < i &&
      msg.ts - allSessionMessages[windowStart]!.ts > OVERLAP_WINDOW_MS
    ) {
      const expiring = allSessionMessages[windowStart]!
      if (sessionLastIndex.get(expiring.sessionId) === windowStart) {
        sessionLastIndex.delete(expiring.sessionId)
      }
      windowStart++
    }

    // Check if this session appeared earlier in the window (pattern: s1 -> s2 -> s1)
    const prevIndex = sessionLastIndex.get(msg.sessionId)
    if (prevIndex !== undefined) {
      for (let j = prevIndex + 1; j < i; j++) {
        const between = allSessionMessages[j]!
        if (between.sessionId !== msg.sessionId) {
          const pair = [msg.sessionId, between.sessionId].sort().join(':')
          multiClaudeSessionPairs.add(pair)
          messagesDuringMulticlaude.add(
            `${allSessionMessages[prevIndex]!.ts}:${msg.sessionId}`,
          )
          messagesDuringMulticlaude.add(`${between.ts}:${between.sessionId}`)
          messagesDuringMulticlaude.add(`${msg.ts}:${msg.sessionId}`)
          break
        }
      }
    }

    sessionLastIndex.set(msg.sessionId, i)
  }

  const sessionsWithOverlaps = new Set<string>()
  for (const pair of multiClaudeSessionPairs) {
    const [s1, s2] = pair.split(':')
    if (s1) sessionsWithOverlaps.add(s1)
    if (s2) sessionsWithOverlaps.add(s2)
  }

  return {
    overlap_events: multiClaudeSessionPairs.size,
    sessions_involved: sessionsWithOverlaps.size,
    user_messages_during: messagesDuringMulticlaude.size,
  }
}

export function aggregateData(
  sessions: SessionMeta[],
  facets: Map<string, SessionFacets>,
): AggregatedData {
  const result: AggregatedData = {
    total_sessions: sessions.length,
    sessions_with_facets: facets.size,
    date_range: { start: '', end: '' },
    total_messages: 0,
    total_duration_hours: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    tool_counts: {},
    languages: {},
    git_commits: 0,
    git_pushes: 0,
    projects: {},
    goal_categories: {},
    outcomes: {},
    satisfaction: {},
    helpfulness: {},
    session_types: {},
    friction: {},
    success: {},
    session_summaries: [],
    // New stats
    total_interruptions: 0,
    total_tool_errors: 0,
    tool_error_categories: {},
    user_response_times: [],
    median_response_time: 0,
    avg_response_time: 0,
    sessions_using_task_agent: 0,
    sessions_using_mcp: 0,
    sessions_using_web_search: 0,
    sessions_using_web_fetch: 0,
    // Additional stats
    total_lines_added: 0,
    total_lines_removed: 0,
    total_files_modified: 0,
    days_active: 0,
    messages_per_day: 0,
    message_hours: [],
    // Multi-clauding stats (matching Python reference)
    multi_clauding: {
      overlap_events: 0,
      sessions_involved: 0,
      user_messages_during: 0,
    },
  }

  const dates: string[] = []
  const allResponseTimes: number[] = []
  const allMessageHours: number[] = []

  for (const session of sessions) {
    dates.push(session.start_time)
    result.total_messages += session.user_message_count
    result.total_duration_hours += session.duration_minutes / 60
    result.total_input_tokens += session.input_tokens
    result.total_output_tokens += session.output_tokens
    result.git_commits += session.git_commits
    result.git_pushes += session.git_pushes

    // New stats aggregation
    result.total_interruptions += session.user_interruptions
    result.total_tool_errors += session.tool_errors
    for (const [cat, count] of Object.entries(session.tool_error_categories)) {
      result.tool_error_categories[cat] =
        (result.tool_error_categories[cat] || 0) + count
    }
    allResponseTimes.push(...session.user_response_times)
    if (session.uses_task_agent) result.sessions_using_task_agent++
    if (session.uses_mcp) result.sessions_using_mcp++
    if (session.uses_web_search) result.sessions_using_web_search++
    if (session.uses_web_fetch) result.sessions_using_web_fetch++

    // Additional stats aggregation
    result.total_lines_added += session.lines_added
    result.total_lines_removed += session.lines_removed
    result.total_files_modified += session.files_modified
    allMessageHours.push(...session.message_hours)

    for (const [tool, count] of Object.entries(session.tool_counts)) {
      result.tool_counts[tool] = (result.tool_counts[tool] || 0) + count
    }

    for (const [lang, count] of Object.entries(session.languages)) {
      result.languages[lang] = (result.languages[lang] || 0) + count
    }

    if (session.project_path) {
      result.projects[session.project_path] =
        (result.projects[session.project_path] || 0) + 1
    }

    const sessionFacets = facets.get(session.session_id)
    if (sessionFacets) {
      // Goal categories
      for (const [cat, count] of safeEntries(sessionFacets.goal_categories)) {
        if (count > 0) {
          result.goal_categories[cat] =
            (result.goal_categories[cat] || 0) + count
        }
      }

      // Outcomes
      result.outcomes[sessionFacets.outcome] =
        (result.outcomes[sessionFacets.outcome] || 0) + 1

      // Satisfaction counts
      for (const [level, count] of safeEntries(
        sessionFacets.user_satisfaction_counts,
      )) {
        if (count > 0) {
          result.satisfaction[level] = (result.satisfaction[level] || 0) + count
        }
      }

      // Helpfulness
      result.helpfulness[sessionFacets.claude_helpfulness] =
        (result.helpfulness[sessionFacets.claude_helpfulness] || 0) + 1

      // Session types
      result.session_types[sessionFacets.session_type] =
        (result.session_types[sessionFacets.session_type] || 0) + 1

      // Friction counts
      for (const [type, count] of safeEntries(sessionFacets.friction_counts)) {
        if (count > 0) {
          result.friction[type] = (result.friction[type] || 0) + count
        }
      }

      // Success factors
      if (sessionFacets.primary_success !== 'none') {
        result.success[sessionFacets.primary_success] =
          (result.success[sessionFacets.primary_success] || 0) + 1
      }
    }

    if (result.session_summaries.length < 50) {
      result.session_summaries.push({
        id: session.session_id.slice(0, 8),
        date: session.start_time.split('T')[0] || '',
        summary: session.summary || session.first_prompt.slice(0, 100),
        goal: sessionFacets?.underlying_goal,
      })
    }
  }

  dates.sort()
  result.date_range.start = dates[0]?.split('T')[0] || ''
  result.date_range.end = dates[dates.length - 1]?.split('T')[0] || ''

  // Calculate response time stats
  result.user_response_times = allResponseTimes
  if (allResponseTimes.length > 0) {
    const sorted = [...allResponseTimes].sort((a, b) => a - b)
    result.median_response_time = sorted[Math.floor(sorted.length / 2)] || 0
    result.avg_response_time =
      allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length
  }

  // Calculate days active and messages per day
  const uniqueDays = new Set(dates.map(d => d.split('T')[0]))
  result.days_active = uniqueDays.size
  result.messages_per_day =
    result.days_active > 0
      ? Math.round((result.total_messages / result.days_active) * 10) / 10
      : 0

  // Store message hours for time-of-day chart
  result.message_hours = allMessageHours

  result.multi_clauding = detectMultiClauding(sessions)

  return result
}

// ============================================================================
// Export Types & Functions
// ============================================================================

/**
 * Build export data from already-computed values.
 * Used by background upload to S3.
 */
export function buildExportData(
  data: AggregatedData,
  insights: InsightResults,
  facets: Map<string, SessionFacets>,
): InsightsExport {
  const version = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

  const facets_summary = {
    total: facets.size,
    goal_categories: {} as Record<string, number>,
    outcomes: {} as Record<string, number>,
    satisfaction: {} as Record<string, number>,
    friction: {} as Record<string, number>,
  }
  for (const f of facets.values()) {
    for (const [cat, count] of safeEntries(f.goal_categories)) {
      if (count > 0) {
        facets_summary.goal_categories[cat] =
          (facets_summary.goal_categories[cat] || 0) + count
      }
    }
    facets_summary.outcomes[f.outcome] =
      (facets_summary.outcomes[f.outcome] || 0) + 1
    for (const [level, count] of safeEntries(f.user_satisfaction_counts)) {
      if (count > 0) {
        facets_summary.satisfaction[level] =
          (facets_summary.satisfaction[level] || 0) + count
      }
    }
    for (const [type, count] of safeEntries(f.friction_counts)) {
      if (count > 0) {
        facets_summary.friction[type] =
          (facets_summary.friction[type] || 0) + count
      }
    }
  }

  return {
    metadata: {
      username: process.env.SAFEUSER || process.env.USER || 'unknown',
      generated_at: new Date().toISOString(),
      claude_code_version: version,
      date_range: data.date_range,
      session_count: data.total_sessions,
    },
    aggregated_data: data,
    insights,
    facets_summary,
  }
}

function safeEntries<V>(
  obj: Record<string, V> | undefined | null,
): [string, V][] {
  return obj ? Object.entries(obj) : []
}

export function safeKeys(obj: Record<string, unknown> | undefined | null): string[] {
  return obj ? Object.keys(obj) : []
}
