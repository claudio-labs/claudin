/**
 * The automatic dream's own "Additional context": its tool limits, the
 * sessions it reviews, and the decision digest of the period, last. The
 * manual `/dream` runs with normal permissions and writes its own.
 */

const READ_ONLY_COMMANDS = ['ls', 'find', 'grep', 'cat', 'stat', 'wc', 'head', 'tail'] as const

function listInWords(items: readonly string[]): string {
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function toolLimits(): string {
  const commands = listInWords(READ_ONLY_COMMANDS.map(command => `\`${command}\``))
  return `**Tool limits in this run.** Bash is read-only here. Commands that only look, such as ${commands}, go through; anything that writes, redirects output into a file or otherwise changes state is denied, so there is no need to test where the line is.`
}

function sessionList(sessionIds: readonly string[]): string {
  return [
    `**Sessions touched since the last consolidation (${sessionIds.length}):**`,
    ...sessionIds.map(id => `- ${id}`),
  ].join('\n')
}

export function buildDreamRunContext(sessionIds: readonly string[], digest: string): string {
  return [toolLimits(), sessionList(sessionIds), digest].join('\n\n')
}
