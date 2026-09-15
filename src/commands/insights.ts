import { execFileSync } from 'child_process'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Command } from 'src/commands/commands.js'
import type { LogOption } from 'src/shared/types/logs.js'
import { loadAllLogsFromSessionFile } from 'src/sessions/sessionStorage.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { escapeXmlAttr as escapeHtml } from 'src/shared/data/xml.js'
import {
  LABEL_MAP,
  OUTCOME_ORDER,
  SATISFACTION_ORDER,
} from 'src/commands/insights/constants.js'
import {
  aggregateData,
  safeKeys,
} from 'src/commands/insights/aggregate.js'
import {
  extractFacetsFromAPI,
  hasValidDates,
  logToSessionMeta,
} from 'src/commands/insights/extract.js'
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

export type { InsightsExport } from 'src/commands/insights/types.js'
export {
  buildExportData,
  detectMultiClauding,
} from 'src/commands/insights/aggregate.js'
export { deduplicateSessionBranches } from 'src/commands/insights/extract.js'

// Escape HTML but render **bold** as <strong>
function escapeHtmlWithBold(text: string): string {
  const escaped = escapeHtml(text)
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

function generateBarChart(
  data: Record<string, number>,
  color: string,
  maxItems = 6,
  fixedOrder?: string[],
): string {
  let entries: [string, number][]

  if (fixedOrder) {
    // Use fixed order, only including items that exist in data
    entries = fixedOrder
      .filter(key => key in data && (data[key] ?? 0) > 0)
      .map(key => [key, data[key] ?? 0] as [string, number])
  } else {
    // Sort by count descending
    entries = Object.entries(data)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxItems)
  }

  if (entries.length === 0) return '<p class="empty">No data</p>'

  const maxVal = Math.max(...entries.map(e => e[1]))
  return entries
    .map(([label, count]) => {
      const pct = (count / maxVal) * 100
      // Use LABEL_MAP if available, otherwise clean up underscores and title case
      const cleanLabel =
        LABEL_MAP[label] ||
        label.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      return `<div class="bar-row">
        <div class="bar-label">${escapeHtml(cleanLabel)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="bar-value">${count}</div>
      </div>`
    })
    .join('\n')
}

function generateResponseTimeHistogram(times: number[]): string {
  if (times.length === 0) return '<p class="empty">No response time data</p>'

  // Create buckets (matching Python reference)
  const buckets: Record<string, number> = {
    '2-10s': 0,
    '10-30s': 0,
    '30s-1m': 0,
    '1-2m': 0,
    '2-5m': 0,
    '5-15m': 0,
    '>15m': 0,
  }

  for (const t of times) {
    if (t < 10) buckets['2-10s'] = (buckets['2-10s'] ?? 0) + 1
    else if (t < 30) buckets['10-30s'] = (buckets['10-30s'] ?? 0) + 1
    else if (t < 60) buckets['30s-1m'] = (buckets['30s-1m'] ?? 0) + 1
    else if (t < 120) buckets['1-2m'] = (buckets['1-2m'] ?? 0) + 1
    else if (t < 300) buckets['2-5m'] = (buckets['2-5m'] ?? 0) + 1
    else if (t < 900) buckets['5-15m'] = (buckets['5-15m'] ?? 0) + 1
    else buckets['>15m'] = (buckets['>15m'] ?? 0) + 1
  }

  const maxVal = Math.max(...Object.values(buckets))
  if (maxVal === 0) return '<p class="empty">No response time data</p>'

  return Object.entries(buckets)
    .map(([label, count]) => {
      const pct = (count / maxVal) * 100
      return `<div class="bar-row">
        <div class="bar-label">${label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:#6366f1"></div></div>
        <div class="bar-value">${count}</div>
      </div>`
    })
    .join('\n')
}

