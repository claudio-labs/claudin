/**
 * Pure parsing for the /auto-mode-setup scan.
 *
 * Everything the scan sends to a model passes through here first, and the rule
 * the whole module exists to enforce is: **no argument text leaves the
 * machine**. A shell history line or a transcript command is reduced to a
 * `binary subcommand` head, and a head only survives if its binary is one this
 * file names. A path, a URL, a flag value or a `FOO=secret` prefix can never
 * reach the output because none of them is ever copied into it.
 */

/** One command shape and how often it was seen. */
export type CommandCount = {
  command: string
  count: number
}

/** Binaries whose NAME may be reported. Anything else is dropped whole. */
const REPORTABLE_BINARIES = new Set([
  // version control & forges
  'git', 'gh', 'glab', 'tea', 'hg', 'svn', 'jj',
  // js/ts
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'deno', 'tsc', 'tsx',
  'vite', 'next', 'eslint', 'prettier', 'jest', 'vitest', 'playwright',
  // python
  'python', 'python3', 'pip', 'pip3', 'uv', 'uvx', 'poetry', 'pytest', 'ruff',
  'mypy', 'black', 'conda', 'pyenv',
  // other toolchains
  'cargo', 'rustc', 'rustup', 'go', 'gofmt', 'java', 'javac', 'mvn', 'gradle',
  'sbt', 'dotnet', 'swift', 'xcodebuild', 'zig', 'mix', 'rebar3', 'flutter',
  'dart', 'ruby', 'gem', 'bundle', 'rails', 'rake', 'php', 'composer', 'perl',
  'lua', 'luarocks', 'ghc', 'cabal', 'stack', 'elm', 'nim',
  // build & task runners
  'make', 'cmake', 'ninja', 'bazel', 'just', 'task', 'ant',
  // containers, orchestration, cloud
  'docker', 'podman', 'nerdctl', 'kubectl', 'helm', 'minikube', 'kind',
  'terraform', 'tofu', 'pulumi', 'ansible', 'vagrant', 'aws', 'gcloud', 'az',
  'flyctl', 'heroku', 'vercel', 'netlify', 'wrangler', 'supabase', 'railway',
  // databases
  'psql', 'mysql', 'sqlite3', 'redis-cli', 'mongosh', 'prisma',
  // shell & file basics
  'ls', 'cd', 'cat', 'less', 'head', 'tail', 'grep', 'rg', 'fd', 'find', 'sed',
  'awk', 'sort', 'uniq', 'wc', 'diff', 'cp', 'mv', 'rm', 'mkdir', 'rmdir',
  'touch', 'chmod', 'chown', 'ln', 'tar', 'zip', 'unzip', 'gzip', 'du', 'df',
  'echo', 'which', 'file', 'stat', 'tree', 'xargs',
  // network & processes
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'ping', 'dig', 'nc', 'ps', 'top',
  'htop', 'kill', 'pkill', 'lsof', 'systemctl', 'journalctl', 'service',
  // editors, multiplexers, misc dev
  'vim', 'nvim', 'nano', 'code', 'tmux', 'screen', 'jq', 'yq', 'sudo', 'env',
  'man', 'watch', 'time', 'open', 'pbcopy', 'claude', 'claudin', 'codex',
])

/**
 * Binaries whose first bare-word argument is a SUBCOMMAND rather than a name
 * from the user's machine. `git status` is worth reporting; `cd my-client-repo`
 * and `which internal-tool` are not, so everything outside this set is reduced
 * to the binary alone.
 */
const SUBCOMMAND_BINARIES = new Set([
  'git', 'gh', 'glab', 'tea', 'jj', 'hg', 'svn',
  'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'deno', 'npx',
  'pip', 'pip3', 'uv', 'uvx', 'poetry', 'conda', 'pyenv',
  'cargo', 'rustup', 'go', 'mvn', 'gradle', 'sbt', 'dotnet', 'swift', 'zig',
  'mix', 'rebar3', 'flutter', 'dart', 'gem', 'bundle', 'rails', 'composer',
  'docker', 'podman', 'nerdctl', 'kubectl', 'helm', 'minikube', 'kind',
  'terraform', 'tofu', 'pulumi', 'ansible', 'vagrant', 'aws', 'gcloud', 'az',
  'flyctl', 'heroku', 'vercel', 'netlify', 'wrangler', 'supabase', 'railway',
  'systemctl', 'journalctl', 'service', 'tmux', 'screen', 'prisma', 'code',
  'claude', 'claudin', 'codex', 'just', 'task', 'bazel',
])

/** A subcommand looks like a bare word — never a path, flag or url. */
const SUBCOMMAND_RE = /^[a-z][a-z0-9:_-]*$/i

/** `FOO=bar` prefixes, stripped before the binary is read. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/** zsh extended history: `: 1699999999:0;git status`. */
const ZSH_EXTENDED_HISTORY_RE = /^:\s*\d+:\d*;/

