/**
 * The rewrite's order, as docs/tech/rewrite/README.md lays it out: leaves
 * before the core, so each phase leans on modules that are already rewritten.
 * The longest matching prefix wins, which is how the shell parsers under
 * src/platform/ go with the tools that use them instead of with platform.
 */
export type Phase = { phase: number; title: string; prefixes: string[] }

export const PHASES: Phase[] = [
  { phase: 1, title: 'Pilot: skills', prefixes: ['src/skills/'] },
  { phase: 2, title: 'memory, vcs, sessions', prefixes: ['src/memory/', 'src/vcs/', 'src/sessions/'] },
  { phase: 3, title: 'mcp, permissions', prefixes: ['src/mcp/', 'src/permissions/'] },
  { phase: 4, title: 'shared', prefixes: ['src/shared/'] },
  { phase: 5, title: 'providers', prefixes: ['src/providers/'] },
  { phase: 6, title: 'tools and the shell parsers', prefixes: ['src/tools/', 'src/platform/shell/', 'src/platform/bash/'] },
  { phase: 7, title: 'commands, plugins', prefixes: ['src/commands/', 'src/plugins/'] },
  { phase: 8, title: 'platform', prefixes: ['src/platform/'] },
  { phase: 9, title: 'terminal, native-ts', prefixes: ['src/terminal/', 'src/native-ts/'] },
  { phase: 10, title: 'agent', prefixes: ['src/agent/'] },
  { phase: 11, title: 'scripts', prefixes: ['scripts/'] },
  { phase: 12, title: 'Final cut: everything else', prefixes: [''] },
]

export function phaseOf(file: string): Phase {
  let best: Phase | undefined
  let bestLength = -1
  for (const phase of PHASES) {
    for (const prefix of phase.prefixes) {
      if (file.startsWith(prefix) && prefix.length > bestLength) {
        best = phase
        bestLength = prefix.length
      }
    }
  }
  return best!
}

/**
 * The unit a rewrite takes on: `src/<slice>/<dir>`, or `src/<slice>/*` for the
 * files at the top of a slice; `scripts/<dir>`; anything else by its top
 * directory, or by name at the root.
 */
export function moduleOf(file: string): string {
  const parts = file.split('/')
  if (parts[0] === 'src') {
    if (parts.length >= 4) return parts.slice(0, 3).join('/')
    if (parts.length === 3) return `${parts[0]}/${parts[1]}/*`
    return file
  }
  if (parts[0] === 'scripts' && parts.length >= 3) return `${parts[0]}/${parts[1]}`
  return parts.length === 1 ? file : parts[0]!
}
