import { dreamPromptLines } from 'src/memory/autoDream/prompt/dreamPromptText.js'

// getTeamMemPath() returns a path with a trailing separator (teamMemPaths.ts)
// — strip it before interpolating so the prompt doesn't render `…/team//x`.
const TRAILING_SEP_RE = /[/\\]+$/

const ADDITIONAL_CONTEXT_HEADING = '## Additional context'

/**
 * The dream prompt. `teamRoot` is the team memory dir when team memory is
 * active (the dream then files decisions, bugs and docs into its category
 * subdirectories — the git commit is the review gate) and null otherwise,
 * in which case the run is private-only as it always was. `extra` carries
 * the run-specific tail: the decision-sources digest (dreamDigest.ts), the
 * session list, tool constraints.
 */
export function buildConsolidationPrompt(
  memoryRoot: string,
  transcriptDir: string,
  extra: string,
  teamRoot: string | null = null,
): string {
  const teamDir = teamRoot === null ? null : teamRoot.replace(TRAILING_SEP_RE, '')
  const prompt = dreamPromptLines({ memoryRoot, transcriptDir, teamDir }).join('\n')
  return extra === '' ? prompt : `${prompt}\n\n${ADDITIONAL_CONTEXT_HEADING}\n\n${extra}`
}
