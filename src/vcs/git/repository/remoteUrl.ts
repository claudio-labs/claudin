/** A remote's host (with its port, for http and https), owner and repository name, as written. */
export type ParsedRepository = {
  host: string
  owner: string
  name: string
}

// git@<host>:<owner>/<name>: the user must be git, and there is no port.
const SCP_LIKE_RE = /^git@([^\s/:@]+):([^\s/:]+)\/([^\s/]+)$/
// <scheme>://[<user-info>@]<host>[:<port>]/<owner>/<name>, scheme in lower case.
// The user-info runs to the last `@` before the path, so a password holding an
// unencoded `@` never spills into the host.
const URL_FORM_RE =
  /^(https?|ssh|git):\/\/(?:[^\s/]*@)?([^\s/:@?#]+)(?::(\d+))?\/([^\s/?#]+)\/([^\s/?#]+)$/
const LETTERS_ONLY_RE = /^[A-Za-z]+$/
const DOT_GIT_SUFFIX_RE = /\.git$/
const SCHEME_PREFIX_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
const SCHEMES_KEEPING_PORT: ReadonlySet<string> = new Set(['http', 'https'])
const GITHUB_HOST = 'github.com'

type RemoteMatcher = (remote: string) => ParsedRepository | null

const matchScpLike: RemoteMatcher = remote => {
  const match = SCP_LIKE_RE.exec(remote)
  if (match === null) return null
  const [, host = '', owner = '', name = ''] = match
  return repositoryOn(host, host, owner, name)
}

const matchUrlForm: RemoteMatcher = remote => {
  const match = URL_FORM_RE.exec(remote)
  if (match === null) return null
  const [, scheme = '', hostname = '', port, owner = '', name = ''] = match
  const host =
    port !== undefined && SCHEMES_KEEPING_PORT.has(scheme) ? `${hostname}:${port}` : hostname
  return repositoryOn(hostname, host, owner, name)
}

const REMOTE_MATCHERS: readonly RemoteMatcher[] = [matchScpLike, matchUrlForm]

/** Reads the two forms a repository remote takes; anything else is null. */
export function parseGitRemote(input: string): ParsedRepository | null {
  const remote = input.trim()
  for (const match of REMOTE_MATCHERS) {
    const parsed = match(remote)
    if (parsed !== null) return parsed
  }
  return null
}

function repositoryOn(
  hostname: string,
  host: string,
  owner: string,
  rawName: string,
): ParsedRepository | null {
  const name = rawName.replace(DOT_GIT_SUFFIX_RE, '')
  return isServerHostname(hostname) && name !== '' ? { host, owner, name } : null
}

/**
 * A hostname that names a server: it has a dot and its last label is letters
 * only. That rules out SSH config aliases (`github.com-work`), `localhost`
 * and IP addresses.
 */
function isServerHostname(hostname: string): boolean {
  const lastDot = hostname.lastIndexOf('.')
  return lastDot > 0 && LETTERS_ONLY_RE.test(hostname.slice(lastDot + 1))
}

/** Hostnames are case-insensitive, so `GitHub.com` is github.com too. */
export function isGitHubHost(host: string): boolean {
  return host.toLowerCase() === GITHUB_HOST
}

/** `owner/name` when the repository is on github.com, null otherwise. */
export function gitHubNameOf(repository: ParsedRepository | null): string | null {
  if (repository === null || !isGitHubHost(repository.host)) return null
  return `${repository.owner}/${repository.name}`
}

/** `owner/name` from a github.com remote or from the `owner/name` shorthand; null for anything else. */
export function toGitHubName(input: string): string | null {
  const text = input.trim()
  const remote = parseGitRemote(text)
  return remote === null ? parseShorthand(text) : gitHubNameOf(remote)
}

function parseShorthand(text: string): string | null {
  if (text.includes('://') || text.includes('@')) return null
  const parts = text.split('/')
  if (parts.length !== 2) return null
  const [owner = '', rawName = ''] = parts
  const name = rawName.replace(DOT_GIT_SUFFIX_RE, '')
  return owner !== '' && name !== '' ? `${owner}/${name}` : null
}

/**
 * The remote with its user-info masked, for logs: tokens ride there
 * (`https://x-access-token:<token>@github.com/...`). Everything up to the last
 * `@` after the scheme is masked, so an unencoded `@` in a password is covered.
 */
export function redactRemoteUserInfo(remote: string): string {
  const scheme = SCHEME_PREFIX_RE.exec(remote)?.[0] ?? ''
  const rest = remote.slice(scheme.length)
  const lastAt = rest.lastIndexOf('@')
  return lastAt < 0 ? remote : `${scheme}***${rest.slice(lastAt)}`
}