function generateTimeOfDayChart(messageHours: number[]): string {
  if (messageHours.length === 0) return '<p class="empty">No time data</p>'

  // Group into time periods
  const periods = [
    { label: 'Morning (6-12)', range: [6, 7, 8, 9, 10, 11] },
    { label: 'Afternoon (12-18)', range: [12, 13, 14, 15, 16, 17] },
    { label: 'Evening (18-24)', range: [18, 19, 20, 21, 22, 23] },
    { label: 'Night (0-6)', range: [0, 1, 2, 3, 4, 5] },
  ]

  const hourCounts: Record<number, number> = {}
  for (const h of messageHours) {
    hourCounts[h] = (hourCounts[h] || 0) + 1
  }

  const periodCounts = periods.map(p => ({
    label: p.label,
    count: p.range.reduce((sum, h) => sum + (hourCounts[h] || 0), 0),
  }))

  const maxVal = Math.max(...periodCounts.map(p => p.count)) || 1

  const barsHtml = periodCounts
    .map(
      p => `
      <div class="bar-row">
        <div class="bar-label">${p.label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(p.count / maxVal) * 100}%;background:#8b5cf6"></div></div>
        <div class="bar-value">${p.count}</div>
      </div>`,
    )
    .join('\n')

  return `<div id="hour-histogram">${barsHtml}</div>`
}

function getHourCountsJson(messageHours: number[]): string {
  const hourCounts: Record<number, number> = {}
  for (const h of messageHours) {
    hourCounts[h] = (hourCounts[h] || 0) + 1
  }
  return jsonStringify(hourCounts)
}

