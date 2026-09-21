import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { Command } from 'src/commands/commands.js'
import { isAutoMemoryEnabled, getAutoMemPath } from 'src/memory/memdir/paths.js'
import {
  getTeamMemPath,
  isTeamMemoryEnabled,
} from 'src/memory/memdir/teamMemPaths.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { getOriginalCwd, getSessionId } from 'src/platform/bootstrap/state.js'
import { buildConsolidationPrompt } from 'src/memory/autoDream/consolidationPrompt.js'
import { collectDreamDigest } from 'src/memory/autoDream/dreamDigest.js'
import {
  readLastConsolidatedAt,
  listSessionsTouchedSince,
  recordConsolidation,
} from 'src/memory/autoDream/consolidationLock.js'

const command = {
  type: 'prompt',
  name: 'dream',
  description:
    'Run memory consolidation — synthesize recent sessions into durable memories',
  isEnabled: () => isAutoMemoryEnabled(),
  progressMessage: 'consolidating memories',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(): Promise<ContentBlockParam[]> {
    const memoryRoot = getAutoMemPath()
    const transcriptDir = getProjectDir(getOriginalCwd())

    let lastAt: number
    try {
      lastAt = await readLastConsolidatedAt()
    } catch {
      lastAt = 0
    }

    let sessionIds: string[]
    try {
      sessionIds = await listSessionsTouchedSince(lastAt)
    } catch {
      sessionIds = []
    }

    const currentSession = getSessionId()
    sessionIds = sessionIds.filter(id => id !== currentSession)

    if (sessionIds.length === 0) {
      sessionIds = [currentSession]
    }

    const hoursSince =
      lastAt > 0
        ? `${((Date.now() - lastAt) / 3_600_000).toFixed(1)}h ago`
        : 'never'

    const teamRoot =
      feature('TEAMMEM') && isTeamMemoryEnabled() ? getTeamMemPath() : null
    const digest = await collectDreamDigest(lastAt, sessionIds)
    const extra = `
**Manually triggered by user via /dream.**

Sessions since last consolidation (${sessionIds.length}, last run: ${hoursSince}):
${sessionIds.map(id => `- ${id}`).join('\n')}

${digest}`

    const prompt = buildConsolidationPrompt(
      memoryRoot,
      transcriptDir,
      extra,
      teamRoot,
    )

    // Record consolidation timestamp programmatically so auto-dream
    // knows when the last manual run happened.
    await recordConsolidation()

    return [{ type: 'text', text: prompt }]
  },
} satisfies Command

export default command
