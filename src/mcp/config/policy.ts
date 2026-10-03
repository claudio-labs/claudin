import escapeRegExp from 'lodash-es/escapeRegExp.js'
import {
  type AllowedMcpServerEntry,
  type DeniedMcpServerEntry,
  isMcpServerCommandEntry,
  isMcpServerNameEntry,
  isMcpServerUrlEntry,
} from 'src/platform/settings/types.js'
import { isRecord } from 'src/mcp/config/jsonFile.js'

export type PolicyVerdict = 'allowed' | 'denied' | 'not-allowed'

/** The two lists as resolved from settings. No allowlist means no restriction. */
export type PolicyLists = {
  allow: readonly AllowedMcpServerEntry[] | undefined
  deny: readonly DeniedMcpServerEntry[]
}

type UrlMatcher = (url: string) => boolean

/** One list, sorted by what each entry matches on. */
type EntryIndex = {
  names: ReadonlySet<string>
  commands: readonly (readonly string[])[]
  urls: readonly UrlMatcher[]
}

export type CompiledPolicy = { deny: EntryIndex; allow: EntryIndex | null }

/** What a policy entry other than a name can match a server by. */
type ServerHandle = { kind: 'command'; argv: readonly string[] } | { kind: 'url'; url: string } | { kind: 'name-only' }

// A URL's scheme and authority: everything before the path, query or fragment.
const SCHEME_AND_HOST = /^[^:/?#]*:\/\/[^/?#]*/

function foldSchemeAndHost(text: string): string {
  return text.replace(SCHEME_AND_HOST, head => head.toLowerCase())
}

function wildcardRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)
}

/**
 * `*` spans any run of characters (path separators included); every other
 * character is literal and the whole URL must match. Hosts are compared
 * case-insensitively: the folded comparison only adds matches, so a pattern
 * that matched before still does.
 */
export function compileUrlPattern(pattern: string): UrlMatcher {
  const asWritten = wildcardRegex(pattern)
  const folded = wildcardRegex(foldSchemeAndHost(pattern))
  return url => asWritten.test(url) || folded.test(foldSchemeAndHost(url))
}

function indexEntries(entries: readonly (AllowedMcpServerEntry | DeniedMcpServerEntry)[]): EntryIndex {
  const names = new Set<string>()
  const commands: string[][] = []
  const urls: UrlMatcher[] = []
  for (const entry of entries) {
    if (isMcpServerNameEntry(entry)) names.add(entry.serverName)
    if (isMcpServerCommandEntry(entry)) commands.push(entry.serverCommand)
    if (isMcpServerUrlEntry(entry)) urls.push(compileUrlPattern(entry.serverUrl))
  }
  return { names, commands, urls }
}

export function compilePolicy(lists: PolicyLists): CompiledPolicy {
  return { deny: indexEntries(lists.deny), allow: lists.allow ? indexEntries(lists.allow) : null }
}

function handleOf(config: unknown): ServerHandle {
  if (!isRecord(config)) return { kind: 'name-only' }
  const { type, command, args, url } = config
  if ((type === undefined || type === 'stdio') && typeof command === 'string') {
    const rest = Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : []
    return { kind: 'command', argv: [command, ...rest] }
  }
  if (typeof url === 'string') return { kind: 'url', url }
  return { kind: 'name-only' }
}

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i])
}

function matchesTyped(index: EntryIndex, handle: ServerHandle): boolean {
  switch (handle.kind) {
    case 'command':
      return index.commands.some(entry => sameArgv(entry, handle.argv))
    case 'url':
      return index.urls.some(matches => matches(handle.url))
    case 'name-only':
      return false
  }
}

/** Command or URL entries in an allowlist bind servers of that kind to them. */
function hasTypedEntries(index: EntryIndex, handle: ServerHandle): boolean {
  if (handle.kind === 'command') return index.commands.length > 0
  if (handle.kind === 'url') return index.urls.length > 0
  return false
}

/**
 * The verdict for one server. A deny entry wins over anything the allowlist
 * says. With an allowlist, a server whose kind has typed entries must match
 * one of them; any other server needs its name listed.
 */
export function judgeServer(name: string, config: unknown, policy: CompiledPolicy): PolicyVerdict {
  const handle = handleOf(config)
  if (policy.deny.names.has(name) || matchesTyped(policy.deny, handle)) return 'denied'
  if (!policy.allow) return 'allowed'
  const admitted = hasTypedEntries(policy.allow, handle)
    ? matchesTyped(policy.allow, handle)
    : policy.allow.names.has(name)
  return admitted ? 'allowed' : 'not-allowed'
}
