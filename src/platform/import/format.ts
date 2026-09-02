/**
 * How an import plan and its report are described to a human.
 *
 * Both the selection tree and the final report show the same groups — "4 MCP
 * servers", "7 commands" — so the grouping lives here rather than in the Ink
 * component. That is also what makes it testable: a module reachable from
 * `src/terminal/ink.js` cannot be imported by a colocated unit test.
 */
import { basename } from 'path'

import type {
  ImportArtifact,
  ImportArtifactKind,
  ImportPlan,
  ImportReport,
  ImportScope,
} from 'src/platform/import/types.js'

/** Rendering order inside one agent's group, most useful first. */
const KIND_ORDER: readonly ImportArtifactKind[] = [
  'mcpServer',
  'instructions',
  'command',
  'agent',
  'rule',
  'skillDir',
  'settingsKey',
  'providerHint',
]

const MAX_NAMES_IN_DETAIL = 3

export type ArtifactGroup = {
  key: string
  kind: ImportArtifactKind
  scope: ImportScope
  artifacts: ImportArtifact[]
  /** Left column, e.g. `4 MCP servers`. */
  label: string
  /** Right column, e.g. `github, filesystem, slack, +1`. */
  detail: string
}

export function shortenHome(path: string, homeDir?: string): string {
  if (!homeDir || !path.startsWith(homeDir)) return path
  return `~${path.slice(homeDir.length)}`
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function namesOf(artifacts: ImportArtifact[]): string {
  const names = artifacts.map(artifact =>
    'name' in artifact
      ? artifact.name
      : 'key' in artifact
        ? artifact.key
        : basename(artifact.destination),
  )
  if (names.length <= MAX_NAMES_IN_DETAIL) return names.join(', ')
  return `${names.slice(0, MAX_NAMES_IN_DETAIL).join(', ')}, +${names.length - MAX_NAMES_IN_DETAIL}`
}

function groupLabel(
  kind: ImportArtifactKind,
  artifacts: ImportArtifact[],
): string {
  const count = artifacts.length
  switch (kind) {
    case 'mcpServer':
      return plural(count, 'MCP server')
    case 'instructions':
      return count === 1 && artifacts[0]
        ? basename(artifacts[0].source)
        : plural(count, 'memory file')
    case 'command':
      return plural(count, 'command')
    case 'agent':
      return plural(count, 'agent')
    case 'rule':
      return plural(count, 'rule')
    case 'skillDir':
      return plural(count, 'skill')
    case 'settingsKey':
      return plural(count, 'setting')
    case 'providerHint':
      return 'provider config'
  }
}

function groupDetail(
  kind: ImportArtifactKind,
  artifacts: ImportArtifact[],
  homeDir?: string,
): string {
  const first = artifacts[0]
  if (!first) return ''
  switch (kind) {
    case 'mcpServer':
      return `${namesOf(artifacts)}  →  ${first.scope}`
    case 'settingsKey':
      return namesOf(artifacts)
    case 'providerHint':
      return first.kind === 'providerHint'
        ? `${first.model || 'no model'} at ${first.baseUrl || 'no base URL'} (no token)`
        : ''
    default:
      return `→ ${shortenHome(commonDestination(artifacts), homeDir)}`
  }
}

/**
 * The deepest directory every destination in the group shares, so a group of
 * commands reads `→ ~/.claudin/commands/` rather than listing seven paths.
 */
function commonDestination(artifacts: ImportArtifact[]): string {
  const paths = artifacts.map(artifact => artifact.destination)
  const first = paths[0]
  if (!first) return ''
  if (paths.length === 1) return first
  const segments = first.split('/')
  let shared = segments.length
  for (const path of paths.slice(1)) {
    const other = path.split('/')
    let index = 0
    while (index < shared && index < other.length && segments[index] === other[index]) {
      index += 1
    }
    shared = index
  }
  return `${segments.slice(0, shared).join('/')}/`
}

export function groupArtifacts(
  artifacts: readonly ImportArtifact[],
  homeDir?: string,
): ArtifactGroup[] {
  const buckets = new Map<string, ImportArtifact[]>()
  for (const artifact of artifacts) {
    const key = `${artifact.kind}:${artifact.scope}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(artifact)
    else buckets.set(key, [artifact])
  }

  const groups: ArtifactGroup[] = []
  for (const kind of KIND_ORDER) {
    for (const scope of ['user', 'project'] as const) {
      const bucket = buckets.get(`${kind}:${scope}`)
      if (!bucket || bucket.length === 0) continue
      groups.push({
        key: `${kind}:${scope}`,
        kind,
        scope,
        artifacts: bucket,
        label: groupLabel(kind, bucket),
        detail: groupDetail(kind, bucket, homeDir),
      })
    }
  }
  return groups
}

export function planIsEmpty(plan: ImportPlan): boolean {
  return plan.artifacts.length === 0
}

export function formatImportReport(
  report: ImportReport,
  homeDir?: string,
): string {
  const lines: string[] = []

  if (report.applied.length === 0) {
    lines.push('Nothing was imported.')
  } else {
    for (const group of groupArtifacts(report.applied, homeDir)) {
      lines.push(`  ✓ ${group.label}${group.detail ? `   ${group.detail}` : ''}`)
    }
  }

  if (report.skipped.length > 0) {
    lines.push('')
    lines.push(`  ⚠ ${report.skipped.length} skipped`)
    for (const artifact of report.skipped) {
      const name =
        'name' in artifact
          ? artifact.name
          : 'key' in artifact
            ? artifact.key
            : basename(artifact.destination)
      lines.push(
        `      ${name} — ${artifact.statusReason ?? 'already present'}`,
      )
    }
  }

  if (report.notImportable.length > 0) {
    lines.push('')
    lines.push('  ⎿ Not imported')
    for (const item of report.notImportable) {
      lines.push(`      ${item.label} — ${item.detail}`)
    }
  }

  if (report.warnings.length > 0) {
    lines.push('')
    lines.push(`  Warnings (${report.warnings.length})`)
    for (const warning of report.warnings) {
      lines.push(`      ${shortenHome(warning, homeDir)}`)
    }
  }

  if (report.errors.length > 0) {
    lines.push('')
    lines.push(`  Errors (${report.errors.length})`)
    for (const error of report.errors) {
      lines.push(`      ${error}`)
    }
  }

  if (report.applied.some(artifact => artifact.kind === 'mcpServer')) {
    lines.push('')
    lines.push('  Restart Claudin to connect the new MCP servers.')
  }
  if (report.applied.some(artifact => artifact.kind === 'providerHint')) {
    lines.push('  Run /provider to finish signing in — no tokens were copied.')
  }

  return lines.join('\n')
}
