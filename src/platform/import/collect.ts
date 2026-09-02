/**
 * Runs the selected adapters and merges what they find into one plan.
 *
 * The only thing this adds on top of the adapters is collision handling. Two
 * agents can both define an MCP server called `github`, or both want to write
 * `commands/review.md`. The first agent in the caller's order wins — that is
 * the order the user checked them in — and every later claim becomes a
 * `conflict` row naming the winner, so nothing is silently dropped.
 */
import { homedir } from 'os'

import { getAdapter } from 'src/platform/import/registry.js'
import {
  emptyPlan,
  type CollectContext,
  type ForeignAgentId,
  type ImportArtifact,
  type ImportPlan,
} from 'src/platform/import/types.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { logError } from 'src/shared/log.js'

export function createCollectContext(
  overrides: Partial<CollectContext> = {},
): CollectContext {
  return {
    homeDir: homedir(),
    cwd: getCwd(),
    claudinHomeDir: getClaudinConfigHomeDir(),
    env: process.env,
    ...overrides,
  }
}

/**
 * What makes two artifacts the same thing. Files collide on their destination
 * path; an MCP server collides on its name within a scope, because the name is
 * the key it is stored under rather than a path.
 */
export function artifactKey(artifact: ImportArtifact): string {
  switch (artifact.kind) {
    case 'mcpServer':
      return `mcpServer:${artifact.scope}:${artifact.name}`
    case 'settingsKey':
      return `settingsKey:${artifact.scope}:${artifact.key}`
    case 'providerHint':
      return `providerHint:${artifact.provider}:${artifact.baseUrl}:${artifact.model}`
    default:
      return `${artifact.kind}:${artifact.destination}`
  }
}

function dedupe(
  artifacts: ImportArtifact[],
  labelFor: (id: ForeignAgentId) => string,
): ImportArtifact[] {
  const winners = new Map<string, ImportArtifact>()
  return artifacts.map(artifact => {
    const key = artifactKey(artifact)
    const winner = winners.get(key)
    if (!winner) {
      winners.set(key, artifact)
      return artifact
    }
    return {
      ...artifact,
      status: 'conflict' as const,
      statusReason: `also provided by ${labelFor(winner.agent)}, which was selected first`,
    }
  })
}

export async function collectImportPlan(
  ctx: CollectContext,
  agentIds: readonly ForeignAgentId[],
): Promise<ImportPlan> {
  const merged = emptyPlan()
  const labels = new Map<ForeignAgentId, string>()

  for (const id of agentIds) {
    const adapter = getAdapter(id)
    if (!adapter) continue
    labels.set(id, adapter.label)
    try {
      const plan = await adapter.collect(ctx)
      merged.artifacts.push(...plan.artifacts)
      merged.notImportable.push(...plan.notImportable)
      merged.warnings.push(...plan.warnings)
    } catch (e: unknown) {
      // One unreadable agent must not take the whole import down with it.
      logError(e)
      merged.warnings.push(
        `${adapter.label}: could not be read (${e instanceof Error ? e.message : String(e)})`,
      )
    }
  }

  merged.artifacts = dedupe(merged.artifacts, id => labels.get(id) ?? id)
  return merged
}