function generateHtmlReport(
  data: AggregatedData,
  insights: InsightResults,
): string {
  const markdownToHtml = (md: string): string => {
    if (!md) return ''
    return md
      .split('\n\n')
      .map(p => {
        let html = escapeHtml(p)
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        html = html.replace(/^- /gm, '• ')
        html = html.replace(/\n/g, '<br>')
        return `<p>${html}</p>`
      })
      .join('\n')
  }

  // Build At a Glance section (new 4-part format with links to sections)
  const atAGlance = insights.at_a_glance
  const atAGlanceHtml = atAGlance
    ? `
    <div class="at-a-glance">
      <div class="glance-title">At a Glance</div>
      <div class="glance-sections">
        ${atAGlance.whats_working ? `<div class="glance-section"><strong>What's working:</strong> ${escapeHtmlWithBold(atAGlance.whats_working)} <a href="#section-wins" class="see-more">Impressive Things You Did →</a></div>` : ''}
        ${atAGlance.whats_hindering ? `<div class="glance-section"><strong>What's hindering you:</strong> ${escapeHtmlWithBold(atAGlance.whats_hindering)} <a href="#section-friction" class="see-more">Where Things Go Wrong →</a></div>` : ''}
        ${atAGlance.quick_wins ? `<div class="glance-section"><strong>Quick wins to try:</strong> ${escapeHtmlWithBold(atAGlance.quick_wins)} <a href="#section-features" class="see-more">Features to Try →</a></div>` : ''}
        ${atAGlance.ambitious_workflows ? `<div class="glance-section"><strong>Ambitious workflows:</strong> ${escapeHtmlWithBold(atAGlance.ambitious_workflows)} <a href="#section-horizon" class="see-more">On the Horizon →</a></div>` : ''}
      </div>
    </div>
    `
    : ''

  // Build project areas section
  const projectAreas = insights.project_areas?.areas || []
  const projectAreasHtml =
    projectAreas.length > 0
      ? `
    <h2 id="section-work">What You Work On</h2>
    <div class="project-areas">
      ${projectAreas
        .map(
          area => `
        <div class="project-area">
          <div class="area-header">
            <span class="area-name">${escapeHtml(area.name)}</span>
            <span class="area-count">~${area.session_count} sessions</span>
          </div>
          <div class="area-desc">${escapeHtml(area.description)}</div>
        </div>
      `,
        )
        .join('')}
    </div>
    `
      : ''

  // Build interaction style section
  const interactionStyle = insights.interaction_style
  const interactionHtml = interactionStyle?.narrative
    ? `
    <h2 id="section-usage">How You Use Claudin</h2>
    <div class="narrative">
      ${markdownToHtml(interactionStyle.narrative)}
      ${interactionStyle.key_pattern ? `<div class="key-insight"><strong>Key pattern:</strong> ${escapeHtml(interactionStyle.key_pattern)}</div>` : ''}
    </div>
    `
    : ''

  // Build what works section
  const whatWorks = insights.what_works
  const whatWorksHtml =
    whatWorks?.impressive_workflows && whatWorks.impressive_workflows.length > 0
      ? `
    <h2 id="section-wins">Impressive Things You Did</h2>
    ${whatWorks.intro ? `<p class="section-intro">${escapeHtml(whatWorks.intro)}</p>` : ''}
    <div class="big-wins">
      ${whatWorks.impressive_workflows
        .map(
          wf => `
        <div class="big-win">
          <div class="big-win-title">${escapeHtml(wf.title || '')}</div>
          <div class="big-win-desc">${escapeHtml(wf.description || '')}</div>
        </div>
      `,
        )
        .join('')}
    </div>
    `
      : ''

  // Build friction section
  const frictionAnalysis = insights.friction_analysis
  const frictionHtml =
    frictionAnalysis?.categories && frictionAnalysis.categories.length > 0
      ? `
    <h2 id="section-friction">Where Things Go Wrong</h2>
    ${frictionAnalysis.intro ? `<p class="section-intro">${escapeHtml(frictionAnalysis.intro)}</p>` : ''}
    <div class="friction-categories">
      ${frictionAnalysis.categories
        .map(
          cat => `
        <div class="friction-category">
          <div class="friction-title">${escapeHtml(cat.category || '')}</div>
          <div class="friction-desc">${escapeHtml(cat.description || '')}</div>
          ${cat.examples ? `<ul class="friction-examples">${cat.examples.map(ex => `<li>${escapeHtml(ex)}</li>`).join('')}</ul>` : ''}
        </div>
      `,
        )
        .join('')}
    </div>
    `
      : ''

  // Build suggestions section
  const suggestions = insights.suggestions
  const suggestionsHtml = suggestions
    ? `
    ${
      suggestions.claude_md_additions &&
      suggestions.claude_md_additions.length > 0
        ? `
    <h2 id="section-features">Existing CC Features to Try</h2>
    <div class="claude-md-section">
      <h3>Suggested CLAUDE.md Additions</h3>
      <p style="font-size: 12px; color: #64748b; margin-bottom: 12px;">Just copy this into Claudin to add it to your CLAUDE.md.</p>
      <div class="claude-md-actions">
        <button class="copy-all-btn" onclick="copyAllCheckedClaudeMd()">Copy All Checked</button>
      </div>
      ${suggestions.claude_md_additions
        .map(
          (add, i) => `
        <div class="claude-md-item">
          <input type="checkbox" id="cmd-${i}" class="cmd-checkbox" checked data-text="${escapeHtml(add.prompt_scaffold || add.where || 'Add to CLAUDE.md')}\\n\\n${escapeHtml(add.addition)}">
          <label for="cmd-${i}">
            <code class="cmd-code">${escapeHtml(add.addition)}</code>
            <button class="copy-btn" onclick="copyCmdItem(${i})">Copy</button>
          </label>
          <div class="cmd-why">${escapeHtml(add.why)}</div>
        </div>
      `,
        )
        .join('')}
    </div>
    `
        : ''
    }
    ${
      suggestions.features_to_try && suggestions.features_to_try.length > 0
        ? `
    <p style="font-size: 13px; color: #64748b; margin-bottom: 12px;">Just copy this into Claudin and it'll set it up for you.</p>
    <div class="features-section">
      ${suggestions.features_to_try
        .map(
          feat => `
        <div class="feature-card">
          <div class="feature-title">${escapeHtml(feat.feature || '')}</div>
          <div class="feature-oneliner">${escapeHtml(feat.one_liner || '')}</div>
          <div class="feature-why"><strong>Why for you:</strong> ${escapeHtml(feat.why_for_you || '')}</div>
          ${
            feat.example_code
              ? `
          <div class="feature-examples">
            <div class="feature-example">
              <div class="example-code-row">
                <code class="example-code">${escapeHtml(feat.example_code)}</code>
                <button class="copy-btn" onclick="copyText(this)">Copy</button>
              </div>
            </div>
          </div>
          `
              : ''
          }
        </div>
      `,
        )
        .join('')}
    </div>
    `
        : ''
    }
    ${
      suggestions.usage_patterns && suggestions.usage_patterns.length > 0
        ? `
    <h2 id="section-patterns">New Ways to Use Claudin</h2>
    <p style="font-size: 13px; color: #64748b; margin-bottom: 12px;">Just copy this into Claudin and it'll walk you through it.</p>
    <div class="patterns-section">
      ${suggestions.usage_patterns
        .map(
          pat => `
        <div class="pattern-card">
          <div class="pattern-title">${escapeHtml(pat.title || '')}</div>
          <div class="pattern-summary">${escapeHtml(pat.suggestion || '')}</div>
          ${pat.detail ? `<div class="pattern-detail">${escapeHtml(pat.detail)}</div>` : ''}
          ${
            pat.copyable_prompt
              ? `
          <div class="copyable-prompt-section">
            <div class="prompt-label">Paste into Claudin:</div>
            <div class="copyable-prompt-row">
              <code class="copyable-prompt">${escapeHtml(pat.copyable_prompt)}</code>
              <button class="copy-btn" onclick="copyText(this)">Copy</button>
            </div>
          </div>
          `
              : ''
          }
        </div>
      `,
        )
        .join('')}
    </div>
    `
        : ''
    }
    `
    : ''

  // Build On the Horizon section
  const horizonData = insights.on_the_horizon
  const horizonHtml =
    horizonData?.opportunities && horizonData.opportunities.length > 0
      ? `
    <h2 id="section-horizon">On the Horizon</h2>
    ${horizonData.intro ? `<p class="section-intro">${escapeHtml(horizonData.intro)}</p>` : ''}
    <div class="horizon-section">
      ${horizonData.opportunities
        .map(
          opp => `
        <div class="horizon-card">
          <div class="horizon-title">${escapeHtml(opp.title || '')}</div>
          <div class="horizon-possible">${escapeHtml(opp.whats_possible || '')}</div>
          ${opp.how_to_try ? `<div class="horizon-tip"><strong>Getting started:</strong> ${escapeHtml(opp.how_to_try)}</div>` : ''}
          ${opp.copyable_prompt ? `<div class="pattern-prompt"><div class="prompt-label">Paste into Claudin:</div><code>${escapeHtml(opp.copyable_prompt)}</code><button class="copy-btn" onclick="copyText(this)">Copy</button></div>` : ''}
        </div>
      `,
        )
        .join('')}
    </div>
    `
      : ''

  const teamFeedbackHtml = ''

  // Build Fun Ending section
  const funEnding = insights.fun_ending
  const funEndingHtml = funEnding?.headline
    ? `
    <div class="fun-ending">
      <div class="fun-headline">"${escapeHtml(funEnding.headline)}"</div>
      ${funEnding.detail ? `<div class="fun-detail">${escapeHtml(funEnding.detail)}</div>` : ''}
    </div>
    `
    : ''

  const css = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #f8fafc; color: #334155; line-height: 1.65; padding: 48px 24px; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 32px; font-weight: 700; color: #0f172a; margin-bottom: 8px; }
    h2 { font-size: 20px; font-weight: 600; color: #0f172a; margin-top: 48px; margin-bottom: 16px; }
    .subtitle { color: #64748b; font-size: 15px; margin-bottom: 32px; }
    .nav-toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0 32px 0; padding: 16px; background: white; border-radius: 8px; border: 1px solid #e2e8f0; }
    .nav-toc a { font-size: 12px; color: #64748b; text-decoration: none; padding: 6px 12px; border-radius: 6px; background: #f1f5f9; transition: all 0.15s; }
    .nav-toc a:hover { background: #e2e8f0; color: #334155; }
    .stats-row { display: flex; gap: 24px; margin-bottom: 40px; padding: 20px 0; border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
    .stat { text-align: center; }
    .stat-value { font-size: 24px; font-weight: 700; color: #0f172a; }
    .stat-label { font-size: 11px; color: #64748b; text-transform: uppercase; }
    .at-a-glance { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 1px solid #f59e0b; border-radius: 12px; padding: 20px 24px; margin-bottom: 32px; }
    .glance-title { font-size: 16px; font-weight: 700; color: #92400e; margin-bottom: 16px; }
    .glance-sections { display: flex; flex-direction: column; gap: 12px; }
    .glance-section { font-size: 14px; color: #78350f; line-height: 1.6; }
    .glance-section strong { color: #92400e; }
    .see-more { color: #b45309; text-decoration: none; font-size: 13px; white-space: nowrap; }
    .see-more:hover { text-decoration: underline; }
    .project-areas { display: flex; flex-direction: column; gap: 12px; margin-bottom: 32px; }
    .project-area { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
    .area-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .area-name { font-weight: 600; font-size: 15px; color: #0f172a; }
    .area-count { font-size: 12px; color: #64748b; background: #f1f5f9; padding: 2px 8px; border-radius: 4px; }
    .area-desc { font-size: 14px; color: #475569; line-height: 1.5; }
    .narrative { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
    .narrative p { margin-bottom: 12px; font-size: 14px; color: #475569; line-height: 1.7; }
    .key-insight { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px 16px; margin-top: 12px; font-size: 14px; color: #166534; }
    .section-intro { font-size: 14px; color: #64748b; margin-bottom: 16px; }
    .big-wins { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
    .big-win { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; }
    .big-win-title { font-weight: 600; font-size: 15px; color: #166534; margin-bottom: 8px; }
    .big-win-desc { font-size: 14px; color: #15803d; line-height: 1.5; }
    .friction-categories { display: flex; flex-direction: column; gap: 16px; margin-bottom: 24px; }
    .friction-category { background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 16px; }
    .friction-title { font-weight: 600; font-size: 15px; color: #991b1b; margin-bottom: 6px; }
    .friction-desc { font-size: 13px; color: #7f1d1d; margin-bottom: 10px; }
    .friction-examples { margin: 0 0 0 20px; font-size: 13px; color: #334155; }
    .friction-examples li { margin-bottom: 4px; }
    .claude-md-section { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
    .claude-md-section h3 { font-size: 14px; font-weight: 600; color: #1e40af; margin: 0 0 12px 0; }
    .claude-md-actions { margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #dbeafe; }
    .copy-all-btn { background: #2563eb; color: white; border: none; border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer; font-weight: 500; transition: all 0.2s; }
    .copy-all-btn:hover { background: #1d4ed8; }
    .copy-all-btn.copied { background: #16a34a; }
    .claude-md-item { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; padding: 10px 0; border-bottom: 1px solid #dbeafe; }
    .claude-md-item:last-child { border-bottom: none; }
    .cmd-checkbox { margin-top: 2px; }
    .cmd-code { background: white; padding: 8px 12px; border-radius: 4px; font-size: 12px; color: #1e40af; border: 1px solid #bfdbfe; font-family: monospace; display: block; white-space: pre-wrap; word-break: break-word; flex: 1; }
    .cmd-why { font-size: 12px; color: #64748b; width: 100%; padding-left: 24px; margin-top: 4px; }
    .features-section, .patterns-section { display: flex; flex-direction: column; gap: 12px; margin: 16px 0; }
    .feature-card { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 16px; }
    .pattern-card { background: #f0f9ff; border: 1px solid #7dd3fc; border-radius: 8px; padding: 16px; }
    .feature-title, .pattern-title { font-weight: 600; font-size: 15px; color: #0f172a; margin-bottom: 6px; }
    .feature-oneliner { font-size: 14px; color: #475569; margin-bottom: 8px; }
    .pattern-summary { font-size: 14px; color: #475569; margin-bottom: 8px; }
    .feature-why, .pattern-detail { font-size: 13px; color: #334155; line-height: 1.5; }
    .feature-examples { margin-top: 12px; }
    .feature-example { padding: 8px 0; border-top: 1px solid #d1fae5; }
    .feature-example:first-child { border-top: none; }
    .example-desc { font-size: 13px; color: #334155; margin-bottom: 6px; }
    .example-code-row { display: flex; align-items: flex-start; gap: 8px; }
    .example-code { flex: 1; background: #f1f5f9; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #334155; overflow-x: auto; white-space: pre-wrap; }
    .copyable-prompt-section { margin-top: 12px; padding-top: 12px; border-top: 1px solid #e2e8f0; }
    .copyable-prompt-row { display: flex; align-items: flex-start; gap: 8px; }
    .copyable-prompt { flex: 1; background: #f8fafc; padding: 10px 12px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #334155; border: 1px solid #e2e8f0; white-space: pre-wrap; line-height: 1.5; }
    .feature-code { background: #f8fafc; padding: 12px; border-radius: 6px; margin-top: 12px; border: 1px solid #e2e8f0; display: flex; align-items: flex-start; gap: 8px; }
    .feature-code code { flex: 1; font-family: monospace; font-size: 12px; color: #334155; white-space: pre-wrap; }
    .pattern-prompt { background: #f8fafc; padding: 12px; border-radius: 6px; margin-top: 12px; border: 1px solid #e2e8f0; }
    .pattern-prompt code { font-family: monospace; font-size: 12px; color: #334155; display: block; white-space: pre-wrap; margin-bottom: 8px; }
    .prompt-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #64748b; margin-bottom: 6px; }
    .copy-btn { background: #e2e8f0; border: none; border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; color: #475569; flex-shrink: 0; }
    .copy-btn:hover { background: #cbd5e1; }
    .charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 24px 0; }
    .chart-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
    .chart-title { font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase; margin-bottom: 12px; }
    .bar-row { display: flex; align-items: center; margin-bottom: 6px; }
    .bar-label { width: 100px; font-size: 11px; color: #475569; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { flex: 1; height: 6px; background: #f1f5f9; border-radius: 3px; margin: 0 8px; }
    .bar-fill { height: 100%; border-radius: 3px; }
    .bar-value { width: 28px; font-size: 11px; font-weight: 500; color: #64748b; text-align: right; }
    .empty { color: #94a3b8; font-size: 13px; }
    .horizon-section { display: flex; flex-direction: column; gap: 16px; }
    .horizon-card { background: linear-gradient(135deg, #faf5ff 0%, #f5f3ff 100%); border: 1px solid #c4b5fd; border-radius: 8px; padding: 16px; }
    .horizon-title { font-weight: 600; font-size: 15px; color: #5b21b6; margin-bottom: 8px; }
    .horizon-possible { font-size: 14px; color: #334155; margin-bottom: 10px; line-height: 1.5; }
    .horizon-tip { font-size: 13px; color: #6b21a8; background: rgba(255,255,255,0.6); padding: 8px 12px; border-radius: 4px; }
    .feedback-header { margin-top: 48px; color: #64748b; font-size: 16px; }
    .feedback-intro { font-size: 13px; color: #94a3b8; margin-bottom: 16px; }
    .feedback-section { margin-top: 16px; }
    .feedback-section h3 { font-size: 14px; font-weight: 600; color: #475569; margin-bottom: 12px; }
    .feedback-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
    .feedback-card.team-card { background: #eff6ff; border-color: #bfdbfe; }
    .feedback-card.model-card { background: #faf5ff; border-color: #e9d5ff; }
    .feedback-title { font-weight: 600; font-size: 14px; color: #0f172a; margin-bottom: 6px; }
    .feedback-detail { font-size: 13px; color: #475569; line-height: 1.5; }
    .feedback-evidence { font-size: 12px; color: #64748b; margin-top: 8px; }
    .fun-ending { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 1px solid #fbbf24; border-radius: 12px; padding: 24px; margin-top: 40px; text-align: center; }
    .fun-headline { font-size: 18px; font-weight: 600; color: #78350f; margin-bottom: 8px; }
    .fun-detail { font-size: 14px; color: #92400e; }
    .collapsible-section { margin-top: 16px; }
    .collapsible-header { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 12px 0; border-bottom: 1px solid #e2e8f0; }
    .collapsible-header h3 { margin: 0; font-size: 14px; font-weight: 600; color: #475569; }
    .collapsible-arrow { font-size: 12px; color: #94a3b8; transition: transform 0.2s; }
    .collapsible-content { display: none; padding-top: 16px; }
    .collapsible-content.open { display: block; }
    .collapsible-header.open .collapsible-arrow { transform: rotate(90deg); }
    @media (max-width: 640px) { .charts-row { grid-template-columns: 1fr; } .stats-row { justify-content: center; } }
  `

  const hourCountsJson = getHourCountsJson(data.message_hours)

  const js = `
    function toggleCollapsible(header) {
      header.classList.toggle('open');
      const content = header.nextElementSibling;
      content.classList.toggle('open');
    }
    function copyText(btn) {
      const code = btn.previousElementSibling;
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      });
    }
    function copyCmdItem(idx) {
      const checkbox = document.getElementById('cmd-' + idx);
      if (checkbox) {
        const text = checkbox.dataset.text;
        navigator.clipboard.writeText(text).then(() => {
          const btn = checkbox.nextElementSibling.querySelector('.copy-btn');
          if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
        });
      }
    }
    function copyAllCheckedClaudeMd() {
      const checkboxes = document.querySelectorAll('.cmd-checkbox:checked');
      const texts = [];
      checkboxes.forEach(cb => {
        if (cb.dataset.text) { texts.push(cb.dataset.text); }
      });
      const combined = texts.join('\\n');
      const btn = document.querySelector('.copy-all-btn');
      if (btn) {
        navigator.clipboard.writeText(combined).then(() => {
          btn.textContent = 'Copied ' + texts.length + ' items!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Copy All Checked'; btn.classList.remove('copied'); }, 2000);
        });
      }
    }
    // Timezone selector for time of day chart (data is from our own analytics, not user input)
    const rawHourCounts = ${hourCountsJson};
    function updateHourHistogram(offsetFromPT) {
      const periods = [
        { label: "Morning (6-12)", range: [6,7,8,9,10,11] },
        { label: "Afternoon (12-18)", range: [12,13,14,15,16,17] },
        { label: "Evening (18-24)", range: [18,19,20,21,22,23] },
        { label: "Night (0-6)", range: [0,1,2,3,4,5] }
      ];
      const adjustedCounts = {};
      for (const [hour, count] of Object.entries(rawHourCounts)) {
        const newHour = (parseInt(hour) + offsetFromPT + 24) % 24;
        adjustedCounts[newHour] = (adjustedCounts[newHour] || 0) + count;
      }
      const periodCounts = periods.map(p => ({
        label: p.label,
        count: p.range.reduce((sum, h) => sum + (adjustedCounts[h] || 0), 0)
      }));
      const maxCount = Math.max(...periodCounts.map(p => p.count)) || 1;
      const container = document.getElementById('hour-histogram');
      container.textContent = '';
      periodCounts.forEach(p => {
        const row = document.createElement('div');
        row.className = 'bar-row';
        const label = document.createElement('div');
        label.className = 'bar-label';
        label.textContent = p.label;
        const track = document.createElement('div');
        track.className = 'bar-track';
        const fill = document.createElement('div');
        fill.className = 'bar-fill';
        fill.style.width = (p.count / maxCount) * 100 + '%';
        fill.style.background = '#8b5cf6';
        track.appendChild(fill);
        const value = document.createElement('div');
        value.className = 'bar-value';
        value.textContent = p.count;
        row.appendChild(label);
        row.appendChild(track);
        row.appendChild(value);
        container.appendChild(row);
      });
    }
    document.getElementById('timezone-select').addEventListener('change', function() {
      const customInput = document.getElementById('custom-offset');
      if (this.value === 'custom') {
        customInput.style.display = 'inline-block';
        customInput.focus();
      } else {
        customInput.style.display = 'none';
        updateHourHistogram(parseInt(this.value));
      }
    });
    document.getElementById('custom-offset').addEventListener('change', function() {
      const offset = parseInt(this.value) + 8;
      updateHourHistogram(offset);
    });
  `

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Claudin Insights</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${css}</style>
</head>
<body>
  <div class="container">
    <h1>Claudin Insights</h1>
    <p class="subtitle">${data.total_messages.toLocaleString()} messages across ${data.total_sessions} sessions${data.total_sessions_scanned && data.total_sessions_scanned > data.total_sessions ? ` (${data.total_sessions_scanned.toLocaleString()} total)` : ''} | ${data.date_range.start} to ${data.date_range.end}</p>

    ${atAGlanceHtml}

    <nav class="nav-toc">
      <a href="#section-work">What You Work On</a>
      <a href="#section-usage">How You Use CC</a>
      <a href="#section-wins">Impressive Things</a>
      <a href="#section-friction">Where Things Go Wrong</a>
      <a href="#section-features">Features to Try</a>
      <a href="#section-patterns">New Usage Patterns</a>
      <a href="#section-horizon">On the Horizon</a>
      <a href="#section-feedback">Team Feedback</a>
    </nav>

    <div class="stats-row">
      <div class="stat"><div class="stat-value">${data.total_messages.toLocaleString()}</div><div class="stat-label">Messages</div></div>
      <div class="stat"><div class="stat-value">+${data.total_lines_added.toLocaleString()}/-${data.total_lines_removed.toLocaleString()}</div><div class="stat-label">Lines</div></div>
      <div class="stat"><div class="stat-value">${data.total_files_modified}</div><div class="stat-label">Files</div></div>
      <div class="stat"><div class="stat-value">${data.days_active}</div><div class="stat-label">Days</div></div>
      <div class="stat"><div class="stat-value">${data.messages_per_day}</div><div class="stat-label">Msgs/Day</div></div>
    </div>

    ${projectAreasHtml}

    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title">What You Wanted</div>
        ${generateBarChart(data.goal_categories, '#2563eb')}
      </div>
      <div class="chart-card">
        <div class="chart-title">Top Tools Used</div>
        ${generateBarChart(data.tool_counts, '#0891b2')}
      </div>
    </div>

    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title">Languages</div>
        ${generateBarChart(data.languages, '#10b981')}
      </div>
      <div class="chart-card">
        <div class="chart-title">Session Types</div>
        ${generateBarChart(data.session_types || {}, '#8b5cf6')}
      </div>
    </div>

    ${interactionHtml}

    <!-- Response Time Distribution -->
    <div class="chart-card" style="margin: 24px 0;">
      <div class="chart-title">User Response Time Distribution</div>
      ${generateResponseTimeHistogram(data.user_response_times)}
      <div style="font-size: 12px; color: #64748b; margin-top: 8px;">
        Median: ${data.median_response_time.toFixed(1)}s &bull; Average: ${data.avg_response_time.toFixed(1)}s
      </div>
    </div>

    <!-- Multi-clauding Section (matching Python reference) -->
    <div class="chart-card" style="margin: 24px 0;">
      <div class="chart-title">Multi-Clauding (Parallel Sessions)</div>
      ${
        data.multi_clauding.overlap_events === 0
          ? `
        <p style="font-size: 14px; color: #64748b; padding: 8px 0;">
          No parallel session usage detected. You typically work with one Claudin session at a time.
        </p>
      `
          : `
        <div style="display: flex; gap: 24px; margin: 12px 0;">
          <div style="text-align: center;">
            <div style="font-size: 24px; font-weight: 700; color: #7c3aed;">${data.multi_clauding.overlap_events}</div>
            <div style="font-size: 11px; color: #64748b; text-transform: uppercase;">Overlap Events</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 24px; font-weight: 700; color: #7c3aed;">${data.multi_clauding.sessions_involved}</div>
            <div style="font-size: 11px; color: #64748b; text-transform: uppercase;">Sessions Involved</div>
          </div>
          <div style="text-align: center;">
            <div style="font-size: 24px; font-weight: 700; color: #7c3aed;">${data.total_messages > 0 ? Math.round((100 * data.multi_clauding.user_messages_during) / data.total_messages) : 0}%</div>
            <div style="font-size: 11px; color: #64748b; text-transform: uppercase;">Of Messages</div>
          </div>
        </div>
        <p style="font-size: 13px; color: #475569; margin-top: 12px;">
          You run multiple Claudin sessions simultaneously. Multi-clauding is detected when sessions
          overlap in time, suggesting parallel workflows.
        </p>
      `
      }
    </div>

    <!-- Time of Day & Tool Errors -->
    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title" style="display: flex; align-items: center; gap: 12px;">
          User Messages by Time of Day
          <select id="timezone-select" style="font-size: 12px; padding: 4px 8px; border-radius: 4px; border: 1px solid #e2e8f0;">
            <option value="0">PT (UTC-8)</option>
            <option value="3">ET (UTC-5)</option>
            <option value="8">London (UTC)</option>
            <option value="9">CET (UTC+1)</option>
            <option value="17">Tokyo (UTC+9)</option>
            <option value="custom">Custom offset...</option>
          </select>
          <input type="number" id="custom-offset" placeholder="UTC offset" style="display: none; width: 80px; font-size: 12px; padding: 4px; border-radius: 4px; border: 1px solid #e2e8f0;">
        </div>
        ${generateTimeOfDayChart(data.message_hours)}
      </div>
      <div class="chart-card">
        <div class="chart-title">Tool Errors Encountered</div>
        ${Object.keys(data.tool_error_categories).length > 0 ? generateBarChart(data.tool_error_categories, '#dc2626') : '<p class="empty">No tool errors</p>'}
      </div>
    </div>

    ${whatWorksHtml}

    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title">What Helped Most (Claude's Capabilities)</div>
        ${generateBarChart(data.success, '#16a34a')}
      </div>
      <div class="chart-card">
        <div class="chart-title">Outcomes</div>
        ${generateBarChart(data.outcomes, '#8b5cf6', 6, OUTCOME_ORDER)}
      </div>
    </div>

    ${frictionHtml}

    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title">Primary Friction Types</div>
        ${generateBarChart(data.friction, '#dc2626')}
      </div>
      <div class="chart-card">
        <div class="chart-title">Inferred Satisfaction (model-estimated)</div>
        ${generateBarChart(data.satisfaction, '#eab308', 6, SATISFACTION_ORDER)}
      </div>
    </div>

    ${suggestionsHtml}

    ${horizonHtml}

    ${funEndingHtml}

    ${teamFeedbackHtml}
  </div>
  <script>${js}</script>
</body>
</html>`
}

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