/** fish history: `- cmd: git status`. */
const FISH_HISTORY_RE = /^-\s*cmd:\s*/

/** Network filesystem types worth refusing to read history from. */
const NETWORK_FS_TYPES = new Set([
  'nfs', 'nfs4', 'cifs', 'smbfs', 'smb3', 'afs', 'sshfs', 'fuse.sshfs',
  'ncpfs', 'davfs', 'fuse.davfs', 'glusterfs', 'ceph',
])

/**
 * Reduce one command line to `binary` or `binary subcommand`.
 *
 * Returns null when the binary is not on the reportable list — that is the
 * check that keeps an unknown internal tool's name, and every argument of
 * every command, out of the payload.
 */
export function extractCommandHead(command: string): string | null {
  const tokens = tokenize(command)
  let index = 0
  while (index < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[index]!)) {
    index += 1
  }
  const rawBinary = tokens[index]
  if (!rawBinary) return null

  // basename only: a path would otherwise leak directory names.
  const binary = rawBinary.split('/').pop()?.split('\\').pop() ?? ''
  if (!REPORTABLE_BINARIES.has(binary)) return null

  const next = tokens[index + 1]
  if (
    next &&
    SUBCOMMAND_BINARIES.has(binary) &&
    SUBCOMMAND_RE.test(next) &&
    !next.includes('=')
  ) {
    return `${binary} ${next}`
  }
  return binary
}

/**
 * Split a command line into the shell words of its FIRST segment. Operators
 * end the segment: only the head of the pipeline is described, and quoted text
 * is never reassembled.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '|' || char === ';' || char === '&' || char === '\n') break
    if (char === ' ' || char === '\t') {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

/**
 * Extract the command lines from a shell history file. Handles plain bash
 * history, zsh extended history and fish history; everything else is treated
 * as one command per line.
 */
export function parseShellHistory(text: string): string[] {
  const commands: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (FISH_HISTORY_RE.test(line)) {
      commands.push(line.replace(FISH_HISTORY_RE, ''))
      continue
    }
    if (line.startsWith('-') || line.startsWith('when:')) continue
    commands.push(line.replace(ZSH_EXTENDED_HISTORY_RE, ''))
  }
  return commands
}

/** Count command heads, most frequent first, capped at `limit`. */
export function buildHistogram(
  heads: readonly (string | null)[],
  limit: number,
): CommandCount[] {
  const counts = new Map<string, number>()
  for (const head of heads) {
    if (!head) continue
    counts.set(head, (counts.get(head) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command))
    .slice(0, limit)
}

/**
 * True when the home directory sits on a network filesystem, in which case the
 * scan skips shell history entirely (reading it can hang, and the file is not
 * even reliably the user's own).
 */
export function isNetworkHome(mountsText: string | null, home: string): boolean {
  if (home.startsWith('\\\\')) return true // UNC path
  if (!mountsText) return false

  let bestMatch = ''
  let bestType = ''
  for (const line of mountsText.split('\n')) {
    const parts = line.split(/\s+/)
    const mountPoint = parts[1]
    const fsType = parts[2]
    if (!mountPoint || !fsType) continue
    const isPrefix = home === mountPoint || home.startsWith(`${mountPoint}/`)
    if (isPrefix && mountPoint.length >= bestMatch.length) {
      bestMatch = mountPoint
      bestType = fsType
    }
  }
  return NETWORK_FS_TYPES.has(bestType)
}

/**
 * Pull the tool uses out of raw session JSONL text. Only tool NAMES and, for
 * shell tools, the command head are read; inputs are never copied.
 */
export function extractToolUsesFromTranscript(text: string): {
  toolNames: string[]
  commandHeads: (string | null)[]
} {
  const toolNames: string[] = []
  const commandHeads: (string | null)[] = []

  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      // A tail read starts mid-line, and a session file can hold a partial
      // last line; both are expected, not errors.
      continue
    }
    for (const block of toolUseBlocks(entry)) {
      toolNames.push(block.name)
      if (block.name === 'Bash' || block.name === 'PowerShell') {
        const command = readStringField(block.input, 'command')
        if (command) commandHeads.push(extractCommandHead(command))
      }
    }
  }

  return { toolNames, commandHeads }
}

type ToolUseBlock = { name: string; input: unknown }

function toolUseBlocks(entry: unknown): ToolUseBlock[] {
  if (!isRecord(entry)) return []
  const message = entry.message
  if (!isRecord(message)) return []
  const content = message.content
  if (!Array.isArray(content)) return []

  const blocks: ToolUseBlock[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type !== 'tool_use') continue
    const name = block.name
    if (typeof name !== 'string') continue
    blocks.push({ name, input: block.input })
  }
  return blocks
}

function readStringField(input: unknown, field: string): string | null {
  if (!isRecord(input)) return null
  const value = input[field]
  return typeof value === 'string' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
