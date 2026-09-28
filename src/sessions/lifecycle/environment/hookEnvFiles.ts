/**
 * The files hooks leave `export` lines in, one per hook: how they are named,
 * and the order the shell sources them in. Pure.
 */

/** The hook events that may export variables, in the order their files are sourced. */
const EXPORTING_EVENTS = ['Setup', 'SessionStart', 'CwdChanged', 'FileChanged'] as const
export type ExportingHookEvent = (typeof EXPORTING_EVENTS)[number]

const EVENT_PREFIXES: readonly string[] = EXPORTING_EVENTS.map(event => event.toLowerCase())

/** `<event, lowercased>-hook-<index>.sh` and nothing else: no other case, suffix or index. */
const HOOK_ENV_FILE = new RegExp(`^(${EVENT_PREFIXES.join('|')})-hook-(\\d+)\\.sh$`)

/** What those events export belongs to the directory they ran in. */
const DIRECTORY_SCOPED_PREFIXES: ReadonlySet<string> = new Set(['cwdchanged', 'filechanged'])

type HookEnvFile = { name: string; prefix: string; index: number }

export function hookEnvFileName(event: ExportingHookEvent, index: number): string {
  return `${event.toLowerCase()}-hook-${index}.sh`
}

/** The hook env files among `names`, by event and then by index as a number (2 before 10). */
export function orderHookEnvFiles(names: readonly string[]): string[] {
  const rank = (file: HookEnvFile) => EVENT_PREFIXES.indexOf(file.prefix)
  return names
    .flatMap(name => parseHookEnvFile(name) ?? [])
    .sort((a, b) => rank(a) - rank(b) || a.index - b.index)
    .map(file => file.name)
}

/** Whether `name` holds exports that a change of directory makes stale. */
export function isDirectoryScopedHookEnvFile(name: string): boolean {
  const file = parseHookEnvFile(name)
  return file !== undefined && DIRECTORY_SCOPED_PREFIXES.has(file.prefix)
}

function parseHookEnvFile(name: string): HookEnvFile | undefined {
  const match = HOOK_ENV_FILE.exec(name)
  if (!match) return undefined
  return { name, prefix: match[1] ?? '', index: Number(match[2]) }
}
